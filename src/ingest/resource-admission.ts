import type { ResourceDraftAdmission } from '@app-domain/resource-graph-contracts';
import { sha256Hex } from '@core-shared/hash';
import { canonicalizeOptionalResourceLang } from '@core-shared/resource-types';
import { normalizeUrl, parseExternalHttpUrl, validatedExternalMediaUrl } from '@core-shared/url';
import type { CoreDb } from '@db/connection';
import { contentResourceIdentitySql } from '@db/resource-identity-sql';
import { cleanString, dateValue, requiredString, stringArrayValue } from '@ingest/domain/resource-values';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { enqueueOrRestartWorkflow, workflowOutputWasSuperseded } from '../workflow-control';

const ProviderRevisionSchema = z
	.string()
	.trim()
	.min(1)
	.max(80)
	.regex(/^[a-zA-Z0-9_-]+$/);

const DraftAdmissionSchema = z.discriminatedUnion('kind', [
	z
		.object({ kind: z.literal('profileSave'), userId: z.string().trim().min(1).max(255), visibility: z.enum(['public', 'private']) })
		.strict(),
	z
		.object({
			kind: z.literal('container'),
			userId: z.string().trim().min(1).max(255),
			container: z.object({ kind: z.enum(['collection', 'workspace']), id: z.string().uuid() }).strict(),
		})
		.strict(),
	z.object({ kind: z.literal('source'), sourceId: z.string().uuid() }).strict(),
	z
		.object({
			kind: z.literal('subject'),
			parentResourceId: z.string().uuid(),
			expectedParentRevision: z
				.string()
				.length(64)
				.regex(/^[0-9a-f]+$/)
				.nullable(),
		})
		.strict(),
	z
		.object({
			kind: z.literal('userFilePaper'),
			fileResourceId: z.string().uuid(),
			expectedFileRevision: z
				.string()
				.length(64)
				.regex(/^[0-9a-f]+$/)
				.nullable(),
		})
		.strict(),
]);

const ResourceDraftTargetSchema = z
	.object({
		kind: z.literal('draft'),
		admission: DraftAdmissionSchema,
		url: z.url().max(2_048),
		sourceHints: z
			.object({
				summary: z.string().max(20_000).optional(),
				originalLang: z.string().trim().min(1).max(35).optional(),
				publishedDate: z.iso.datetime().optional(),
				keywords: z.array(z.string().max(500)).max(100).optional(),
				sourceAvatarUrl: z.url().max(2_048).optional(),
			})
			.strict()
			.optional(),
		expectedProviderRevision: ProviderRevisionSchema.optional(),
	})
	.strict();

const ResourceProcessingWorkflowPayloadSchema = z
	.object({
		target: z.discriminatedUnion('kind', [
			z
				.object({
					kind: z.literal('storedBlob'),
					resourceId: z.string().uuid(),
				})
				.strict(),
			z
				.object({
					kind: z.literal('reacquire'),
					resourceId: z.string().uuid(),
					expectedProviderRevision: ProviderRevisionSchema.optional(),
				})
				.strict(),
			ResourceDraftTargetSchema,
		]),
	})
	.strict();

export type ResourceProcessingWorkflowPayload = z.infer<typeof ResourceProcessingWorkflowPayloadSchema>;
export type ResourceDraftTarget = Extract<ResourceProcessingWorkflowPayload['target'], { kind: 'draft' }>;
export type ExistingResourceTarget = Extract<ResourceProcessingWorkflowPayload['target'], { kind: 'storedBlob' | 'reacquire' }>;

export function parseResourceProcessingWorkflowPayload(value: unknown): ResourceProcessingWorkflowPayload {
	return ResourceProcessingWorkflowPayloadSchema.parse(value);
}

export type SourceResourceDraft = {
	sourceId: string;
	url: string;
	publishedDate: Date | null;
	summary: string | null;
	originalLang?: string;
	keywords?: string[];
	sourceAvatarUrl?: string | null;
	/** Provider event revision that should refresh an already-enriched Resource once. */
	refreshRevision?: string;
};

