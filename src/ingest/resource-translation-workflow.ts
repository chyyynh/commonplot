import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { connectCoreDb } from '@db/connection';
import { isResourceTranslationRevision, loadResourceTranslationInput } from '@ingest/domain/resource-translation-store';
import { AI_SEARCH_SYNC_STEP_CONFIG, syncCorpusItem } from '../ai-search';
import {
	CONTENT_TRANSLATION_MAX_LENGTH,
	generateZhHantMetadataTranslation,
	planZhHantTranslation,
	translateZhHantContent,
} from './domain/resource-translation';

type ResourceTranslationPayload = { resourceId: string; sourceRevision: string };

const RESOURCE_TRANSLATION_WORKFLOW_REVISION = 'canonical-v5';

function workflowId(resourceId: string, sourceRevision: string): string {
	return `rt-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-${resourceId}-${sourceRevision}`;
}

// One stable instance per source revision dedupes completed translations while
// allowing a failed attempt to be retried. A changed original gets a new ID.
export async function enqueueResourceTranslation(env: CoreEnv, resourceId: string, sourceRevision: string): Promise<string> {
	if (!isResourceTranslationRevision(sourceRevision)) throw new Error('Invalid resource translation source revision');
	const id = workflowId(resourceId, sourceRevision);
	const [created] = await env.RESOURCE_TRANSLATION_V2_WORKFLOW.createBatch([{ id, params: { resourceId, sourceRevision } }]);
	if (created) return created.id;
	const instance = await env.RESOURCE_TRANSLATION_V2_WORKFLOW.get(id);
	const { status } = await instance.status();
	if (status === 'errored') await instance.restart();
	if (status === 'unknown') throw new Error(`Resource translation Workflow ${id} has unknown status`);
	return id;
}

export class ResourceTranslationV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceTranslationPayload> {
	async run(event: WorkflowEvent<ResourceTranslationPayload>, step: WorkflowStep) {
		const { resourceId, sourceRevision } = event.payload;
		const input = await step.do(
			'load-resource-translation-input-kind-platform-v2',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			},
			async () => loadResourceTranslationInput(await connectCoreDb(this.env), resourceId),
		);
		if (!input) {
			console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Resource original is unavailable; skipping', resource_id: resourceId });
			return { success: true, resource_id: resourceId, skipped: true };
		}
		if (input.sourceRevision !== sourceRevision) {
			console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Source revision was superseded; skipping', resource_id: resourceId });
			return { success: true, resource_id: resourceId, skipped: true, superseded: true };
		}

		const resource = input.resource;
		const translationPlan = planZhHantTranslation(resource);
		if (translationPlan.content === 'skip-too-long') {
			console.info({
				tag: 'RESOURCE_TRANSLATION',
				msg: 'Body too long to translate in one call; keeping the original',
				resource_id: resource.id,
				chars: resource.content.trim().length,
				limit: CONTENT_TRANSLATION_MAX_LENGTH,
			});
		}
		const metadataTask = translationPlan.metadata;
		if (!metadataTask && translationPlan.content !== 'translate') {
			return { success: true, resource_id: resourceId, skipped: true };
		}
		const initialContent = resource.content.trim();
		if (!initialContent) throw new Error(`Resource ${resourceId} has no persisted original content`);

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
				() =>
					this.env.DOMAIN.persistMachineZhHantTranslation({
						resourceId,
						sourceRevision,
						patch: translatedMetadata,
					}),
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
				() =>
					this.env.DOMAIN.persistMachineZhHantTranslation({
						resourceId,
						sourceRevision,
						patch: { content: translated },
					}),
			);
			if (!persisted) return { success: true, resource_id: resourceId, skipped: true, superseded: true };
		}
		await step.do('sync-translated-resource-to-ai-search', AI_SEARCH_SYNC_STEP_CONFIG, async () =>
			syncCorpusItem(this.env, await connectCoreDb(this.env), resourceId),
		);
		console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Completed', resource_id: resourceId });
		return { success: true, resource_id: resourceId };
	}
}
