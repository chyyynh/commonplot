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
import {
	canonicalizeOptionalResourceLang,
	canonicalizeResourceLang,
	DEFAULT_RESOURCE_LANG,
	resourceIdentityForDetectedPlatform,
	toResourceIdentityColumns,
} from '@core-shared/resource-types';
import type { ResourceForProcessing } from '@core-shared/types';
import { canonicalResourcePlatformUrl, detectResourceUrl } from '@core-shared/url';
import { loadStoredResourceForProcessing, type StoredResourceProcessingInput } from '@ingest/domain/resource-store';
import { AI_SEARCH_SYNC_STEP_CONFIG, syncCorpusItem } from '../ai-search';
import { DURABLE_WORKFLOW_RETRIES, shouldReconcileSupersededRefresh } from '../workflow-control';
import {
	ACQUISITION_STEP,
	type AcquiredContent,
	applyAcquiredMaterial,
	readSavedUrlAcquisitionArtifact,
	scrapeSavedUrlArtifact,
} from './acquisition';
import { classifyResource } from './domain/resource-classification';
import { resourceSourceRevision } from './domain/resource-revision';
import { loadEligibleResourceTranslationRevision } from './domain/resource-translation-store';
import { stageHackerNewsAnnotation } from './platforms/hackernews';
import { applyPaperEnrichment, privatePaperAttachment, stagePaperEnrichment } from './platforms/paper';
import { stageOpenAlexContentAcquisition } from './platforms/paper-content';
import { stagePdfTextExtraction } from './platforms/pdf';
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
import { exactPlatformLocator, type ResolvedSubjectInput, resolveContentResource, resolvedSubjectInput } from './resource-resolver';
import { enqueueResourceTranslation } from './resource-translation-workflow';
import { PDF_MIME } from './web-acquisition';

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

type InitialResourceAcquisition = {
	acquiredContent: AcquiredContent | undefined;
	resource: ResourceForProcessing;
};

