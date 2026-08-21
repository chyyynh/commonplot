import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { isPaperIdentifier, normalizeResourceIdentifiers } from '@core-shared/resource-identifiers';
import type { HostedResourceImage } from '@core-shared/resource-image-mapping';
import {
	isContentResourceIdentity,
	isResourceSourceSnapshotHash,
	parseResourceIdentity,
	toResourceIdentityColumns,
} from '@core-shared/resource-types';
import type { PaperMetadata, PdfExtractionMetadata, ResourceForProcessing } from '@core-shared/types';
import { canonicalResourcePlatformUrl, detectResourceUrl } from '@core-shared/url';
import { withCoreTx } from '@db/client';
import {
	claimStalePendingResourceAdmissions,
	type SourceResourceDraft,
	upsertPendingSourceResource,
} from '@ingest/domain/resource-admission-store';
import {
	loadOriginalResourceContentArtifact,
	loadResourceShellForProcessing,
	type ResourceProcessingShell,
	readOriginalResourceContentArtifact,
} from '@ingest/domain/resource-store';
import { AI_SEARCH_SYNC_STEP_CONFIG, syncCorpusItem } from '../ai-search';
import { DURABLE_WORKFLOW_RETRIES, enqueueOrRestartWorkflow } from '../workflow-control';
import {
	ACQUISITION_STEP,
	type AcquiredContent,
	applyAcquiredMaterial,
	readAcquiredContentArtifact,
	scrapeSavedUrlArtifact,
} from './acquisition';
import { classifyResource } from './domain/resource-classification';
import { loadEligibleResourceTranslationRevision } from './domain/resource-translation-store';
import { handleResolvedResource } from './kind-handler';
import { stagePaperEnrichment } from './platforms/paper';
import { stagePreferredOpenAlexContent, stagePreliminaryAcquisition } from './platforms/paper-content';
import { stagePdfTextExtraction } from './platforms/pdf';
import { MIN_MONITORED_VIDEO_DURATION_SECONDS } from './platforms/youtube-acquisition';
import { rehostResourceImage } from './resource-image-rehosting';
import {
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

type WorkflowOperation = 'ingest' | 'resync';
type WorkflowPayload = { resourceId: string; operation: WorkflowOperation; sourceRevision?: string };

class ResourceProcessingOutcomeError extends NonRetryableError {
	constructor(
		readonly outcome: Exclude<ResourceProcessingFailureOutcome, 'retry'>,
		message: string,
		name: string,
	) {
		super(message, name);
	}
}

const PENDING_RESOURCE_GRACE_MS = 10 * 60 * 1000;
// Completed instance IDs restart on their pinned Workflow version. Bump this
// namespace when a new graph must not reuse an older instance.
const RESOURCE_PROCESSING_WORKFLOW_REVISION = 'resource-v6';
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

export async function admitPendingSourceResource(env: CoreEnv, draft: SourceResourceDraft): Promise<void> {
	const pending = await withCoreTx(env, (db) => upsertPendingSourceResource(db, draft));
	if (pending.needsProcessing) await enqueueProcessing(env, pending.resourceId, pending.sourceRevision ?? undefined);
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
		? [RESOURCE_PROCESSING_WORKFLOW_REVISION, workflowIdPart(resourceId), sourceRevision.slice(0, 32)].join('-')
		: [RESOURCE_PROCESSING_WORKFLOW_REVISION, workflowIdPart(resourceId)].join('-');
}

async function stageResourceImages(
	env: CoreEnv,
	step: WorkflowStep,
	resourceId: string,
	sourceUrls: readonly string[],
): Promise<HostedResourceImage[]> {
	const images: HostedResourceImage[] = [];
	for (let offset = 0; offset < sourceUrls.length; offset += 3) {
		const batch = sourceUrls.slice(offset, offset + 3);
		const results = await Promise.all(
			batch.map((sourceUrl, batchIndex) => {
				const index = offset + batchIndex;
				return step
					.do(
						`rehost-resource-image-${index + 1}-v1`,
						{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
						() => rehostResourceImage(env.IMAGES, sourceUrl),
					)
					.catch((error) => {
						console.error({
							tag: 'RESOURCE_IMAGE',
							event: 'eager_rehost_failed',
							resource_id: resourceId,
							source_host: new URL(sourceUrl).hostname,
							error: error instanceof Error ? error.message : String(error),
						});
						return null;
					});
			}),
		);
		for (const result of results) if (result) images.push(result);
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
	if (!sourceUrl) throw new Error(`Resource ${resource.id} has no source URL`);
	const acquired = await readAcquiredContentArtifact(
		await step.do('acquire-content-kind-platform-v1', ACQUISITION_STEP, () =>
			scrapeSavedUrlArtifact(sourceUrl, env, shell.isMonitoredOnly, shell.sourceAvatarUrl, resource.id),
		),
	);
	if (shell.isMonitoredOnly && acquired.provider === 'youtube') {
		const durationSeconds = acquired.acquisition.data.durationSeconds;
		if (durationSeconds === null || durationSeconds <= MIN_MONITORED_VIDEO_DURATION_SECONDS) {
			const reason = durationSeconds === null ? 'is a live stream or unstarted premiere' : `runs ${durationSeconds}s`;
			throw new ResourceProcessingOutcomeError(
				'drop',
				`YouTube video ${resource.id} ${reason}; monitored videos must exceed ${MIN_MONITORED_VIDEO_DURATION_SECONDS}s`,
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

async function acquireResourceForOperation(
	env: CoreEnv,
	step: WorkflowStep,
	shell: ResourceProcessingShell,
	operation: WorkflowOperation,
): Promise<AcquiredContent | undefined> {
	if (!shouldAcquireContent(shell, operation === 'resync')) return undefined;
	return stageSavedUrlAcquisition(env, step, shell);
}

function assertOperationCanProcessResource(resource: ResourceForProcessing, operation: WorkflowOperation): void {
	if (operation === 'resync' && !resource.url) {
		throw new ResourceProcessingOutcomeError('failed', `Resource ${resource.id} has no source URL`, 'ResourceResyncUnsupportedError');
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
	if (acquired.provider === 'hackernews') return acquired.hackerNewsItem.url?.trim() || null;
	if (acquired.provider === 'twitter') {
		return acquired.acquisition.data.externalUrl?.trim() || null;
	}
	return null;
}

async function prepareResourceForProcessing(
	env: CoreEnv,
	step: WorkflowStep,
	initialShell: ResourceProcessingShell,
	operation: WorkflowOperation,
): Promise<PreparedResource> {
	const { resource: initialResource } = initialShell;
	// Exact DOI/arXiv/OpenAlex URLs can go straight to OpenAlex Content. The
	// original landing page is only acquired when OpenAlex has no cached PDF.
	const preliminary = await stagePreliminaryAcquisition(env, step, initialResource, () =>
		acquireResourceForOperation(env, step, initialShell, operation),
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
						identifiers: preliminary.explicitResolution?.identifiers ?? initialResource.resource_identifiers.filter(isPaperIdentifier),
					},
					{ stepName: 'resolve-paper-openalex-with-citations-v1' },
				)
			: { contentGrobidXmlUrl: null, contentPdfUrl: null, identifiers: [], metadata: null };
	const paperEnrichment = paperResolution.metadata;
	const preferred = await stagePreferredOpenAlexContent(env, step, acquiredResource, acquiredContent, paperResolution, preliminary);
	acquiredContent = preferred.acquiredContent;
	const resourceIdentifiers = normalizeResourceIdentifiers([...paperResolution.identifiers, ...preferred.resource.resource_identifiers]);
	const resolution = resolveContentResource({
		url: preferred.resource.url,
		resourceIdentifiers,
		subjectUrl: acquiredSubjectUrl(acquiredContent),
	});
	const finalPaperEnrichment = resolution.kind === 'paper' ? paperEnrichment : null;
	const identity = parseResourceIdentity(resolution.kind, resolution.resourcePlatform);
	if (!identity || !isContentResourceIdentity(identity)) {
		throw new ResourceProcessingOutcomeError('failed', 'Resolver produced an invalid content Resource identity', 'ResourceIdentityError');
	}
	const identifiers = resolvedResourceIdentifiers(resolution, resourceIdentifiers);
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
	const outcome: ResourceProcessingFailureOutcome =
		input.error instanceof ResourceProcessingOutcomeError
			? input.error.outcome
			: input.error instanceof NonRetryableError
				? 'drop'
				: 'retry';
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

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, WorkflowPayload> {
	async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep) {
		const { resourceId, operation, sourceRevision } = event.payload;
		if (sourceRevision !== undefined && !isResourceSourceSnapshotHash(sourceRevision)) {
			throw new ResourceProcessingOutcomeError('failed', 'Invalid resource source revision', 'ResourceSourceRevisionError');
		}
		let persistedSourceRevision: string | null | undefined;
		try {
			const initialShell = await step.do(
				'fetch-resource-shell-kind-platform-v1',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				async () => loadResourceShellForProcessing(this.env, resourceId),
			);
			const { resource: initialResource } = initialShell;
			persistedSourceRevision = initialResource.source_revision;
			if (sourceRevision !== undefined && initialResource.source_revision !== sourceRevision) {
				return { success: true, resource_id: resourceId, operation, superseded: true };
			}
			assertOperationCanProcessResource(initialResource, operation);
			const prepared = await prepareResourceForProcessing(this.env, step, initialShell, operation);
			const { acquiredContent, identityPdfTextArtifact, paperEnrichment, resolution, resource } = prepared;
			const logContext = { resource_id: resourceId, table: 'resources' };

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
				resourceId,
			});
			assertResourceContentProcessable({
				acquiredContent,
				hasPersistedContent: hasContent,
				isMonitoredOnly: initialShell.isMonitoredOnly,
				pdfTextArtifact,
				resourceId,
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
								() => loadOriginalResourceContentArtifact(this.env, resourceId),
							),
							resourceId,
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
				resourceId,
				expectedSourceRevision: initialResource.source_revision,
				handled,
				classification,
				previewImageUrl,
			};
			const hostedImages = await stageResourceImages(this.env, step, resourceId, processedResourceImageSources(persistenceInput));
			const persistence = await step.do(
				'update-db-kind-platform-v3',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => persistProcessedResource(this.env, persistenceInput, hostedImages),
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

			console.info({ tag: 'WORKFLOW', msg: 'Completed', resource_id: persistedResourceId, table: 'resources' });
			return {
				success: true,
				resource_id: persistedResourceId,
				...(operation !== 'ingest' ? { operation, changed: true } : {}),
			};
		} catch (error) {
			if (operation === 'resync') throw error;
			if (
				await settleFailedResourceProcessing(this.env, step, {
					error,
					persistedSourceRevision,
					resourceId,
				})
			) {
				return { success: true, resource_id: resourceId, operation, dropped: true };
			}
			throw error;
		}
	}
}
