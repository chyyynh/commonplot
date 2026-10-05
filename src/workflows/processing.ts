import { hash } from 'node:crypto';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { stageResourceAcquisition } from '../adapters/acquire';
import type { AcquisitionInput } from '../contracts/acquired-resource';
import { resourceImageSources, withHostedImages } from '../contracts/image-mapping';
import { ResourceDraftTargetSchema, ResourceProcessingTargetSchema, type ResourceProcessingTarget } from '../contracts/processing-target';
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
	loadStoredPdf,
	persistResolvedResource,
	type ResourcePersistenceTarget,
} from '../store/resources';
import { translatesContentAutomatically } from '../store/translations';
import { createResourceTask } from './progress';
import { stageResourceReferences } from './references';
import { enqueueResourceTranslation } from './translation';

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceProcessingTarget> {
	async run(event: WorkflowEvent<ResourceProcessingTarget>, step: WorkflowStep) {
		const target = ResourceProcessingTargetSchema.parse(event.payload);
		// Only Web admissions report progress: monitor discoveries, subject children and resyncs are background work.
		const required = target.kind === 'storedBlob' || (target.kind === 'draft' && !target.relation);
		const task = createResourceTask(this.env, step, event.instanceId, required);
		let publishedResourceId: string | undefined;
		try {
			if (target.kind === 'storedBlob') {
				const current = await step.do('start-owned-pdf-attempt-v1', () =>
					this.env.APP.verifyStoredBlobProcessing(target.objectId, event.instanceId),
				);
				if (!current) {
					await task.report('superseded', { stage: 'acquiring', status: 'superseded' });
					return {};
				}
			}
			// An uploaded PDF that names a paper publishes that paper, read from the upload.
			const acquisition = loadAcquisitionInput(this.env, step, target).then((input) =>
				stageResourceAcquisition(this.env, step, input, event.instanceId),
			);
			// Acquisition runs beside the start gate; a task that ended meanwhile discards its result and its failure.
			acquisition.catch(() => {});
			if (!(await task.start(target.kind === 'storedBlob' ? 'parsing' : 'acquiring')))
				return target.kind === 'reacquire' ? { resourceId: target.resourceId } : {};
			const { resource, uploadedPaper } = await acquisition;
			const plan = await planAttempt(target, uploadedPaper, event.instanceId, (resourceId) =>
				step.do('claim-acquisition-fence-v1', STORAGE_STEP, async () =>
					withCoreDb(this.env, (db) => claimAcquisitionFence(db, resourceId)),
				),
			);

			console.info({
				tag: 'WORKFLOW',
				msg: 'Starting',
				resourceKind: resource.kind,
				resourcePlatform: resource.resourcePlatform,
				processing_id: event.instanceId,
				target_kind: target.kind,
			});
			void task.report('analysis', { stage: 'analyzing', status: 'running' });
			const [summary, entities, hostedImages] = await Promise.all([
				// Posts are their text; a summary would only restate it.
				resource.summary ??
					(resource.kind === 'post'
						? null
						: step.do('summarize-resource-v2', AI_STEP, () => summarizeResource(resource, this.env, event.instanceId))),
				// Entities only relate Resources; an import never fails without them, and a reacquisition keeps the stored ones.
				step
					.do('extract-resource-entities-v2', AI_STEP, () => extractResourceEntities(resource, this.env, event.instanceId))
					.catch((error: unknown) => {
						console.error({ tag: 'WORKFLOW', msg: 'Entity extraction failed', processing_id: event.instanceId, error });
						return undefined;
					}),
				stageResourceImages(
					this.env,
					step,
					event.instanceId,
					resourceImageSources([resource]),
					target.kind === 'reacquire' ? event.instanceId : undefined,
				),
			]);
			const summarized = withHostedImages({ ...resource, summary, entities }, hostedImages);
			void task.report('persisting', { stage: 'persisting', status: 'running' });
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
			if (persistence.outcome === 'superseded') {
				await task.report('persist-superseded', { stage: 'persisting', status: 'superseded' });
				return { resourceId: persistence.id };
			}
			const { id: persistedResourceId, scope, subjectResourceId, originalHash, outcome } = persistence;
			const { saveTarget } = plan;
			if (saveTarget)
				await step.do('complete-resource-save-v2', STORAGE_STEP, () => this.env.APP.completeResourceSave(persistedResourceId, saveTarget));
			publishedResourceId = persistedResourceId;

			const subjectUrl = resource.subjectUrl;
			// Crossref enrichment is background work that no import waits on.
			const references =
				scope === 'corpus' &&
				persistence.kind === 'paper' &&
				outcome === 'written' &&
				summarized.references?.some(({ doi, arxivId }) => !doi && !arxivId)
					? stageResourceReferences(this.env, step, persistedResourceId).catch((error: unknown) => {
							console.error({ tag: 'WORKFLOW', msg: 'Reference enrichment failed', resource_id: persistedResourceId, error });
						})
					: undefined;
			// Every handoff runs to completion even when an independent one fails.
			const followups = await Promise.allSettled([
				task.report('ready', { stage: 'persisting', status: 'complete', resourceId: persistedResourceId }),
				scope === 'corpus'
					? step.do('enqueue-resolved-ai-search-sync-v2', STORAGE_STEP, async () => {
							await this.env.RESOURCE_SEARCH_SYNC_QUEUE.send({ resourceId: persistedResourceId });
						})
					: undefined,
				// Ordinary imports share a translation; a reacquisition that replaced the original forces a fresh run.
				// Only monitor discoveries translate their content here; readers request the rest.
				step.do('enqueue-resource-translation-v7', STORAGE_STEP, async () => {
					const automatic = await withCoreDb(this.env, (db) => translatesContentAutomatically(db, persistedResourceId));
					return enqueueResourceTranslation(
						this.env,
						persistence,
						automatic ? 'full' : 'metadata',
						target.kind !== 'draft' && outcome === 'written',
						task,
					);
				}),
				subjectUrl && outcome === 'written' && subjectResourceId === null
					? step.do('enqueue-resolved-subject-child-v2', STORAGE_STEP, async () => {
							const subjectTarget = ResourceDraftTargetSchema.parse({
								kind: 'draft',
								relation: { kind: 'subject', parentResourceId: persistedResourceId, parentOriginalHash: originalHash },
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
			const failures = followups.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
			await task.seal(failures.length ? 'followup_dispatch_failed' : undefined);
			await references;
			if (failures.length) throw new AggregateError(failures, 'Resource persisted, but one or more follow-ups failed');

			console.info({ tag: 'WORKFLOW', msg: 'Completed', resource_id: persistedResourceId, target_kind: target.kind });
			return { resourceId: persistedResourceId };
		} catch (error) {
			await Promise.allSettled([
				task.report('outcome-after-error', {
					status: publishedResourceId ? 'complete' : 'failed',
					...(publishedResourceId ? { resourceId: publishedResourceId } : { errorCode: 'processing_failed' }),
				}),
				publishedResourceId ? task.seal('followup_dispatch_failed') : undefined,
			]);
			throw error;
		}
	}
}

/** Read the stored side of a reacquisition or an upload here, so adapters never touch the database. */
async function loadAcquisitionInput(env: CoreEnv, step: WorkflowStep, target: ResourceProcessingTarget): Promise<AcquisitionInput> {
	switch (target.kind) {
		case 'draft':
			return { kind: 'url', url: target.url, ...(target.sourceHints ? { sourceHints: target.sourceHints } : {}) };
		case 'reacquire': {
			const source = await step.do('load-resource-reacquisition-source-v3', STORAGE_STEP, async () =>
				withCoreDb(env, (db) => loadReacquisitionSource(db, target.resourceId)),
			);
			return { kind: 'url', ...source };
		}
		case 'storedBlob': {
			const pdf = await step.do('load-stored-pdf-input-v2', STORAGE_STEP, async () =>
				withCoreDb(env, (db) => loadStoredPdf(db, target.objectId)),
			);
			return { kind: 'storedPdf', objectId: target.objectId, pdf };
		}
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
