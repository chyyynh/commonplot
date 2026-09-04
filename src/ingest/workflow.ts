import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { connectCoreDb } from '../shared/db';
import { sha256Hex } from '../shared/hash';
import { resourceImageSourceUrls } from '../shared/image-mapping';
import { normalizePaperIdentifiers, type PaperIdentifier } from '../shared/paper-identity';
import {
	canonicalizeOptionalResourceLang,
	canonicalizeResourceLang,
	isPaperIdentifier,
	ResourceIdentifiersSchema,
} from '../shared/resource';
import { type ProcessingResource, stageStoredResourceAcquisition, stageUrlAcquisition } from './acquisition';
import { analyzeResource } from './analysis';
import { stageResourceImages } from './image-rehosting';
import { LLAMA_PARSE_MAX_PAGES } from './platforms/pdf-fallback-policy';
import {
	persistResolvedResource,
	prepareResolvedResource,
	type ResourceDraftRelation,
	type ResourcePersistenceTarget,
} from './resource-persistence';
import { enqueueResourceReferenceEnrichment } from './resource-reference-workflow';
import { shouldEnqueueResourceTranslation } from './translation-policy';
import { enqueueResourceTranslation } from './translation-workflow';

const ResourceDraftRelationSchema: z.ZodType<ResourceDraftRelation> = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('source'), sourceId: z.uuid() }),
	z.strictObject({ kind: z.literal('subject'), parentResourceId: z.uuid() }),
]);

const PaidPdfFallbackGrantSchema = z.strictObject({ maxPages: z.int().min(1).max(LLAMA_PARSE_MAX_PAGES) });

export const ResourceDraftTargetSchema = z.strictObject({
	kind: z.literal('draft'),
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
		  AND resource.enrichment_status = 'enriched'
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

const ResourceProcessingTargetSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('storedBlob'),
		paidPdfFallback: PaidPdfFallbackGrantSchema.optional(),
		resourceId: z.uuid(),
	}),
	z.strictObject({
		kind: z.literal('reacquire'),
		paidPdfFallback: PaidPdfFallbackGrantSchema.optional(),
		resourceId: z.uuid(),
	}),
	ResourceDraftTargetSchema,
]);

type ResourceProcessingTarget = z.infer<typeof ResourceProcessingTargetSchema>;

type ResolvedProcessingCall = {
	keywordHints: readonly string[];
	resource: ProcessingResource;
	persistenceTarget: ResourcePersistenceTarget;
	processingId: string;
	saveTarget: ResourceDraftTarget['saveTarget'] | null;
};

type ResourceReacquisitionInput = {
	originalLang: string;
	paperIdentifiers: PaperIdentifier[];
	publishedDate: string | null;
	summary: string | null;
	url: string;
};

type ResourceReacquisitionRow = {
	original_lang: string;
	published_date: Date | string | null;
	resource_identifiers: unknown;
	summary: string | null;
	url: string | null;
};

async function loadResourceReacquisitionInput(db: NodePgDatabase, resourceId: string): Promise<ResourceReacquisitionInput> {
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
	if (!row) throw new Error(`Failed to fetch resource ${resourceId}: not found`);
	const url = row.url ? URL.parse(row.url) : null;
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
		throw new Error(`Resource ${resourceId} has no valid external HTTP URL and cannot be reacquired`);
	}
	const publishedDate = row.published_date instanceof Date ? row.published_date : row.published_date ? new Date(row.published_date) : null;
	if (publishedDate && !Number.isFinite(publishedDate.getTime())) throw new Error('Invalid published_date: expected date');
	return {
		originalLang: canonicalizeResourceLang(row.original_lang),
		paperIdentifiers: normalizePaperIdentifiers(ResourceIdentifiersSchema.parse(row.resource_identifiers ?? []).filter(isPaperIdentifier)),
		publishedDate: publishedDate?.toISOString() ?? null,
		summary: row.summary,
		url: url.toString(),
	};
}

