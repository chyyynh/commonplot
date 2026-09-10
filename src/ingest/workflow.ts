import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { connectCoreDb } from '../shared/db';
import { sha256Hex } from '../shared/hash';
import { resourceImageSourceUrls } from '../shared/image-mapping';
import {
	canonicalizeOptionalResourceLang,
	canonicalizeResourceLang,
	isPaperIdentifier,
	ResourceIdentifiersSchema,
} from '../shared/resource';
import { stageStoredResourceAcquisition, stageUrlAcquisition } from './acquisition';
import { analyzeResource } from './analysis';
import { stageResourceImages } from './image-rehosting';
import { LLAMA_PARSE_MAX_PAGES } from './platforms/pdf-fallback-policy';
import { createResourceTask, enqueueSearchProgress, registerResourceTask, type ResourceTask } from './progress';
import {
	persistResolvedResource,
	publishPublicPdfCrops,
	prepareResolvedResource,
	type ResourceDraftRelation,
	type ResourcePersistenceTarget,
} from './resource-persistence';
import { enqueueResourceReferenceEnrichment } from './resource-references';
import { shouldEnqueueResourceTranslation } from './translation-policy';
import { enqueueResourceTranslation } from './translation-workflow';
import { withoutPrivatePdfImages } from './zotero-sdt.ts';

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

type ResourceReacquisitionRow = {
	original_lang: string;
	published_date: Date | string | null;
	resource_identifiers: unknown;
	summary: string | null;
	url: string | null;
};

async function loadResourceReacquisitionInput(db: NodePgDatabase, resourceId: string) {
	const result = await db.execute<ResourceReacquisitionRow>(sql`
		SELECT
			original.summary,
			resource.original_lang,
			(
				SELECT jsonb_agg(
					jsonb_build_object(
						'preferred', identifier.is_preferred,
						'scheme', identifier.scheme,
						'value', identifier.value
					)
					ORDER BY identifier.scheme, identifier.is_preferred DESC, identifier.value
				)
				FROM resource_identifiers identifier
				WHERE identifier.resource_id = resource.id
				  AND identifier.scheme IN ('doi', 'arxiv', 'openalex')
			) AS resource_identifiers,
			resource.url,
			resource.published_date
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		WHERE resource.id = ${resourceId}::uuid
		LIMIT 1
	`);
	const row = result.rows[0];
	if (!row) throw new NonRetryableError(`Failed to fetch resource ${resourceId}: not found`);
	const url = row.url ? URL.parse(row.url) : null;
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
		throw new NonRetryableError(`Resource ${resourceId} has no valid external HTTP URL and cannot be reacquired`);
	}
	const publishedDate = row.published_date instanceof Date ? row.published_date : row.published_date ? new Date(row.published_date) : null;
	if (publishedDate && !Number.isFinite(publishedDate.getTime())) throw new NonRetryableError('Invalid published_date: expected date');
	return {
		originalLang: canonicalizeResourceLang(row.original_lang),
		paperIdentifiers: ResourceIdentifiersSchema.parse(row.resource_identifiers ?? []).filter(isPaperIdentifier),
		publishedDate: publishedDate?.toISOString() ?? null,
		summary: row.summary,
		url: url.toString(),
	};
}

async function resolveProcessingResource(env: CoreEnv, step: WorkflowStep, target: ResourceProcessingTarget, task: ResourceTask) {
	if (target.kind === 'draft') {
		return stageUrlAcquisition(env, step, {
			hints: {
				originalLang: target.sourceHints?.originalLang ?? null,
				publishedDate: target.sourceHints?.publishedDate ?? null,
				summary: target.sourceHints?.summary ?? null,
			},
			allowCitoidLookup: target.relation?.kind !== 'source',
			paidPdfFallback: target.paidPdfFallback ?? null,
			processingId: task.taskId,
			url: target.url,
		});
	}

	if (target.kind === 'storedBlob') {
		return stageStoredResourceAcquisition(env, step, target, task);
	}

	const snapshot = await step.do(
		'load-resource-reacquisition-input-v1',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		async () => loadResourceReacquisitionInput(await connectCoreDb(env), target.resourceId),
	);
	return stageUrlAcquisition(env, step, {
		hints: snapshot,
		allowCitoidLookup: false,
		paperIdentifiers: snapshot.paperIdentifiers,
		paidPdfFallback: target.paidPdfFallback ?? null,
		processingId: target.resourceId,
		url: snapshot.url,
	});
}

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceProcessingTarget> {
	async run(event: WorkflowEvent<ResourceProcessingTarget>, step: WorkflowStep) {
		const target = ResourceProcessingTargetSchema.parse(event.payload);
		const required =
			target.kind === 'storedBlob' || (target.kind === 'draft' && target.relation?.kind !== 'source' && target.progress !== false);
		const task = createResourceTask(this.env, step, event.instanceId, required ? 'required' : 'none');
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
				step.do('analyze-resource-v2', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' }, () =>
					analyzeResource(resource, target.kind === 'draft' ? (target.sourceHints?.keywords ?? []) : [], this.env, processingId),
				),
				stageResourceImages(this.env, step, processingId, imageSources),
			]);
			await task.report('persisting', { stage: 'persisting', status: 'running' });
			let privateTranslation: { resourceId: string; translationRevision: string } | undefined;
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
			}
			const preparedResource = prepareResolvedResource(
				uploadedPaper ? { ...resource, content: withoutPrivatePdfImages(resource.content) } : resource,
				analysis,
				hostedImages,
			);
			const persistence = await step.do(
				'persist-resolved-resource-scope-v4',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				async () => persistResolvedResource(await connectCoreDb(this.env), preparedResource, persistenceTarget),
			);
			const { resourceId: persistedResourceId, scope, subjectAttached, translationRevision, acquisitionRevision } = persistence;
			const forceProcessingRunKey = target.kind === 'reacquire' ? (await sha256Hex(event.instanceId)).slice(0, 16) : undefined;
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
			const followups = await Promise.allSettled([
				uploadedPaper
					? step.do(
							'enqueue-resource-reference-enrichment-v4',
							{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
							() => enqueueResourceReferenceEnrichment(this.env, persistedResourceId, translationRevision, target.resourceId, task),
						)
					: undefined,
				scope === 'corpus'
					? step.do(
							'enqueue-resolved-ai-search-sync-v2',
							{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
							() => enqueueSearchProgress(this.env, persistedResourceId, task, translationRevision),
						)
					: undefined,
				privateTranslation
					? step.do(
							'enqueue-private-pdf-translation-v2',
							{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
							() =>
								enqueueResourceTranslation(
									this.env,
									privateTranslation!.resourceId,
									privateTranslation!.translationRevision,
									undefined,
									task,
								),
						)
					: undefined,
				shouldEnqueueResourceTranslation({ ...preparedResource, scope })
					? step.do(
							'enqueue-resource-translation-v4',
							{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
							() => enqueueResourceTranslation(this.env, persistedResourceId, translationRevision, forceProcessingRunKey, task),
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
