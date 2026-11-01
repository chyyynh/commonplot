import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { stageQuality, stageResourceAcquisition } from '../adapters/acquire';
import type { AcquisitionInput } from '../contracts/acquired-resource';
import { resourceImageSources, withHostedImages } from '../contracts/image-mapping';
import { CONTENT_TRANSLATION_LANGS } from '../contracts/languages';
import { ResourceProcessingTargetSchema, type ResourceProcessingTarget } from '../contracts/processing-target';
import { MONITOR_QUALITY_MIN } from '../contracts/quality';
import { creatorName } from '../contracts/resource-kinds';
import { blobKey } from '../contracts/storage-keys';
import { enqueueMonitorDrafts } from '../monitors/admission';
import { stageResourceImages } from '../services/image-rehosting';
import { errorMessage, namedErrorMessage } from '../services/response';
import { STORAGE_STEP, timedStep } from '../services/workflow-step';
import { withCoreDb } from '../store/db';
import { loadTranslationCandidate } from '../store/derivations';
import { failRequests, judgeMonitorRequests } from '../store/requests';
import {
	claimAcquisitionFence,
	loadReacquisitionSource,
	persistResolvedResource,
	type ResourcePersistenceTarget,
} from '../store/resources';
import { deriveResource } from './derivation';
import { stageResourceReferences } from './references';
import { admitRequests } from './requests';
import { enqueueResourceTranslation } from './translation';

/** The published Resource, or a run a newer attempt replaced. */
type ResourceProcessingOutput =
	| { outcome: 'ready'; resourceId: string; textHash: string }
	| { outcome: 'superseded' }
	| { outcome: 'rejected'; quality: number };

