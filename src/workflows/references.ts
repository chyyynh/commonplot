import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';
import { fetchCrossrefDepositedReferences, matchDepositedReferences, resolveCrossrefReferenceDoi } from '../services/crossref';
import { errorMessage } from '../services/response';
import { STORAGE_STEP, stepJson } from '../services/workflow-step';
import { withCoreDb } from '../store/db';
import { loadUnresolvedReferences, persistReferenceDois, type ReferenceDoi, type StoredReference } from '../store/references';

const CROSSREF_BATCH_SIZE = 10;
const CROSSREF_PACE_MS = 350;
const CROSSREF_STEP = { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
/** Ten sequential searches at up to 12 s each, with pacing between them. */
const CROSSREF_BATCH_STEP = { retries: CROSSREF_STEP.retries, timeout: '180 seconds' } as const;

/**
 * Search Crossref for each citation, ten to a step. A citation Crossref rejects or answers malformed is skipped; a transient failure retries
 * its batch, and a batch that keeps failing is skipped rather than failing the paper.
 */
async function resolveReferenceDois(step: WorkflowStep, references: readonly StoredReference[]): Promise<ReferenceDoi[]> {
	const updates: ReferenceDoi[] = [];
	for (let offset = 0; offset < references.length; offset += CROSSREF_BATCH_SIZE) {
		const batch = references.slice(offset, offset + CROSSREF_BATCH_SIZE);
		const resolved = await step
			.do(`resolve-crossref-references-v3-${offset / CROSSREF_BATCH_SIZE}`, CROSSREF_BATCH_STEP, async () => {
				const dois: ReferenceDoi[] = [];
				for (const [index, reference] of batch.entries()) {
					if (index) await scheduler.wait(CROSSREF_PACE_MS);
					try {
						const doi = await resolveCrossrefReferenceDoi(reference.text);
						if (doi) dois.push({ ...reference, doi });
					} catch (error) {
						if (!(error instanceof NonRetryableError || error instanceof z.ZodError)) throw error;
						console.warn({ tag: 'CROSSREF', event: 'reference_resolution_failed', ordinal: reference.ordinal, error: errorMessage(error) });
					}
				}
				return dois;
			})
			.catch((error) => {
				console.warn({ tag: 'CROSSREF', event: 'reference_batch_failed', first_ordinal: batch[0]!.ordinal, error: errorMessage(error) });
				return [];
			});
		updates.push(...resolved);
	}
	return updates;
}

/**
 * Give this paper's printed bibliography DOIs. A paper with a DOI reads its publisher's deposited
 * reference list once; only without a deposited list (preprints, closed publishers) does each citation search Crossref.
 */
export async function stageResourceReferences(env: CoreEnv, step: WorkflowStep, resourceId: string): Promise<void> {
	const { doi, references } = await stepJson(step, 'load-unresolved-references-v3', STORAGE_STEP, () =>
		withCoreDb(env, (db) => loadUnresolvedReferences(db, resourceId)),
	);
	if (!references.length) return;
	const deposited = doi
		? await stepJson(step, 'fetch-crossref-deposited-references-v1', CROSSREF_STEP, () => fetchCrossrefDepositedReferences(doi))
		: [];
	const updates = deposited.length ? matchDepositedReferences(references, deposited) : await resolveReferenceDois(step, references);
	const enrichedCount = updates.length
		? await step.do('persist-crossref-reference-dois-v2', STORAGE_STEP, async () => {
				return withCoreDb(env, (db) => persistReferenceDois(db, resourceId, updates));
			})
		: 0;
	console.info({
		tag: 'RESOURCE_REFERENCES',
		event: 'reference_enrichment_completed',
		resource_id: resourceId,
		source: deposited.length ? 'deposited' : 'search',
		deposited_count: deposited.length,
		unresolved_reference_count: references.length,
		crossref_enriched_count: enrichedCount,
	});
}
