import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { normalizePaperIdentifiers } from '@core-shared/paper-identity';
import { isPaperIdentifier } from '@core-shared/resource-identifiers';
import type { ResourceImagePlan } from '@core-shared/resource-images';
import {
	isContentResourceIdentity,
	isResourceSourceSnapshotHash,
	parseResourceIdentity,
	toResourceIdentityColumns,
} from '@core-shared/resource-types';
import type { PaperMetadata, ResourceForProcessing } from '@core-shared/types';
import { detectResourceUrl } from '@core-shared/url';
import { claimStalePendingResourceAdmissions } from '@ingest/domain/resource-admission-store';
import { loadResourceForProcessing, loadResourceShellForProcessing } from '@ingest/domain/resource-store';
import { loadFeedSourcePolicy } from '@ingest/domain/source-store';
import { AI_SEARCH_SYNC_STEP_CONFIG, syncCorpusItem } from '../ai-search';
import { DURABLE_WORKFLOW_RETRIES, enqueueOrRestartWorkflow } from '../workflow-control';
import {
	ACQUISITION_STEP,
	type AcquiredContent,
	applyAcquiredMaterial,
	PDF_MIME,
	pdfExtractionMetadata,
	readAcquiredContentArtifact,
	scrapeRssFeedItemArtifact,
	scrapeSavedUrlArtifact,
	stageAcquisitionEnhancements,
} from './acquisition';
import { enqueueResourceTranslation, loadEligibleResourceTranslationRevision } from './content-localization-workflow';
import { classifyResource } from './domain/ai-utils';
import { handleResolvedResource } from './kind-handler';
import { stagePaperEnrichment } from './platforms/paper';
import { stagePreferredOpenAlexContent, stagePreliminaryAcquisition } from './platforms/paper-content';
import { stagePdfTextExtraction } from './platforms/pdf';
import type { RssFeedAcquisitionInput } from './platforms/rss-feed';
import { rehostResourceImages } from './resource-image-rehosting';
import { markResourceEnrichmentFailed, persistProcessedResource } from './resource-persistence';
import {
	canonicalPlatformUrl,
	exactPlatformLocator,
	type ResolvedContentResourceInput,
	resolveContentResource,
	resolvedResourceIdentifiers,
} from './resource-resolver';

type WorkflowOperation = 'ingest' | 'resync';
type WorkflowPayload = { resourceId: string; operation: WorkflowOperation; sourceRevision?: string };

const PENDING_RESOURCE_GRACE_MS = 10 * 60 * 1000;
// Stale pending resources are readmitted through the same canonical resolver
// as fresh ingest; pace reconciliation well below the Workflow creation limit.
const PENDING_RESOURCE_RECONCILE_LIMIT = 50;
const PENDING_RESOURCE_RECONCILE_CONCURRENCY = 10;
const RESOURCE_TRANSLATION_ADMISSION_STEP_CONFIG = {
	retries: DURABLE_WORKFLOW_RETRIES,
	timeout: '30 seconds',
} as const satisfies WorkflowStepConfig;

export async function enqueueProcessing(env: CoreEnv, resourceId: string, sourceRevision?: string): Promise<string> {
	if (sourceRevision && !isResourceSourceSnapshotHash(sourceRevision)) throw new Error('Invalid resource source revision');
	return enqueueOrRestartWorkflow(env.RESOURCE_PROCESSING_V2_WORKFLOW, storedWorkflowId(resourceId, sourceRevision), {
		resourceId,
		operation: 'ingest',
		...(sourceRevision ? { sourceRevision } : {}),
	});
}

