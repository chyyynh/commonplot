import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { connectCoreDb } from '../shared/db';
import { sha256Hex } from '../shared/hash';
import { resourceImageSourceUrls } from '../shared/image-mapping';
import { canonicalizeOptionalResourceLang } from '../shared/resource';
import { stageStoredResourceAcquisition, stageUrlAcquisition } from './acquisition';
import { analyzeResource, classifyResource } from './analysis';
import { stageResourceImages } from './image-rehosting';
import { withoutPrivatePdfImages } from './pdf-markdown.ts';
import { LLAMA_PARSE_MAX_PAGES } from './platforms/pdf-fallback-policy';
import { createResourceTask, enqueueSearchProgress, registerResourceTask, type ResourceTask } from './progress';
import {
	persistResolvedResource,
	persistResourceClassification,
	publishPublicPdfCrops,
	prepareResolvedResource,
	type ResourceDraftRelation,
	type ResourcePersistenceTarget,
} from './resource-persistence';
import { enqueueResourceReferenceEnrichment } from './resource-references';
import { shouldEnqueueResourceTranslation } from './translation-policy';
import { enqueueResourceTranslation } from './translation-workflow';

const ResourceDraftRelationSchema: z.ZodType<ResourceDraftRelation> = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('source'), sourceId: z.uuid() }),
	z.strictObject({ kind: z.literal('subject'), parentResourceId: z.uuid(), parentAcquisitionRevision: z.hash('md5') }),
]);

const PaidPdfFallbackGrantSchema = z.strictObject({ maxPages: z.int().min(1).max(LLAMA_PARSE_MAX_PAGES) });

export const ResourceDraftTargetSchema = z.strictObject({
	kind: z.literal('draft'),
	progress: z.boolean().optional(),
	paidPdfFallback: PaidPdfFallbackGrantSchema.optional(),
	relation: ResourceDraftRelationSchema.optional(),
	saveTarget: z.record(z.string(), z.json()).optional(),
	url: z
		.url({ normalize: true, protocol: /^https?$/ })
		.max(2_048)
		.refine((value) => {
			const url = URL.parse(value);
			return url !== null && !url.username && !url.password;
		}, 'URL credentials are not allowed'),
	sourceHints: z
		.strictObject({
			summary: z.string().max(20_000).optional(),
			originalLang: z.string().trim().min(1).max(35).optional(),
			publishedDate: z.iso.datetime().optional(),
			keywords: z.array(z.string().max(500)).max(100).optional(),
		})
		.optional(),
});

export type ResourceDraftTarget = z.infer<typeof ResourceDraftTargetSchema>;

export type SourceResourceDraft = {
	sourceId: string;
	url: string;
	publishedDate: Date | null;
	summary: string | null;
	originalLang?: string;
	keywords?: string[];
};

/** Crosses the discovery -> Resource Workflow boundary for every monitor. */
export async function enqueueSourceDrafts(env: CoreEnv, db: NodePgDatabase, drafts: SourceResourceDraft[]): Promise<number> {
	const targets = drafts.map((draft) => {
		const originalLang = canonicalizeOptionalResourceLang(draft.originalLang);
		if (draft.publishedDate && !Number.isFinite(draft.publishedDate.getTime())) throw new Error('Source published date is invalid');
		const summary = draft.summary?.trim() || null;
		return {
			kind: 'draft',
			relation: { kind: 'source', sourceId: z.uuid().parse(draft.sourceId.trim()) },
			url: ResourceDraftTargetSchema.shape.url.parse(draft.url),
			sourceHints: {
				...(summary ? { summary } : {}),
				...(originalLang ? { originalLang } : {}),
				...(draft.publishedDate ? { publishedDate: draft.publishedDate.toISOString() } : {}),
				...(draft.keywords?.length ? { keywords: draft.keywords } : {}),
			},
		} satisfies ResourceDraftTarget;
	});
	if (!targets.length) return 0;
	const urls = targets.map(({ url }) => url);
	const known = await db.execute<{ normalized_url: string | null; url: string | null }>(sql`
		SELECT resource.url, resource.normalized_url
		FROM resources resource
		WHERE resource.scope = 'corpus'
		  AND resource.source_id IS NOT NULL
		  AND (${inArray(sql`resource.url`, urls)} OR ${inArray(sql`resource.normalized_url`, urls)})
	`);
	const knownUrls = new Set(known.rows.flatMap(({ normalized_url, url }) => [url, normalized_url]).filter((url) => url !== null));
	const instances = await Promise.all(
		targets
			.filter(({ url }) => !knownUrls.has(url))
			.map(async (target) => ({
				id: `source-draft-v7-${await sha256Hex(`${target.relation.sourceId}:${target.url}`)}`,
				params: target,
				retention: { successRetention: '5 minutes', errorRetention: '1 hour' } as const,
			})),
	);
	let created = 0;
	for (let offset = 0; offset < instances.length; offset += 100) {
		created += (await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch(instances.slice(offset, offset + 100))).length;
	}
	return created;
}

