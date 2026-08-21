import { isResourceSourceSnapshotHash } from '@core-shared/resource-types';
import { normalizeUrl } from '@core-shared/url';
import { withCoreDb, withCoreTx } from '@db/client';
import {
	claimExistingDiscoveredResources,
	claimStalePendingResourceAdmissions,
	type SourceResourceDraft,
	upsertPendingSourceResource,
} from '@ingest/domain/resource-admission-store';
import { enqueueOrRestartWorkflow } from '../workflow-control';

export type ResourceProcessingOperation = 'ingest' | 'resync';
export type ResourceProcessingWorkflowPayload = {
	resourceId: string;
	operation: ResourceProcessingOperation;
	sourceRevision?: string;
};

export type SourceResourceAdmissionOutcome = 'created' | 'existing' | 'refreshed' | 'retried';

type ExistingDiscoveredResource = Awaited<ReturnType<typeof claimExistingDiscoveredResources>>[number];

const PENDING_RESOURCE_GRACE_MS = 10 * 60 * 1000;
// Completed instance IDs restart on their pinned Workflow version. Bump this
// namespace when a new graph must not reuse an older instance.
const RESOURCE_PROCESSING_WORKFLOW_REVISION = 'resource-v6';
// Stale pending resources are readmitted through the same canonical resolver
// as fresh ingest; pace reconciliation well below the Workflow creation limit.
const PENDING_RESOURCE_RECONCILE_LIMIT = 50;
const PENDING_RESOURCE_RECONCILE_CONCURRENCY = 10;
const DISCOVERED_RESOURCE_ADMISSION_CONCURRENCY = 5;

export async function enqueueProcessing(env: CoreEnv, resourceId: string, sourceRevision?: string): Promise<string> {
	if (sourceRevision && !isResourceSourceSnapshotHash(sourceRevision)) throw new Error('Invalid resource source revision');
	return enqueueOrRestartWorkflow(env.RESOURCE_PROCESSING_V2_WORKFLOW, storedWorkflowId(resourceId, sourceRevision), {
		resourceId,
		operation: 'ingest',
		...(sourceRevision ? { sourceRevision } : {}),
	});
}

async function admitDiscoveredSourceResource(
	env: CoreEnv,
	draft: SourceResourceDraft,
	resource: ExistingDiscoveredResource | undefined,
): Promise<SourceResourceAdmissionOutcome> {
	if (!resource) {
		const pending = await withCoreTx(env, (db) => upsertPendingSourceResource(db, draft));
		if (pending.needsProcessing) await enqueueProcessing(env, pending.resourceId, pending.sourceRevision ?? undefined);
		return 'created';
	}
	if (resource.enrichmentStatus !== 'enriched') {
		if (!resource.shouldRetryEnrichment) return 'existing';
		await enqueueProcessing(env, resource.id);
		return 'retried';
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
	const revision = refreshRevision.trim();
	if (!/^[a-zA-Z0-9_-]{1,80}$/.test(revision)) throw new Error('Invalid resource refresh revision');
	const id = ['resource-refresh-v1', workflowIdPart(resourceId), workflowIdPart(revision)].join('-');
	const [created] = await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([{ id, params: { resourceId, operation: 'resync' } }]);
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

/** Re-admits app-owned pending rows whose initial DB -> Workflow handoff was interrupted. */
export async function reconcilePendingResourceProcessing(env: CoreEnv): Promise<void> {
	const admissions = await claimStalePendingResourceAdmissions(
		env,
		new Date(Date.now() - PENDING_RESOURCE_GRACE_MS),
		PENDING_RESOURCE_RECONCILE_LIMIT,
	);
	if (!admissions.length) return;

	let reconciled = 0;
	let failed = 0;
	for (let offset = 0; offset < admissions.length; offset += PENDING_RESOURCE_RECONCILE_CONCURRENCY) {
		const batch = admissions.slice(offset, offset + PENDING_RESOURCE_RECONCILE_CONCURRENCY);
		const results = await Promise.allSettled(
			batch.map(({ resourceId, sourceRevision }) => enqueueProcessing(env, resourceId, sourceRevision ?? undefined)),
		);
		for (const [index, result] of results.entries()) {
			if (result.status === 'fulfilled') {
				reconciled++;
				continue;
			}
			failed++;
			console.error({
				tag: 'RESOURCE_WORKFLOW',
				event: 'pending_resource_reconciliation_failed',
				resource_id: batch[index]?.resourceId,
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
	}
	console.info({
		tag: 'RESOURCE_WORKFLOW',
		event: 'pending_resource_reconciliation_completed',
		attempted: admissions.length,
		reconciled,
		failed,
	});
}

export async function enqueueResourceResync(env: CoreEnv, resourceId: string): Promise<string> {
	// A resync is a distinct run, not a retry of the original ingest. A unique
	// instance ID also keeps clients from observing a cached terminal status
	// from an earlier resync of the same resource.
	const instance = await env.RESOURCE_PROCESSING_V2_WORKFLOW.create({
		id: `resource-resync-v2-${workflowIdPart(resourceId)}-${crypto.randomUUID()}`,
		params: { resourceId, operation: 'resync' },
	});
	return instance.id;
}

function workflowIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

function storedWorkflowId(resourceId: string, sourceRevision?: string): string {
	return sourceRevision
		? [RESOURCE_PROCESSING_WORKFLOW_REVISION, workflowIdPart(resourceId), sourceRevision.slice(0, 32)].join('-')
		: [RESOURCE_PROCESSING_WORKFLOW_REVISION, workflowIdPart(resourceId)].join('-');
}
