import { hash } from 'node:crypto';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { stageResourceAcquisition } from '../adapters/acquire';
import type { AcquisitionInput, StoredPdf } from '../contracts/acquired-resource';
import { resourceImageSources, withHostedImages } from '../contracts/image-mapping';
import { ResourceDraftTargetSchema, ResourceProcessingTargetSchema, type ResourceProcessingTarget } from '../contracts/processing-target';
import { RESOURCE_KINDS } from '../contracts/resource';
import { blobKey } from '../contracts/storage-keys';
import { coreExports } from '../exports.ts';
import { AI_STEP } from '../services/ai-model';
import { extractResourceEntities } from '../services/entities';
import { stageResourceImages } from '../services/image-rehosting';
import { summarizeResource } from '../services/summary';
import { STORAGE_STEP } from '../services/workflow-step';
import { withCoreDb } from '../store/db';
import {
	claimAcquisitionFence,
	loadReacquisitionSource,
	persistResolvedResource,
	type ResourcePersistenceTarget,
} from '../store/resources';
import { translatesContentAutomatically } from '../store/translations';
import { stageResourceReferences } from './references';
import { enqueueResourceTranslation, importTranslationProgress } from './translation';

/** What an import reads back: the published Resource and the translation it waits for, or a run a newer attempt replaced. */
type ResourceProcessingOutput =
	// Runs completed before text_hash return `originalHash`; drop it after their 7-day retention.
	| ({ outcome: 'ready'; resourceId: string; translationId?: string } & ({ textHash: string } | { originalHash: string }))
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
				? await importTranslationProgress(
						output.resourceId,
						'textHash' in output ? output.textHash : output.originalHash,
						output.translationId,
					)
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
		const [summary, entities, hostedImages] = await Promise.all([
			// An untitled Resource is its text; a summary would only restate it.
			resource.summary ??
				(!RESOURCE_KINDS[resource.kind].titled
					? null
					: step.do('summarize-resource-v2', AI_STEP, () => summarizeResource(resource, this.env, event.instanceId))),
			// Entities only relate Resources; an import never fails without them, and a reacquisition keeps the stored ones.
			step
				.do('extract-resource-entities-v2', AI_STEP, () => extractResourceEntities(resource, this.env, event.instanceId))
				.catch((error: unknown) => {
					console.error({ tag: 'WORKFLOW', msg: 'Entity extraction failed', processing_id: event.instanceId, error });
					return undefined;
				}),
			stageResourceImages(this.env, step, event.instanceId, resourceImageSources([resource])),
		]);
		const summarized = withHostedImages({ ...resource, summary, entities }, hostedImages);
		const persistence = await step.do('persist-resolved-resource-scope-v8', STORAGE_STEP, async () =>
			withCoreDb(this.env, (db) =>
				persistResolvedResource(
					db,
					summarized,
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

		const subjectUrl = resource.subjectUrl;
		// Crossref enrichment runs beside the handoffs; the import settles only after it, since the Workflow returns last.
		const references =
			scope === 'corpus' &&
			persistence.kind === 'paper' &&
			outcome === 'written' &&
			summarized.references?.some(({ doi, arxivId }) => !doi && !arxivId)
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