/** What a run's `ingest_run` log line reports beside its step timings; the weekly ingest review reads these lines. */
type IngestRun = { resourceKind?: string; resourcePlatform?: string | null; chars?: number; quality?: number | null; writtenAt?: number };

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceProcessingTarget> {
	async run(event: WorkflowEvent<ResourceProcessingTarget>, step: WorkflowStep): Promise<ResourceProcessingOutput> {
		const target = ResourceProcessingTargetSchema.parse(event.payload);
		const timings: Record<string, number> = {};
		const run: IngestRun = {};
		const record = (outcome: string, error?: string) =>
			step.do('record-ingest-run-v1', async () => {
				console.info({
					tag: 'INGEST',
					event: 'ingest_run',
					workflow_id: event.instanceId,
					requester: target.requester,
					target_kind: target.kind,
					outcome,
					resource_kind: run.resourceKind ?? null,
					resource_platform: run.resourcePlatform ?? null,
					chars: run.chars ?? null,
					quality: run.quality ?? null,
					// From the Workflow's creation, so queueing counts: when the import could first show as ready.
					written_ms: run.writtenAt ? run.writtenAt - event.timestamp.getTime() : null,
					total_ms: Date.now() - event.timestamp.getTime(),
					...(error ? { error: error.slice(0, 500) } : {}),
					steps: timings,
				});
			});
		try {
			const output = await this.process(target, event.instanceId, timedStep(step, timings), run);
			await record(output.outcome);
			return output;
		} catch (error) {
			// Every request waiting on this acquisition settles with it, so none waits for a workflow that ended.
			const message = namedErrorMessage(error);
			await step.do('fail-resource-requests-v1', STORAGE_STEP, () =>
				withCoreDb(this.env, (db) => failRequests(db, target.requestId, message)),
			);
			await record('failed', message);
			throw error;
		}
	}

	private async process(
		target: ResourceProcessingTarget,
		instanceId: string,
		step: WorkflowStep,
		run: IngestRun,
	): Promise<ResourceProcessingOutput> {
		// Read the stored side of a reacquisition here, so adapters never touch the database; Web describes the upload.
		let input: AcquisitionInput;
		switch (target.kind) {
			case 'draft':
				input = { kind: 'url', url: target.url, ...(target.sourceHints ? { sourceHints: target.sourceHints } : {}) };
				break;
			case 'reacquire': {
				const source = await step.do('load-resource-reacquisition-source-v3', STORAGE_STEP, async () =>
					withCoreDb(this.env, (db) => loadReacquisitionSource(db, target.resourceId)),
				);
				input = { kind: 'url', ...source };
				break;
			}
			case 'storedBlob': {
				// Web owns the upload: it confirms this attempt and describes the bytes. Core only rechecks, when it commits, that the object is still ready.
				const upload = await step.do('start-owned-pdf-attempt-v2', async () => {
					const verified = await this.env.APP.verifyStoredBlobProcessing(target.objectId, instanceId);
					return verified && { contentHash: verified.contentHash, fileName: verified.fileName };
				});
				if (!upload) {
					// A newer attempt of the same upload, or one Web gave up on, waits behind this lead or retries on its own.
					await step.do('supersede-upload-request-v1', STORAGE_STEP, () =>
						withCoreDb(this.env, (db) => failRequests(db, target.requestId, 'Superseded by a newer upload attempt', true)),
					);
					return { outcome: 'superseded' };
				}
				input = { kind: 'storedPdf', objectId: target.objectId, pdf: upload };
			}
		}
		// An uploaded PDF identified as a paper publishes that paper, read from the upload.
		const resource = await stageResourceAcquisition(this.env, step, input, instanceId);
		// Only a monitor's entry is judged: whoever else asked chose it already.
		const quality = target.requester === 'monitor' ? await stageQuality(this.env, step, resource, instanceId) : null;
		Object.assign(run, {
			resourceKind: resource.kind,
			resourcePlatform: resource.resourcePlatform,
			chars: resource.content.length,
			quality,
		});
		// An entry a reader would not save is kept out, unless someone besides monitors asked for it too.
		if (quality !== null) {
			const monitors = await step.do('judge-monitor-requests-v2', STORAGE_STEP, () =>
				withCoreDb(this.env, (db) => judgeMonitorRequests(db, target.requestId, quality, MONITOR_QUALITY_MIN)),
			);
			if (monitors.length) {
				// What a rejected post quotes or links may be worth reading on its own, so each monitor asks for it as an entry it
				// found, judged by its own text.
				const subjectUrl = resource.subjectUrl;
				if (subjectUrl)
					await step.do('request-rejected-subject-v1', STORAGE_STEP, () =>
						withCoreDb(this.env, async (db) => {
							for (const monitorId of new Set(monitors)) await enqueueMonitorDrafts(db, monitorId, [{ url: subjectUrl }]);
						}),
					);
				return { outcome: 'rejected', quality };
			}
		}
		// Where this attempt writes. Reacquiring an existing Resource claims a fencing token, so it commits only if no newer
		// attempt has committed first. An upload runs one attempt at a time: an identified one is a draft of its public paper,
		// and any other stays the uploader's private file.
		const persistenceTarget: ResourcePersistenceTarget =
			target.kind === 'draft'
				? { kind: 'draft' }
				: target.kind === 'reacquire'
					? {
							kind: 'existing',
							resourceId: target.resourceId,
							fence: await step.do('claim-acquisition-fence-v1', STORAGE_STEP, async () =>
								withCoreDb(this.env, (db) => claimAcquisitionFence(db, target.resourceId)),
							),
							...(target.force ? { force: true } : {}),
						}
					: resource.kind === 'paper'
						? { kind: 'draft', uploadId: target.objectId }
						: { kind: 'upload', objectId: target.objectId };

		console.info({
			tag: 'WORKFLOW',
			msg: 'Starting',
			resourceKind: resource.kind,
			resourcePlatform: resource.resourcePlatform,
			processing_id: instanceId,
			target_kind: target.kind,
		});
		const hosted = {
			...withHostedImages(resource, await stageResourceImages(this.env, step, instanceId, resourceImageSources([resource]))),
			qualityScore: quality,
		};
		const persistence = await step.do('persist-resolved-resource-scope-v9', STORAGE_STEP, async () =>
			withCoreDb(this.env, (db) =>
				persistResolvedResource(
					db,
					hosted,
					persistenceTarget,
					target.requestId,
					async (contentHash) => (await this.env.R2.head(blobKey(contentHash))) !== null,
				),
			),
		);
		if (persistence.outcome === 'superseded') return { outcome: 'superseded' };
		run.writtenAt = Date.now();
		const { id: resourceId, scope, subjectResourceId, textHash, outcome, carriers, imports } = persistence;
		// The Resource is published; its summary and entities are derived from what was written, and each handoff waits
		// only for the derivations it reads.
		const derivations = persistence.derivations
			.filter((derivation) => derivation.kind !== 'translation')
			.map((derivation) => ({
				derivation,
				done: deriveResource(
					this.env,
					step,
					resourceId,
					textHash,
					{ ...hosted, description: hosted.summary, byline: hosted.creators.map(creatorName) },
					derivation,
					instanceId,
				),
			}));
		const summaries = Promise.all(derivations.flatMap(({ derivation, done }) => (derivation.kind === 'summary' ? [done] : [])));
		const subjectUrl = resource.subjectUrl;
		// Crossref enrichment runs beside the handoffs; the import settles only after it, since the Workflow returns last.
		const references =
			scope === 'corpus' &&
			persistence.kind === 'paper' &&
			outcome === 'written' &&
			hosted.references?.some(({ doi, arxivId }) => !doi && !arxivId)
				? stageResourceReferences(this.env, step, resourceId).catch((error: unknown) => {
						console.error({ tag: 'WORKFLOW', msg: 'Reference enrichment failed', resource_id: resourceId, error: errorMessage(error) });
					})
				: undefined;
		// A private Resource keeps a document vector for its owner's interests. Attaching a subject rewrote its
		// carrier's search document, so the carrier syncs too.
		const searchSyncIds = [resourceId, ...carriers];
		// Every handoff runs to completion even when an independent one fails.
		const followups = await Promise.allSettled([
			// Web files each user import that asked for this Resource where its user asked.
			imports.length
				? step.do('save-imported-resources-v1', STORAGE_STEP, async () => {
						await this.env.APP.saveImportedResources(imports);
					})
				: undefined,
			// Search documents lead with the summaries.
			searchSyncIds.length
				? summaries.then(() =>
						step.do('enqueue-resolved-ai-search-sync-v3', STORAGE_STEP, async () => {
							await this.env.RESOURCE_SEARCH_SYNC_QUEUE.sendBatch(searchSyncIds.map((id) => ({ body: { resourceId: id } })));
						}),
					)
				: undefined,
			// Content translates here where it does automatically, or to renew one a reader has; readers request the rest.
			// A reacquisition that replaced the original forces a fresh run. Each waits for its language's card, whose title
			// and summary it reads for the names to keep.
			...CONTENT_TRANSLATION_LANGS.map(async (lang) => {
				const candidate = await step.do(`load-translation-candidate-${lang.toLowerCase()}-v1`, STORAGE_STEP, () =>
					withCoreDb(this.env, (db) => loadTranslationCandidate(db, resourceId, lang)),
				);
				if (!candidate?.automatic && !candidate?.translated) return;
				await derivations.find(({ derivation }) => derivation.kind === 'summary' && derivation.lang === lang)?.done;
				return step.do(`enqueue-resource-translation-${lang.toLowerCase()}-v9`, STORAGE_STEP, () =>
					enqueueResourceTranslation(persistence, lang, target.kind !== 'draft' && outcome === 'written'),
				);
			}),
			subjectUrl && outcome === 'written' && subjectResourceId === null
				? step.do('request-subject-v1', STORAGE_STEP, async () => {
						const leads = await withCoreDb(this.env, (db) =>
							admitRequests(db, [
								{
									requester: 'subject',
									parentResourceId: resourceId,
									parentTextHash: textHash,
									target: {
										kind: 'draft',
										url: subjectUrl,
										// Carrier-resolved hints only; the subject page still wins when it states its own date.
										...(resource.publishedDate ? { sourceHints: { publishedDate: resource.publishedDate } } : {}),
									},
								},
							]),
						);
						return leads.map(({ workflowId }) => workflowId);
					})
				: undefined,
		]);
		await Promise.all(derivations.map(({ done }) => done));
		await references;
		// The Resource is published, so a lost handoff is logged rather than failing the import that already landed.
		const failures = followups.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
		if (failures.length) console.error({ tag: 'WORKFLOW', msg: 'Follow-up dispatch failed', resource_id: resourceId, errors: failures });

		console.info({ tag: 'WORKFLOW', msg: 'Completed', resource_id: resourceId, target_kind: target.kind });
		return { outcome: 'ready', resourceId, textHash };
	}
}
