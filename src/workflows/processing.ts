import { hash } from 'node:crypto';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { stageResourceAcquisition } from '../adapters/acquire';
import type { AcquisitionInput, StoredPdf } from '../contracts/acquired-resource';
import { resourceImageSources, withHostedImages } from '../contracts/image-mapping';
import { ResourceDraftTargetSchema, ResourceProcessingTargetSchema, type ResourceProcessingTarget } from '../contracts/processing-target';
import { blobKey } from '../contracts/storage-keys';
import { coreExports } from '../exports.ts';
import { stageResourceImages } from '../services/image-rehosting';
import { STORAGE_STEP } from '../services/workflow-step';
import { withCoreDb } from '../store/db';
import {
	claimAcquisitionFence,
	loadReacquisitionSource,
	persistResolvedResource,
	type ResourcePersistenceTarget,
} from '../store/resources';
import { translatesContentAutomatically } from '../store/translations';
import { deriveResource } from './derivation';
import { stageResourceReferences } from './references';
import { enqueueResourceTranslation, importTranslationProgress } from './translation';

/** What an import reads back: the published Resource and the translation it waits for, or a run a newer attempt replaced. */
type ResourceProcessingOutput =
	| { outcome: 'ready'; resourceId: string; textHash: string; translationId?: string }
	| { outcome: 'superseded' };

export type ResourceImportExecution =
	| { state: 'absent' | 'queued' | 'running' | 'failed' }
	| { state: 'ready'; resourceId: string; translation?: 'running' | 'failed' };

/** An import's progress, read from its Workflow and the translation that Workflow admitted. */
export async function resourceImportExecution(id: string): Promise<ResourceImportExecution> {
	let snapshot: Awaited<ReturnType<WorkflowInstance['status']>>;
	try {
		snapshot = await (await coreExports.ResourceProcessingV2Workflow.get(id)).status();
	} catch {
		return { state: 'absent' };
	}
	switch (snapshot.status) {
		case 'queued':
			return { state: 'queued' };
		case 'errored':
		case 'terminated':
			return { state: 'failed' };
		case 'complete': {
			const output = snapshot.output as ResourceProcessingOutput;
			if (output.outcome === 'superseded') return { state: 'failed' };
			const translation = output.translationId
				? await importTranslationProgress(output.resourceId, output.textHash, output.translationId)
				: undefined;
			return { state: 'ready', resourceId: output.resourceId, ...(translation ? { translation } : {}) };
		}
		default:
			return { state: 'running' };
	}
}

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceProcessingTarget> {
	async run(event: WorkflowEvent<ResourceProcessingTarget>, step: WorkflowStep): Promise<ResourceProcessingOutput> {
		const target = ResourceProcessingTargetSchema.parse(event.payload);
		let upload: StoredPdf | null | undefined;
		if (target.kind === 'storedBlob') {
			// Web owns the upload: it confirms this attempt and describes the bytes. Core only rechecks, when it commits, that the object is still ready.
			upload = await step.do('start-owned-pdf-attempt-v2', async () => {
				const verified = await this.env.APP.verifyStoredBlobProcessing(target.objectId, event.instanceId);
				return verified && { contentHash: verified.contentHash, fileName: verified.fileName };
			});
			if (!upload) return { outcome: 'superseded' };
		}
		// An uploaded PDF that names a paper publishes that paper, read from the upload.
		const { resource, uploadedPaper } = await stageResourceAcquisition(
			this.env,
			step,
			await loadAcquisitionInput(this.env, step, target, upload),
			event.instanceId,
		);
		const plan = await planAttempt(target, uploadedPaper, event.instanceId, (resourceId) =>
			step.do('claim-acquisition-fence-v1', STORAGE_STEP, async () => withCoreDb(this.env, (db) => claimAcquisitionFence(db, resourceId))),
		);

		console.info({
			tag: 'WORKFLOW',
			msg: 'Starting',
			resourceKind: resource.kind,
			resourcePlatform: resource.resourcePlatform,
			processing_id: event.instanceId,
			target_kind: target.kind,
		});
		const hosted = withHostedImages(
			resource,
			await stageResourceImages(this.env, step, event.instanceId, resourceImageSources([resource])),
		);
		const persistence = await step.do('persist-resolved-resource-scope-v9', STORAGE_STEP, async () =>
			withCoreDb(this.env, (db) =>
				persistResolvedResource(
					db,
					hosted,
					plan.persistence,
					async (contentHash) => (await this.env.R2.head(blobKey(contentHash))) !== null,
				),
			),
		);
		if (persistence.outcome === 'superseded') return { outcome: 'superseded' };
		const { id: resourceId, scope, subjectResourceId, textHash, outcome } = persistence;
		const { saveTarget } = plan;
		if (saveTarget)
			await step.do('complete-resource-save-v2', STORAGE_STEP, () => this.env.APP.completeResourceSave(resourceId, saveTarget));

		// The Resource is published; its summary and entities are derived from what was written, before the handoffs read them.
		await Promise.all(
			persistence.derivations.map((kind) => deriveResource(this.env, step, resourceId, textHash, hosted, kind, event.instanceId)),
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
		const searchSyncIds = [
			...(scope === 'corpus' ? [resourceId] : []),
			...(target.kind === 'draft' && target.relation?.kind === 'subject' ? [target.relation.parentResourceId] : []),
		];
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
				? step.do('enqueue-resolved-subject-child-v2', STORAGE_STEP, async () => {
						const subjectTarget = ResourceDraftTargetSchema.parse({
							kind: 'draft',
							relation: { kind: 'subject', parentResourceId: resourceId, parentTextHash: textHash },
							// Carrier-resolved hints only; the subject page still wins when it states its own date.
							...(resource.publishedDate ? { sourceHints: { publishedDate: resource.publishedDate } } : {}),
							url: subjectUrl,
						});
						const id = `subject-draft-auto-v1-${hash('sha256', JSON.stringify(subjectTarget), 'hex')}`;
						await coreExports.ResourceProcessingV2Workflow.createBatch([{ id, params: subjectTarget }]);
						return id;
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
 * Where this attempt writes and which save it completes. Reacquiring an existing Resource claims a fencing token, so it
 * commits only if no newer attempt has committed first. An upload runs one attempt at a time: an identified one is a draft
 * of its public paper, and any other stays the uploader's private file.
 */
async function planAttempt(
	target: ResourceProcessingTarget,
	uploadedPaper: boolean,
	instanceId: string,
	claimFence: (resourceId: string) => Promise<number>,
): Promise<{ persistence: ResourcePersistenceTarget; saveTarget: unknown }> {
	switch (target.kind) {
		case 'draft':
			return {
				persistence: { kind: 'draft', ...(target.relation ? { relation: target.relation } : {}) },
				saveTarget: target.saveTarget ?? null,
			};
		case 'reacquire':
			return {
				persistence: {
					kind: 'existing',
					resourceId: target.resourceId,
					fence: await claimFence(target.resourceId),
					...(target.force ? { force: true } : {}),
				},
				saveTarget: null,
			};
		case 'storedBlob':
			return {
				persistence: uploadedPaper ? { kind: 'draft', uploadId: target.objectId } : { kind: 'upload', objectId: target.objectId },
				saveTarget: { kind: 'userFileResult', objectId: target.objectId, workflowId: instanceId },
			};
	}
}
