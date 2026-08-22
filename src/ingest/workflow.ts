import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import { resourceImageSourceUrls } from '@core-shared/resource-image-mapping';
import { DEFAULT_RESOURCE_LANG } from '@core-shared/resource-types';
import type { ResolvedResource } from '@core-shared/types';
import { connectCoreDb } from '@db/connection';
import { loadResourceReacquisitionInput, loadStoredPdfInput, markStoredBlobProcessingFailed } from '@ingest/stored-resource';
import { AI_SEARCH_SYNC_STEP_CONFIG, syncCorpusItem } from '../ai-search';
import { DURABLE_WORKFLOW_RETRIES } from '../workflow-control';
import { stageStoredPdfResource, stageUrlAcquisition } from './acquisition';
import { classifyResource } from './domain/resource-classification';
import { stageResourceImages } from './hosted-images';
import { enqueueSubjectDraft, parseResourceProcessingWorkflowPayload, type ResourceProcessingWorkflowPayload } from './resource-admission';
import { type PersistProcessedTarget, persistProcessedResource } from './resource-persistence';
import { enqueueResourceTranslation } from './resource-translation-workflow';

const WORKFLOW_ENQUEUE_STEP_CONFIG = {
	retries: DURABLE_WORKFLOW_RETRIES,
	timeout: '30 seconds',
} as const satisfies WorkflowStepConfig;
type ResolvedProcessingCall = {
	resource: ResolvedResource;
	persistenceTarget: PersistProcessedTarget;
};

async function resolveProcessingCall(
	env: CoreEnv,
	step: WorkflowStep,
	target: ResourceProcessingWorkflowPayload['target'],
	instanceId: string,
): Promise<ResolvedProcessingCall> {
	if (target.kind === 'draft') {
		const origin = {
			originalLang: target.sourceHints?.originalLang ?? DEFAULT_RESOURCE_LANG,
			summary: target.sourceHints?.summary ?? null,
			url: target.url,
			publishedDate: target.sourceHints?.publishedDate ?? null,
			tags: [],
			keywords: target.sourceHints?.keywords ?? [],
			normalizedUrl: target.url,
			resourceIdentifiers: [],
		};
		return {
			resource: await stageUrlAcquisition(env, step, {
				discoverRelatedContent: target.admission.kind !== 'source',
				isMonitoredOnly: target.admission.kind === 'source',
				origin,
				processingId: instanceId,
				...(target.providerSequence ? { providerSequence: target.providerSequence } : {}),
				sourceAvatarUrl: target.sourceHints?.sourceAvatarUrl ?? null,
				sourceUrl: target.url,
				translatePaperUrl: target.admission.kind !== 'source',
			}),
			persistenceTarget: {
				kind: 'draft',
				admission: target.admission,
				providerSequence: target.providerSequence ?? null,
			},
		};
	}

	if (target.kind === 'storedBlob') {
		const storedPdf = await step.do(
			'load-stored-pdf-input-v1',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => loadStoredPdfInput(await connectCoreDb(env), target.resourceId),
			{
				rollback: async () => markStoredBlobProcessingFailed(await connectCoreDb(env), target.resourceId),
				rollbackConfig: {
					retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
					timeout: '30 seconds',
				},
			},
		);
		return stageStoredPdfResource(env, step, storedPdf);
	}

	const snapshot = await step.do(
		'load-resource-reacquisition-input-v1',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		async () => loadResourceReacquisitionInput(await connectCoreDb(env), target.resourceId),
	);
	return {
		resource: await stageUrlAcquisition(env, step, {
			discoverRelatedContent: true,
			isMonitoredOnly: snapshot.isMonitoredOnly,
			origin: snapshot,
			processingId: target.resourceId,
			sourceAvatarUrl: snapshot.sourceAvatarUrl,
			sourceUrl: snapshot.url,
			translatePaperUrl: snapshot.translatePaperUrl,
		}),
		persistenceTarget: {
			kind: 'existing',
			resourceId: target.resourceId,
			storageKey: snapshot.storageKey,
		},
	};
}

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceProcessingWorkflowPayload> {
	async run(event: WorkflowEvent<ResourceProcessingWorkflowPayload>, step: WorkflowStep) {
		const { target } = parseResourceProcessingWorkflowPayload(event.payload);
		const processingId = target.kind === 'draft' ? event.instanceId : target.resourceId;
		const call = await resolveProcessingCall(this.env, step, target, event.instanceId);
		const resource = call.resource;

		console.info({
			tag: 'WORKFLOW',
			msg: 'Starting',
			resourceKind: resource.kind,
			resourcePlatform: resource.resourcePlatform,
			processing_id: processingId,
			target_kind: target.kind,
		});
		const imageSources = resourceImageSourceUrls({
			creators: resource.creators,
			kindMetadata: resource.kindMetadata,
			ogImageUrl: resource.previewImageUrl,
		});
		const [classification, hostedImages] = await Promise.all([
			step.do('classify-resource', { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' }, () =>
				classifyResource(resource, this.env, processingId),
			),
			stageResourceImages(this.env, step, processingId, imageSources),
		]);
		const persistence = await step.do(
			'persist-resolved-resource-v1',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() => persistProcessedResource(this.env, { classification, resource, target: call.persistenceTarget }, hostedImages),
		);
		if (!persistence.persisted) {
			return { resourceId: persistence.resourceId };
		}
		const persistedResourceId = persistence.resourceId;
		const translationRevision = persistence.translationRevision;
		const followUps: Promise<unknown>[] = [
			step.do('sync-resolved-ai-search-v1', AI_SEARCH_SYNC_STEP_CONFIG, async () => {
				const db = await connectCoreDb(this.env);
				await Promise.all(
					[persistedResourceId, ...persistence.retiredResourceIds].map((resourceId) => syncCorpusItem(this.env, db, resourceId)),
				);
			}),
		];
		if (translationRevision) {
			followUps.push(
				step.do('enqueue-resource-translation-v2', WORKFLOW_ENQUEUE_STEP_CONFIG, () =>
					enqueueResourceTranslation(this.env, persistedResourceId, translationRevision),
				),
			);
		}
		const subject = resource.subject;
		if (subject && !persistence.subjectAttached) {
			followUps.push(
				step.do('enqueue-resolved-subject-child-v1', WORKFLOW_ENQUEUE_STEP_CONFIG, () =>
					enqueueSubjectDraft(this.env, {
						parentResourceId: persistedResourceId,
						url: subject.normalizedUrl,
					}),
				),
			);
		}
		await Promise.all(followUps);

		console.info({ tag: 'WORKFLOW', msg: 'Completed', resource_id: persistedResourceId, target_kind: target.kind });
		return { resourceId: persistedResourceId };
	}
}
