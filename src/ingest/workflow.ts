import {
	type WorkflowDelayFunction,
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
	type WorkflowStepConfig,
} from 'cloudflare:workers';
import { paperIdentifiersFromIdentity, resolveExactPaperInput } from '@core-shared/paper-identity';
import { isPaperIdentifier, normalizeResourceIdentifiers } from '@core-shared/resource-identifiers';
import type { HostedResourceImage } from '@core-shared/resource-image-mapping';
import {
	canonicalizeOptionalResourceLang,
	canonicalizeResourceLang,
	isContentResourceIdentity,
	parseResourceIdentity,
	resourceIdentityForDetectedPlatform,
	toResourceIdentityColumns,
} from '@core-shared/resource-types';
import type { PaperMetadata, PdfExtractionMetadata, ResourceForProcessing } from '@core-shared/types';
import { canonicalResourcePlatformUrl, detectResourceUrl } from '@core-shared/url';
import { loadSourceAvatarUrl, loadStoredResourceForProcessing, type StoredResourceProcessingInput } from '@ingest/domain/resource-store';
import { AI_SEARCH_SYNC_STEP_CONFIG, syncCorpusItem } from '../ai-search';
import { DURABLE_WORKFLOW_RETRIES } from '../workflow-control';
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
import { handleResolvedResource } from './kind-handler';
import { privatePaperAttachment, stagePaperEnrichment } from './platforms/paper';
import { stagePreferredOpenAlexContent, stagePreliminaryAcquisition } from './platforms/paper-content';
import { stagePdfTextExtraction } from './platforms/pdf';
import { MIN_MONITORED_VIDEO_DURATION_SECONDS } from './platforms/youtube-acquisition';
import {
	enqueueSubjectDraft,
	parseResourceProcessingWorkflowPayload,
	type ResourceDraftTarget,
	type ResourceProcessingWorkflowPayload,
	type StoredResourceTarget,
} from './resource-admission';
import { rehostResourceImage } from './resource-image-rehosting';
import {
	persistProcessedDraft,
	persistProcessedPrivatePaperDraft,
	persistProcessedResource,
	processedResourceImageSources,
	settleStoredBlobProcessingFailure,
} from './resource-persistence';
import {
	exactPlatformLocator,
	type ResolvedContentResourceInput,
	resolveContentResource,
	resolvedResourceIdentifiers,
	resolvedSubjectInput,
} from './resource-resolver';
import { enqueueResourceTranslation } from './resource-translation-workflow';
import { PDF_MIME, pdfExtractionMetadata } from './web-acquisition';

class ResourceProcessingRejectedError extends Error {
	constructor(message: string, name: string) {
		super(message);
		this.name = name;
	}
}

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
	resourceId: string,
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
				resource_id: resourceId,
				source_host: new URL(batch[index]!).hostname,
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
		const failed = results.filter((result) => result.status === 'rejected').length;
		if (failed) {
			throw new ResourceProcessingRejectedError(
				`Resource ${resourceId} failed to host ${failed} canonical image${failed === 1 ? '' : 's'}`,
				'ResourceImageRehostingError',
			);
		}
	}
	if (sourceUrls.length > 0) {
		console.info({
			tag: 'RESOURCE_IMAGE',
			event: 'eager_rehost_completed',
			resource_id: resourceId,
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
			);
		}),
	);
	if (acquisition.status === 'rejected') {
		throw new ResourceProcessingRejectedError(acquisition.message, 'ResourceAcquisitionRejectedError');
	}
	const acquired = acquisition.content;
	if (input.isMonitoredOnly && acquired.provider === 'youtube') {
		const durationSeconds = acquired.durationSeconds;
		if (durationSeconds === null || durationSeconds <= MIN_MONITORED_VIDEO_DURATION_SECONDS) {
			const reason = durationSeconds === null ? 'is a live stream or unstarted premiere' : `runs ${durationSeconds}s`;
			throw new ResourceProcessingRejectedError(
				`YouTube processing ${input.processingId} ${reason}; monitored videos must exceed ${MIN_MONITORED_VIDEO_DURATION_SECONDS}s`,
				'MonitoredVideoRejectedError',
			);
		}
	}
	return acquired;
}

function assertPdfExtractionProcessable(input: {
	acquiredExtraction: PdfExtractionMetadata | undefined;
	pdfTextArtifact: Awaited<ReturnType<typeof stagePdfTextExtraction>> | null;
	resourceId: string;
}): void {
	const extraction = input.pdfTextArtifact ? pdfExtractionMetadata(input.pdfTextArtifact) : input.acquiredExtraction;
	if (extraction?.status === 'needs_ocr') {
		throw new ResourceProcessingRejectedError(`PDF resource ${input.resourceId} requires OCR`, 'PdfOcrRequiredError');
	}
}

