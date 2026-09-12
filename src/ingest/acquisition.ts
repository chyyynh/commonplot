import type { WorkflowStep } from 'cloudflare:workers';
import type { ResourceAcquisitionHints } from '../shared/resource';
import { stageHackerNewsAcquisition } from './platforms/hackernews';
import { stageLessWrongAcquisition } from './platforms/lesswrong';
import { stagePaperResolution } from './platforms/paper';
import { type PaidPdfFallbackGrant, stageStoredPdfAcquisition } from './platforms/pdf';
import { resolvePlatformResourceUrl } from './platforms/resource-url';
import { stageTwitterAcquisition } from './platforms/twitter-acquisition';
import { stageWebAcquisition } from './platforms/web';
import { stageYouTubeAcquisition } from './platforms/youtube';
import type { ResourceTask } from './progress';

export async function stageUrlAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		hints: ResourceAcquisitionHints;
		paidPdfFallback: PaidPdfFallbackGrant | null;
		processingId: string;
		url: string;
	},
) {
	let detected = resolvePlatformResourceUrl(new URL(input.url));
	if (!detected) {
		const web = await stageWebAcquisition(env, step, input);
		if (!('platform' in web)) {
			return stagePaperResolution(env, step, {
				resource: web,
				processingId: input.processingId,
				seedIdentifiers: [],
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
			});
		case 'lesswrong':
			return stageLessWrongAcquisition(step, detected.platformId, input.hints);
		case 'twitter':
			return stageTwitterAcquisition(env, step, {
				hints: input.hints,
				processingId: input.processingId,
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
