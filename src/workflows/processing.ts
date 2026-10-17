import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { stageResourceAcquisition } from '../adapters/acquire';
import type { AcquisitionInput, StoredPdf } from '../contracts/acquired-resource';
import { resourceImageSources, withHostedImages } from '../contracts/image-mapping';
import { ResourceProcessingTargetSchema, type ResourceProcessingTarget } from '../contracts/processing-target';
import { blobKey } from '../contracts/storage-keys';
import { stageResourceImages } from '../services/image-rehosting';
import { STORAGE_STEP } from '../services/workflow-step';
import { withCoreDb } from '../store/db';
import { completeUserRequests, failRequests } from '../store/requests';
import {
	claimAcquisitionFence,
	loadReacquisitionSource,
	persistResolvedResource,
	type ResourcePersistenceTarget,
} from '../store/resources';
import { translatesContentAutomatically } from '../store/translations';
import { deriveResource } from './derivation';
import { stageResourceReferences } from './references';
import { admitRequests, requestSaveTarget } from './requests';
import { enqueueResourceTranslation } from './translation';

/** The published Resource and the translation its imports follow, or a run a newer attempt replaced. */
type ResourceProcessingOutput =
	| { outcome: 'ready'; resourceId: string; textHash: string; translationId?: string }
	| { outcome: 'superseded' };

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceProcessingTarget> {
	async run(event: WorkflowEvent<ResourceProcessingTarget>, step: WorkflowStep): Promise<ResourceProcessingOutput> {
		const target = ResourceProcessingTargetSchema.parse(event.payload);
		try {
			return await this.process(target, event.instanceId, step);
		} catch (error) {
			// Every request waiting on this acquisition settles with it, so none waits for a workflow that ended.
			const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			await step.do('fail-resource-requests-v1', STORAGE_STEP, () =>
				withCoreDb(this.env, (db) => failRequests(db, target.requestId, message)),
			);
			throw error;
		}
	}

	private async process(target: ResourceProcessingTarget, instanceId: string, step: WorkflowStep): Promise<ResourceProcessingOutput> {
		let upload: StoredPdf | null | undefined;
		if (target.kind === 'storedBlob') {
			// Web owns the upload: it confirms this attempt and describes the bytes. Core only rechecks, when it commits, that the object is still ready.
			upload = await step.do('start-owned-pdf-attempt-v2', async () => {
				const verified = await this.env.APP.verifyStoredBlobProcessing(target.objectId, instanceId);
				return verified && { contentHash: verified.contentHash, fileName: verified.fileName };
			});
			if (!upload) {
				// A newer attempt of the same upload, or one Web gave up on, waits behind this lead or retries on its own.
				await step.do('supersede-upload-request-v1', STORAGE_STEP, () =>
					withCoreDb(this.env, (db) => failRequests(db, target.requestId, 'Superseded by a newer upload attempt', true)),
				);
				return { outcome: 'superseded' };
			}
		}
		// An uploaded PDF that names a paper publishes that paper, read from the upload.
		const { resource, uploadedPaper } = await stageResourceAcquisition(
			this.env,
			step,
			await loadAcquisitionInput(this.env, step, target, upload),
			instanceId,
		);
		const persistenceTarget = await planAttempt(target, uploadedPaper, (resourceId) =>
			step.do('claim-acquisition-fence-v1', STORAGE_STEP, async () => withCoreDb(this.env, (db) => claimAcquisitionFence(db, resourceId))),
		);

		console.info({
			tag: 'WORKFLOW',
			msg: 'Starting',
			resourceKind: resource.kind,
			resourcePlatform: resource.resourcePlatform,
			processing_id: instanceId,
			target_kind: target.kind,
		});
		const hosted = withHostedImages(resource, await stageResourceImages(this.env, step, instanceId, resourceImageSources([resource])));
		const persistence = await step.do('persist-resolved-resource-scope-v9', STORAGE_STEP, async () =>
			withCoreDb(this.env, (db) =>
				persistResolvedResource(
					db,
					hosted,
					persistenceTarget,
					target.requestId,
					async (contentHash) => (await this.env.R2.head(blobKey(contentHash))) !== null,
				),
			),
		);
		if (persistence.outcome === 'superseded') return { outcome: 'superseded' };
		const { id: resourceId, scope, subjectResourceId, textHash, outcome, requests } = persistence;
		// Each user who asked saves the Resource; one save failing fails only that user's request.
		const saved = (
			await Promise.all(
				requests.users.map(async (request) => {
					try {
						await step.do(`complete-request-save-v1-${request.id}`, STORAGE_STEP, () =>
							this.env.APP.completeResourceSave(resourceId, requestSaveTarget(request)),
						);
						return [request.id];
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						await step.do(`fail-request-save-v1-${request.id}`, STORAGE_STEP, () =>
							withCoreDb(this.env, (db) => failRequests(db, request.id, `Save failed: ${message}`, true)),
						);
						return [];
					}
				}),
			)
		).flat();

		// The Resource is published; its summary and entities are derived from what was written, before the handoffs read them.
		await Promise.all(
			persistence.derivations.map((derivation) =>
				deriveResource(this.env, step, resourceId, textHash, { ...hosted, description: hosted.summary }, derivation, instanceId),
			),
		);
		const subjectUrl = resource.subjectUrl;
		// Crossref enrichment runs beside the handoffs; the import settles only after it, since the Workflow returns last.
		const references =
			scope === 'corpus' &&
			persistence.kind === 'paper' &&
			outcome === 'written' &&
			hosted.references?.some(({ doi, arxivId }) => !doi && !arxivId)
				? stageResourceReferences(this.env, step, resourceId).catch((error: unknown) => {
						console.error({ tag: 'WORKFLOW', msg: 'Reference enrichment failed', resource_id: resourceId, error });
					})
				: undefined;
		// Attaching a subject rewrote its carrier's search document, so the carrier syncs too.
		const searchSyncIds = [...(scope === 'corpus' ? [resourceId] : []), ...requests.carriers];
		// Every handoff runs to completion even when an independent one fails.
		const followups = await Promise.allSettled([
			searchSyncIds.length
				? step.do('enqueue-resolved-ai-search-sync-v3', STORAGE_STEP, async () => {
						await this.env.RESOURCE_SEARCH_SYNC_QUEUE.sendBatch(searchSyncIds.map((id) => ({ body: { resourceId: id } })));
					})
				: undefined,
			// Ordinary imports share a translation; a reacquisition that replaced the original forces a fresh run.
			// Only monitor discoveries translate their content here; readers request the rest.
			step.do('enqueue-resource-translation-v7', STORAGE_STEP, async () => {
				const automatic = await withCoreDb(this.env, (db) => translatesContentAutomatically(db, resourceId));
				return enqueueResourceTranslation(persistence, automatic ? 'full' : 'metadata', target.kind !== 'draft' && outcome === 'written');
			}),
			subjectUrl && outcome === 'written' && subjectResourceId === null
				? step.do('request-subject-v1', STORAGE_STEP, async () => {
						const leads = await withCoreDb(this.env, (db) =>
							admitRequests(db, [
								{
									requester: 'subject',
									parentResourceId: resourceId,
									parentTextHash: textHash,
									target: {
										kind: 'draft',
										url: subjectUrl,
										// Carrier-resolved hints only; the subject page still wins when it states its own date.
										...(resource.publishedDate ? { sourceHints: { publishedDate: resource.publishedDate } } : {}),
									},
								},
							]),
						);
						return leads.map(({ workflowId }) => workflowId);
					})
				: undefined,
		]);
		await references;
		// The Resource is published, so a lost handoff is logged rather than failing the import that already landed.
		const failures = followups.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
		if (failures.length) console.error({ tag: 'WORKFLOW', msg: 'Follow-up dispatch failed', resource_id: resourceId, errors: failures });

		console.info({ tag: 'WORKFLOW', msg: 'Completed', resource_id: resourceId, target_kind: target.kind });
		const translation = followups[1];
		const translationId = translation.status === 'fulfilled' ? translation.value?.id : undefined;
		await step.do('complete-user-requests-v1', STORAGE_STEP, () =>
			withCoreDb(this.env, (db) => completeUserRequests(db, saved, translationId ?? null)),
		);
		return { outcome: 'ready', resourceId, textHash, ...(translationId ? { translationId } : {}) };
	}
}

