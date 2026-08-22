import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import { paperIdentifiersFromIdentity, resolveExactPaperInput } from '@core-shared/paper-identity';
import { isPaperIdentifier, normalizeResourceIdentifiers, type ResourceIdentifier } from '@core-shared/resource-identifiers';
import { type HostedResourceImage, resourceImageSourceUrls } from '@core-shared/resource-image-mapping';
import { DEFAULT_RESOURCE_LANG } from '@core-shared/resource-types';
import type { MaterializedResource, ResolvedResource } from '@core-shared/types';
import { canonicalResourcePlatformUrl } from '@core-shared/url';
import { connectCoreDb } from '@db/connection';
import { loadResourceReacquisitionInput, loadStoredPdfInput } from '@ingest/stored-resource';
import { AI_SEARCH_SYNC_STEP_CONFIG, syncCorpusItem } from '../ai-search';
import { DURABLE_WORKFLOW_RETRIES } from '../workflow-control';
import {
	type AcquiredContent,
	acquiredContentArtifact,
	ResourceProcessingRejectedError,
	readAcquiredContentArtifact,
	sanitizeAcquiredContent,
	stagePlatformEnrichment,
	stageSavedUrlAcquisition,
} from './acquisition';
import { classifyResource } from './domain/resource-classification';
import { applyPaperEnrichment, stagePaperProcessing } from './platforms/paper';
import { acquireStoredPdf } from './platforms/pdf';
import { enqueueSubjectDraft, parseResourceProcessingWorkflowPayload, type ResourceProcessingWorkflowPayload } from './resource-admission';
import { rehostResourceImage } from './resource-image-rehosting';
import { markStoredBlobProcessingFailed, type PersistProcessedTarget, persistProcessedResource } from './resource-persistence';
import { exactPlatformLocator, materializeAcquiredResource, type ResourcePlatformLocator } from './resource-resolver';
import { enqueueResourceTranslation } from './resource-translation-workflow';

const WORKFLOW_ENQUEUE_STEP_CONFIG = {
	retries: DURABLE_WORKFLOW_RETRIES,
	timeout: '30 seconds',
} as const satisfies WorkflowStepConfig;
async function stageResourceImages(
	env: CoreEnv,
	step: WorkflowStep,
	processingId: string,
	sourceUrls: readonly string[],
): Promise<HostedResourceImage[]> {
	if (sourceUrls.length === 0) return [];
	let images: HostedResourceImage[];
	try {
		images = await step.do(
			'rehost-resource-images-v2',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '10 minutes' },
			async () => {
				const hosted: HostedResourceImage[] = [];
				for (let offset = 0; offset < sourceUrls.length; offset += 3) {
					hosted.push(...(await Promise.all(sourceUrls.slice(offset, offset + 3).map((url) => rehostResourceImage(env.IMAGES, url)))));
				}
				return hosted;
			},
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error({ tag: 'RESOURCE_IMAGE', event: 'eager_rehost_failed', processing_id: processingId, error: message });
		throw new ResourceProcessingRejectedError(`Processing ${processingId} failed to host canonical images: ${message}`);
	}
	console.info({
		tag: 'RESOURCE_IMAGE',
		event: 'eager_rehost_completed',
		processing_id: processingId,
		ready: images.length,
	});
	return images;
}

type ResourceMaterializationSeed = Pick<
	MaterializedResource,
	'keywords' | 'normalizedUrl' | 'originalLang' | 'publishedDate' | 'resourceIdentifiers' | 'summary' | 'tags' | 'url'
>;

type ResolvedProcessingCall = {
	processingId: string;
	acquiredContent: AcquiredContent;
	origin: ResourceMaterializationSeed;
	translatePaperUrl: boolean;
	persistenceTarget: PersistProcessedTarget;
};