async function resolveProcessingCall(
	env: CoreEnv,
	step: WorkflowStep,
	target: ResourceProcessingTarget,
	instanceId: string,
): Promise<ResolvedProcessingCall> {
	if (target.kind === 'draft') {
		return {
			keywordHints: target.sourceHints?.keywords ?? [],
			processingId: instanceId,
			resource: await stageUrlAcquisition(env, step, {
				hints: {
					originalLang: target.sourceHints?.originalLang ?? null,
					publishedDate: target.sourceHints?.publishedDate ?? null,
					summary: target.sourceHints?.summary ?? null,
				},
				allowCitoidLookup: target.relation?.kind !== 'source',
				paidPdfFallback: target.paidPdfFallback ?? null,
				processingId: instanceId,
				url: target.url,
			}),
			persistenceTarget: {
				kind: 'draft',
				...(target.relation ? { relation: target.relation } : {}),
			},
			saveTarget: target.saveTarget ?? null,
		};
	}

	if (target.kind === 'storedBlob') {
		const resource = await stageStoredResourceAcquisition(env, step, {
			paidPdfFallback: target.paidPdfFallback ?? null,
			resourceId: target.resourceId,
		});
		const resolvedPaper = resource.kind === 'paper';
		return {
			keywordHints: [],
			processingId: target.resourceId,
			resource,
			persistenceTarget: resolvedPaper ? { kind: 'draft' } : { kind: 'existing', resourceId: target.resourceId },
			saveTarget: resolvedPaper ? { kind: 'userFilePaper', fileResourceId: target.resourceId } : null,
		};
	}

	const snapshot = await step.do(
		'load-resource-reacquisition-input-v1',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		async () => loadResourceReacquisitionInput(await connectCoreDb(env), target.resourceId),
	);
	return {
		keywordHints: [],
		processingId: target.resourceId,
		resource: await stageUrlAcquisition(env, step, {
			hints: {
				originalLang: snapshot.originalLang,
				publishedDate: snapshot.publishedDate,
				summary: snapshot.summary,
			},
			allowCitoidLookup: false,
			paperIdentifiers: snapshot.paperIdentifiers,
			paidPdfFallback: target.paidPdfFallback ?? null,
			processingId: target.resourceId,
			url: snapshot.url,
		}),
		persistenceTarget: {
			kind: 'existing',
			resourceId: target.resourceId,
		},
		saveTarget: null,
	};
}

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceProcessingTarget> {
	async run(event: WorkflowEvent<ResourceProcessingTarget>, step: WorkflowStep) {
		const target = ResourceProcessingTargetSchema.parse(event.payload);
		const call = await resolveProcessingCall(this.env, step, target, event.instanceId);
		const resource = call.resource;
		const processingId = call.processingId;

		console.info({
			tag: 'WORKFLOW',
			msg: 'Starting',
			resourceKind: resource.kind,
			resourcePlatform: resource.resourcePlatform,
			processing_id: processingId,
			target_kind: target.kind,
		});
		const imageSources = resourceImageSourceUrls({
			creators: resource.creators,
			kindMetadata: resource.kindMetadata,
			ogImageUrl: resource.previewImageUrl,
		});
		const [analysis, hostedImages] = await Promise.all([
			step.do('classify-resource', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' }, () =>
				analyzeResource(resource, call.keywordHints, this.env, processingId),
			),
			stageResourceImages(this.env, step, processingId, imageSources),
		]);
		const preparedResource = prepareResolvedResource(resource, analysis, hostedImages);
		const persistence = await step.do(
			'persist-resolved-resource-scope-v2',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => persistResolvedResource(await connectCoreDb(this.env), preparedResource, call.persistenceTarget),
		);
		const { resourceId: persistedResourceId, scope, subjectAttached, translationRevision } = persistence;
		const forceProcessingRunKey = target.kind === 'reacquire' ? (await sha256Hex(event.instanceId)).slice(0, 16) : undefined;
		const saveTarget = call.saveTarget;
		if (saveTarget) {
			await step.do(
				'complete-resource-save-v1',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				async () => {
					await this.env.APP.completeResourceSave(persistedResourceId, saveTarget);
					return true;
				},
			);
		}
		const followUps: Promise<unknown>[] = [];
		if (preparedResource.kind === 'paper' && target.kind === 'storedBlob') {
			followUps.push(
				step.do(
					'enqueue-resource-reference-enrichment-v3',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					() => enqueueResourceReferenceEnrichment(this.env, persistedResourceId, translationRevision, target.resourceId),
				),
			);
		}
		if (scope === 'corpus') {
			followUps.push(
				step.do(
					'enqueue-resolved-ai-search-sync-v1',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					() => this.env.RESOURCE_SEARCH_SYNC_QUEUE.send({ resourceId: persistedResourceId }),
				),
			);
		}
		if (shouldEnqueueResourceTranslation({ ...preparedResource, scope })) {
			followUps.push(
				step.do(
					'enqueue-resource-translation-v3',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					() => enqueueResourceTranslation(this.env, persistedResourceId, translationRevision, forceProcessingRunKey),
				),
			);
		}
		const subject = resource.subject;
		if (subject && !subjectAttached) {
			followUps.push(
				step.do(
					'enqueue-resolved-subject-child-v1',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					async () => {
						const subjectTarget = ResourceDraftTargetSchema.parse({
							kind: 'draft',
							relation: { kind: 'subject', parentResourceId: persistedResourceId },
							// Carrier-resolved hints only; the subject page still wins when it states its own date.
							...(subject.publishedDate ? { sourceHints: { publishedDate: subject.publishedDate } } : {}),
							url: subject.normalizedUrl,
						});
						const id = `subject-draft-v4-${await sha256Hex(JSON.stringify(subjectTarget))}`;
						await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([{ id, params: subjectTarget }]);
						return id;
					},
				),
			);
		}
		await Promise.all(followUps);

		console.info({ tag: 'WORKFLOW', msg: 'Completed', resource_id: persistedResourceId, target_kind: target.kind });
		return { resourceId: persistedResourceId };
	}
}