function assertResourceContentProcessable(input: {
	acquiredContent: AcquiredContent | undefined;
	pdfTextArtifact: Awaited<ReturnType<typeof stagePdfTextExtraction>> | null;
	resourceId: string;
}): void {
	if (input.pdfTextArtifact?.text?.trim() || input.acquiredContent?.markdown?.trim()) return;
	throw new ResourceProcessingRejectedError(`Resource ${input.resourceId} has no extractable content`, 'ResourceContentMissingError');
}

type PreparedResource = {
	acquiredContent: AcquiredContent | undefined;
	identityPdfTextArtifact: Awaited<ReturnType<typeof stagePdfTextExtraction>> | null;
	paperEnrichment: PaperMetadata | null;
	resolution: ResolvedContentResourceInput;
	resource: ResourceForProcessing;
};

type ResourcePreparationInput =
	| {
			kind: 'draft';
			processingId: string;
			sourceAvatarUrl: string | null;
			target: ResourceDraftTarget;
	  }
	| {
			kind: 'stored';
			stored: StoredResourceProcessingInput;
			target: StoredResourceTarget;
	  };

async function prepareResourceForProcessing(env: CoreEnv, step: WorkflowStep, input: ResourcePreparationInput): Promise<PreparedResource> {
	let initialResource: ResourceForProcessing;
	let preliminary: Awaited<ReturnType<typeof stagePreliminaryAcquisition>>;
	let acquiredContent: AcquiredContent | undefined;
	if (input.kind === 'draft') {
		const exactPaper = resolveExactPaperInput(input.target.url);
		const detected = exactPaper ? null : detectResourceUrl(input.target.url);
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
		const sourceId = input.target.admission.kind === 'source' ? input.target.admission.sourceId : null;
		const draftCandidate = {
			processing_id: input.processingId,
			published_date: input.target.publishedDate,
			resource_identifiers: resourceIdentifiers,
			resource_platform: identity.resourcePlatform,
			scope: 'corpus' as const,
			source: new URL(input.target.url).hostname.replace(/^www\./, ''),
			source_id: sourceId,
			storage_key: null,
			summary: input.target.summary,
			title: input.target.title,
			url: input.target.url,
		};
		// Exact DOI/arXiv/OpenAlex drafts can go straight to OpenAlex Content.
		// The landing page is acquired only when OpenAlex has no cached content.
		preliminary = await stagePreliminaryAcquisition(env, step, draftCandidate, () =>
			stageSavedUrlAcquisition(
				env,
				step,
				{
					isMonitoredOnly: input.target.admission.kind === 'source',
					processingId: input.processingId,
					sourceAvatarUrl: input.sourceAvatarUrl,
					sourceUrl: input.target.url,
				},
				input.target.expectedProviderRevision,
			),
		);
		acquiredContent = preliminary.acquiredContent;
		if (!acquiredContent) {
			throw new ResourceProcessingRejectedError(
				`Resource draft ${input.processingId} produced no acquired content`,
				'ResourceContentMissingError',
			);
		}
		const canonicalUrl = acquiredContent.canonicalUrl?.trim() || input.target.url;
		let publishedDate = input.target.publishedDate;
		if (publishedDate === null && acquiredContent.publishedDate?.trim()) {
			const parsed = new Date(acquiredContent.publishedDate);
			if (!Number.isNaN(parsed.getTime())) publishedDate = parsed.toISOString();
		}
		initialResource = {
			...toResourceIdentityColumns(identity),
			processing_id: input.processingId,
			source_id: sourceId,
			scope: 'corpus',
			original_lang: canonicalizeOptionalResourceLang(acquiredContent.originalLang) ?? canonicalizeResourceLang(input.target.originalLang),
			title: acquiredContent.title.trim(),
			summary: acquiredContent.summary ?? input.target.summary,
			content: acquiredContent.markdown,
			url: canonicalUrl,
			source: acquiredContent.source,
			published_date: publishedDate,
			tags: [],
			keywords: input.target.keywords,
			creators: acquiredContent.creators,
			kind_metadata: acquiredContent.kindMetadata,
			source_revision: acquiredContent.sourceSnapshotHash ?? null,
			resource_identifiers: resourceIdentifiers,
			storage_key: null,
			file_type: acquiredContent.fileType,
			normalized_url: canonicalUrl,
		};
	} else {
		initialResource = input.stored.resource;
		if (input.target.operation === 'reacquire') {
			const locator = exactPlatformLocator(initialResource.resource_identifiers);
			const sourceUrl = locator ? canonicalResourcePlatformUrl(locator.resourcePlatform, locator.platformId) : initialResource.url;
			if (!sourceUrl) {
				throw new ResourceProcessingRejectedError(
					`Resource processing ${initialResource.processing_id} has no source URL`,
					'ResourceReacquisitionUnsupportedError',
				);
			}
			preliminary = await stagePreliminaryAcquisition(env, step, initialResource, () =>
				stageSavedUrlAcquisition(
					env,
					step,
					{
						isMonitoredOnly: input.stored.isMonitoredOnly,
						processingId: initialResource.processing_id,
						sourceAvatarUrl: input.stored.sourceAvatarUrl,
						sourceUrl,
					},
					input.target.expectedProviderRevision,
				),
			);
			acquiredContent = preliminary.acquiredContent;
		} else {
			preliminary = { acquiredContent: undefined, explicitResolution: null };
		}
	}
	const acquiredResource = input.kind === 'draft' ? initialResource : applyAcquiredMaterial(initialResource, acquiredContent);
	const rootCanBePaper = !acquiredResource.url || !detectResourceUrl(acquiredResource.url);
	const identityPdfTextArtifact =
		acquiredResource.storage_key && acquiredResource.file_type === PDF_MIME && acquiredContent?.fileType !== PDF_MIME
			? await stagePdfTextExtraction(env, step, { sourceStorageKey: acquiredResource.storage_key })
			: null;
	const identifierText = identityPdfTextArtifact?.text?.trim()
		? identityPdfTextArtifact.text
		: acquiredResource.file_type === PDF_MIME
			? acquiredResource.content
			: null;
	const paperResolution = preliminary.explicitResolution?.metadata
		? preliminary.explicitResolution
		: rootCanBePaper
			? await stagePaperEnrichment(
					env,
					step,
					{
						...acquiredResource,
						identifierText,
						identifiers: preliminary.explicitResolution?.identifiers ?? initialResource.resource_identifiers.filter(isPaperIdentifier),
					},
					{ stepName: 'resolve-paper-openalex-with-citations-v1' },
				)
			: { contentGrobidXmlUrl: null, contentPdfUrl: null, identifiers: [], metadata: null };
	const paperEnrichment = paperResolution.metadata;
	const preferred = await stagePreferredOpenAlexContent(env, step, acquiredResource, acquiredContent, paperResolution, preliminary);
	acquiredContent = preferred.acquiredContent;
	const resourceIdentifiers = normalizeResourceIdentifiers([...paperResolution.identifiers, ...preferred.resource.resource_identifiers]);
	const subjectUrl =
		acquiredContent?.provider === 'hackernews'
			? acquiredContent.hackerNewsItem.url?.trim() || null
			: acquiredContent?.provider === 'twitter'
				? acquiredContent.subjectUrl?.trim() || null
				: null;
	const resolution = resolveContentResource({
		url: preferred.resource.url,
		resourceIdentifiers,
		subjectUrl,
	});
	const finalPaperEnrichment = resolution.kind === 'paper' ? paperEnrichment : null;
	const identity = parseResourceIdentity(resolution.kind, resolution.resourcePlatform);
	if (!identity || !isContentResourceIdentity(identity)) {
		throw new ResourceProcessingRejectedError('Resolver produced an invalid content Resource identity', 'ResourceIdentityError');
	}
	const identifiers = resolvedResourceIdentifiers(resolution);
	const locator = exactPlatformLocator(identifiers);
	const resolvedUrl = locator ? canonicalResourcePlatformUrl(locator.resourcePlatform, locator.platformId) : preferred.resource.url;
	return {
		acquiredContent,
		identityPdfTextArtifact,
		paperEnrichment: finalPaperEnrichment,
		resolution,
		resource: {
			...preferred.resource,
			...toResourceIdentityColumns(identity),
			url: resolvedUrl,
			normalized_url: resolvedUrl ?? preferred.resource.normalized_url ?? null,
			resource_identifiers: identifiers,
		},
	};
}

