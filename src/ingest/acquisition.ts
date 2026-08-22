import type { WorkflowStep } from 'cloudflare:workers';
import { paperIdentifiersFromIdentity, resolveExactPaperInput } from '@core-shared/paper-identity';
import { isPaperIdentifier, normalizeResourceIdentifiers, type ResourceIdentifier } from '@core-shared/resource-identifiers';
import type { AcquiredMaterial, MaterializedResource, ResolvedResource } from '@core-shared/types';
import { canonicalResourcePlatformUrl, detectResourceUrl, normalizeUrl, parseExternalHttpUrl } from '@core-shared/url';
import { type HackerNewsAcquiredContent, stageHackerNewsAcquisition, stageHackerNewsEnrichment } from './platforms/hackernews';
import { stageLessWrongAcquisition } from './platforms/lesswrong';
import { stagePaperProcessing } from './platforms/paper';
import { stageTwitterAcquisition } from './platforms/twitter-acquisition';
import { stageYouTubeAcquisition, stageYouTubeEnrichment } from './platforms/youtube-acquisition';
import { exactPlatformLocator, materializeAcquiredResource, type ResourceMaterializationOrigin } from './resource-resolver';
import { stageWebAcquisition } from './web-acquisition';

type RawAcquiredContent =
	| AcquiredMaterial<null>
	| HackerNewsAcquiredContent
	| AcquiredMaterial<'lesswrong'>
	| AcquiredMaterial<'twitter'>
	| AcquiredMaterial<'youtube'>;

export type AcquiredContent = RawAcquiredContent & { sourceSnapshotHash: string };

export type ResourceResolutionOrigin = ResourceMaterializationOrigin & Pick<MaterializedResource, 'resourceIdentifiers'>;

type SavedUrlAcquisitionResult = AcquiredContent | { redirectUrl: string };

function validateAcquisitionUrl(url: string): string {
	const parsed = parseExternalHttpUrl(url);
	if (!parsed) throw new Error('Only http(s) URLs without credentials are allowed');
	return normalizeUrl(parsed.toString());
}

export async function stageSavedUrlAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		discoverRelatedContent: boolean;
		isMonitoredOnly: boolean;
		processingId: string;
		resourceIdentifiers?: readonly ResourceIdentifier[];
		sourceAvatarUrl: string | null;
		sourceUrl: string | null;
	},
	providerSequence?: string,
): Promise<AcquiredContent> {
	const locator = exactPlatformLocator(input.resourceIdentifiers ?? []);
	const sourceUrl = locator ? canonicalResourcePlatformUrl(locator.resourcePlatform, locator.platformId) : input.sourceUrl;
	if (!sourceUrl) throw new Error(`Resource processing ${input.processingId} has no source URL`);
	let acquisitionUrl = validateAcquisitionUrl(sourceUrl);
	for (let route = 0; route < 5; route++) {
		const detected = detectResourceUrl(acquisitionUrl);
		let staged: Promise<SavedUrlAcquisitionResult>;
		if (!detected) {
			staged = stageWebAcquisition(env, step, { processingId: input.processingId, route, url: acquisitionUrl });
		} else {
			switch (detected.resourcePlatform) {
				case 'hackernews':
					staged = stageHackerNewsAcquisition(step, { itemId: detected.platformId, route, url: acquisitionUrl });
					break;
				case 'lesswrong':
					staged = stageLessWrongAcquisition(step, { postId: detected.platformId, route, url: acquisitionUrl });
					break;
				case 'twitter':
					staged = stageTwitterAcquisition(env, step, {
						discoverRelatedContent: input.discoverRelatedContent,
						processingId: input.processingId,
						...(providerSequence ? { providerSequence } : {}),
						route,
						tweetId: detected.platformId,
						url: acquisitionUrl,
					});
					break;
				case 'youtube':
					staged = stageYouTubeAcquisition(env, step, {
						monitoredOnly: input.isMonitoredOnly,
						route,
						sourceAvatarUrl: input.sourceAvatarUrl,
						url: acquisitionUrl,
						videoId: detected.platformId,
					});
					break;
				default:
					detected.resourcePlatform satisfies never;
					throw new Error(`Unsupported resource platform for ${input.processingId}`);
			}
		}
		const acquisition = await staged;
		if (!('redirectUrl' in acquisition)) return acquisition;
		acquisitionUrl = validateAcquisitionUrl(acquisition.redirectUrl);
	}
	throw new Error(`Resource acquisition ${input.processingId} exceeded its platform redirect limit`);
}

export async function resolveAcquiredResource(
	env: CoreEnv,
	step: WorkflowStep,
	acquired: AcquiredContent,
	origin: ResourceResolutionOrigin,
	processingId: string,
	translatePaperUrl: boolean,
): Promise<ResolvedResource> {
	const canonicalUrl = acquired.canonicalUrl?.trim() || origin.url;
	const exactPaper = resolveExactPaperInput(origin.url) ?? resolveExactPaperInput(canonicalUrl);
	const resourceIdentifiers = normalizeResourceIdentifiers([
		...origin.resourceIdentifiers,
		...(exactPaper ? paperIdentifiersFromIdentity(exactPaper.identity) : []),
	]);
	let publishedDate = origin.publishedDate;
	if (acquired.publishedDate?.trim()) {
		const parsed = new Date(acquired.publishedDate);
		if (!Number.isNaN(parsed.getTime())) publishedDate = parsed.toISOString();
	}

	if (acquired.resourcePlatform === null) {
		const paper = await stagePaperProcessing(env, step, {
			acquiredContent: acquired,
			canonicalUrl,
			identifiers: resourceIdentifiers.filter(isPaperIdentifier),
			originSummary: origin.summary,
			processingId,
			publishedDate,
			translateUrl: translatePaperUrl,
		});
		if (!paper.acquiredContent.markdown.trim()) {
			throw new Error(`Processing ${processingId} has no extractable content`);
		}
		return {
			...materializeAcquiredResource(paper.acquiredContent, origin, {
				canonicalUrl,
				publishedDate: paper.publishedDate,
				resourceIdentifiers: normalizeResourceIdentifiers([...paper.identifiers, ...resourceIdentifiers]),
			}),
			specialization: null,
		};
	}

	if (!acquired.markdown.trim()) {
		throw new Error(`Processing ${processingId} has no extractable content`);
	}
	const resolution = { canonicalUrl, publishedDate, resourceIdentifiers };
	switch (acquired.resourcePlatform) {
		case 'hackernews':
			return {
				...materializeAcquiredResource(await stageHackerNewsEnrichment(env, step, acquired, processingId), origin, resolution),
				specialization: null,
			};
		case 'youtube':
			return {
				...materializeAcquiredResource(acquired, origin, resolution),
				specialization: await stageYouTubeEnrichment(env, step, acquired, processingId),
			};
		case null:
		case 'lesswrong':
		case 'twitter':
			return { ...materializeAcquiredResource(acquired, origin, resolution), specialization: null };
		default:
			acquired satisfies never;
			throw new Error(`Unsupported acquired resource platform for ${processingId}`);
	}
}