/** Re-admits app-owned pending rows whose initial DB -> Workflow handoff was interrupted. */
export async function reconcilePendingResourceProcessing(env: CoreEnv): Promise<void> {
	const admissions = await claimStalePendingResourceAdmissions(
		env,
		new Date(Date.now() - PENDING_RESOURCE_GRACE_MS),
		PENDING_RESOURCE_RECONCILE_LIMIT,
	);
	if (!admissions.length) return;

	let reconciled = 0;
	let failed = 0;
	for (let offset = 0; offset < admissions.length; offset += PENDING_RESOURCE_RECONCILE_CONCURRENCY) {
		const batch = admissions.slice(offset, offset + PENDING_RESOURCE_RECONCILE_CONCURRENCY);
		const results = await Promise.allSettled(
			batch.map(({ resourceId, sourceRevision }) => enqueueProcessing(env, resourceId, sourceRevision ?? undefined)),
		);
		for (const [index, result] of results.entries()) {
			if (result.status === 'fulfilled') {
				reconciled++;
				continue;
			}
			failed++;
			console.error({
				tag: 'RESOURCE_WORKFLOW',
				event: 'pending_resource_reconciliation_failed',
				resource_id: batch[index]?.resourceId,
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
	}
	console.info({
		tag: 'RESOURCE_WORKFLOW',
		event: 'pending_resource_reconciliation_completed',
		attempted: admissions.length,
		reconciled,
		failed,
	});
}

export async function enqueueResourceResync(env: CoreEnv, resourceId: string): Promise<string> {
	// A resync is a distinct run, not a retry of the original ingest. A unique
	// instance ID also keeps clients from observing a cached terminal status
	// from an earlier resync of the same resource.
	const instance = await env.RESOURCE_PROCESSING_V2_WORKFLOW.create({
		id: `resource-resync-v2-${workflowIdPart(resourceId)}-${crypto.randomUUID()}`,
		params: { resourceId, operation: 'resync' },
	});
	return instance.id;
}

function workflowIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

function storedWorkflowId(resourceId: string, sourceRevision?: string): string {
	return sourceRevision
		? ['resource-v4', workflowIdPart(resourceId), sourceRevision.slice(0, 32)].join('-')
		: ['resource-v4', workflowIdPart(resourceId)].join('-');
}

async function stageResourceImages(env: CoreEnv, step: WorkflowStep, resourceId: string, plan: ResourceImagePlan): Promise<void> {
	const imageSourceRevision = plan.revision;
	if (imageSourceRevision === null) return;
	await step
		.do(
			'rehost-resource-images-v2',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
			async () => {
				await rehostResourceImages(env.R2, plan);
				await env.DOMAIN.markResourceImagesReady({ resourceId, imageSourceRevision });
				console.info({
					tag: 'RESOURCE_IMAGE',
					event: 'eager_rehost_completed',
					resource_id: resourceId,
					image_source_revision: imageSourceRevision,
				});
			},
		)
		.catch((error) =>
			console.error({
				tag: 'RESOURCE_IMAGE',
				event: 'eager_rehost_failed',
				resource_id: resourceId,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
}

function shouldAcquireContent(
	resource: ResourceForProcessing & { has_content?: boolean; has_youtube_transcript?: boolean },
	force = false,
): boolean {
	if (force) return !resource.storage_key && !!resource.url;
	const hasContent = 'has_content' in resource && !!resource.has_content;
	const needsYouTubeAcquisition = resource.resource_platform === 'youtube' && !resource.has_youtube_transcript;
	const needsPlatformAcquisition = !!detectResourceUrl(resource.url) && resource.kind_metadata === null;
	return (!hasContent || needsYouTubeAcquisition || needsPlatformAcquisition) && !resource.storage_key && !!resource.url;
}

async function stageSavedUrlAcquisition(env: CoreEnv, step: WorkflowStep, resource: ResourceForProcessing): Promise<AcquiredContent> {
	const locator = exactPlatformLocator(resource.resource_identifiers);
	const sourceUrl = locator ? canonicalPlatformUrl(locator) : resource.url;
	if (!sourceUrl) throw new Error(`Resource ${resource.id} has no source URL`);
	// A monitored source's feed decided to list this; anything else is a person's
	// explicit save, which feed policies must not veto.
	const origin = { monitored: !!resource.source_id };
	const acquired = await readAcquiredContentArtifact(
		await step.do('acquire-content-kind-platform-v1', ACQUISITION_STEP, () => scrapeSavedUrlArtifact(sourceUrl, env, origin, resource.id)),
	);
	return stageAcquisitionEnhancements(step, acquired, resource.id);
}

function feedSourceId(resource: ResourceForProcessing): string | null {
	// A detected special platform remains authoritative even when its URL came
	// from an RSS/Atom source. Feed content policy applies only to generic docs.
	return resource.resource_platform === null && resource.source_acquisition_mode === 'feed' ? resource.source_id : null;
}

async function stageRssFeedAcquisition(env: CoreEnv, step: WorkflowStep, input: RssFeedAcquisitionInput): Promise<AcquiredContent> {
	return readAcquiredContentArtifact(
		await step.do('acquire-rss-feed-content-kind-platform-v1', ACQUISITION_STEP, () => scrapeRssFeedItemArtifact(input, env)),
	);
}

function assertPdfExtractionProcessable(input: {
	acquiredExtraction: AcquiredContent['extraction'];
	pdfTextArtifact: Awaited<ReturnType<typeof stagePdfTextExtraction>> | null;
	resourceId: string;
}): void {
	const extraction = input.pdfTextArtifact ? pdfExtractionMetadata(input.pdfTextArtifact) : input.acquiredExtraction;
	if (extraction?.status === 'needs_ocr') {
		throw new NonRetryableError(`PDF resource ${input.resourceId} requires OCR`, 'PdfOcrRequiredError');
	}
}

async function acquireResourceForOperation(
	env: CoreEnv,
	step: WorkflowStep,
	resource: ResourceForProcessing,
	operation: WorkflowOperation,
): Promise<AcquiredContent | undefined> {
	if (!shouldAcquireContent(resource, operation === 'resync')) return undefined;
	const sourceId = feedSourceId(resource);
	if (sourceId) {
		const source = await step.do(
			'load-rss-source-policy',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() => loadFeedSourcePolicy(env, sourceId),
		);
		if (source.acquisitionMode === 'feed') {
			if (!resource.url) throw new Error(`RSS resource ${resource.id} has no article URL`);
			return stageRssFeedAcquisition(env, step, {
				feedUrl: source.handle,
				articleUrl: resource.url,
				resourceId: resource.id,
				sourceName: source.name,
			});
		}
	}
	return stageSavedUrlAcquisition(env, step, resource);
}

function assertOperationCanProcessResource(resource: ResourceForProcessing, operation: WorkflowOperation): void {
	if (operation === 'resync' && !resource.url) {
		throw new NonRetryableError(`Resource ${resource.id} has no source URL`, 'ResourceResyncUnsupportedError');
	}
}

type PreparedResource = {
	acquiredContent: AcquiredContent | undefined;
	identityPdfTextArtifact: Awaited<ReturnType<typeof stagePdfTextExtraction>> | null;
	paperEnrichment: PaperMetadata | null;
	resolution: ResolvedContentResourceInput;
	resource: ResourceForProcessing;
};

function acquiredSubjectUrl(acquired: AcquiredContent | undefined): string | null {
	if (!acquired) return null;
	if (acquired.provider === 'hackernews') return acquired.hackerNewsItem?.url?.trim() || null;
	if (acquired.provider === 'twitter') {
		return acquired.acquisition.data.externalUrl?.trim() || null;
	}
	return null;
}

async function prepareResourceForProcessing(
	env: CoreEnv,
	step: WorkflowStep,
	initialResource: ResourceForProcessing,
	operation: WorkflowOperation,
): Promise<PreparedResource> {
	// Exact DOI/arXiv/OpenAlex URLs can go straight to OpenAlex Content. The
	// original landing page is only acquired when OpenAlex has no cached PDF.
	const preliminary = await stagePreliminaryAcquisition(env, step, initialResource, () =>
		acquireResourceForOperation(env, step, initialResource, operation),
	);
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
						identifiers: preliminary.explicitResolution?.identifiers ?? initialResource.paper_identifiers,
					},
					{ stepName: 'resolve-paper-openalex-with-citations-v1' },
				)
			: { contentGrobidXmlUrl: null, contentPdfUrl: null, identifiers: [], metadata: null };
	const paperEnrichment = paperResolution.metadata;
	const preferred = await stagePreferredOpenAlexContent(env, step, acquiredResource, acquiredContent, paperResolution, preliminary);
	acquiredContent = preferred.acquiredContent;
	const paperIdentifiers = normalizePaperIdentifiers(paperResolution.identifiers);
	const resolution = resolveContentResource({
		url: preferred.resource.url,
		paperIdentifiers,
		resourceIdentifiers: preferred.resource.resource_identifiers,
		subjectUrl: acquiredSubjectUrl(acquiredContent),
	});
	const finalPaperEnrichment = resolution.kind === 'paper' ? paperEnrichment : null;
	const identity = parseResourceIdentity(resolution.kind, resolution.resourcePlatform);
	if (!identity || !isContentResourceIdentity(identity)) {
		throw new NonRetryableError('Resolver produced an invalid content Resource identity', 'ResourceIdentityError');
	}
	const identifiers = resolvedResourceIdentifiers(resolution, preferred.resource.resource_identifiers);
	const locator = exactPlatformLocator(identifiers);
	const resolvedUrl = locator ? canonicalPlatformUrl(locator) : preferred.resource.url;
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
			paper_identifiers: identifiers.filter(isPaperIdentifier),
		},
	};
}

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, WorkflowPayload> {
	async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep) {
		const { resourceId, operation, sourceRevision } = event.payload;
		if (sourceRevision !== undefined && !isResourceSourceSnapshotHash(sourceRevision)) {
			throw new NonRetryableError('Invalid resource source revision', 'ResourceSourceRevisionError');
		}
		let persistedSourceRevision: string | null | undefined;
		try {
			return await this.runResource(resourceId, step, operation, sourceRevision, (revision) => {
				persistedSourceRevision = revision;
			});
		} catch (error) {
			if (operation === 'resync') throw error;
			// Cleanup must not throw: whatever it raises would replace `error`
			// as the instance's top-level failure. Do not delete the search
			// document here. Successful persistence is the only path that writes
			// it, and a concurrent newer workflow may have refreshed it after
			// this workflow failed.
			const logCleanupFailure = (msg: string) => (cleanupError: unknown) =>
				console.error({
					tag: 'WORKFLOW',
					msg,
					resource_id: resourceId,
					error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
				});
			if (persistedSourceRevision !== undefined) {
				await step
					.do(
						'mark-resource-failed-for-source-revision-v1',
						{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
						() => markResourceEnrichmentFailed(this.env, resourceId, persistedSourceRevision ?? null),
					)
					.catch(logCleanupFailure('Failed to mark resource as failed'));
			}
			throw error;
		}
	}

	private async runResource(
		resourceId: string,
		step: WorkflowStep,
		operation: WorkflowOperation,
		expectedSourceRevision: string | undefined,
		recordPersistedSourceRevision: (revision: string | null) => void,
	) {
		const initialResource = await step.do(
			'fetch-resource-shell-kind-platform-v1',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => loadResourceShellForProcessing(this.env, resourceId),
		);
		recordPersistedSourceRevision(initialResource.source_revision);
		if (expectedSourceRevision !== undefined && initialResource.source_revision !== expectedSourceRevision) {
			return { success: true, resource_id: resourceId, operation, superseded: true };
		}
		assertOperationCanProcessResource(initialResource, operation);
		const prepared = await prepareResourceForProcessing(this.env, step, initialResource, operation);
		const { acquiredContent, identityPdfTextArtifact, paperEnrichment, resolution, resource } = prepared;
		const logContext = { resource_id: resourceId, table: 'resources' };

		console.info({
			tag: 'WORKFLOW',
			msg: 'Starting',
			resourceKind: resource.kind,
			resourcePlatform: resource.resource_platform,
			...logContext,
		});
		const hasContent = 'has_content' in resource && !!resource.has_content;
		const pdfTextArtifact =
			identityPdfTextArtifact ??
			(!hasContent && !acquiredContent && resource.storage_key && resource.file_type === PDF_MIME
				? await stagePdfTextExtraction(this.env, step, {
						sourceStorageKey: resource.storage_key,
					})
				: null);
		assertPdfExtractionProcessable({
			acquiredExtraction: acquiredContent?.extraction,
			pdfTextArtifact,
			resourceId,
		});
		await step.do('validate-resource-content', { retries: { limit: 0, delay: '1 second' }, timeout: '5 seconds' }, async () => {
			const hasProcessableContent = hasContent || !!pdfTextArtifact?.text?.trim() || !!acquiredContent?.markdown?.trim();
			if (!hasProcessableContent) {
				throw new NonRetryableError(`Resource ${resourceId} has no extractable content`, 'ResourceContentMissingError');
			}
			return true;
		});

		// Reread durable rows unless in-memory acquisition already holds the freshest copy; PDF text always wins.
		const loadFull = async (): Promise<ResourceForProcessing> => {
			const base = acquiredContent || pdfTextArtifact ? resource : await loadResourceForProcessing(this.env, resourceId);
			const extractedPdfText = pdfTextArtifact?.text?.trim();
			return extractedPdfText ? { ...base, content: extractedPdfText } : base;
		};

		const previewImageUrl = acquiredContent?.previewImageUrl?.trim() || null;
		const handled = await handleResolvedResource({
			acquiredContent,
			env: this.env,
			loadFull,
			paperEnrichment,
			resolution,
			resource,
			step,
		});

		const classificationResult = await step.do(
			'classify-resource',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
			() => classifyResource(handled.resource, this.env, handled.classificationExclusions),
		);
		const persistence = await step.do(
			'update-db-kind-platform-v2',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				return persistProcessedResource(this.env, {
					resourceId,
					expectedSourceRevision: initialResource.source_revision,
					handled,
					processorResult: classificationResult,
					previewImageUrl,
				});
			},
		);
		if (!persistence.persisted) {
			return { success: true, resource_id: persistence.resourceId, operation, superseded: true };
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
			return {
				success: true,
				resource_id: persistedResourceId,
				operation,
				attachedCanonicalResourceId: persistedResourceId,
			};
		}
		if (persistence.subjectNeedsProcessing && persistence.subjectResourceId) {
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
		await stageResourceImages(this.env, step, persistedResourceId, persistence.imagePlan);
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

		console.info({ tag: 'WORKFLOW', msg: 'Completed', resource_id: persistedResourceId, table: 'resources' });
		return {
			success: true,
			resource_id: persistedResourceId,
			...(operation !== 'ingest' ? { operation, changed: true } : {}),
		};
	}
}
