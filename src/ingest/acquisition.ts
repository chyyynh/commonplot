import type { WorkflowStep } from 'cloudflare:workers';
import { type PaperIdentifier, paperIdentifiersFromIdentity, resolveExactPaperInput } from '../shared/paper-identity';
import type { PlatformResourceUrl, ResourceAcquisitionHints, ResourceSubjectIdentity } from '../shared/resource';
import { parseHackerNewsResourceUrl, stageHackerNewsAcquisition } from './platforms/hackernews';
import { parseLessWrongResourceUrl, stageLessWrongAcquisition } from './platforms/lesswrong';
import { stagePaperResolution } from './platforms/paper';
import { type PaidPdfFallbackGrant, stageStoredPdfAcquisition } from './platforms/pdf';
import { parseTwitterResourceUrl, stageTwitterAcquisition } from './platforms/twitter-acquisition';
import { canonicalizeWebResourceUrl, stageWebAcquisition } from './platforms/web';
import { parseYouTubeResourceUrl, stageYouTubeAcquisition } from './platforms/youtube';
import type { ResourceTask } from './progress';

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

function resolveResourceSubject(value: string | null | undefined): ResourceSubjectIdentity | null {
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

	return { identifiers: [], normalizedUrl: canonicalizeWebResourceUrl(url) };
}

export async function stageUrlAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		hints: ResourceAcquisitionHints;
		paperIdentifiers?: readonly PaperIdentifier[];
		paidPdfFallback: PaidPdfFallbackGrant | null;
		processingId: string;
		url: string;
	},
) {
	let detected = resolvePlatformResourceUrl(new URL(input.url));
	if (!detected) {
		const web = await stageWebAcquisition(env, step, input, resolvePlatformResourceUrl);
		if (!('platform' in web)) {
			return stagePaperResolution(env, step, {
				resource: web,
				processingId: input.processingId,
				seedIdentifiers: input.paperIdentifiers ?? [],
				sourceUrl: input.url,
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
	target: Readonly<{
		paidPdfFallback?: PaidPdfFallbackGrant;
		resourceId: string;
	}>,
	task?: ResourceTask,
) {
	const acquired = await stageStoredPdfAcquisition(env, step, target);
	if (task) await task.report('metadata', { stage: 'metadata', status: 'running' });
	return stagePaperResolution(env, step, {
		resource: acquired,
		processingId: target.resourceId,
		seedIdentifiers: [],
		sourceUrl: null,
	});
}
