import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { stageHackerNewsAcquisition } from './platforms/hackernews';
import { stageLessWrongAcquisition } from './platforms/lesswrong';
import type { PaidPdfFallbackGrant } from './platforms/pdf-policy';
import { resolveResourceUrl } from './platforms/resource-url';
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
	let detected = resolveResourceUrl(input.url);
	if (!detected) throw new NonRetryableError('Resource URL must be HTTP(S) without credentials');
	if (!detected.resourcePlatform) {
		const web = await stageWebAcquisition(env, step, input);
		if (!('platform' in web)) {
			web.resourceIdentifiers = [...detected.identifiers, ...web.resourceIdentifiers];
			return web;
		}
		detected = web.platform;
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
			return stageYouTubeAcquisition(env, step, {
				processingId: input.processingId,
				videoId: platformId,
			});
		default:
			throw new NonRetryableError('Redirected resource has no supported platform');
	}
}