/** Read the stored side of a reacquisition here, so adapters never touch the database; Web described the upload. */
async function loadAcquisitionInput(
	env: CoreEnv,
	step: WorkflowStep,
	target: ResourceProcessingTarget,
	upload: StoredPdf | null | undefined,
): Promise<AcquisitionInput> {
	switch (target.kind) {
		case 'draft':
			return { kind: 'url', url: target.url, ...(target.sourceHints ? { sourceHints: target.sourceHints } : {}) };
		case 'reacquire': {
			const source = await step.do('load-resource-reacquisition-source-v3', STORAGE_STEP, async () =>
				withCoreDb(env, (db) => loadReacquisitionSource(db, target.resourceId)),
			);
			return { kind: 'url', ...source };
		}
		case 'storedBlob':
			if (!upload) throw new Error('A stored PDF attempt starts with its verified upload');
			return { kind: 'storedPdf', objectId: target.objectId, pdf: upload };
	}
}

/**
 * Where this attempt writes. Reacquiring an existing Resource claims a fencing token, so it commits only if no newer attempt
 * has committed first. An upload runs one attempt at a time: an identified one is a draft of its public paper, and any other
 * stays the uploader's private file.
 */
async function planAttempt(
	target: ResourceProcessingTarget,
	uploadedPaper: boolean,
	claimFence: (resourceId: string) => Promise<number>,
): Promise<ResourcePersistenceTarget> {
	switch (target.kind) {
		case 'draft':
			return { kind: 'draft' };
		case 'reacquire':
			return {
				kind: 'existing',
				resourceId: target.resourceId,
				fence: await claimFence(target.resourceId),
				...(target.force ? { force: true } : {}),
			};
		case 'storedBlob':
			return uploadedPaper ? { kind: 'draft', uploadId: target.objectId } : { kind: 'upload', objectId: target.objectId };
	}
}
