import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { connectCoreDb } from '../shared/db';
import { sha256Hex } from '../shared/hash';
import { resourceImageSourceUrls } from '../shared/image-mapping';
import { stageResourceAcquisition } from './acquisition';
import { ResourceDraftTargetSchema, ResourceProcessingTargetSchema, type ResourceProcessingTarget } from './admission';
import { summarizeResource, classifyResource } from './analysis';
import { stageResourceImages } from './image-rehosting';
import { withoutPrivatePdfImages } from './pdf-markdown.ts';
import { stageYouTubeHighlights } from './platforms/youtube';
import { createResourceTask, enqueueSearchProgress, registerResourceTask } from './progress';
import {
	persistResolvedResource,
	persistResourceClassification,
	loadPublicPdfContent,
	prepareResolvedResource,
	type ResourcePersistenceTarget,
} from './resource-persistence';
import { stageResourceReferences } from './resource-references';
import { enqueueResourceTranslation, shouldEnqueueResourceTranslation } from './translation-workflow';
import { publishPublicPdfCrops } from './zotero-sdt-service.ts';

const STORAGE_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
const AI_STEP = { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' } as const;

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
			const processingId = target.kind === 'draft' ? event.instanceId : target.resourceId;
			const resource = await stageResourceAcquisition(this.env, step, target, processingId);
			const uploadedPaper = target.kind === 'storedBlob' && resource.kind === 'paper';
			const ownedBlobId = target.kind === 'storedBlob' ? target.resourceId : undefined;
			const persistenceTarget: ResourcePersistenceTarget =
				target.kind === 'draft'
					? { kind: 'draft', ...(target.relation ? { relation: target.relation } : {}) }
					: uploadedPaper
						? { kind: 'draft', ownedBlobId }
						: { kind: 'existing', resourceId: target.resourceId, ...(ownedBlobId ? { ownedBlobId } : {}) };
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
			const [summary, hostedImages] = await Promise.all([
				resource.summary ?? step.do('summarize-resource-v2', AI_STEP, () => summarizeResource(resource, this.env, processingId)),
				stageResourceImages(this.env, step, processingId, imageSources, target.kind === 'reacquire' ? event.instanceId : undefined),
			]);
			const summarized = { ...resource, summary };
			await task.report('persisting', { stage: 'persisting', status: 'running' });
			const translationTargets: { resourceId: string; translationRevision: string; forceRunKey?: string; stepName: string }[] = [];
			// Ordinary imports share a translation; explicit reacquisition forces a fresh run.
			const forceProcessingRunKey = target.kind === 'draft' ? undefined : (await sha256Hex(event.instanceId)).slice(0, 16);
			const classificationTargets: Parameters<typeof persistResourceClassification>[1][] = [];
			if (uploadedPaper) {
				const privateRendition = prepareResolvedResource(
					{
						...summarized,
						kind: 'file',
						kindMetadata: null,
						resourcePlatform: null,
						resourceIdentifiers: [],
						url: null,
						subject: null,
					},
					hostedImages,
				);
				const privatePersistence = await step.do('persist-private-pdf-rendition-v2', STORAGE_STEP, async () =>
					persistResolvedResource(await connectCoreDb(this.env), privateRendition, {
						kind: 'existing',
						resourceId: target.resourceId,
						ownedBlobId,
					}),
				);
				if (shouldEnqueueResourceTranslation(privatePersistence))
					translationTargets.push({
						...privatePersistence,
						forceRunKey: forceProcessingRunKey,
						stepName: 'enqueue-private-pdf-translation-v2',
					});
				classificationTargets.push(privatePersistence);
			}
			const preparedResource = prepareResolvedResource(
				uploadedPaper ? { ...summarized, content: withoutPrivatePdfImages(resource.content) } : summarized,
				hostedImages,
			);
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
			const { resourceId: persistedResourceId, scope, subjectAttached, translationRevision, acquisitionRevision } = persistence;
			if (persistence.originalWritten) classificationTargets.push(persistence);
			if (shouldEnqueueResourceTranslation(persistence))
				translationTargets.push({
					resourceId: persistedResourceId,
					translationRevision,
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

			const subject = resource.subject;
			// Let independent background work and handoffs finish before reporting failures.
			const [ready, references, highlights, ...followups] = await Promise.allSettled([
				task.report('ready', {
					stage: 'persisting',
					status: 'complete',
					resourceId: persistedResourceId,
				}),
				scope === 'corpus' &&
				persistence.kind === 'paper' &&
				(preparedResource.citations?.references.length || !persistence.originalWritten)
					? stageResourceReferences(this.env, step, persistedResourceId, translationRevision, task)
					: undefined,
				preparedResource.youtube && persistence.originalWritten
					? stageYouTubeHighlights(this.env, step, persistence, preparedResource.youtube)
					: undefined,
				(async () => {
					if (classificationTargets.length) {
						try {
							const classification = await step.do('classify-published-resource-v1', AI_STEP, () =>
								classifyResource(summarized, this.env, processingId),
							);
							await step.do('persist-resource-classification-v1', STORAGE_STEP, async () => {
								const db = await connectCoreDb(this.env);
								for (const target of classificationTargets) await persistResourceClassification(db, target, classification);
							});
						} catch (error) {
							console.error({ tag: 'WORKFLOW', msg: 'Classification failed', resource_id: persistedResourceId, error });
						}
					}
					// Classification is optional; handing the published body to search is required.
					if (scope === 'corpus')
						await step.do('enqueue-resolved-ai-search-sync-v2', STORAGE_STEP, () =>
							enqueueSearchProgress(this.env, persistedResourceId, task, translationRevision),
						);
				})(),
				...translationTargets.map(({ stepName, resourceId, translationRevision, forceRunKey }) =>
					step.do(stepName, STORAGE_STEP, () => enqueueResourceTranslation(this.env, resourceId, translationRevision, forceRunKey, task)),
				),
				subject && persistence.originalWritten && !subjectAttached
					? step.do('enqueue-resolved-subject-child-v2', STORAGE_STEP, async () => {
							const subjectTarget = ResourceDraftTargetSchema.parse({
								kind: 'draft',
								relation: { kind: 'subject', parentResourceId: persistedResourceId, parentAcquisitionRevision: acquisitionRevision },
								// Carrier-resolved hints only; the subject page still wins when it states its own date.
								...(resource.publishedDate ? { sourceHints: { publishedDate: resource.publishedDate } } : {}),
								url: subject.url,
							});
							// Separate tracked and automatic executions so neither inherits the other's progress ledger.
							const prefix = task.required ? 'subject-draft-v4' : 'subject-draft-auto-v1';
							const id = `${prefix}-${await sha256Hex(JSON.stringify(subjectTarget))}`;
							await registerResourceTask(this.env, { taskId: id, kind: 'processing' }, task);
							await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([{ id, params: { ...subjectTarget, progress: task.required } }]);
							return id;
						})
					: undefined,
			]);
			for (const outcome of [references, highlights]) {
				if (outcome.status === 'rejected')
					console.error({ tag: 'WORKFLOW', msg: 'Background work failed', resource_id: persistedResourceId, error: outcome.reason });
			}
			const failures = [ready, ...followups].flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
			await task.seal(failures.length ? 'followup_dispatch_failed' : undefined);
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
