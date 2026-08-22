import {
	type WorkflowDelayFunction,
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
	type WorkflowStepConfig,
} from 'cloudflare:workers';
import type { YouTubeSpecializationMutation } from '@app-domain/resource-graph-contracts';
import { paperIdentifiersFromIdentity, resolveExactPaperInput } from '@core-shared/paper-identity';
import { isPaperIdentifier, normalizeResourceIdentifiers } from '@core-shared/resource-identifiers';
import { type HostedResourceImage, resourceImageSourceUrls } from '@core-shared/resource-image-mapping';
import { DEFAULT_RESOURCE_LANG } from '@core-shared/resource-types';
import type { ResourceForProcessing } from '@core-shared/types';
import { canonicalResourcePlatformUrl, detectResourceUrl } from '@core-shared/url';
import { loadStoredResourceForProcessing, type StoredResourceProcessingInput } from '@ingest/domain/resource-store';
import { AI_SEARCH_SYNC_STEP_CONFIG, syncCorpusItem } from '../ai-search';
import { DURABLE_WORKFLOW_RETRIES, shouldReconcileSupersededRefresh } from '../workflow-control';
import {
	ACQUISITION_STEP,
	type AcquiredContent,
	acquiredContentArtifact,
	readAcquiredContentArtifact,
	readSavedUrlAcquisitionArtifact,
	sanitizeAcquiredContent,
	scrapeSavedUrlArtifact,
} from './acquisition';
import { classifyResource } from './domain/resource-classification';
import { resourceSourceRevision } from './domain/resource-revision';
import { stageHackerNewsAnnotation } from './platforms/hackernews';
import { applyPaperEnrichment, privatePaperAttachment, stagePaperEnrichment } from './platforms/paper';
import { stageOpenAlexContentAcquisition } from './platforms/paper-content';
import { acquireStoredPdf, PDF_MIME } from './platforms/pdf';
import { stageYouTubeEnrichment } from './platforms/youtube';
import {
	type ExistingResourceTarget,
	enqueueSubjectDraft,
	enqueueSupersededResourceRefresh,
	parseResourceProcessingWorkflowPayload,
	type ResourceDraftTarget,
	type ResourceProcessingWorkflowPayload,
} from './resource-admission';
import { rehostResourceImage } from './resource-image-rehosting';
import { markStoredBlobProcessingFailed, persistProcessedResource } from './resource-persistence';
import { exactPlatformLocator, materializeAcquiredResource, type ResolvedSubjectInput, resolvedSubjectInput } from './resource-resolver';
import { enqueueResourceTranslation } from './resource-translation-workflow';

class ResourceProcessingRejectedError extends Error {}

const RESOURCE_TRANSLATION_ADMISSION_STEP_CONFIG = {
	retries: DURABLE_WORKFLOW_RETRIES,
	timeout: '30 seconds',
} as const satisfies WorkflowStepConfig;
// Source watermarks can advance after refresh admission, so the acquisition
// instance itself must survive a provider outage. Keep attempts bounded because
// twitterapi.io requests (especially Article requests) are paid operations.
const resourceRefreshRetryDelay: WorkflowDelayFunction = ({ ctx }) =>
	ctx.attempt <= 3 ? '10 seconds' : ctx.attempt <= 15 ? '1 minute' : '30 minutes';
const RESOURCE_REFRESH_ACQUISITION_STEP_CONFIG = {
	retries: { limit: 50, delay: resourceRefreshRetryDelay },
	timeout: '120 seconds',
} as const satisfies WorkflowStepConfig;

