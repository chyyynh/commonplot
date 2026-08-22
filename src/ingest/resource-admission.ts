import type { ResourceDraftAdmission } from '@app-domain/resource-graph-contracts';
import { sha256Hex } from '@core-shared/hash';
import { CONTENT_RESOURCE_KINDS, canonicalizeOptionalResourceLang, parseResourceProviderSequence } from '@core-shared/resource-types';
import { normalizeUrl, parseExternalHttpUrl, validatedExternalMediaUrl } from '@core-shared/url';
import type { CoreDb } from '@db/connection';
import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { enqueueOrRestartWorkflow } from '../workflow-control';

const ProviderSequenceSchema = z
	.string()
	.trim()
	.min(1)
	.max(19)
	.refine((value) => parseResourceProviderSequence(value) !== null);

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
		})
		.strict(),
	z
		.object({
			kind: z.literal('userFilePaper'),
			fileResourceId: z.string().uuid(),
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
		providerSequence: ProviderSequenceSchema.optional(),
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
				})
				.strict(),
			ResourceDraftTargetSchema,
		]),
	})
	.strict();

export type ResourceProcessingWorkflowPayload = z.infer<typeof ResourceProcessingWorkflowPayloadSchema>;
type ResourceDraftTarget = Extract<ResourceProcessingWorkflowPayload['target'], { kind: 'draft' }>;

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
	/** Monotonic provider event sequence used to reject stale draft commits. */
	providerSequence?: string;
};

export type AppResourceDraftInput = Readonly<{
	instanceId: string;
	url: string;
	admission: Extract<ResourceDraftAdmission, { kind: 'profileSave' | 'container' }>;
}>;

type SourceResourceAdmissionOutcome = 'created' | 'existing';

const PENDING_BLOB_GRACE_MS = 10 * 60 * 1000;
const STORED_RESOURCE_WORKFLOW_REVISION = 'stored-resource-v9';
const SOURCE_DRAFT_WORKFLOW_REVISION = 'source-draft-v4';
const PENDING_BLOB_RECONCILE_LIMIT = 50;
const PENDING_BLOB_RECONCILE_CONCURRENCY = 10;
const DISCOVERED_RESOURCE_ADMISSION_CONCURRENCY = 5;

export async function enqueueProcessing(env: CoreEnv, resourceId: string): Promise<string> {
	const id = z.uuid().parse(resourceId);
	return enqueueOrRestartWorkflow(env.RESOURCE_PROCESSING_V2_WORKFLOW, `${STORED_RESOURCE_WORKFLOW_REVISION}-${id}`, {
		target: {
			kind: 'storedBlob',
			resourceId: id,
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
	const target = ResourceDraftTargetSchema.parse({
		kind: 'draft',
		admission: input.admission,
		url,
	});
	return enqueueOrRestartWorkflow(env.RESOURCE_PROCESSING_V2_WORKFLOW, input.instanceId, { target });
}

function sourceDraftTarget(base: SourceResourceDraft): ResourceDraftTarget {
	const originalLang = canonicalizeOptionalResourceLang(base.originalLang);
	if (base.publishedDate && !Number.isFinite(base.publishedDate.getTime())) throw new Error('Source published date is invalid');
	const publishedDate = base.publishedDate?.toISOString() ?? null;
	const parsedUrl = parseExternalHttpUrl(base.url.trim());
	if (!parsedUrl) throw new Error('Source resource URL must be external http(s)');
	const url = normalizeUrl(parsedUrl.toString());
	const summary = base.summary?.trim() || null;
	const keywords = base.keywords ?? [];
	const sourceAvatarUrl = validatedExternalMediaUrl(base.sourceAvatarUrl);
	return ResourceDraftTargetSchema.parse({
		kind: 'draft',
		admission: { kind: 'source', sourceId: base.sourceId.trim() },
		url,
		sourceHints: {
			...(summary ? { summary } : {}),
			...(originalLang ? { originalLang } : {}),
			...(publishedDate ? { publishedDate } : {}),
			...(keywords.length ? { keywords } : {}),
			...(sourceAvatarUrl ? { sourceAvatarUrl } : {}),
		},
		...(base.providerSequence?.trim() ? { providerSequence: base.providerSequence.trim() } : {}),
	});
}

export async function enqueueSubjectDraft(
	env: CoreEnv,
	input: {
		parentResourceId: string;
		url: string;
	},
): Promise<string> {
	const target = ResourceDraftTargetSchema.parse({
		kind: 'draft',
		admission: {
			kind: 'subject',
			parentResourceId: input.parentResourceId,
		},
		url: normalizeUrl(input.url),
	});
	const identity = await sha256Hex(JSON.stringify(target));
	return enqueueOrRestartWorkflow(env.RESOURCE_PROCESSING_V2_WORKFLOW, `subject-draft-v3-${identity}`, { target });
}

async function admitDiscoveredSourceResource(env: CoreEnv, draft: SourceResourceDraft): Promise<SourceResourceAdmissionOutcome> {
	const target = sourceDraftTarget(draft);
	const identity = await sha256Hex(JSON.stringify(target));
	const [created] = await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([
		{ id: `${SOURCE_DRAFT_WORKFLOW_REVISION}-${identity}`, params: { target } },
	]);
	return created ? 'created' : 'existing';
}

export async function admitDiscoveredSourceResources(
	env: CoreEnv,
	drafts: SourceResourceDraft[],
): Promise<Array<PromiseSettledResult<SourceResourceAdmissionOutcome>>> {
	if (!drafts.length) return [];
	const outcomes: Array<PromiseSettledResult<SourceResourceAdmissionOutcome>> = [];
	for (let offset = 0; offset < drafts.length; offset += DISCOVERED_RESOURCE_ADMISSION_CONCURRENCY) {
		const batch = drafts.slice(offset, offset + DISCOVERED_RESOURCE_ADMISSION_CONCURRENCY);
		outcomes.push(...(await Promise.allSettled(batch.map((draft) => admitDiscoveredSourceResource(env, draft)))));
	}
	return outcomes;
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
			  AND ${inArray(sql`kind`, CONTENT_RESOURCE_KINDS)}
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
	const id = z.uuid().parse(resourceId);
	const instance = await env.RESOURCE_PROCESSING_V2_WORKFLOW.create({
		id: `resource-resync-v3-${id}-${crypto.randomUUID()}`,
		params: { target: { kind: 'reacquire', resourceId: id } },
	});
	return instance.id;
}
