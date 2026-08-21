import type { ResourceDraftAdmission } from '@app-domain/resource-graph-contracts';
import { sha256Hex } from '@core-shared/hash';
import { canonicalizeOptionalResourceLang, DEFAULT_RESOURCE_LANG } from '@core-shared/resource-types';
import { normalizeUrl, parseExternalHttpUrl } from '@core-shared/url';
import { withCoreDb } from '@db/client';
import { claimExistingDiscoveredResources, claimStalePendingBlobAdmissions } from '@ingest/domain/resource-admission-store';
import { cleanString, dateValue, requiredString, stringArrayValue } from '@ingest/domain/resource-values';
import { z } from 'zod';
import { enqueueOrRestartWorkflow } from '../workflow-control';

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
		title: z.string().trim().min(1).max(5_000),
		summary: z.string().max(20_000).nullable(),
		originalLang: z.string().trim().min(1).max(35),
		publishedDate: z.iso.datetime().nullable(),
		keywords: z.array(z.string().max(500)).max(100),
		expectedProviderRevision: ProviderRevisionSchema.optional(),
	})
	.strict();

const ResourceProcessingWorkflowPayloadSchema = z
	.object({
		target: z.discriminatedUnion('kind', [
			z
				.object({
					kind: z.literal('stored'),
					resourceId: z.string().uuid(),
					operation: z.enum(['blob', 'reacquire']),
					expectedProviderRevision: ProviderRevisionSchema.optional(),
				})
				.strict(),
			ResourceDraftTargetSchema,
		]),
	})
	.strict();

export type ResourceProcessingWorkflowPayload = z.infer<typeof ResourceProcessingWorkflowPayloadSchema>;
export type ResourceDraftTarget = Extract<ResourceProcessingWorkflowPayload['target'], { kind: 'draft' }>;
export type StoredResourceTarget = Extract<ResourceProcessingWorkflowPayload['target'], { kind: 'stored' }>;

export function parseResourceProcessingWorkflowPayload(value: unknown): ResourceProcessingWorkflowPayload {
	return ResourceProcessingWorkflowPayloadSchema.parse(value);
}

export type SourceResourceDraft = {
	sourceId: string;
	url: string;
	title: string;
	publishedDate: Date | null;
	summary: string | null;
	originalLang?: string;
	keywords?: string[];
	/** Provider event revision that should refresh an already-enriched Resource once. */
	refreshRevision?: string;
};

export type AppResourceDraftInput = Readonly<{
	instanceId: string;
	url: string;
	admission: Extract<ResourceDraftAdmission, { kind: 'profileSave' | 'container' }>;
}>;

export type SourceResourceAdmissionOutcome = 'created' | 'existing' | 'refreshed';

type ExistingDiscoveredResource = Awaited<ReturnType<typeof claimExistingDiscoveredResources>>[number];

const PENDING_BLOB_GRACE_MS = 10 * 60 * 1000;
const STORED_RESOURCE_WORKFLOW_REVISION = 'stored-resource-v8';
const SOURCE_DRAFT_WORKFLOW_REVISION = 'source-draft-v2';
const PENDING_BLOB_RECONCILE_LIMIT = 50;
const PENDING_BLOB_RECONCILE_CONCURRENCY = 10;
const DISCOVERED_RESOURCE_ADMISSION_CONCURRENCY = 5;

export async function enqueueProcessing(env: CoreEnv, resourceId: string): Promise<string> {
	return enqueueOrRestartWorkflow(env.RESOURCE_PROCESSING_V2_WORKFLOW, storedWorkflowId(resourceId), {
		target: {
			kind: 'stored',
			resourceId,
			operation: 'blob',
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
		title: new URL(url).hostname.replace(/^www\./, ''),
		summary: null,
		originalLang: DEFAULT_RESOURCE_LANG,
		publishedDate: null,
		keywords: [],
	};
	const payload = parseResourceProcessingWorkflowPayload({ target });
	return enqueueOrRestartWorkflow(env.RESOURCE_PROCESSING_V2_WORKFLOW, input.instanceId, payload);
}

function sourceDraftTarget(base: SourceResourceDraft): ResourceDraftTarget {
	const originalLang = canonicalizeOptionalResourceLang(base.originalLang) ?? DEFAULT_RESOURCE_LANG;
	const publishedDate = base.publishedDate === null ? null : dateValue(base.publishedDate, 'published_date').toISOString();
	const parsedUrl = parseExternalHttpUrl(requiredString(base.url, 'url'));
	if (!parsedUrl) throw new Error('Source resource URL must be external http(s)');
	const url = normalizeUrl(parsedUrl.toString());
	const title = requiredString(base.title, 'title');
	const summary = cleanString(base.summary);
	const keywords = stringArrayValue(base.keywords ?? [], 'keywords');
	return parseResourceProcessingWorkflowPayload({
		target: {
			kind: 'draft',
			admission: { kind: 'source', sourceId: requiredString(base.sourceId, 'source_id') },
			url,
			title,
			summary,
			originalLang,
			publishedDate,
			keywords,
			...(base.refreshRevision?.trim() ? { expectedProviderRevision: base.refreshRevision.trim() } : {}),
		},
	}).target as ResourceDraftTarget;
}

export async function enqueueSubjectDraft(
	env: CoreEnv,
	input: {
		parentResourceId: string;
		parentRevision: string | null;
		title: string;
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
			title: input.title,
			summary: null,
			originalLang: DEFAULT_RESOURCE_LANG,
			publishedDate: null,
			keywords: [],
		},
	}).target as ResourceDraftTarget;
	const identity = await sha256Hex(JSON.stringify(target));
	return enqueueOrRestartWorkflow(env.RESOURCE_PROCESSING_V2_WORKFLOW, `subject-draft-v2-${identity}`, { target });
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
	drafts: SourceResourceDraft[],
): Promise<Array<PromiseSettledResult<SourceResourceAdmissionOutcome>>> {
	if (!drafts.length) return [];
	const existing = await withCoreDb(env, (db) => claimExistingDiscoveredResources(db, drafts));
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

async function enqueueResourceRefresh(env: CoreEnv, resourceId: string, refreshRevision: string): Promise<boolean> {
	const revision = ProviderRevisionSchema.parse(refreshRevision);
	const id = ['resource-refresh-v4', workflowIdPart(resourceId), workflowIdPart(revision)].join('-');
	const [created] = await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([
		{ id, params: { target: { kind: 'stored', resourceId, operation: 'reacquire', expectedProviderRevision: revision } } },
	]);
	if (created) return true;
	const instance = await env.RESOURCE_PROCESSING_V2_WORKFLOW.get(id);
	const { status } = await instance.status();
	if (status === 'errored') {
		await instance.restart();
		return true;
	}
	if (status === 'unknown') throw new Error(`Resource refresh Workflow ${id} has unknown status`);
	return false;
}

/** Repairs only interrupted DB-to-Workflow handoffs for record-first app-owned blobs. */
export async function reconcilePendingBlobProcessing(env: CoreEnv): Promise<void> {
	const admissions = await claimStalePendingBlobAdmissions(env, new Date(Date.now() - PENDING_BLOB_GRACE_MS), PENDING_BLOB_RECONCILE_LIMIT);
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
		id: `resource-resync-v2-${workflowIdPart(resourceId)}-${crypto.randomUUID()}`,
		params: { target: { kind: 'stored', resourceId, operation: 'reacquire' } },
	});
	return instance.id;
}

function workflowIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

function storedWorkflowId(resourceId: string): string {
	return [STORED_RESOURCE_WORKFLOW_REVISION, workflowIdPart(resourceId)].join('-');
}