async function resolveProcessingCall(
	env: CoreEnv,
	step: WorkflowStep,
	target: ResourceProcessingWorkflowPayload['target'],
	instanceId: string,
): Promise<ResolvedProcessingCall> {
	if (target.kind === 'draft') {
		return {
			processingId: instanceId,
			acquiredContent: await stageSavedUrlAcquisition(
				env,
				step,
				{
					discoverRelatedContent: target.admission.kind !== 'source',
					isMonitoredOnly: target.admission.kind === 'source',
					processingId: instanceId,
					sourceAvatarUrl: target.sourceHints?.sourceAvatarUrl ?? null,
					sourceUrl: target.url,
				},
				target.providerSequence,
			),
			origin: {
				originalLang: target.sourceHints?.originalLang ?? DEFAULT_RESOURCE_LANG,
				summary: target.sourceHints?.summary ?? null,
				url: target.url,
				publishedDate: target.sourceHints?.publishedDate ?? null,
				tags: [],
				keywords: target.sourceHints?.keywords ?? [],
				normalizedUrl: target.url,
				resourceIdentifiers: [],
			},
			translatePaperUrl: target.admission.kind !== 'source',
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
				rollback: async ({ output }) => {
					if (!output) return;
					await markStoredBlobProcessingFailed(await connectCoreDb(env), target.resourceId, output.sourceRevision);
				},
				rollbackConfig: {
					retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
					timeout: '30 seconds',
				},
			},
		);
		return {
			processingId: target.resourceId,
			acquiredContent: await readAcquiredContentArtifact(
				await step.do(
					'acquire-stored-pdf-v1',
					{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
					async () => acquiredContentArtifact(await sanitizeAcquiredContent(await acquireStoredPdf(env, storedPdf))),
				),
			),
			origin: storedPdf,
			translatePaperUrl: false,
			persistenceTarget: {
				kind: 'storedPdf',
				resourceId: target.resourceId,
				expectedSourceRevision: storedPdf.sourceRevision,
				storageKey: storedPdf.storageKey,
			},
		};
	}

	const snapshot = await step.do(
		'load-resource-reacquisition-input-v1',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		async () => loadResourceReacquisitionInput(await connectCoreDb(env), target.resourceId),
	);
	const locator = exactPlatformLocator(snapshot.resourceIdentifiers);
	const sourceUrl = locator ? canonicalResourcePlatformUrl(locator.resourcePlatform, locator.platformId) : snapshot.url;
	if (!sourceUrl) throw new ResourceProcessingRejectedError(`Resource processing ${target.resourceId} has no source URL`);
	return {
		processingId: target.resourceId,
		acquiredContent: await stageSavedUrlAcquisition(env, step, {
			discoverRelatedContent: true,
			isMonitoredOnly: snapshot.isMonitoredOnly,
			processingId: target.resourceId,
			sourceAvatarUrl: snapshot.sourceAvatarUrl,
			sourceUrl,
		}),
		origin: snapshot,
		translatePaperUrl: snapshot.translatePaperUrl,
		persistenceTarget: {
			kind: 'existing',
			resourceId: target.resourceId,
			expectedSourceRevision: snapshot.sourceRevision,
			storageKey: snapshot.storageKey,
		},
	};
}

function resolveProcessingIdentity(call: ResolvedProcessingCall): {
	canonicalUrl: string | null;
	platformIdentity: ResourcePlatformLocator | null;
	resourceIdentifiers: ResourceIdentifier[];
} {
	const canonicalUrl = call.acquiredContent.canonicalUrl?.trim() || call.origin.url;
	const exactPaper = resolveExactPaperInput(call.origin.url ?? canonicalUrl);
	const platformIdentity =
		exactPaper || call.acquiredContent.resourcePlatform === null
			? null
			: { resourcePlatform: call.acquiredContent.resourcePlatform, platformId: call.acquiredContent.platformId };
	const discoveredIdentifiers = exactPaper
		? paperIdentifiersFromIdentity(exactPaper.identity)
		: platformIdentity
			? [{ preferred: true, scheme: platformIdentity.resourcePlatform, value: platformIdentity.platformId } as const]
			: [];
	return {
		canonicalUrl,
		platformIdentity,
		resourceIdentifiers: normalizeResourceIdentifiers([...call.origin.resourceIdentifiers, ...discoveredIdentifiers]),
	};
}