async function settleFailedStoredBlobProcessing(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		persistedSourceRevision: string | null | undefined;
		resourceId: string;
	},
): Promise<void> {
	if (input.persistedSourceRevision === undefined) return;
	await step
		.do(
			'settle-stored-blob-processing-failure-v1',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() => settleStoredBlobProcessingFailure(env, input.resourceId, input.persistedSourceRevision ?? null),
		)
		.catch((cleanupError) => {
			console.error({
				tag: 'WORKFLOW',
				msg: 'Failed to settle stored blob processing',
				resource_id: input.resourceId,
				error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
			});
		});
}

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceProcessingWorkflowPayload> {
	async run(event: WorkflowEvent<ResourceProcessingWorkflowPayload>, step: WorkflowStep) {
		const { target } = parseResourceProcessingWorkflowPayload(event.payload);
		const processingId = target.kind === 'stored' ? target.resourceId : event.instanceId;
		let persistedSourceRevision: string | null | undefined;
		try {
			let preparationInput: ResourcePreparationInput;
			if (target.kind === 'stored') {
				const stored = await step.do(
					'fetch-stored-resource-input-kind-platform-v1',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					() => loadStoredResourceForProcessing(this.env, target.resourceId),
				);
				persistedSourceRevision = stored.resource.source_revision;
				preparationInput = { kind: 'stored', stored, target };
			} else {
				const sourceId = target.admission.kind === 'source' ? target.admission.sourceId : null;
				const sourceAvatarUrl = sourceId
					? await step.do(
							'load-draft-source-avatar-v1',
							{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
							() => loadSourceAvatarUrl(this.env, sourceId),
						)
					: null;
				preparationInput = { kind: 'draft', processingId, sourceAvatarUrl, target };
			}
			const prepared = await prepareResourceForProcessing(this.env, step, preparationInput);
			const { acquiredContent, identityPdfTextArtifact, paperEnrichment, resolution, resource } = prepared;
			const logContext = { processing_id: processingId, target_kind: target.kind };

			console.info({
				tag: 'WORKFLOW',
				msg: 'Starting',
				resourceKind: resource.kind,
				resourcePlatform: resource.resource_platform,
				...logContext,
			});
			const pdfTextArtifact = identityPdfTextArtifact;
			assertPdfExtractionProcessable({
				acquiredExtraction: acquiredContent?.provider === null ? acquiredContent.extraction : undefined,
				pdfTextArtifact,
				resourceId: processingId,
			});
			assertResourceContentProcessable({
				acquiredContent,
				pdfTextArtifact,
				resourceId: processingId,
			});

			const extractedPdfText = pdfTextArtifact?.text?.trim();
			const processableResource = extractedPdfText ? { ...resource, content: extractedPdfText } : resource;

			const previewImageUrl = acquiredContent?.previewImageUrl?.trim() || null;
			const handled = await handleResolvedResource({
				acquiredContent,
				env: this.env,
				paperEnrichment,
				resolution,
				resource: processableResource,
				step,
			});

			const classification = await step.do(
				'classify-resource',
				{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
				() => classifyResource(handled.resource, this.env, handled.classificationExclusions),
			);
			const privatePaper = target.kind === 'stored' && target.operation === 'blob' ? privatePaperAttachment(handled.resource) : null;
			const subject = privatePaper ? null : resolvedSubjectInput(handled);
			const persistenceInput = {
				handled,
				classification,
				previewImageUrl,
				subject,
			};
			let imageSources: string[];
			try {
				imageSources = privatePaper ? [] : processedResourceImageSources(persistenceInput);
			} catch (error) {
				throw new ResourceProcessingRejectedError(
					`Resource processing ${processingId} has an invalid canonical image source: ${error instanceof Error ? error.message : String(error)}`,
					'ResourceImageSourceError',
				);
			}
			const hostedImages = await stageResourceImages(this.env, step, processingId, imageSources);
			const persistence = await step.do(
				privatePaper
					? 'persist-final-private-paper-draft-v1'
					: target.kind === 'stored'
						? 'persist-stored-resource-graph-v5'
						: 'persist-final-resource-draft-v1',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() =>
					privatePaper && target.kind === 'stored'
						? persistProcessedPrivatePaperDraft(
								this.env,
								{
									...persistenceInput,
									canonicalUrl: privatePaper.canonicalUrl,
									resourceId: target.resourceId,
									expectedSourceRevision: persistedSourceRevision ?? null,
								},
								hostedImages,
							)
						: target.kind === 'stored'
							? persistProcessedResource(
									this.env,
									{
										...persistenceInput,
										resourceId: target.resourceId,
										expectedSourceRevision: persistedSourceRevision ?? null,
									},
									hostedImages,
								)
							: persistProcessedDraft(this.env, { ...persistenceInput, admission: target.admission }, hostedImages),
			);
			if (!persistence.persisted) {
				return { status: 'superseded', resourceId: persistence.resourceId } as const;
			}
			const persistedResourceId = persistence.resourceId;
			if (subject && !persistence.subjectAttached) {
				const parentRevision = await resourceSourceRevision(handled.resource);
				await step
					.do(
						'enqueue-resolved-subject-child-v1',
						{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
						() =>
							enqueueSubjectDraft(this.env, {
								parentResourceId: persistedResourceId,
								parentRevision,
								title: subject.title,
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
				...(target.kind === 'stored' && target.operation === 'reacquire' ? { changed: true } : {}),
			} as const;
		} catch (error) {
			if (target.kind === 'draft') {
				if (error instanceof ResourceProcessingRejectedError) {
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
			if (target.operation !== 'blob') throw error;
			await settleFailedStoredBlobProcessing(this.env, step, {
				persistedSourceRevision,
				resourceId: target.resourceId,
			});
			throw error;
		}
	}
}
