import { hash } from 'node:crypto';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { connectCoreDb } from '../shared/db';
import { normalizedResourceImageUrl, resourceImageSourceUrls } from '../shared/image-mapping';
import { stageResourceAcquisition } from './acquisition';
import { ResourceDraftTargetSchema, ResourceProcessingTargetSchema, type ResourceProcessingTarget } from './admission';
import { AI_STEP_RETRIES } from './ai-model';
import { summarizeResource } from './analysis';
import { stageResourceImages } from './image-rehosting';
import { createResourceTask } from './progress';
import {
	claimAcquisitionFence,
	persistResolvedResource,
	loadPublicPdfContent,
	prepareResolvedResource,
	type ResourcePersistenceTarget,
} from './resource-persistence';
import { stageResourceReferences } from './resource-references';
import { enqueueResourceTranslation, shouldEnqueueResourceTranslation } from './translation-workflow';
import { publishPublicPdfCrops } from './zotero-sdt-service.ts';

const STORAGE_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
const AI_STEP = { retries: AI_STEP_RETRIES, timeout: '600 seconds' } as const;

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceProcessingTarget> {
	async run(event: WorkflowEvent<ResourceProcessingTarget>, step: WorkflowStep) {
		const target = ResourceProcessingTargetSchema.parse(event.payload);
		const required =
			target.kind === 'storedBlob' || (target.kind === 'draft' && target.relation?.kind !== 'source' && target.progress !== false);
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
			// Provider reconciliation belongs to this attempt, not the resource shared by later retries.
			const processingId = event.instanceId;
			// An uploaded PDF that names a paper publishes that paper, built without the upload's text,
			// and keeps the upload as its uploader's private file.
			const { resource, privateFile } = await stageResourceAcquisition(this.env, step, target, processingId);
			const plan = await planAttempt(target, privateFile !== null, event.instanceId, (resourceId) =>
				step.do('claim-acquisition-fence-v1', STORAGE_STEP, async () => claimAcquisitionFence(await connectCoreDb(this.env), resourceId)),
			);

			console.info({
				tag: 'WORKFLOW',
				msg: 'Starting',
				resourceKind: resource.kind,
				resourcePlatform: resource.resourcePlatform,
				processing_id: processingId,
				target_kind: target.kind,
			});
			await task.report('analysis', { stage: 'analyzing', status: 'running' });
			const imageSources = resourceImageSourceUrls({ ...resource, ogImageUrl: resource.previewImageUrl });
			// A page's preview image is decoration: a dead one is dropped instead of failing the resource.
			const previewSource = normalizedResourceImageUrl(resource.previewImageUrl);
			const optionalPreview =
				previewSource && !resourceImageSourceUrls({ ...resource, ogImageUrl: null }).includes(previewSource) ? previewSource : null;
			const [summary, hostedImages] = await Promise.all([
				// Posts are their text; a summary would only restate it.
				resource.summary ??
					(resource.kind === 'post'
						? null
						: step.do('summarize-resource-v2', AI_STEP, () => summarizeResource(resource, this.env, processingId))),
				stageResourceImages(
					this.env,
					step,
					processingId,
					imageSources,
					optionalPreview,
					target.kind === 'reacquire' ? event.instanceId : undefined,
				),
			]);
			const summarized = {
				...resource,
				summary,
				previewImageUrl:
					optionalPreview && !hostedImages.some((image) => image.sourceUrl === optionalPreview) ? null : resource.previewImageUrl,
			};
			await task.report('persisting', { stage: 'persisting', status: 'running' });
			const preparedResource = prepareResolvedResource(summarized, hostedImages);
			const renditions = [
				...(privateFile && plan.privateRendition
					? [
							{
								persistStep: 'persist-private-pdf-rendition-v4',
								translationStep: 'enqueue-private-pdf-translation-v3',
								resource: prepareResolvedResource({ ...privateFile, summary: privateFile.summary ?? summary }, hostedImages),
								target: plan.privateRendition,
							},
						]
					: []),
				{
					persistStep: 'persist-resolved-resource-scope-v7',
					translationStep: 'enqueue-resource-translation-v5',
					resource: preparedResource,
					target: plan.persistence,
				},
			];
			const persisted = [];
			for (const rendition of renditions) {
				const persistence = await step.do(rendition.persistStep, STORAGE_STEP, async () =>
					persistResolvedResource(await connectCoreDb(this.env), rendition.resource, rendition.target),
				);
				if (persistence.outcome === 'superseded') {
					await task.report('persist-superseded', { stage: 'persisting', status: 'superseded' });
					return { resourceId: persistence.resourceId };
				}
				persisted.push({ translationStep: rendition.translationStep, persistence });
			}
			const persistence = persisted.at(-1)!.persistence;
			const { resourceId: persistedResourceId, scope, subjectAttached, originalHash, outcome } = persistence;
			if (scope === 'corpus' && persistence.fileType === 'application/pdf') {
				await step.do('publish-public-pdf-crops-v1', STORAGE_STEP, async () =>
					publishPublicPdfCrops(
						this.env,
						persistedResourceId,
						await loadPublicPdfContent(await connectCoreDb(this.env), persistedResourceId),
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
				preparedResource.references?.some(({ doi, arxivId }) => !doi && !arxivId)
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
					shouldEnqueueResourceTranslation(rendition)
						? step.do(translationStep, STORAGE_STEP, () =>
								enqueueResourceTranslation(
									this.env,
									rendition.resourceId,
									rendition.originalHash,
									target.kind !== 'draft' && rendition.outcome === 'written',
									task,
								),
							)
						: undefined,
				),
				subjectUrl && outcome === 'written' && !subjectAttached
					? step.do('enqueue-resolved-subject-child-v2', STORAGE_STEP, async () => {
							const subjectTarget = ResourceDraftTargetSchema.parse({
								kind: 'draft',
								relation: { kind: 'subject', parentResourceId: persistedResourceId, parentOriginalHash: originalHash },
								// Carrier-resolved hints only; the subject page still wins when it states its own date.
								...(resource.publishedDate ? { sourceHints: { publishedDate: resource.publishedDate } } : {}),
								url: subjectUrl,
							});
							// The linked page is background work, never part of the importer's progress.
							const id = `subject-draft-auto-v1-${hash('sha256', JSON.stringify(subjectTarget), 'hex')}`;
							await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([{ id, params: { ...subjectTarget, progress: false } }]);
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
