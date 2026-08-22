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
import type { ResolvedResource } from '@core-shared/types';
import { canonicalResourcePlatformUrl, detectResourceUrl } from '@core-shared/url';
import { connectCoreDb } from '@db/connection';
import { loadStoredResourceForProcessing, type StoredResourceProcessingInput } from '@ingest/stored-resource';
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

const WORKFLOW_ENQUEUE_STEP_CONFIG = {
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
	resource: ResolvedResource;
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

async function acquireResource(env: CoreEnv, step: WorkflowStep, input: ResourcePreparationInput): Promise<AcquiredContent> {
	if (input.kind === 'storedBlob') {
		return readAcquiredContentArtifact(
			await step.do(
				'acquire-stored-pdf-v1',
				{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
				async () => acquiredContentArtifact(await sanitizeAcquiredContent(await acquireStoredPdf(env, input.stored.resource))),
			),
		);
	}
	if (input.kind === 'draft') {
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
	const locator = exactPlatformLocator(input.stored.resource.resourceIdentifiers);
	const sourceUrl = locator ? canonicalResourcePlatformUrl(locator.resourcePlatform, locator.platformId) : input.stored.resource.url;
	if (!sourceUrl) {
		throw new ResourceProcessingRejectedError(`Resource processing ${input.stored.resource.processingId} has no source URL`);
	}
	return stageSavedUrlAcquisition(
		env,
		step,
		{
			discoverTwitterThread: true,
			isMonitoredOnly: input.stored.isMonitoredOnly,
			processingId: input.stored.resource.processingId,
			sourceAvatarUrl: input.stored.sourceAvatarUrl,
			sourceUrl,
		},
		input.expectedProviderRevision,
	);
}

async function prepareResourceForProcessing(
	env: CoreEnv,
	step: WorkflowStep,
	input: ResourcePreparationInput,
	initialAcquiredContent: AcquiredContent,
): Promise<PreparedResource> {
	const origin =
		input.kind === 'draft'
			? {
					processingId: input.processingId,
					sourceId: input.admission.kind === 'source' ? input.admission.sourceId : null,
					scope: 'corpus' as const,
					originalLang: input.sourceHints?.originalLang ?? DEFAULT_RESOURCE_LANG,
					summary: input.sourceHints?.summary ?? null,
					url: input.url,
					publishedDate: input.sourceHints?.publishedDate ?? null,
					tags: [],
					keywords: input.sourceHints?.keywords ?? [],
					storageKey: null,
					normalizedUrl: input.url,
				}
			: input.stored.resource;
	const canonicalUrl = initialAcquiredContent.canonicalUrl?.trim() || origin.url;
	const exactPaper = resolveExactPaperInput(input.kind === 'draft' ? input.url : canonicalUrl);
	const detected = exactPaper || !canonicalUrl ? null : detectResourceUrl(canonicalUrl);
	const resourceIdentifiers =
		input.kind === 'draft'
			? normalizeResourceIdentifiers(
					exactPaper
						? paperIdentifiersFromIdentity(exactPaper.identity)
						: detected
							? [{ preferred: true, scheme: detected.resourcePlatform, value: detected.platformId }]
							: [],
				)
			: input.stored.resource.resourceIdentifiers;
	let publishedDate = origin.publishedDate;
	if ((input.kind === 'draft' || publishedDate === null) && initialAcquiredContent.publishedDate?.trim()) {
		const parsed = new Date(initialAcquiredContent.publishedDate);
		if (!Number.isNaN(parsed.getTime())) publishedDate = parsed.toISOString();
	}
	const paperResolution = await stagePaperEnrichment(env, step, {
		processingId: origin.processingId,
		url: canonicalUrl,
		scope: origin.scope,
		sourceId: origin.sourceId,
		resourcePlatform: detected?.resourcePlatform ?? (input.kind === 'draft' ? null : input.stored.resource.resourcePlatform),
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
				publishedDate,
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
	let resource = materializeAcquiredResource(acquiredContent, origin, {
		canonicalUrl,
		detected,
		publishedDate,
		resourceIdentifiers: normalizeResourceIdentifiers([...(paperResolution?.identifiers ?? []), ...resourceIdentifiers]),
	});
	const extractionStatus = acquiredContent.provider === null ? acquiredContent.extraction?.status : undefined;
	if (extractionStatus === 'needs_ocr') {
		throw new ResourceProcessingRejectedError(`PDF processing ${resource.processingId} requires OCR`);
	}
	if (!acquiredContent.markdown.trim()) {
		throw new ResourceProcessingRejectedError(`Processing ${resource.processingId} has no extractable content`);
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
		acquiredResource: ResolvedResource;
		expectedProviderRevision: string;
		resourceId: string;
		supersededSourceRevision: string | null;
	},
): Promise<void> {
	const acquiredSourceRevision = input.acquiredResource.sourceRevision;
	const supersedingResource = await step.do(
		'load-superseding-provider-refresh-v1',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		async () => loadStoredResourceForProcessing(await connectCoreDb(env), input.resourceId),
	);
	if (!shouldReconcileSupersededRefresh(acquiredSourceRevision, supersedingResource.resource.sourceRevision)) return;
	await step.do('enqueue-superseded-provider-refresh-v1', WORKFLOW_ENQUEUE_STEP_CONFIG, () =>
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
					async () => loadStoredResourceForProcessing(await connectCoreDb(this.env), target.resourceId),
					target.kind === 'storedBlob'
						? {
								rollback: async ({ output }) => {
									if (!output) return;
									await markStoredBlobProcessingFailed(await connectCoreDb(this.env), target.resourceId, output.resource.sourceRevision);
								},
								rollbackConfig: {
									retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
									timeout: '30 seconds',
								},
							}
						: undefined,
				);
				expectedSourceRevision = stored.resource.sourceRevision;
				preparationInput = { ...target, stored };
			} else {
				preparationInput = { ...target, processingId };
			}
			const acquiredContent = await acquireResource(this.env, step, preparationInput);
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
				() =>
					persistProcessedResource(
						this.env,
						{ classification, previewImageUrl, resource, subject, target: persistenceTarget, youtube },
						hostedImages,
					),
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