export type AppResourceDraftInput = Readonly<{
	instanceId: string;
	url: string;
	admission: Extract<ResourceDraftAdmission, { kind: 'profileSave' | 'container' }>;
}>;

export type SourceResourceAdmissionOutcome = 'created' | 'existing' | 'refreshed';

type ExistingDiscoveredResource = { id: string; url: string };

const PENDING_BLOB_GRACE_MS = 10 * 60 * 1000;
const STORED_RESOURCE_WORKFLOW_REVISION = 'stored-resource-v9';
const SOURCE_DRAFT_WORKFLOW_REVISION = 'source-draft-v3';
const PENDING_BLOB_RECONCILE_LIMIT = 50;
const PENDING_BLOB_RECONCILE_CONCURRENCY = 10;
const DISCOVERED_RESOURCE_ADMISSION_CONCURRENCY = 5;

export async function enqueueProcessing(env: CoreEnv, resourceId: string): Promise<string> {
	return enqueueOrRestartWorkflow(env.RESOURCE_PROCESSING_V2_WORKFLOW, storedWorkflowId(resourceId), {
		target: {
			kind: 'storedBlob',
			resourceId,
		},
	});
}

export async function enqueueAppResourceDraft(env: CoreEnv, input: AppResourceDraftInput): Promise<string> {
	if (!/^app-draft-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.instanceId)) {
		throw new Error('Invalid app draft Workflow ID');
	}
	const parsed = parseExternalHttpUrl(input.url);
	if (!parsed) throw new Error('Only http(s) URLs without credentials are allowed');
	const url = normalizeUrl(parsed.toString());
	const target: ResourceDraftTarget = {
		kind: 'draft',
		admission: input.admission,
		url,
	};
	const payload = parseResourceProcessingWorkflowPayload({ target });
	return enqueueOrRestartWorkflow(env.RESOURCE_PROCESSING_V2_WORKFLOW, input.instanceId, payload);
}

function sourceDraftTarget(base: SourceResourceDraft): ResourceDraftTarget {
	const originalLang = canonicalizeOptionalResourceLang(base.originalLang);
	const publishedDate = base.publishedDate === null ? null : dateValue(base.publishedDate, 'published_date').toISOString();
	const parsedUrl = parseExternalHttpUrl(requiredString(base.url, 'url'));
	if (!parsedUrl) throw new Error('Source resource URL must be external http(s)');
	const url = normalizeUrl(parsedUrl.toString());
	const summary = cleanString(base.summary);
	const keywords = stringArrayValue(base.keywords ?? [], 'keywords');
	const sourceAvatarUrl = validatedExternalMediaUrl(base.sourceAvatarUrl);
	return parseResourceProcessingWorkflowPayload({
		target: {
			kind: 'draft',
			admission: { kind: 'source', sourceId: requiredString(base.sourceId, 'source_id') },
			url,
			sourceHints: {
				...(summary ? { summary } : {}),
				...(originalLang ? { originalLang } : {}),
				...(publishedDate ? { publishedDate } : {}),
				...(keywords.length ? { keywords } : {}),
				...(sourceAvatarUrl ? { sourceAvatarUrl } : {}),
			},
			...(base.refreshRevision?.trim() ? { expectedProviderRevision: base.refreshRevision.trim() } : {}),
		},
	}).target as ResourceDraftTarget;
}

export async function enqueueSubjectDraft(
	env: CoreEnv,
	input: {
		parentResourceId: string;
		parentRevision: string | null;
		url: string;
	},
): Promise<string> {
	const target = parseResourceProcessingWorkflowPayload({
		target: {
			kind: 'draft',
			admission: {
				kind: 'subject',
				parentResourceId: input.parentResourceId,
				expectedParentRevision: input.parentRevision,
			},
			url: normalizeUrl(input.url),
		},
	}).target as ResourceDraftTarget;
	const identity = await sha256Hex(JSON.stringify(target));
	return enqueueOrRestartWorkflow(env.RESOURCE_PROCESSING_V2_WORKFLOW, `subject-draft-v3-${identity}`, { target });
}

