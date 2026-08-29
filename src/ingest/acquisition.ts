import type { WorkflowStep } from 'cloudflare:workers';
import {
	canonicalPaperUrl,
	type PaperIdentifier,
	paperIdentifiersFromIdentity,
	paperIdentityFromIdentifiers,
	resolveExactPaperInput,
} from '../shared/paper-identity';
import { isPaperIdentifier } from '../shared/resource';
import { parseHackerNewsResourceUrl, stageHackerNewsAcquisition } from './platforms/hackernews';
import { parseLessWrongResourceUrl, stageLessWrongAcquisition } from './platforms/lesswrong';
import type { PdfWorkflowIdentity } from './platforms/llama-parse';
import {
	type GenericAcquiredMaterial,
	materializeGenericResource,
	type PlatformResourceUrl,
	type ResolvedResource,
	type ResolvedResourceSubject,
	type ResourceAcquisitionHints,
} from './platforms/materialize';
import { stagePaperProcessing } from './platforms/paper';
import { stageStoredPdfAcquisition } from './platforms/pdf';
import { parseTwitterResourceUrl, stageTwitterAcquisition } from './platforms/twitter-acquisition';
import { stageWebAcquisition } from './platforms/web';
import { parseYouTubeResourceUrl, stageYouTubeAcquisition, type YouTubeResourceData } from './platforms/youtube';

export type ProcessingResource = ResolvedResource & { youtube?: YouTubeResourceData };

export function resolvePlatformResourceUrl(url: URL): PlatformResourceUrl | null {
	const hostname = url.hostname.toLowerCase();
	if (hostname === 'ycombinator.com' || hostname.endsWith('.ycombinator.com')) return parseHackerNewsResourceUrl(url);
	if (hostname === 'lesswrong.com' || hostname.endsWith('.lesswrong.com')) return parseLessWrongResourceUrl(url);
	if (hostname === 'twitter.com' || hostname.endsWith('.twitter.com') || hostname === 'x.com' || hostname.endsWith('.x.com')) {
		return parseTwitterResourceUrl(url);
	}
	if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be' || hostname.endsWith('.youtu.be')) {
		return parseYouTubeResourceUrl(url);
	}
	return null;
}

const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'mc_eid', 'mc_cid'];

function resolveResourceSubject(value: string | null | undefined): ResolvedResourceSubject | null {
	const url = value?.trim() ? URL.parse(value) : null;
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;

	const platform = resolvePlatformResourceUrl(url);
	if (platform) {
		return {
			identifiers: [{ preferred: true, scheme: platform.resourcePlatform, value: platform.platformId }],
			normalizedUrl: platform.canonicalUrl,
		};
	}
	const paper = resolveExactPaperInput(url.toString());
	if (paper) return { identifiers: paperIdentifiersFromIdentity(paper.identity), normalizedUrl: paper.canonicalUrl };

	url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
	for (const parameter of TRACKING_PARAMS) url.searchParams.delete(parameter);
	url.searchParams.sort();
	return { identifiers: [], normalizedUrl: url.toString() };
}

async function resolveGenericAcquiredResource(
	env: CoreEnv,
	step: WorkflowStep,
	acquired: GenericAcquiredMaterial,
	input: {
		allowProviderPdfFallback: boolean;
		hints: ResourceAcquisitionHints;
		paperIdentifiers: readonly PaperIdentifier[];
		processingId: string;
		sourceUrl: string | null;
		allowCitoidLookup: boolean;
		workflow: PdfWorkflowIdentity;
	},
): Promise<ResolvedResource> {
	let publishedDate = input.hints.publishedDate;
	if (acquired.publishedDate?.trim()) {
		const parsed = new Date(acquired.publishedDate);
		if (!Number.isNaN(parsed.getTime())) publishedDate = parsed.toISOString();
	}

	const canonicalUrl = acquired.canonicalUrl?.trim() || input.sourceUrl;
	const paper = await stagePaperProcessing(env, step, {
		acquiredContent: acquired,
		allowProviderPdfFallback: input.allowProviderPdfFallback,
		canonicalUrl,
		processingId: input.processingId,
		publishedDate,
		seedIdentifiers: input.paperIdentifiers,
		sourceUrl: input.sourceUrl,
		allowCitoidLookup: input.allowCitoidLookup,
		workflow: input.workflow,
	});
	if (!paper.acquiredContent.markdown.trim()) {
		throw new Error(`Processing ${input.processingId} has no extractable content`);
	}
	return materializeGenericResource(paper.acquiredContent, input.hints, {
		canonicalUrl,
		publishedDate: paper.publishedDate,
		resourceIdentifiers: paper.resourceIdentifiers,
	});
}

export async function stageUrlAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		allowCitoidLookup: boolean;
		hints: ResourceAcquisitionHints;
		paperIdentifiers?: readonly PaperIdentifier[];
		processingId: string;
		url: string;
		workflow: PdfWorkflowIdentity;
	},
): Promise<ProcessingResource> {
	const parsedUrl = URL.parse(input.url);
	if (!parsedUrl) throw new Error(`Processing ${input.processingId} has an invalid URL`);
	let detected = resolvePlatformResourceUrl(parsedUrl);
	if (!detected) {
		const web = await stageWebAcquisition(
			env,
			step,
			{ processingId: input.processingId, url: input.url, workflow: input.workflow },
			resolvePlatformResourceUrl,
		);
		if (!('platform' in web)) {
			return resolveGenericAcquiredResource(env, step, web, {
				allowProviderPdfFallback: true,
				hints: input.hints,
				paperIdentifiers: input.paperIdentifiers ?? [],
				processingId: input.processingId,
				sourceUrl: input.url,
				allowCitoidLookup: input.allowCitoidLookup,
				workflow: input.workflow,
			});
		}
		detected = web.platform;
	}
	switch (detected.resourcePlatform) {
		case 'hackernews':
			return stageHackerNewsAcquisition(env, step, {
				hints: input.hints,
				itemId: detected.platformId,
				processingId: input.processingId,
				resolveSubject: resolveResourceSubject,
			});
		case 'lesswrong':
			return stageLessWrongAcquisition(step, detected.platformId, input.hints);
		case 'twitter':
			return stageTwitterAcquisition(env, step, {
				hints: input.hints,
				processingId: input.processingId,
				resolveSubject: resolveResourceSubject,
				tweetId: detected.platformId,
			});
		case 'youtube':
			return stageYouTubeAcquisition(env, step, {
				hints: input.hints,
				processingId: input.processingId,
				videoId: detected.platformId,
			});
	}
}

export async function stageStoredResourceAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	target: Readonly<{ resourceId: string }>,
	workflow: PdfWorkflowIdentity,
): Promise<ProcessingResource> {
	const acquired = await stageStoredPdfAcquisition(env, step, target);
	const resource = await resolveGenericAcquiredResource(env, step, acquired, {
		allowProviderPdfFallback: false,
		hints: {
			originalLang: acquired.originalLang,
			publishedDate: acquired.publishedDate,
			summary: acquired.summary,
		},
		paperIdentifiers: [],
		processingId: target.resourceId,
		sourceUrl: null,
		allowCitoidLookup: false,
		workflow,
	});
	if (resource.kind !== 'paper') return resource;

	const identity = paperIdentityFromIdentifiers(resource.resourceIdentifiers.filter(isPaperIdentifier));
	if (!identity) throw new Error(`Private paper processing ${target.resourceId} has no canonical identity`);
	const url = canonicalPaperUrl(identity);
	return { ...resource, url, normalizedUrl: url };
}
