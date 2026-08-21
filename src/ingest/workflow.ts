import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import { isPaperIdentifier, normalizeResourceIdentifiers } from '@core-shared/resource-identifiers';
import type { HostedResourceImage } from '@core-shared/resource-image-mapping';
import { isContentResourceIdentity, parseResourceIdentity, toResourceIdentityColumns } from '@core-shared/resource-types';
import type { PaperMetadata, PdfExtractionMetadata, ResourceForProcessing } from '@core-shared/types';
import { canonicalResourcePlatformUrl, detectResourceUrl } from '@core-shared/url';
import {
	loadDraftShellForProcessing,
	loadOriginalResourceContentArtifact,
	loadResourceShellForProcessing,
	type ResourceProcessingShell,
	readOriginalResourceContentArtifact,
} from '@ingest/domain/resource-store';
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
import { loadEligibleResourceTranslationRevision } from './domain/resource-translation-store';
import { handleResolvedResource } from './kind-handler';
import { stagePaperEnrichment } from './platforms/paper';
import { stagePreferredOpenAlexContent, stagePreliminaryAcquisition } from './platforms/paper-content';
import { stagePdfTextExtraction } from './platforms/pdf';
import { MIN_MONITORED_VIDEO_DURATION_SECONDS } from './platforms/youtube-acquisition';
import {
	enqueueProcessing,
	parseResourceProcessingWorkflowPayload,
	type ResourceProcessingOperation,
	type ResourceProcessingWorkflowPayload,
} from './resource-admission';
import { rehostResourceImage } from './resource-image-rehosting';
import {
	persistProcessedDraft,
	persistProcessedResource,
	processedResourceImageSources,
	type ResourceProcessingFailureOutcome,
	settleResourceProcessingFailure,
} from './resource-persistence';
import {
	exactPlatformLocator,
	type ResolvedContentResourceInput,
	resolveContentResource,
	resolvedResourceIdentifiers,
} from './resource-resolver';
import { enqueueResourceTranslation } from './resource-translation-workflow';
import { PDF_MIME, pdfExtractionMetadata } from './web-acquisition';

class ResourceProcessingOutcomeError extends Error {
	constructor(
		readonly outcome: Exclude<ResourceProcessingFailureOutcome, 'retry'>,
		message: string,
		name: string,
	) {
		super(message);
		this.name = name;
	}
}

const RESOURCE_TRANSLATION_ADMISSION_STEP_CONFIG = {
	retries: DURABLE_WORKFLOW_RETRIES,
	timeout: '30 seconds',
} as const satisfies WorkflowStepConfig;

