import type { WorkflowStep } from 'cloudflare:workers';
import { stageHackerNewsAcquisition } from './platforms/hackernews';
import { stageLessWrongAcquisition } from './platforms/lesswrong';
import type { PaidPdfFallbackGrant } from './platforms/pdf-fallback-policy';
import { resolvePlatformResourceUrl } from './platforms/resource-url';
import { stageTwitterAcquisition } from './platforms/twitter-acquisition';
import { stageWebAcquisition } from './platforms/web';
import { stageYouTubeAcquisition } from './platforms/youtube';

export async function stageUrlAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		paidPdfFallback: PaidPdfFallbackGrant | null;
		processingId: string;
		url: string;
	},
) {
	let detected = resolvePlatformResourceUrl(new URL(input.url));
	if (!detected) {
		const web = await stageWebAcquisition(env, step, input);
		if (!('platform' in web)) return web;
		detected = web.platform;
	}
	switch (detected.resourcePlatform) {
		case 'hackernews':
			return stageHackerNewsAcquisition(env, step, {
				itemId: detected.platformId,
				processingId: input.processingId,
			});
		case 'lesswrong':
			return stageLessWrongAcquisition(step, detected.platformId);
		case 'twitter':
			return stageTwitterAcquisition(env, step, {
				processingId: input.processingId,
				tweetId: detected.platformId,
			});
		case 'youtube':
			return stageYouTubeAcquisition(env, step, {
				processingId: input.processingId,
				videoId: detected.platformId,
			});
	}
}
