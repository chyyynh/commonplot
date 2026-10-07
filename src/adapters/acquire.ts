import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { AcquisitionInput } from '../contracts/acquired-resource';
import { normalizeAcquiredResource } from '../contracts/normalize-resource';
import type { ResourceIdentifier } from '../contracts/resource';
import { resolveResourceUrl } from '../contracts/resource-url';
import { hackerNewsTitle, stageHackerNewsAcquisition } from './hackernews';
import { stageLessWrongAcquisition } from './lesswrong';
import { paperTitle, stagePaper } from './paper';
import { stageStoredPdfAcquisition } from './pdf';
import { stageTwitterAcquisition, tweetTitle } from './twitter';
import { stageWebAcquisition, webPageTitle } from './web';
import { stageYouTubeAcquisition, youTubeTitle } from './youtube';

/** A linked paper with neither full text nor an abstract is not acquired. */
async function stageLinkedPaper(
	env: CoreEnv,
	step: WorkflowStep,
	input: { processingId: string; url: string; identifiers: ResourceIdentifier[] },
) {
	const paper = await stagePaper(env, step, input);
	if (!paper) throw new NonRetryableError(`Paper ${input.url} has no readable full text or abstract`);
	return paper;
}

async function stageUrlAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		processingId: string;
		url: string;
		identifiers?: ResourceIdentifier[];
	},
) {
	let detected = resolveResourceUrl(input.url);
	if (!detected) throw new NonRetryableError('Resource URL must be HTTP(S) without credentials');
	if (!detected.resourcePlatform) {
		const identifiers = [...(input.identifiers ?? []), ...detected.identifiers];
		if (identifiers.length) return stageLinkedPaper(env, step, { ...input, identifiers });
		const acquired = await stageWebAcquisition(env, step, { url: detected.url });
		if (!('platform' in acquired)) return acquired;
		detected = acquired.platform;
		if (!detected.resourcePlatform)
			return stageLinkedPaper(env, step, { processingId: input.processingId, url: detected.url, identifiers: detected.identifiers });
	}

	const platformId = detected.identifiers[0]!.value;
	switch (detected.resourcePlatform) {
		case 'hackernews':
			return stageHackerNewsAcquisition(env, step, {
				itemId: platformId,
				processingId: input.processingId,
			});
		case 'lesswrong':
			return stageLessWrongAcquisition(step, platformId);
		case 'twitter':
			return stageTwitterAcquisition(env, step, {
				processingId: input.processingId,
				tweetId: platformId,
			});
		case 'youtube':
			return stageYouTubeAcquisition(env, step, platformId);
		default:
			throw new NonRetryableError('Redirected resource has no supported platform');
	}
}

/** The same detection as acquisition, reading only the title a link chip shows. */
export async function resourceUrlTitle(env: CoreEnv, url: string): Promise<string | null> {
	let detected = resolveResourceUrl(url);
	if (!detected) return null;
	if (!detected.resourcePlatform && !detected.identifiers.length) {
		const page = await webPageTitle(detected.url);
		if (typeof page !== 'object' || !page) return page;
		detected = page.platform;
	}
	const platformId = detected.identifiers[0]!.value;
	const landingPageTitle = async (pageUrl: string) => {
		const page = await webPageTitle(pageUrl, false);
		return typeof page === 'string' ? page : null;
	};
	switch (detected.resourcePlatform) {
		case null:
			// OpenAlex misses many arXiv DOIs; the landing page still names the paper.
			return (await paperTitle(env.OPENALEX_API_KEY, detected.identifiers)) ?? landingPageTitle(detected.url);
		case 'hackernews':
			return hackerNewsTitle(platformId);
		case 'twitter':
			return tweetTitle(platformId);
		case 'youtube':
			return youTubeTitle(platformId, env.YOUTUBE_API_KEY);
		case 'lesswrong':
			return landingPageTitle(detected.url);
	}
}

export async function stageResourceAcquisition(env: CoreEnv, step: WorkflowStep, input: AcquisitionInput, processingId: string) {
	if (input.kind === 'storedPdf') {
		const resource = await stageStoredPdfUpload(env, step, input, processingId);
		return { resource: normalizeAcquiredResource(resource), uploadedPaper: resource.kind === 'paper' };
	}
	const resource = await stageUrlAcquisition(env, step, { ...input, processingId });
	return { resource: normalizeAcquiredResource(resource, input.sourceHints), uploadedPaper: false };
}

/** An uploaded PDF whose title page names a paper is published as that paper; any other stays its uploader's private file. */
async function stageStoredPdfUpload(
	env: CoreEnv,
	step: WorkflowStep,
	input: Extract<AcquisitionInput, { kind: 'storedPdf' }>,
	processingId: string,
) {
	const { titlePageText, resourceIdentifiers, ...file } = await stageStoredPdfAcquisition(env, step, input);
	const upload = { ...file, resourceIdentifiers: [] };
	const paper = await stagePaper(env, step, { identifiers: resourceIdentifiers, titlePageText, upload, url: null, processingId });
	return paper ?? upload;
}
