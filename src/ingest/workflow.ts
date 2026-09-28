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
			// Reacquiring an existing Resource commits only if no newer attempt has committed first.
			const fence =
				target.kind === 'draft'
					? null
					: await step.do('claim-acquisition-fence-v1', STORAGE_STEP, async () =>
							claimAcquisitionFence(await connectCoreDb(this.env), target.resourceId),
						);
			// Provider reconciliation belongs to this attempt, not the resource shared by later retries.
			const processingId = event.instanceId;
			// An uploaded PDF that names a paper publishes that paper, built without the upload's text,
			// and keeps the upload as its uploader's private file.
			const { resource, privateFile } = await stageResourceAcquisition(this.env, step, target, processingId);
			const uploadedPaper = privateFile !== null;
			const ownedBlobId = target.kind === 'storedBlob' ? target.resourceId : undefined;
			const persistenceTarget: ResourcePersistenceTarget =
				target.kind === 'draft'
					? { kind: 'draft', ...(target.relation ? { relation: target.relation } : {}) }
					: uploadedPaper
						? { kind: 'draft', ownedBlobId }
						: {
								kind: 'existing',
								resourceId: target.resourceId,
								fence: fence!,
								...(target.kind === 'reacquire' && target.force ? { force: true } : {}),
								...(ownedBlobId ? { ownedBlobId } : {}),
							};
			const saveTarget =
				target.kind === 'draft'
					? (target.saveTarget ?? null)
					: target.kind === 'storedBlob'
						? ({ kind: 'userFileResult', fileResourceId: target.resourceId, workflowId: event.instanceId } as const)
						: null;

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
			const translationTargets: { resourceId: string; translationRevision: string; forceRunKey?: string; stepName: string }[] = [];
			// Ordinary imports share a translation; explicit reacquisition forces a fresh run.
			const forceProcessingRunKey = target.kind === 'draft' ? undefined : hash('sha256', event.instanceId, 'hex').slice(0, 16);
			if (privateFile && target.kind === 'storedBlob') {
				const privateRendition = prepareResolvedResource({ ...privateFile, summary: privateFile.summary ?? summary }, hostedImages);
				const privatePersistence = await step.do('persist-private-pdf-rendition-v3', STORAGE_STEP, async () =>
					persistResolvedResource(await connectCoreDb(this.env), privateRendition, {
						kind: 'existing',
						resourceId: target.resourceId,
						fence: fence!,
						ownedBlobId,
					}),
				);
				if (privatePersistence.superseded) {
					await task.report('persist-superseded', { stage: 'persisting', status: 'superseded' });
					return { resourceId: target.resourceId };
				}
				if (shouldEnqueueResourceTranslation(privatePersistence))
					translationTargets.push({
						resourceId: privatePersistence.resourceId,
						translationRevision: privatePersistence.originalHash,
						forceRunKey: forceProcessingRunKey,
						stepName: 'enqueue-private-pdf-translation-v2',
					});
			}
			const preparedResource = prepareResolvedResource(summarized, hostedImages);
			const persistence = await step.do('persist-resolved-resource-scope-v6', STORAGE_STEP, async () => {
				const startedAt = Date.now();
				const db = await connectCoreDb(this.env);
				const connectedAt = Date.now();
				const result = await persistResolvedResource(db, preparedResource, persistenceTarget);
				const completedAt = Date.now();
				console.info('resource-persistence-timing', {
					instanceId: event.instanceId,
					resourceId: result.resourceId,
					connectMs: connectedAt - startedAt,
					transactionMs: completedAt - connectedAt,
					totalMs: completedAt - startedAt,
				});
				return result;
			});
			if (persistence.superseded) {
				await task.report('persist-superseded', { stage: 'persisting', status: 'superseded' });
				return { resourceId: persistence.resourceId };
			}
			const { resourceId: persistedResourceId, scope, subjectAttached, originalHash } = persistence;
			if (shouldEnqueueResourceTranslation(persistence))
				translationTargets.push({
					resourceId: persistedResourceId,
					translationRevision: originalHash,
					forceRunKey: persistence.originalWritten ? forceProcessingRunKey : undefined,
					stepName: 'enqueue-resource-translation-v4',
				});
			if (scope === 'corpus' && persistence.fileType === 'application/pdf') {
				await step.do('publish-public-pdf-crops-v1', STORAGE_STEP, async () =>
					publishPublicPdfCrops(
						this.env,
						persistedResourceId,
						await loadPublicPdfContent(await connectCoreDb(this.env), persistedResourceId),
					),
				);
			}

			if (saveTarget)
				await step.do('complete-resource-save-v2', STORAGE_STEP, () => this.env.APP.completeResourceSave(persistedResourceId, saveTarget));
			publishedResourceId = persistedResourceId;

			const subjectUrl = resource.subjectUrl;
			// Crossref enrichment is background work that no import waits on.
			const references =
				scope === 'corpus' &&
				persistence.kind === 'paper' &&
				persistence.originalWritten &&
				preparedResource.references?.some(({ doi, arxivId }) => !doi && !arxivId)
					? stageResourceReferences(this.env, step, persistedResourceId).catch((error: unknown) => {
							console.error({ tag: 'WORKFLOW', msg: 'Reference enrichment failed', resource_id: persistedResourceId, error });
						})
					: undefined;

			const followups = Promise.allSettled([
				task.report('ready', {
					stage: 'persisting',
					status: 'complete',
					resourceId: persistedResourceId,
				}),
				scope === 'corpus'
					? step.do('enqueue-resolved-ai-search-sync-v2', STORAGE_STEP, async () => {
							await this.env.RESOURCE_SEARCH_SYNC_QUEUE.send({ resourceId: persistedResourceId });
						})
					: undefined,
				...translationTargets.map(({ stepName, resourceId, translationRevision, forceRunKey }) =>
					step.do(stepName, STORAGE_STEP, () => enqueueResourceTranslation(this.env, resourceId, translationRevision, forceRunKey, task)),
				),
				subjectUrl && persistence.originalWritten && !subjectAttached
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
			]).then(async ([ready, ...dispatches]) => {
				const failures = [ready, ...dispatches].flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
				await task.seal(failures.length ? 'followup_dispatch_failed' : undefined);
				if (failures.length) throw new AggregateError(failures, 'Resource persisted, but one or more follow-ups failed');
			});
			// Keep every durable branch awaited even when an independent handoff fails.
			const [, dispatched] = await Promise.allSettled([references, followups]);
			if (dispatched.status === 'rejected') throw dispatched.reason;

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