async function prepareResourceForProcessing(env: CoreEnv, step: WorkflowStep, call: ResolvedProcessingCall): Promise<ResolvedResource> {
	const { acquiredContent: initialAcquiredContent, origin, processingId } = call;
	const { canonicalUrl, platformIdentity, resourceIdentifiers } = resolveProcessingIdentity(call);
	let publishedDate = origin.publishedDate;
	if (initialAcquiredContent.publishedDate?.trim()) {
		const parsed = new Date(initialAcquiredContent.publishedDate);
		if (!Number.isNaN(parsed.getTime())) publishedDate = parsed.toISOString();
	}
	const paper = await stagePaperProcessing(env, step, {
		acquiredContent: initialAcquiredContent,
		canonicalUrl,
		identifiers: resourceIdentifiers.filter(isPaperIdentifier),
		originSummary: origin.summary,
		processingId,
		publishedDate,
		resourcePlatform: platformIdentity?.resourcePlatform ?? null,
		translateUrl: call.translatePaperUrl,
	});
	const acquiredContent = paper.acquiredContent;
	let resource = materializeAcquiredResource(acquiredContent, origin, {
		canonicalUrl,
		platformIdentity,
		publishedDate,
		resourceIdentifiers: normalizeResourceIdentifiers([...paper.identifiers, ...resourceIdentifiers]),
	});
	if (!acquiredContent.markdown.trim()) {
		throw new ResourceProcessingRejectedError(`Processing ${processingId} has no extractable content`);
	}
	resource = applyPaperEnrichment(resource, paper.metadata);
	return stagePlatformEnrichment(env, step, acquiredContent, resource, processingId);
}

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceProcessingWorkflowPayload> {
	async run(event: WorkflowEvent<ResourceProcessingWorkflowPayload>, step: WorkflowStep) {
		const { target } = parseResourceProcessingWorkflowPayload(event.payload);
		const processingId = target.kind === 'draft' ? event.instanceId : target.resourceId;
		try {
			const call = await resolveProcessingCall(this.env, step, target, event.instanceId);
			const resource = await prepareResourceForProcessing(this.env, step, call);

			console.info({
				tag: 'WORKFLOW',
				msg: 'Starting',
				resourceKind: resource.kind,
				resourcePlatform: resource.resourcePlatform,
				processing_id: processingId,
				target_kind: target.kind,
			});
			let imageSources: string[];
			try {
				imageSources = resourceImageSourceUrls({
					creators: resource.creators,
					kindMetadata: resource.kindMetadata,
					ogImageUrl: resource.previewImageUrl,
				});
			} catch (error) {
				throw new ResourceProcessingRejectedError(
					`Resource processing ${processingId} has an invalid canonical image source: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const [classification, hostedImages] = await Promise.all([
				step.do('classify-resource', { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' }, () =>
					classifyResource(resource, this.env, processingId),
				),
				stageResourceImages(this.env, step, processingId, imageSources),
			]);
			const persistence = await step.do(
				'persist-resolved-resource-v1',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => persistProcessedResource(this.env, { classification, processingId, resource, target: call.persistenceTarget }, hostedImages),
			);
			if (!persistence.persisted) {
				return { status: 'superseded', resourceId: persistence.resourceId } as const;
			}
			const persistedResourceId = persistence.resourceId;
			const translationRevision = persistence.translationRevision;
			const followUps: Promise<unknown>[] = [
				step.do('sync-resolved-ai-search-v1', AI_SEARCH_SYNC_STEP_CONFIG, async () => {
					const db = await connectCoreDb(this.env);
					return Promise.all(
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
							parentRevision: resource.sourceRevision,
							url: subject.url,
						}),
					),
				);
			}
			await Promise.all(followUps);

			console.info({ tag: 'WORKFLOW', msg: 'Completed', resource_id: persistedResourceId, target_kind: target.kind });
			return {
				status: 'persisted',
				resourceId: persistedResourceId,
				...(target.kind === 'reacquire' ? { changed: true } : {}),
			} as const;
		} catch (error) {
			if (target.kind === 'draft' && error instanceof ResourceProcessingRejectedError) {
				console.info({
					tag: 'WORKFLOW',
					msg: 'Rejected resource draft',
					processing_id: processingId,
					reason: error.message,
				});
				return { status: 'rejected', reason: error.message } as const;
			}
			throw error;
		}
	}
}