export const StoredResourceTargetSchema = z.strictObject({
	kind: z.enum(['storedBlob', 'reacquire']),
	paidPdfFallback: PaidPdfFallbackGrantSchema.optional(),
	resourceId: z.uuid(),
});

const ResourceProcessingTargetSchema = z.discriminatedUnion('kind', [StoredResourceTargetSchema, ResourceDraftTargetSchema]);

type ResourceProcessingTarget = z.infer<typeof ResourceProcessingTargetSchema>;

async function loadResourceReacquisitionUrl(db: NodePgDatabase, resourceId: string) {
	const result = await db.execute<{ url: string | null }>(sql`
		SELECT url FROM resources WHERE id = ${resourceId}::uuid LIMIT 1
	`);
	const row = result.rows[0];
	if (!row) throw new NonRetryableError(`Failed to fetch resource ${resourceId}: not found`);
	const url = row.url ? URL.parse(row.url) : null;
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
		throw new NonRetryableError(`Resource ${resourceId} has no valid external HTTP URL and cannot be reacquired`);
	}
	return url.toString();
}

async function resolveProcessingResource(env: CoreEnv, step: WorkflowStep, target: ResourceProcessingTarget, task: ResourceTask) {
	if (target.kind === 'draft') {
		return stageUrlAcquisition(env, step, {
			hints: {
				originalLang: target.sourceHints?.originalLang ?? null,
				publishedDate: target.sourceHints?.publishedDate ?? null,
				summary: target.sourceHints?.summary ?? null,
			},
			paidPdfFallback: target.paidPdfFallback ?? null,
			processingId: task.taskId,
			url: target.url,
		});
	}

	if (target.kind === 'storedBlob') {
		return stageStoredResourceAcquisition(env, step, target, task);
	}

	const url = await step.do(
		'load-resource-reacquisition-url-v2',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		async () => loadResourceReacquisitionUrl(await connectCoreDb(env), target.resourceId),
	);
	return stageUrlAcquisition(env, step, {
		hints: { originalLang: null, publishedDate: null, summary: null },
		paidPdfFallback: target.paidPdfFallback ?? null,
		processingId: target.resourceId,
		url,
	});
}

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceProcessingTarget> {
	async run(event: WorkflowEvent<ResourceProcessingTarget>, step: WorkflowStep) {
		const target = ResourceProcessingTargetSchema.parse(event.payload);
		const required =
			target.kind === 'storedBlob' || (target.kind === 'draft' && target.relation?.kind !== 'source' && target.progress !== false);
		const task = createResourceTask(this.env, step, event.instanceId, required);
		let publishedResourceId: string | undefined;
		try {
			if (target.kind === 'storedBlob') {
				const current = await step.do('start-owned-pdf-attempt-v1', () =>
					this.env.APP.verifyStoredBlobProcessing(target.resourceId, event.instanceId),
				);
				if (!current) {
					await task.report('superseded', { stage: 'acquiring', status: 'superseded' });
					return { resourceId: target.resourceId };
				}
			}
			if (!(await task.start(target.kind === 'storedBlob' ? 'parsing' : 'acquiring')))
				return target.kind === 'draft' ? {} : { resourceId: target.resourceId };
			const processingId = target.kind === 'draft' ? event.instanceId : target.resourceId;
			const resource = await resolveProcessingResource(this.env, step, target, task);
			const uploadedPaper = target.kind === 'storedBlob' && resource.kind === 'paper';
			const ownedBlobId = target.kind === 'storedBlob' ? target.resourceId : undefined;
			const persistenceTarget: ResourcePersistenceTarget =
				target.kind === 'draft'
					? { kind: 'draft', ...(target.relation ? { relation: target.relation } : {}) }
					: uploadedPaper
						? { kind: 'draft', preservePublishedPdf: true, ownedBlobId }
						: { kind: 'existing', resourceId: target.resourceId, ...(ownedBlobId ? { ownedBlobId } : {}) };
			const saveTarget =
				target.kind === 'draft'
					? (target.saveTarget ?? null)
					: target.kind === 'storedBlob'
						? ({ kind: 'userFileResult', fileResourceId: target.resourceId, workflowId: event.instanceId } as const)
						: null;

			console.info({
				tag: 'WORKFLOW',
				msg: 'Starting',
				resourceKind: resource.kind,
				resourcePlatform: resource.resourcePlatform,
				processing_id: processingId,
				target_kind: target.kind,
			});
			await task.report('analysis', { stage: 'analyzing', status: 'running' });
			const imageSources = resourceImageSourceUrls({ ...resource, ogImageUrl: resource.previewImageUrl });
			const [analysis, hostedImages] = await Promise.all([
				step.do(
					'summarize-resource-v1',
					{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
					() => analyzeResource(resource, target.kind === 'draft' ? (target.sourceHints?.keywords ?? []) : [], this.env, processingId),
				),
				stageResourceImages(this.env, step, processingId, imageSources, target.kind === 'reacquire' ? event.instanceId : undefined),
			]);
			await task.report('persisting', { stage: 'persisting', status: 'running' });
			let privateTranslation: { resourceId: string; translationRevision: string } | undefined;
			const classificationTargets: Parameters<typeof persistResourceClassification>[1][] = [];
			if (uploadedPaper) {
				const privateRendition = prepareResolvedResource(
					{ ...resource, kind: 'file', kindMetadata: null, resourcePlatform: null, resourceIdentifiers: [], url: null, subject: null },
					analysis,
					hostedImages,
				);
				const privatePersistence = await step.do(
					'persist-private-pdf-rendition-v1',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					async () =>
						persistResolvedResource(await connectCoreDb(this.env), privateRendition, {
							kind: 'existing',
							resourceId: target.resourceId,
							ownedBlobId,
						}),
				);
				if (shouldEnqueueResourceTranslation({ ...privateRendition, scope: 'private' })) privateTranslation = privatePersistence;
				classificationTargets.push(privatePersistence);
			}
			const preparedResource = prepareResolvedResource(
				uploadedPaper ? { ...resource, content: withoutPrivatePdfImages(resource.content) } : resource,
				analysis,
				hostedImages,
			);
			const persistence = await step.do(
				'persist-resolved-resource-scope-v4',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				async () => {
					const startedAt = Date.now();
					const db = await connectCoreDb(this.env);
					const connectedAt = Date.now();
					const result = await persistResolvedResource(db, preparedResource, persistenceTarget);
					const completedAt = Date.now();
					console.info('resource-persistence-timing', {
						instanceId: event.instanceId,
						resourceId: result.resourceId,
						connectMs: connectedAt - startedAt,
						transactionMs: completedAt - connectedAt,
						totalMs: completedAt - startedAt,
					});
					return result;
				},
			);
			const { resourceId: persistedResourceId, scope, subjectAttached, translationRevision, acquisitionRevision } = persistence;
			if (persistence.originalWritten) classificationTargets.push(persistence);
			// Overwritten originals have no retained translations, even when their text is unchanged.
			const forceProcessingRunKey = (await sha256Hex(event.instanceId)).slice(0, 16);
			if (scope === 'corpus' && preparedResource.fileType === 'application/pdf') {
				await step.do(
					'publish-public-pdf-crops-v1',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					async () => publishPublicPdfCrops(await connectCoreDb(this.env), this.env, persistedResourceId),
				);
			}

			if (saveTarget)
				await step.do(
					'complete-resource-save-v2',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					() => this.env.APP.completeResourceSave(persistedResourceId, saveTarget),
				);
			publishedResourceId = persistedResourceId;
			await task.report('ready', {
				stage: 'persisting',
				status: 'complete',
				resourceId: persistedResourceId,
			});
			const subject = resource.subject;
			// Only uploaded PDF references require the app's completed profile attachment.
			// Let every independent handoff finish its retries before reporting failures.
			const [references, index, ...followups] = await Promise.allSettled([
				uploadedPaper
					? step.do(
							'enqueue-resource-reference-enrichment-v4',
							{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
							() => enqueueResourceReferenceEnrichment(this.env, persistedResourceId, translationRevision, target.resourceId, task),
						)
					: undefined,
				(async () => {
					try {
						const classification = await step.do(
							'classify-published-resource-v1',
							{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
							() =>
								classifyResource({ ...resource, originalLang: analysis.originalLang, summary: analysis.summary }, this.env, processingId),
						);
						if (analysis.keywords.length) classification.keywords = analysis.keywords;
						await step.do(
							'persist-resource-classification-v1',
							{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
							async () => {
								const db = await connectCoreDb(this.env);
								for (const target of classificationTargets) await persistResourceClassification(db, target, classification);
							},
						);
					} finally {
						// Even failed classification leaves the published title/body searchable.
						if (scope === 'corpus')
							await step.do(
								'enqueue-resolved-ai-search-sync-v2',
								{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
								() => enqueueSearchProgress(this.env, persistedResourceId, task, translationRevision),
							);
					}
				})(),
				privateTranslation
					? step.do(
							'enqueue-private-pdf-translation-v2',
							{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
							() =>
								enqueueResourceTranslation(
									this.env,
									privateTranslation!.resourceId,
									privateTranslation!.translationRevision,
									forceProcessingRunKey,
									task,
								),
						)
					: undefined,
				shouldEnqueueResourceTranslation({ ...preparedResource, scope })
					? step.do(
							'enqueue-resource-translation-v4',
							{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
							() =>
								enqueueResourceTranslation(
									this.env,
									persistedResourceId,
									translationRevision,
									persistence.originalWritten ? forceProcessingRunKey : undefined,
									task,
								),
						)
					: undefined,
				subject && !subjectAttached
					? step.do(
							'enqueue-resolved-subject-child-v2',
							{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
							async () => {
								const subjectTarget = ResourceDraftTargetSchema.parse({
									kind: 'draft',
									relation: { kind: 'subject', parentResourceId: persistedResourceId, parentAcquisitionRevision: acquisitionRevision },
									// Carrier-resolved hints only; the subject page still wins when it states its own date.
									...(subject.publishedDate ? { sourceHints: { publishedDate: subject.publishedDate } } : {}),
									url: subject.normalizedUrl,
								});
								// User subjects keep their existing IDs. Automatic subjects own
								// a separate execution: a simultaneous first import may acquire
								// twice, but cannot inherit an untracked task. Canonical identity
								// and the downstream shared translation ID remain unchanged.
								const prefix = task.required ? 'subject-draft-v4' : 'subject-draft-auto-v1';
								const id = `${prefix}-${await sha256Hex(JSON.stringify(subjectTarget))}`;
								await registerResourceTask(this.env, { taskId: id, kind: 'processing' }, task);
								await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([{ id, params: { ...subjectTarget, progress: task.required } }]);
								return id;
							},
						)
					: undefined,
			]);
			for (const outcome of [references, index]) {
				if (outcome.status === 'rejected')
					console.error({ tag: 'WORKFLOW', msg: 'Background handoff failed', resource_id: persistedResourceId, error: outcome.reason });
			}
			const failures = followups.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
			await task.seal(failures.length ? 'followup_dispatch_failed' : undefined);
			if (failures.length) throw new AggregateError(failures, 'Resource persisted, but one or more follow-ups failed');

			console.info({ tag: 'WORKFLOW', msg: 'Completed', resource_id: persistedResourceId, target_kind: target.kind });
			return { resourceId: persistedResourceId };
		} catch (error) {
			await task.report('outcome-after-error', {
				status: publishedResourceId ? 'complete' : 'failed',
				...(publishedResourceId ? { resourceId: publishedResourceId } : { errorCode: 'processing_failed' }),
			});
			if (publishedResourceId) await task.seal('followup_dispatch_failed');
			throw error;
		}
	}
}