async function claimExistingDiscoveredResources(db: CoreDb, drafts: SourceResourceDraft[]): Promise<ExistingDiscoveredResource[]> {
	const discovered = new Map<string, string>();
	for (const draft of drafts) {
		const url = normalizeUrl(draft.url);
		if (!discovered.has(url)) discovered.set(url, draft.sourceId);
	}
	if (!discovered.size) return [];

	const values = [...discovered].map(([url, sourceId]) => sql`(${url}, ${sourceId}::uuid)`);
	const result = await db.execute<ExistingDiscoveredResource>(sql`
		WITH discovered(normalized_url, source_id) AS (
			VALUES ${sql.join(values, sql`, `)}
		), attached AS (
			UPDATE resources AS resource
			SET source_id = discovered.source_id
			FROM discovered
			WHERE resource.normalized_url = discovered.normalized_url
			  AND resource.source_id IS NULL
			  AND resource.enrichment_status = 'enriched'
			  AND ${contentResourceIdentitySql({
					kind: sql`resource.kind`,
					resourcePlatform: sql`resource.resource_platform`,
				})}
			RETURNING resource.id
		)
		SELECT
			resource.id::text AS id,
			resource.normalized_url AS url
		FROM resources AS resource
		JOIN discovered ON discovered.normalized_url = resource.normalized_url
		WHERE resource.enrichment_status = 'enriched'
		  AND ${contentResourceIdentitySql({
				kind: sql`resource.kind`,
				resourcePlatform: sql`resource.resource_platform`,
			})}
	`);
	return result.rows;
}

async function admitDiscoveredSourceResource(
	env: CoreEnv,
	draft: SourceResourceDraft,
	resource: ExistingDiscoveredResource | undefined,
): Promise<SourceResourceAdmissionOutcome> {
	if (!resource) {
		const target = sourceDraftTarget(draft);
		const identity = await sha256Hex(JSON.stringify(target));
		const [created] = await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([
			{ id: `${SOURCE_DRAFT_WORKFLOW_REVISION}-${identity}`, params: { target } },
		]);
		return created ? 'created' : 'existing';
	}
	if (!draft.refreshRevision) return 'existing';
	return (await enqueueResourceRefresh(env, resource.id, draft.refreshRevision)) ? 'refreshed' : 'existing';
}

export async function admitDiscoveredSourceResources(
	env: CoreEnv,
	db: CoreDb,
	drafts: SourceResourceDraft[],
): Promise<Array<PromiseSettledResult<SourceResourceAdmissionOutcome>>> {
	if (!drafts.length) return [];
	const existing = await claimExistingDiscoveredResources(db, drafts);
	const existingByUrl = new Map(existing.map((resource) => [normalizeUrl(resource.url), resource]));
	const outcomes: Array<PromiseSettledResult<SourceResourceAdmissionOutcome>> = [];
	for (let offset = 0; offset < drafts.length; offset += DISCOVERED_RESOURCE_ADMISSION_CONCURRENCY) {
		const batch = drafts.slice(offset, offset + DISCOVERED_RESOURCE_ADMISSION_CONCURRENCY);
		outcomes.push(
			...(await Promise.allSettled(
				batch.map((draft) => admitDiscoveredSourceResource(env, draft, existingByUrl.get(normalizeUrl(draft.url)))),
			)),
		);
	}
	return outcomes;
}

async function startResourceRefreshWorkflow(env: CoreEnv, id: string, resourceId: string, revision: string): Promise<boolean> {
	const [created] = await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([
		{ id, params: { target: { kind: 'reacquire', resourceId, expectedProviderRevision: revision } } },
	]);
	if (created) return true;
	const instance = await env.RESOURCE_PROCESSING_V2_WORKFLOW.get(id);
	const { output, status } = await instance.status();
	if (status === 'errored' || (status === 'complete' && workflowOutputWasSuperseded(output))) {
		await instance.restart();
		return true;
	}
	if (status === 'unknown') throw new Error(`Resource refresh Workflow ${id} has unknown status`);
	return false;
}

async function enqueueResourceRefresh(env: CoreEnv, resourceId: string, refreshRevision: string): Promise<boolean> {
	const revision = ProviderRevisionSchema.parse(refreshRevision);
	const id = ['resource-refresh-v5', workflowIdPart(resourceId), workflowIdPart(revision)].join('-');
	return startResourceRefreshWorkflow(env, id, resourceId, revision);
}

