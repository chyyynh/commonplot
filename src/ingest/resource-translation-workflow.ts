import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { withCoreDb, withCoreTx } from '@db/client';
import { loadResourceForProcessingFromDb } from '@ingest/domain/resource-store';
import {
	isResourceTranslationRevision,
	loadEligibleResourceTranslationRevisionFromDb,
	persistMachineZhHantTranslation,
} from '@ingest/domain/resource-translation-store';
import { AI_SEARCH_SYNC_STEP_CONFIG, syncCorpusItem } from '../ai-search';
import { enqueueOrRestartWorkflow } from '../workflow-control';
import {
	CONTENT_TRANSLATION_MAX_LENGTH,
	generateZhHantMetadataTranslation,
	planZhHantTranslation,
	translateZhHantContent,
} from './domain/resource-translation';

export function loadEligibleResourceTranslationRevision(env: CoreEnv, resourceId: string): Promise<string | null> {
	return withCoreDb(env, (db) => loadEligibleResourceTranslationRevisionFromDb(db, resourceId, CONTENT_TRANSLATION_MAX_LENGTH));
}

async function loadEligibleResourceTranslationInput(env: CoreEnv, resourceId: string) {
	return withCoreTx(env, async (db, client) => {
		await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
		const sourceRevision = await loadEligibleResourceTranslationRevisionFromDb(db, resourceId, CONTENT_TRANSLATION_MAX_LENGTH);
		if (!sourceRevision) return null;
		const resource = await loadResourceForProcessingFromDb(db, resourceId);
		return { resource, sourceRevision };
	});
}

type ResourceTranslationPayload = { resourceId: string; sourceRevision: string };

const RESOURCE_TRANSLATION_WORKFLOW_REVISION = 'canonical-v3';

function workflowId(resourceId: string, sourceRevision: string): string {
	return `rt-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-${resourceId}-${sourceRevision}`;
}

// One stable instance per source revision dedupes repeated enqueue attempts while
// ensuring a newer original body never shares execution with an older one.
export async function enqueueResourceTranslation(env: CoreEnv, resourceId: string, sourceRevision: string): Promise<string> {
	if (!isResourceTranslationRevision(sourceRevision)) throw new Error('Invalid resource translation source revision');
	return enqueueOrRestartWorkflow(env.RESOURCE_TRANSLATION_V2_WORKFLOW, workflowId(resourceId, sourceRevision), {
		resourceId,
		sourceRevision,
	});
}

export class ResourceTranslationV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceTranslationPayload> {
	async run(event: WorkflowEvent<ResourceTranslationPayload>, step: WorkflowStep) {
		const { resourceId, sourceRevision } = event.payload;
		if (!isResourceTranslationRevision(sourceRevision)) {
			console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Legacy source revision missing; skipping', resource_id: resourceId });
			return { success: true, resource_id: resourceId, skipped: true, superseded: true };
		}
		const input = await step.do(
			'load-resource-translation-input-kind-platform-v1',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			},
			() => loadEligibleResourceTranslationInput(this.env, resourceId),
		);
		if (!input) {
			console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'No longer eligible; skipping', resource_id: resourceId });
			return { success: true, resource_id: resourceId, skipped: true };
		}
		if (input.sourceRevision !== sourceRevision) {
			console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Source revision was superseded; skipping', resource_id: resourceId });
			return { success: true, resource_id: resourceId, skipped: true, superseded: true };
		}

		const resource = input.resource;
		const initialContent = resource.content?.trim();
		if (!initialContent) throw new Error(`Resource ${resourceId} has no persisted original content`);

		const translationPlan = planZhHantTranslation(resource);
		if (translationPlan.content === 'skip-too-long') {
			console.info({
				tag: 'RESOURCE_TRANSLATION',
				msg: 'Body too long to translate in one call; keeping the original',
				resource_id: resource.id,
				chars: initialContent.length,
				limit: CONTENT_TRANSLATION_MAX_LENGTH,
			});
		}

		const metadataTask = translationPlan.metadata;
		if (metadataTask) {
			const translatedMetadata = await step.do(
				'translate-zh-hant-title-summary',
				{
					retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
					timeout: '180 seconds',
				},
				() => generateZhHantMetadataTranslation(resource, this.env, metadataTask),
			);
			const persisted = await step.do(
				'persist-zh-hant-title-summary',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => persistMachineZhHantTranslation(this.env, resourceId, sourceRevision, translatedMetadata),
			);
			if (!persisted) return { success: true, resource_id: resourceId, skipped: true, superseded: true };
		}

		if (translationPlan.content === 'translate') {
			const translated = await step.do(
				'translate-zh-hant-content',
				// A body at the 36k-character ceiling emits ~11.1k tokens at a
				// measured ~90 tokens/s, so 180s left almost no margin.
				{ retries: { limit: 3, delay: '15 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
				() => translateZhHantContent(initialContent, this.env, resourceId),
			);
			const persisted = await step.do(
				'persist-zh-hant-content',
				{
					retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
					timeout: '30 seconds',
				},
				() => persistMachineZhHantTranslation(this.env, resourceId, sourceRevision, { content: translated }),
			);
			if (!persisted) return { success: true, resource_id: resourceId, skipped: true, superseded: true };
		}
		await step.do('sync-translated-resource-to-ai-search', AI_SEARCH_SYNC_STEP_CONFIG, () => syncCorpusItem(this.env, resourceId));
		console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Completed', resource_id: resourceId });
		return { success: true, resource_id: resourceId };
	}
}
