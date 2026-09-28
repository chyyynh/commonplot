import { hash } from 'node:crypto';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { stageResourceAcquisition } from '../adapters/acquire';
import type { AcquisitionInput } from '../contracts/acquired-resource';
import { resourceImageSources, withHostedImages } from '../contracts/image-mapping';
import { ResourceDraftTargetSchema, ResourceProcessingTargetSchema, type ResourceProcessingTarget } from '../contracts/processing-target';
import { AI_STEP_RETRIES } from '../services/ai-model';
import { stageResourceImages } from '../services/image-rehosting';
import { summarizeResource } from '../services/summary';
import { publishPublicPdfCrops } from '../services/zotero-sdt-service.ts';
import { withCoreDb } from '../store/db';
import {
	claimAcquisitionFence,
	loadReacquisitionSource,
	loadStoredPdf,
	persistResolvedResource,
	loadPublicPdfContent,
	type ResourcePersistenceTarget,
} from '../store/resources';
import { createResourceTask } from './progress';
import { stageResourceReferences } from './references';
import { enqueueResourceTranslation } from './translation';

const STORAGE_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
const AI_STEP = { retries: AI_STEP_RETRIES, timeout: '600 seconds' } as const;

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
					this.env.APP.verifyStoredBlobProcessing(target.resourceId, event.instanceId),
				);
				if (!current) {
					await task.report('superseded', { stage: 'acquiring', status: 'superseded' });
					return { resourceId: target.resourceId };
				}
			}
			if (!(await task.start(target.kind === 'storedBlob' ? 'parsing' : 'acquiring')))
				return target.kind === 'draft' ? {} : { resourceId: target.resourceId };
			// An uploaded PDF that names a paper publishes that paper, built without the upload's text,
			// and keeps the upload as its uploader's private file.
			const input = await loadAcquisitionInput(this.env, step, target);
			const { resource, privateFile } = await stageResourceAcquisition(this.env, step, input, event.instanceId);
			const plan = await planAttempt(target, privateFile !== null, event.instanceId, (resourceId) =>
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
			await task.report('analysis', { stage: 'analyzing', status: 'running' });
			const [summary, hostedImages] = await Promise.all([
				// Posts are their text; a summary would only restate it.
				resource.summary ??
					(resource.kind === 'post'
						? null
						: step.do('summarize-resource-v2', AI_STEP, () => summarizeResource(resource, this.env, event.instanceId))),
				stageResourceImages(
					this.env,
					step,
					event.instanceId,
					resourceImageSources(privateFile ? [resource, privateFile] : [resource]),
					target.kind === 'reacquire' ? event.instanceId : undefined,
				),
			]);
			const summarized = withHostedImages({ ...resource, summary }, hostedImages);
			await task.report('persisting', { stage: 'persisting', status: 'running' });
			const renditions = [
				...(privateFile && plan.privateRendition
					? [
							{
								persistStep: 'persist-private-pdf-rendition-v4',
								translationStep: 'enqueue-private-pdf-translation-v3',
								resource: withHostedImages({ ...privateFile, summary: privateFile.summary ?? summary }, hostedImages),
								target: plan.privateRendition,
							},
						]
					: []),
				{
					persistStep: 'persist-resolved-resource-scope-v7',
					translationStep: 'enqueue-resource-translation-v5',
					resource: summarized,
					target: plan.persistence,
				},
			];
			const persisted = [];
			for (const rendition of renditions) {
				const persistence = await step.do(rendition.persistStep, STORAGE_STEP, async () =>
					withCoreDb(this.env, (db) => persistResolvedResource(db, rendition.resource, rendition.target)),
				);
				if (persistence.outcome === 'superseded') {
					await task.report('persist-superseded', { stage: 'persisting', status: 'superseded' });
					return { resourceId: persistence.id };
				}
				persisted.push({ translationStep: rendition.translationStep, persistence });
			}
			const persistence = persisted.at(-1)!.persistence;
			const { id: persistedResourceId, scope, subjectResourceId, originalHash, outcome } = persistence;
			if (scope === 'corpus' && persistence.fileType === 'application/pdf') {
				await step.do('publish-public-pdf-crops-v1', STORAGE_STEP, async () =>
					publishPublicPdfCrops(
						this.env,
						persistedResourceId,
						await withCoreDb(this.env, (db) => loadPublicPdfContent(db, persistedResourceId)),
					),
				);
			}

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
				...persisted.map(({ translationStep, persistence: rendition }) =>
					step.do(translationStep, STORAGE_STEP, () =>
						enqueueResourceTranslation(this.env, rendition, target.kind !== 'draft' && rendition.outcome === 'written', task),
					),
				),
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
							await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([{ id, params: subjectTarget }]);
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
			const pdf = await step.do('load-stored-pdf-input-v1', STORAGE_STEP, async () =>
				withCoreDb(env, (db) => loadStoredPdf(db, target.resourceId)),
			);
			return { kind: 'storedPdf', resourceId: target.resourceId, pdf };
		}
	}
}

/**
 * Where this attempt writes and which save it completes. Reacquiring an existing Resource claims a fencing token, so it
 * commits only if no newer attempt has committed first; an uploaded paper is a new draft and keeps the upload private.
 */
async function planAttempt(
	target: ResourceProcessingTarget,
	uploadedPaper: boolean,
	instanceId: string,
	claimFence: (resourceId: string) => Promise<number>,
): Promise<{ persistence: ResourcePersistenceTarget; privateRendition: ResourcePersistenceTarget | null; saveTarget: unknown }> {
	switch (target.kind) {
		case 'draft':
			return {
				persistence: { kind: 'draft', ...(target.relation ? { relation: target.relation } : {}) },
				privateRendition: null,
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
				privateRendition: null,
				saveTarget: null,
			};
		case 'storedBlob': {
			const ownedBlobId = target.resourceId;
			const upload = { kind: 'existing', resourceId: ownedBlobId, fence: await claimFence(ownedBlobId), ownedBlobId } as const;
			return {
				persistence: uploadedPaper ? { kind: 'draft', ownedBlobId } : upload,
				privateRendition: uploadedPaper ? upload : null,
				saveTarget: { kind: 'userFileResult', fileResourceId: ownedBlobId, workflowId: instanceId },
			};
		}
	}
}