async function stageResourceImages(
	env: CoreEnv,
	step: WorkflowStep,
	processingId: string,
	sourceUrls: readonly string[],
): Promise<HostedResourceImage[]> {
	const images: HostedResourceImage[] = [];
	for (let offset = 0; offset < sourceUrls.length; offset += 3) {
		const batch = sourceUrls.slice(offset, offset + 3);
		const results = await Promise.allSettled(
			batch.map((sourceUrl, batchIndex) => {
				const index = offset + batchIndex;
				return step.do(
					`rehost-resource-image-${index + 1}-v1`,
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
					() => rehostResourceImage(env.IMAGES, sourceUrl),
				);
			}),
		);
		for (const [index, result] of results.entries()) {
			if (result.status === 'fulfilled') {
				images.push(result.value);
				continue;
			}
			console.error({
				tag: 'RESOURCE_IMAGE',
				event: 'eager_rehost_failed',
				processing_id: processingId,
				source_host: new URL(batch[index]!).hostname,
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
		const failed = results.filter((result) => result.status === 'rejected').length;
		if (failed) {
			throw new ResourceProcessingRejectedError(
				`Processing ${processingId} failed to host ${failed} canonical image${failed === 1 ? '' : 's'}`,
			);
		}
	}
	if (sourceUrls.length > 0) {
		console.info({
			tag: 'RESOURCE_IMAGE',
			event: 'eager_rehost_completed',
			processing_id: processingId,
			ready: images.length,
			failed: sourceUrls.length - images.length,
		});
	}
	return images;
}

async function stageSavedUrlAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		discoverTwitterThread: boolean;
		isMonitoredOnly: boolean;
		processingId: string;
		sourceAvatarUrl: string | null;
		sourceUrl: string;
	},
	expectedProviderRevision?: string,
): Promise<AcquiredContent> {
	const expectsProviderRevision = !!expectedProviderRevision;
	const stepConfig = expectsProviderRevision ? RESOURCE_REFRESH_ACQUISITION_STEP_CONFIG : ACQUISITION_STEP;
	const acquisition = await readSavedUrlAcquisitionArtifact(
		await step.do('acquire-content-kind-platform-v1', stepConfig, (ctx) => {
			if (expectsProviderRevision) {
				console.info({
					tag: 'RESOURCE_ACQUISITION',
					event: 'refresh_acquisition_attempt',
					resource_id: input.processingId,
					resource_platform: detectResourceUrl(input.sourceUrl)?.resourcePlatform ?? null,
					expects_provider_revision: expectsProviderRevision,
					attempt: ctx.attempt,
				});
			}
			return scrapeSavedUrlArtifact(
				input.sourceUrl,
				env,
				input.isMonitoredOnly,
				input.sourceAvatarUrl,
				input.processingId,
				expectedProviderRevision,
				input.discoverTwitterThread,
			);
		}),
	);
	if (acquisition.status === 'rejected') {
		throw new ResourceProcessingRejectedError(acquisition.message);
	}
	return acquisition.content;
}

type PreparedResource = {
	previewImageUrl: string | null;
	resource: ResourceForProcessing;
	subject: ResolvedSubjectInput | null;
	youtube: YouTubeSpecializationMutation | null;
};

type ResourcePreparationInput =
	| (ResourceDraftTarget & {
			processingId: string;
	  })
	| (ExistingResourceTarget & {
			stored: StoredResourceProcessingInput;
	  });

async function acquireDraftResource(
	env: CoreEnv,
	step: WorkflowStep,
	input: Extract<ResourcePreparationInput, { kind: 'draft' }>,
): Promise<AcquiredContent> {
	return stageSavedUrlAcquisition(
		env,
		step,
		{
			discoverTwitterThread: input.admission.kind !== 'source',
			isMonitoredOnly: input.admission.kind === 'source',
			processingId: input.processingId,
			sourceAvatarUrl: input.sourceHints?.sourceAvatarUrl ?? null,
			sourceUrl: input.url,
		},
		input.expectedProviderRevision,
	);
}

async function acquireExistingResource(
	env: CoreEnv,
	step: WorkflowStep,
	input: Extract<ResourcePreparationInput, { kind: 'storedBlob' | 'reacquire' }>,
): Promise<AcquiredContent> {
	const storedResource = input.stored.resource;
	if (input.kind === 'storedBlob') {
		return readAcquiredContentArtifact(
			await step.do(
				'acquire-stored-pdf-v1',
				{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
				async () => acquiredContentArtifact(await sanitizeAcquiredContent(await acquireStoredPdf(env, storedResource))),
			),
		);
	}
	const locator = exactPlatformLocator(storedResource.resource_identifiers);
	const sourceUrl = locator ? canonicalResourcePlatformUrl(locator.resourcePlatform, locator.platformId) : storedResource.url;
	if (!sourceUrl) {
		throw new ResourceProcessingRejectedError(`Resource processing ${storedResource.processing_id} has no source URL`);
	}
	return stageSavedUrlAcquisition(
		env,
		step,
		{
			discoverTwitterThread: true,
			isMonitoredOnly: input.stored.isMonitoredOnly,
			processingId: storedResource.processing_id,
			sourceAvatarUrl: input.stored.sourceAvatarUrl,
			sourceUrl,
		},
		input.expectedProviderRevision,
	);
}

function resourceOriginFromTarget(input: ResourcePreparationInput) {
	if (input.kind === 'draft') {
		return {
			origin: {
				keywords: input.sourceHints?.keywords ?? [],
				normalizedUrl: input.url,
				originalLang: input.sourceHints?.originalLang ?? DEFAULT_RESOURCE_LANG,
				processingId: input.processingId,
				publishedDate: input.sourceHints?.publishedDate ?? null,
				scope: 'corpus' as const,
				sourceId: input.admission.kind === 'source' ? input.admission.sourceId : null,
				storageKey: null,
				summary: input.sourceHints?.summary ?? null,
				tags: [],
				url: input.url,
			},
			resourceIdentifiers: [],
			resourcePlatform: null,
			sourceUrl: input.url,
		};
	}
	const resource = input.stored.resource;
	return {
		origin: {
			keywords: resource.keywords,
			normalizedUrl: resource.normalized_url,
			originalLang: resource.original_lang,
			processingId: resource.processing_id,
			publishedDate: resource.published_date,
			scope: resource.scope,
			sourceId: resource.source_id,
			storageKey: resource.storage_key,
			summary: resource.summary,
			tags: resource.tags,
			url: resource.url,
		},
		resourceIdentifiers: resource.resource_identifiers,
		resourcePlatform: resource.resource_platform,
		sourceUrl: resource.url,
	};
}

function resolveAcquiredResourceOrigin(input: ResourcePreparationInput, acquired: AcquiredContent) {
	const target = resourceOriginFromTarget(input);
	const { origin } = target;
	let { resourceIdentifiers, resourcePlatform } = target;
	origin.originalLang = acquired.originalLang?.trim() || origin.originalLang;
	if ((input.kind === 'draft' || origin.publishedDate === null) && acquired.publishedDate?.trim()) {
		const parsed = new Date(acquired.publishedDate);
		if (!Number.isNaN(parsed.getTime())) origin.publishedDate = parsed.toISOString();
	}
	const canonicalUrl = acquired.canonicalUrl?.trim() || target.sourceUrl;
	const exactPaper = resolveExactPaperInput(input.kind === 'draft' ? input.url : canonicalUrl);
	const detected = exactPaper || !canonicalUrl ? null : detectResourceUrl(canonicalUrl);
	if (input.kind === 'draft') {
		resourceIdentifiers = normalizeResourceIdentifiers(
			exactPaper
				? paperIdentifiersFromIdentity(exactPaper.identity)
				: detected
					? [{ preferred: true, scheme: detected.resourcePlatform, value: detected.platformId }]
					: [],
		);
	}
	resourcePlatform = detected?.resourcePlatform ?? resourcePlatform;
	return { canonicalUrl, origin, resourceIdentifiers, resourcePlatform };
}

async function prepareResourceForProcessing(
	env: CoreEnv,
	step: WorkflowStep,
	input: ResourcePreparationInput,
	initialAcquiredContent: AcquiredContent,
): Promise<PreparedResource> {
	const { canonicalUrl, origin, resourceIdentifiers, resourcePlatform } = resolveAcquiredResourceOrigin(input, initialAcquiredContent);
	const paperResolution = await stagePaperEnrichment(env, step, {
		processing_id: origin.processingId,
		url: canonicalUrl,
		scope: origin.scope,
		source_id: origin.sourceId,
		resource_platform: resourcePlatform,
		identifierText: initialAcquiredContent.fileType === PDF_MIME ? initialAcquiredContent.markdown : null,
		identifiers: resourceIdentifiers.filter(isPaperIdentifier),
	});
	let acquiredContent = initialAcquiredContent;
	if (paperResolution && origin.scope === 'corpus' && !origin.storageKey) {
		const openAlexContent = await stageOpenAlexContentAcquisition(
			env,
			step,
			{
				processingId: origin.processingId,
				publishedDate: acquiredContent.publishedDate ?? origin.publishedDate,
				source: acquiredContent.source,
				summary: acquiredContent.summary ?? origin.summary,
				title: acquiredContent.title,
				url: canonicalUrl,
			},
			paperResolution,
		);
		if (openAlexContent) acquiredContent = openAlexContent;
	}
	const paperEnrichment = paperResolution?.metadata ?? null;
	let resource = materializeAcquiredResource(
		acquiredContent,
		origin,
		normalizeResourceIdentifiers([...(paperResolution?.identifiers ?? []), ...resourceIdentifiers]),
	);
	const extractionStatus = acquiredContent.provider === null ? acquiredContent.extraction?.status : undefined;
	if (extractionStatus === 'needs_ocr') {
		throw new ResourceProcessingRejectedError(`PDF processing ${resource.processing_id} requires OCR`);
	}
	if (!acquiredContent.markdown.trim()) {
		throw new ResourceProcessingRejectedError(`Processing ${resource.processing_id} has no extractable content`);
	}
	if (resource.kind === 'paper') resource = applyPaperEnrichment(resource, paperEnrichment);
	if (acquiredContent.provider === 'hackernews') {
		resource = await stageHackerNewsAnnotation(env, step, resource, acquiredContent.hackerNewsItem);
	}
	const youtube =
		acquiredContent.provider === 'youtube' ? await stageYouTubeEnrichment(env, step, resource, acquiredContent.youtubeTranscript) : null;
	return {
		previewImageUrl: acquiredContent.previewImageUrl?.trim() || null,
		resource,
		subject: resolvedSubjectInput(acquiredContent.subjectUrl?.trim()),
		youtube,
	};
}

async function reconcileSupersededProviderRefresh(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		acquiredResource: ResourceForProcessing;
		expectedProviderRevision: string;
		resourceId: string;
		supersededSourceRevision: string | null;
	},
): Promise<void> {
	const acquiredSourceRevision = await resourceSourceRevision(input.acquiredResource);
	const supersedingResource = await step.do(
		'load-superseding-provider-refresh-v1',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		() => loadStoredResourceForProcessing(env, input.resourceId),
	);
	if (!shouldReconcileSupersededRefresh(acquiredSourceRevision, supersedingResource.resource.source_revision)) return;
	await step.do('enqueue-superseded-provider-refresh-v1', RESOURCE_TRANSLATION_ADMISSION_STEP_CONFIG, () =>
		enqueueSupersededResourceRefresh(env, {
			resourceId: input.resourceId,
			refreshRevision: input.expectedProviderRevision,
			supersededSourceRevision: input.supersededSourceRevision,
		}),
	);
}

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceProcessingWorkflowPayload> {
	async run(event: WorkflowEvent<ResourceProcessingWorkflowPayload>, step: WorkflowStep) {
		const { target } = parseResourceProcessingWorkflowPayload(event.payload);
		const processingId = target.kind === 'draft' ? event.instanceId : target.resourceId;
		let expectedSourceRevision: string | null = null;
		try {
			let preparationInput: ResourcePreparationInput;
			let acquiredContent: AcquiredContent;
			if (target.kind !== 'draft') {
				const stored = await step.do(
					'fetch-stored-resource-input-kind-platform-v1',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					() => loadStoredResourceForProcessing(this.env, target.resourceId),
					target.kind === 'storedBlob'
						? {
								rollback: async ({ output }) => {
									if (!output) return;
									await markStoredBlobProcessingFailed(this.env, target.resourceId, output.resource.source_revision);
								},
								rollbackConfig: {
									retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
									timeout: '30 seconds',
								},
							}
						: undefined,
				);
				expectedSourceRevision = stored.resource.source_revision;
				preparationInput = { ...target, stored };
				acquiredContent = await acquireExistingResource(this.env, step, preparationInput);
			} else {
				preparationInput = { ...target, processingId };
				acquiredContent = await acquireDraftResource(this.env, step, preparationInput);
			}
			if (target.kind === 'reacquire' && target.expectedProviderRevision && acquiredContent.sourceSnapshotHash === expectedSourceRevision) {
				console.info({
					tag: 'WORKFLOW',
					msg: 'Provider refresh content is unchanged',
					resource_id: target.resourceId,
				});
				return { status: 'unchanged', resourceId: target.resourceId, changed: false } as const;
			}
			const prepared = await prepareResourceForProcessing(this.env, step, preparationInput, acquiredContent);
			const { previewImageUrl, resource, subject, youtube } = prepared;
			const logContext = { processing_id: processingId, target_kind: target.kind };

			console.info({
				tag: 'WORKFLOW',
				msg: 'Starting',
				resourceKind: resource.kind,
				resourcePlatform: resource.resource_platform,
				...logContext,
			});
			let imageSources: string[];
			try {
				imageSources = resourceImageSourceUrls({
					creators: resource.creators,
					kindMetadata: resource.kind_metadata,
					ogImageUrl: previewImageUrl,
				});
			} catch (error) {
				throw new ResourceProcessingRejectedError(
					`Resource processing ${processingId} has an invalid canonical image source: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const [classification, hostedImages] = await Promise.all([
				step.do('classify-resource', { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' }, () =>
					classifyResource(resource, this.env),
				),
				stageResourceImages(this.env, step, processingId, imageSources),
			]);
			const privatePaper = target.kind === 'storedBlob' ? privatePaperAttachment(resource) : null;
			const persistenceInput = {
				classification,
				previewImageUrl,
				resource,
				subject,
				youtube,
			};
			const persistenceTarget =
				target.kind === 'draft'
					? ({ kind: 'draft', admission: target.admission } as const)
					: privatePaper
						? ({
								kind: 'privatePaper',
								canonicalUrl: privatePaper.canonicalUrl,
								fileResourceId: target.resourceId,
								expectedFileRevision: expectedSourceRevision,
							} as const)
						: ({ kind: 'existing', resourceId: target.resourceId, expectedSourceRevision } as const);
			const persistence = await step.do(
				'persist-resolved-resource-v1',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => persistProcessedResource(this.env, { ...persistenceInput, target: persistenceTarget }, hostedImages),
			);
			if (!persistence.persisted) {
				if (target.kind === 'reacquire' && target.expectedProviderRevision) {
					await reconcileSupersededProviderRefresh(this.env, step, {
						acquiredResource: resource,
						expectedProviderRevision: target.expectedProviderRevision,
						resourceId: persistence.resourceId,
						supersededSourceRevision: expectedSourceRevision,
					});
				}
				return { status: 'superseded', resourceId: persistence.resourceId } as const;
			}
			const persistedResourceId = persistence.resourceId;
			const translationRevision = persistence.translationRevision;
			const followUps: Promise<unknown>[] = [
				step.do('enqueue-resource-translation-v2', RESOURCE_TRANSLATION_ADMISSION_STEP_CONFIG, async () =>
					translationRevision ? enqueueResourceTranslation(this.env, persistedResourceId, translationRevision) : null,
				),
				step.do('sync-resolved-ai-search-v1', AI_SEARCH_SYNC_STEP_CONFIG, () =>
					Promise.all([persistedResourceId, ...persistence.retiredResourceIds].map((resourceId) => syncCorpusItem(this.env, resourceId))),
				),
			];
			if (subject && !persistence.subjectAttached) {
				followUps.push(
					step.do(
						'enqueue-resolved-subject-child-v1',
						{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
						async () =>
							enqueueSubjectDraft(this.env, {
								parentResourceId: persistedResourceId,
								parentRevision: await resourceSourceRevision(resource),
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