export async function enqueueSupersededResourceRefresh(
	env: CoreEnv,
	input: {
		resourceId: string;
		refreshRevision: string;
		supersededSourceRevision: string | null;
	},
): Promise<string> {
	const revision = ProviderRevisionSchema.parse(input.refreshRevision);
	const identity = await sha256Hex(JSON.stringify([input.resourceId, revision, input.supersededSourceRevision]));
	const id = `resource-refresh-reconcile-v2-${identity}`;
	const started = await startResourceRefreshWorkflow(env, id, input.resourceId, revision);
	console.info({
		tag: 'RESOURCE_WORKFLOW',
		event: 'superseded_provider_refresh_reconciled',
		resource_id: input.resourceId,
		expected_provider_revision: revision,
		superseded_source_revision: input.supersededSourceRevision,
		workflow_id: id,
		started,
	});
	return id;
}

async function claimStalePendingBlobAdmissions(db: CoreDb, olderThan: Date, limit: number): Promise<Array<{ resourceId: string }>> {
	const claimed = await db.execute<{ resource_id: string }>(sql`
		WITH candidates AS (
			SELECT id
			FROM resources
			WHERE enrichment_status = 'pending'
			  AND scope = 'private'
			  AND storage_key IS NOT NULL
			  AND EXISTS (
			    SELECT 1
			    FROM user_files
			    WHERE user_files.resource_id = resources.id
			  )
			  AND updated_at < ${olderThan}
			  AND ${contentResourceIdentitySql({
					kind: sql`kind`,
					resourcePlatform: sql`resource_platform`,
				})}
			ORDER BY updated_at ASC, id ASC
			FOR UPDATE SKIP LOCKED
			LIMIT ${limit}
		)
		UPDATE resources AS resource
		SET updated_at = NOW()
		FROM candidates
		WHERE resource.id = candidates.id
		RETURNING resource.id::text AS resource_id
	`);
	return claimed.rows.map(({ resource_id }) => ({ resourceId: resource_id }));
}

/** Repairs only interrupted DB-to-Workflow handoffs for record-first app-owned blobs. */
export async function reconcilePendingBlobProcessing(env: CoreEnv, db: CoreDb): Promise<void> {
	const admissions = await claimStalePendingBlobAdmissions(db, new Date(Date.now() - PENDING_BLOB_GRACE_MS), PENDING_BLOB_RECONCILE_LIMIT);
	if (!admissions.length) return;

	let reconciled = 0;
	let failed = 0;
	for (let offset = 0; offset < admissions.length; offset += PENDING_BLOB_RECONCILE_CONCURRENCY) {
		const batch = admissions.slice(offset, offset + PENDING_BLOB_RECONCILE_CONCURRENCY);
		const results = await Promise.allSettled(batch.map(({ resourceId }) => enqueueProcessing(env, resourceId)));
		for (const [index, result] of results.entries()) {
			if (result.status === 'fulfilled') {
				reconciled++;
				continue;
			}
			failed++;
			console.error({
				tag: 'RESOURCE_WORKFLOW',
				event: 'pending_blob_reconciliation_failed',
				resource_id: batch[index]?.resourceId,
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
	}
	console.info({
		tag: 'RESOURCE_WORKFLOW',
		event: 'pending_blob_reconciliation_completed',
		attempted: admissions.length,
		reconciled,
		failed,
	});
}

export async function enqueueResourceResync(env: CoreEnv, resourceId: string): Promise<string> {
	const instance = await env.RESOURCE_PROCESSING_V2_WORKFLOW.create({
		id: `resource-resync-v3-${workflowIdPart(resourceId)}-${crypto.randomUUID()}`,
		params: { target: { kind: 'reacquire', resourceId } },
	});
	return instance.id;
}

function workflowIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

function storedWorkflowId(resourceId: string): string {
	return [STORED_RESOURCE_WORKFLOW_REVISION, workflowIdPart(resourceId)].join('-');
}
