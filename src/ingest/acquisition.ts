import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { sql } from 'drizzle-orm';
import { connectCoreDb } from '../shared/db';
import type { ResourceCreator, ResourceIdentifier, ResourceKind, ResourceKindMetadata, ResourcePlatform } from '../shared/resource';
import type { ResourceProcessingTarget } from './admission';
import { stageHackerNewsAcquisition } from './platforms/hackernews';
import { stageLessWrongAcquisition } from './platforms/lesswrong';
import { stagePaperResolution } from './platforms/paper';
import { stageStoredPdfAcquisition } from './platforms/pdf';
import type { PaidPdfFallbackGrant } from './platforms/pdf-policy';
import { resolveResourceUrl } from './platforms/resource-url';
import { stageTwitterAcquisition } from './platforms/twitter-acquisition';
import { stageWebAcquisition } from './platforms/web';
import { stageYouTubeAcquisition } from './platforms/youtube';
import type { ResourceTask } from './progress';
import { canonicalizeOptionalResourceLang } from './resource-language';

// Adapters share an output contract; each adapter owns its mapping and identity.
export type AcquiredResource = {
	citations?: { references: readonly { key: string; label: string | null; text: string }[] } | null;
	kind: Exclude<ResourceKind, 'image'>;
	resourcePlatform: ResourcePlatform | null;
	resourceIdentifiers: ResourceIdentifier[];
	url: string | null;
	title: string;
	summary: string | null;
	content: string;
	source: string;
	originalLang: string;
	publishedDate: string | null;
	creators: ResourceCreator[];
	kindMetadata: ResourceKindMetadata;
	fileType: string | null;
	previewImageUrl: string | null;
	subject: { identifiers: ResourceIdentifier[]; normalizedUrl: string } | null;
};

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

export async function stageResourceAcquisition(env: CoreEnv, step: WorkflowStep, target: ResourceProcessingTarget, task: ResourceTask) {
	const processingId = target.kind === 'draft' ? task.taskId : target.resourceId;
	const url =
		target.kind === 'reacquire'
			? await step.do(
					'load-resource-reacquisition-url-v2',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					async () => {
						const db = await connectCoreDb(env);
						const { rows } = await db.execute<{ url: string | null }>(sql`SELECT url FROM resources WHERE id = ${target.resourceId}::uuid`);
						if (!rows[0]) throw new NonRetryableError(`Failed to fetch resource ${target.resourceId}: not found`);
						const url = resolveResourceUrl(rows[0].url)?.url;
						if (!url) throw new NonRetryableError(`Resource ${target.resourceId} has no valid external HTTP URL and cannot be reacquired`);
						return url;
					},
				)
			: target.kind === 'draft'
				? target.url
				: null;
	const acquired =
		target.kind === 'storedBlob'
			? await stageStoredPdfAcquisition(env, step, target)
			: await stageUrlAcquisition(env, step, { paidPdfFallback: target.paidPdfFallback ?? null, processingId, url: url! });
	const source = target.kind === 'draft' ? target.sourceHints : undefined;
	const parsedDate = Date.parse(acquired.publishedDate ?? '');
	const publishedDate = Number.isNaN(parsedDate) ? (source?.publishedDate ?? null) : new Date(parsedDate).toISOString();
	const resource = {
		...acquired,
		originalLang:
			canonicalizeOptionalResourceLang(acquired.originalLang) ?? canonicalizeOptionalResourceLang(source?.originalLang) ?? 'und',
		publishedDate,
		summary: acquired.summary?.trim() || source?.summary?.trim() || null,
	};
	if (resource.resourcePlatform !== null) return resource;
	if (target.kind === 'storedBlob') await task.report('metadata', { stage: 'metadata', status: 'running' });
	return stagePaperResolution(env, step, {
		resource,
		processingId,
	});
}