async function stageResourceImages(
	env: CoreEnv,
	step: WorkflowStep,
	resourceId: string,
	sourceUrls: readonly string[],
	isMonitoredOnly: boolean,
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
			throw new ResourceProcessingOutcomeError(
				isMonitoredOnly ? 'drop' : 'failed',
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

function shouldAcquireContent(shell: ResourceProcessingShell, force = false): boolean {
	const { resource } = shell;
	if (force) return !resource.storage_key && !!resource.url;
	const needsYouTubeAcquisition = resource.resource_platform === 'youtube' && !shell.hasYoutubeTranscript;
	const needsPlatformAcquisition = !!detectResourceUrl(resource.url) && (resource.kind_metadata === null || resource.creators.length === 0);
	return (!shell.hasPersistedContent || needsYouTubeAcquisition || needsPlatformAcquisition) && !resource.storage_key && !!resource.url;
}

async function stageSavedUrlAcquisition(env: CoreEnv, step: WorkflowStep, shell: ResourceProcessingShell): Promise<AcquiredContent> {
	const { resource } = shell;
	const locator = exactPlatformLocator(resource.resource_identifiers);
	const sourceUrl = locator ? canonicalResourcePlatformUrl(locator.resourcePlatform, locator.platformId) : resource.url;
	if (!sourceUrl) throw new Error(`Resource processing ${resource.processing_id} has no source URL`);
	const acquisition = await readSavedUrlAcquisitionArtifact(
		await step.do('acquire-content-kind-platform-v1', ACQUISITION_STEP, () =>
			scrapeSavedUrlArtifact(sourceUrl, env, shell.isMonitoredOnly, shell.sourceAvatarUrl, resource.processing_id),
		),
	);
	if (acquisition.status === 'rejected') {
		throw new ResourceProcessingOutcomeError('drop', acquisition.message, 'ResourceAcquisitionRejectedError');
	}
	const acquired = acquisition.content;
	if (shell.isMonitoredOnly && acquired.provider === 'youtube') {
		const durationSeconds = acquired.durationSeconds;
		if (durationSeconds === null || durationSeconds <= MIN_MONITORED_VIDEO_DURATION_SECONDS) {
			const reason = durationSeconds === null ? 'is a live stream or unstarted premiere' : `runs ${durationSeconds}s`;
			throw new ResourceProcessingOutcomeError(
				'drop',
				`YouTube processing ${resource.processing_id} ${reason}; monitored videos must exceed ${MIN_MONITORED_VIDEO_DURATION_SECONDS}s`,
				'MonitoredVideoRejectedError',
			);
		}
	}
	return acquired;
}

function assertPdfExtractionProcessable(input: {
	acquiredExtraction: PdfExtractionMetadata | undefined;
	isMonitoredOnly: boolean;
	pdfTextArtifact: Awaited<ReturnType<typeof stagePdfTextExtraction>> | null;
	resourceId: string;
}): void {
	const extraction = input.pdfTextArtifact ? pdfExtractionMetadata(input.pdfTextArtifact) : input.acquiredExtraction;
	if (extraction?.status === 'needs_ocr') {
		throw new ResourceProcessingOutcomeError(
			input.isMonitoredOnly ? 'drop' : 'failed',
			`PDF resource ${input.resourceId} requires OCR`,
			'PdfOcrRequiredError',
		);
	}
}

function assertResourceContentProcessable(input: {
	acquiredContent: AcquiredContent | undefined;
	hasPersistedContent: boolean;
	isMonitoredOnly: boolean;
	pdfTextArtifact: Awaited<ReturnType<typeof stagePdfTextExtraction>> | null;
	resourceId: string;
}): void {
	if (input.hasPersistedContent || input.pdfTextArtifact?.text?.trim() || input.acquiredContent?.markdown?.trim()) return;
	throw new ResourceProcessingOutcomeError(
		input.isMonitoredOnly ? 'drop' : 'failed',
		`Resource ${input.resourceId} has no extractable content`,
		'ResourceContentMissingError',
	);
}

type PreparedResource = {
	acquiredContent: AcquiredContent | undefined;
	identityPdfTextArtifact: Awaited<ReturnType<typeof stagePdfTextExtraction>> | null;
	paperEnrichment: PaperMetadata | null;
	resolution: ResolvedContentResourceInput;
	resource: ResourceForProcessing;
};

async function prepareResourceForProcessing(
	env: CoreEnv,
	step: WorkflowStep,
	initialShell: ResourceProcessingShell,
	operation: ResourceProcessingOperation,
): Promise<PreparedResource> {
	const { resource: initialResource } = initialShell;
	if (operation === 'resync' && !initialResource.url) {
		throw new ResourceProcessingOutcomeError(
			'failed',
			`Resource processing ${initialResource.processing_id} has no source URL`,
			'ResourceResyncUnsupportedError',
		);
	}
	// Exact DOI/arXiv/OpenAlex URLs can go straight to OpenAlex Content. The
	// original landing page is only acquired when OpenAlex has no cached PDF.
	const preliminary = await stagePreliminaryAcquisition(env, step, initialResource, async () => {
		if (!shouldAcquireContent(initialShell, operation === 'resync')) return undefined;
		return stageSavedUrlAcquisition(env, step, initialShell);
	});
	let { acquiredContent } = preliminary;
	const acquiredResource = applyAcquiredMaterial(initialResource, acquiredContent);
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
		throw new ResourceProcessingOutcomeError('failed', 'Resolver produced an invalid content Resource identity', 'ResourceIdentityError');
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

async function settleFailedResourceProcessing(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		error: unknown;
		persistedSourceRevision: string | null | undefined;
		resourceId: string;
	},
): Promise<boolean> {
	if (input.persistedSourceRevision === undefined) return false;
	const outcome: ResourceProcessingFailureOutcome = input.error instanceof ResourceProcessingOutcomeError ? input.error.outcome : 'retry';
	const settlement = await step
		.do(
			'settle-resource-processing-for-source-revision-v1',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() => settleResourceProcessingFailure(env, input.resourceId, input.persistedSourceRevision ?? null, outcome),
		)
		.catch((cleanupError) => {
			console.error({
				tag: 'WORKFLOW',
				msg: 'Failed to settle resource processing',
				resource_id: input.resourceId,
				error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
			});
			return undefined;
		});
	if (outcome !== 'drop' || settlement !== 'dropped') return false;
	await step
		.do('delete-dropped-ai-search-item-v1', AI_SEARCH_SYNC_STEP_CONFIG, () => syncCorpusItem(env, input.resourceId))
		.catch((cleanupError) =>
			console.error({
				tag: 'WORKFLOW',
				msg: 'Failed to delete dropped AI Search item',
				resource_id: input.resourceId,
				error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
			}),
		);
	console.info({ tag: 'WORKFLOW', msg: 'Dropped source-only resource', resource_id: input.resourceId });
	return true;
}

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceProcessingWorkflowPayload> {
	async run(event: WorkflowEvent<ResourceProcessingWorkflowPayload>, step: WorkflowStep) {
		const { target } = parseResourceProcessingWorkflowPayload(event.payload);
		const operation: ResourceProcessingOperation = target.kind === 'stored' ? target.operation : 'ingest';
		const processingId = target.kind === 'stored' ? target.resourceId : event.instanceId;
		let persistedSourceRevision: string | null | undefined;
		try {
			const initialShell = await step.do(
				target.kind === 'stored' ? 'fetch-resource-shell-kind-platform-v1' : 'build-resource-draft-shell-v1',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() =>
					target.kind === 'stored'
						? loadResourceShellForProcessing(this.env, target.resourceId)
						: loadDraftShellForProcessing(this.env, event.instanceId, target),
			);
			const { resource: initialResource } = initialShell;
			persistedSourceRevision = target.kind === 'stored' ? initialResource.source_revision : undefined;
			if (target.kind === 'stored' && target.sourceRevision !== undefined && initialResource.source_revision !== target.sourceRevision) {
				return { status: 'superseded', resourceId: target.resourceId } as const;
			}
			const prepared = await prepareResourceForProcessing(this.env, step, initialShell, operation);
			const { acquiredContent, identityPdfTextArtifact, paperEnrichment, resolution, resource } = prepared;
			const logContext = { processing_id: processingId, target_kind: target.kind };

			console.info({
				tag: 'WORKFLOW',
				msg: 'Starting',
				resourceKind: resource.kind,
				resourcePlatform: resource.resource_platform,
				...logContext,
			});
			const hasContent = initialShell.hasPersistedContent;
			const pdfTextArtifact =
				identityPdfTextArtifact ??
				(!hasContent && !acquiredContent && resource.storage_key && resource.file_type === PDF_MIME
					? await stagePdfTextExtraction(this.env, step, {
							sourceStorageKey: resource.storage_key,
						})
					: null);
			assertPdfExtractionProcessable({
				acquiredExtraction: acquiredContent?.provider === null ? acquiredContent.extraction : undefined,
				isMonitoredOnly: initialShell.isMonitoredOnly,
				pdfTextArtifact,
				resourceId: processingId,
			});
			assertResourceContentProcessable({
				acquiredContent,
				hasPersistedContent: hasContent,
				isMonitoredOnly: initialShell.isMonitoredOnly,
				pdfTextArtifact,
				resourceId: processingId,
			});

			// Read only the original content when the shell is otherwise sufficient. The stream keeps large content outside Workflow's persisted-value
			// size limit; acquired or extracted content always wins.
			const persistedContent =
				acquiredContent || pdfTextArtifact
					? null
					: await readOriginalResourceContentArtifact(
							await step.do(
								'load-original-resource-content-kind-platform-v1',
								{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
								() => loadOriginalResourceContentArtifact(this.env, target.kind === 'stored' ? target.resourceId : processingId),
							),
							target.kind === 'stored' ? target.resourceId : processingId,
						);
			const resourceWithContent = persistedContent === null ? resource : { ...resource, content: persistedContent };
			const extractedPdfText = pdfTextArtifact?.text?.trim();
			const processableResource = extractedPdfText ? { ...resourceWithContent, content: extractedPdfText } : resourceWithContent;

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
			const persistenceInput = {
				handled,
				classification,
				previewImageUrl,
			};
			let imageSources: string[];
			try {
				imageSources = processedResourceImageSources(persistenceInput);
			} catch (error) {
				throw new ResourceProcessingOutcomeError(
					initialShell.isMonitoredOnly ? 'drop' : 'failed',
					`Resource processing ${processingId} has an invalid canonical image source: ${error instanceof Error ? error.message : String(error)}`,
					'ResourceImageSourceError',
				);
			}
			const hostedImages = await stageResourceImages(this.env, step, processingId, imageSources, initialShell.isMonitoredOnly);
			const persistence = await step.do(
				target.kind === 'stored' ? 'persist-stored-resource-graph-v4' : 'persist-final-resource-draft-v1',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() =>
					target.kind === 'stored'
						? persistProcessedResource(
								this.env,
								{
									...persistenceInput,
									resourceId: target.resourceId,
									expectedSourceRevision: initialResource.source_revision,
								},
								hostedImages,
							)
						: persistProcessedDraft(this.env, { ...persistenceInput, admission: target.admission }, hostedImages),
			);
			if (!persistence.persisted) {
				return { status: 'superseded', resourceId: persistence.resourceId } as const;
			}
			const persistedResourceId = persistence.resourceId;
			if (persistence.resourceNeedsProcessing) {
				await step
					.do(
						'enqueue-private-paper-canonical-v1',
						{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
						() => enqueueProcessing(this.env, persistedResourceId),
					)
					.catch((error) =>
						console.error({
							tag: 'WORKFLOW',
							msg: 'Canonical paper committed but enqueue failed; pending reconciler will retry',
							resource_id: persistedResourceId,
							error: error instanceof Error ? error.message : String(error),
						}),
					);
				return { status: 'persisted', resourceId: persistedResourceId, attachedCanonicalResourceId: persistedResourceId } as const;
			}
			if (target.kind === 'stored' && persistence.subjectNeedsProcessing && persistence.subjectResourceId) {
				await step
					.do(
						'enqueue-resolved-subject-v1',
						{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
						() => enqueueProcessing(this.env, persistence.subjectResourceId!),
					)
					.catch((error) =>
						console.error({
							tag: 'WORKFLOW',
							msg: 'Subject committed but enqueue failed; pending reconciler will retry',
							resource_id: persistence.subjectResourceId,
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
			return { status: 'persisted', resourceId: persistedResourceId, ...(operation === 'resync' ? { changed: true } : {}) } as const;
		} catch (error) {
			if (target.kind === 'draft') {
				if (error instanceof ResourceProcessingOutcomeError) {
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
			if (operation === 'resync') throw error;
			if (
				await settleFailedResourceProcessing(this.env, step, {
					error,
					persistedSourceRevision,
					resourceId: target.resourceId,
				})
			) {
				return { status: 'rejected', resourceId: target.resourceId } as const;
			}
			throw error;
		}
	}
}