async function acquireDraftResource(
	env: CoreEnv,
	step: WorkflowStep,
	input: Extract<ResourcePreparationInput, { kind: 'draft' }>,
): Promise<InitialResourceAcquisition> {
	const exactPaper = resolveExactPaperInput(input.url);
	const detected = exactPaper ? null : detectResourceUrl(input.url);
	const identity = exactPaper
		? ({ kind: 'paper', resourcePlatform: null } as const)
		: detected
			? resourceIdentityForDetectedPlatform(detected.resourcePlatform)
			: ({ kind: 'blog', resourcePlatform: null } as const);
	const resourceIdentifiers = normalizeResourceIdentifiers(
		exactPaper
			? paperIdentifiersFromIdentity(exactPaper.identity)
			: detected
				? [{ preferred: true, scheme: detected.resourcePlatform, value: detected.platformId }]
				: [],
	);
	const sourceId = input.admission.kind === 'source' ? input.admission.sourceId : null;
	const acquiredContent = await stageSavedUrlAcquisition(
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
	const canonicalUrl = acquiredContent.canonicalUrl?.trim() || input.url;
	let publishedDate = input.sourceHints?.publishedDate ?? null;
	if (acquiredContent.publishedDate?.trim()) {
		const parsed = new Date(acquiredContent.publishedDate);
		if (!Number.isNaN(parsed.getTime())) publishedDate = parsed.toISOString();
	}
	return {
		acquiredContent,
		resource: {
			...toResourceIdentityColumns(identity),
			processing_id: input.processingId,
			source_id: sourceId,
			scope: 'corpus',
			original_lang:
				canonicalizeOptionalResourceLang(acquiredContent.originalLang) ??
				canonicalizeResourceLang(input.sourceHints?.originalLang ?? DEFAULT_RESOURCE_LANG),
			title: acquiredContent.title.trim(),
			summary: acquiredContent.summary ?? input.sourceHints?.summary ?? null,
			content: acquiredContent.markdown,
			url: canonicalUrl,
			source: acquiredContent.source,
			published_date: publishedDate,
			tags: [],
			keywords: input.sourceHints?.keywords ?? [],
			creators: acquiredContent.creators,
			kind_metadata: acquiredContent.kindMetadata,
			source_revision: acquiredContent.sourceSnapshotHash ?? null,
			resource_identifiers: resourceIdentifiers,
			storage_key: null,
			file_type: acquiredContent.fileType,
			normalized_url: canonicalUrl,
		},
	};
}

async function acquireExistingResource(
	env: CoreEnv,
	step: WorkflowStep,
	input: Extract<ResourcePreparationInput, { kind: 'storedBlob' | 'reacquire' }>,
): Promise<InitialResourceAcquisition> {
	const storedResource = input.stored.resource;
	if (input.kind === 'storedBlob') {
		return { acquiredContent: undefined, resource: storedResource };
	}
	const locator = exactPlatformLocator(storedResource.resource_identifiers);
	const sourceUrl = locator ? canonicalResourcePlatformUrl(locator.resourcePlatform, locator.platformId) : storedResource.url;
	if (!sourceUrl) {
		throw new ResourceProcessingRejectedError(`Resource processing ${storedResource.processing_id} has no source URL`);
	}
	const acquiredContent = await stageSavedUrlAcquisition(
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
	return { acquiredContent, resource: applyAcquiredMaterial(storedResource, acquiredContent) };
}

async function prepareResourceForProcessing(env: CoreEnv, step: WorkflowStep, input: ResourcePreparationInput): Promise<PreparedResource> {
	const acquired = input.kind === 'draft' ? await acquireDraftResource(env, step, input) : await acquireExistingResource(env, step, input);
	let { acquiredContent, resource } = acquired;
	const pdfTextArtifact =
		resource.storage_key && resource.file_type === PDF_MIME && acquiredContent?.fileType !== PDF_MIME
			? await stagePdfTextExtraction(env, step, { sourceStorageKey: resource.storage_key })
			: null;
	const identifierText = pdfTextArtifact?.text?.trim() || (resource.file_type === PDF_MIME ? resource.content : null);
	const paperResolution = await stagePaperEnrichment(env, step, {
		...resource,
		identifierText,
		identifiers: resource.resource_identifiers.filter(isPaperIdentifier),
	});
	if (paperResolution && resource.scope === 'corpus' && !resource.storage_key) {
		const openAlexContent = await stageOpenAlexContentAcquisition(
			env,
			step,
			{
				processingId: resource.processing_id,
				publishedDate: resource.published_date,
				source: resource.source,
				summary: resource.summary,
				title: resource.title,
				url: resource.url,
			},
			paperResolution,
		);
		if (openAlexContent) {
			acquiredContent = openAlexContent;
			resource = applyAcquiredMaterial(resource, openAlexContent);
		}
	}
	const paperEnrichment = paperResolution?.metadata ?? null;
	const resourceIdentifiers = normalizeResourceIdentifiers([...(paperResolution?.identifiers ?? []), ...resource.resource_identifiers]);
	const subjectUrl = acquiredContent?.subjectUrl?.trim() || null;
	resource = resolveContentResource({
		...resource,
		resource_identifiers: resourceIdentifiers,
	});
	const extractionStatus = pdfTextArtifact?.status ?? (acquiredContent?.provider === null ? acquiredContent.extraction?.status : undefined);
	if (extractionStatus === 'needs_ocr') {
		throw new ResourceProcessingRejectedError(`PDF processing ${resource.processing_id} requires OCR`);
	}
	const extractedPdfText = pdfTextArtifact?.text?.trim();
	if (!extractedPdfText && !acquiredContent?.markdown?.trim()) {
		throw new ResourceProcessingRejectedError(`Processing ${resource.processing_id} has no extractable content`);
	}
	if (extractedPdfText) resource = { ...resource, content: extractedPdfText };
	if (resource.kind === 'paper') resource = applyPaperEnrichment(resource, paperEnrichment);
	if (acquiredContent?.provider === 'hackernews') {
		resource = await stageHackerNewsAnnotation(env, step, resource, acquiredContent.hackerNewsItem);
	}
	const youtube =
		acquiredContent?.provider === 'youtube' ? await stageYouTubeEnrichment(env, step, resource, acquiredContent.youtubeTranscript) : null;
	return {
		previewImageUrl: acquiredContent?.previewImageUrl?.trim() || null,
		resource,
		subject: resolvedSubjectInput(subjectUrl),
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
			} else {
				preparationInput = { ...target, processingId };
			}
			const prepared = await prepareResourceForProcessing(this.env, step, preparationInput);
			const { previewImageUrl, resource, subject, youtube } = prepared;
			const logContext = { processing_id: processingId, target_kind: target.kind };

			console.info({
				tag: 'WORKFLOW',
				msg: 'Starting',
				resourceKind: resource.kind,
				resourcePlatform: resource.resource_platform,
				...logContext,
			});
			const classification = await step.do(
				'classify-resource',
				{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
				() => classifyResource(resource, this.env),
			);
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
			const hostedImages = await stageResourceImages(this.env, step, processingId, imageSources);
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
			if (subject && !persistence.subjectAttached) {
				const parentRevision = await resourceSourceRevision(resource);
				await step
					.do(
						'enqueue-resolved-subject-child-v1',
						{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
						() =>
							enqueueSubjectDraft(this.env, {
								parentResourceId: persistedResourceId,
								parentRevision,
								url: subject.url,
							}),
					)
					.catch((error) =>
						console.error({
							tag: 'WORKFLOW',
							msg: 'Resource persisted but subject child enqueue failed',
							resource_id: persistedResourceId,
							error: error instanceof Error ? error.message : String(error),
						}),
					);
			}
			const translationSourceRevision = await step.do(
				'load-resource-translation-revision-v1',
				RESOURCE_TRANSLATION_ADMISSION_STEP_CONFIG,
				() => loadEligibleResourceTranslationRevision(this.env, persistedResourceId),
			);
			if (translationSourceRevision) {
				await step.do('enqueue-resource-translation', RESOURCE_TRANSLATION_ADMISSION_STEP_CONFIG, () =>
					enqueueResourceTranslation(this.env, persistedResourceId, translationSourceRevision),
				);
			}
			await step.do('sync-ai-search', AI_SEARCH_SYNC_STEP_CONFIG, () => syncCorpusItem(this.env, persistedResourceId));
			if (persistence.retiredResourceIds.length) {
				await step.do('delete-merged-ai-search-items-v1', AI_SEARCH_SYNC_STEP_CONFIG, async () => {
					for (const retiredResourceId of persistence.retiredResourceIds) {
						await syncCorpusItem(this.env, retiredResourceId);
					}
				});
			}

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
