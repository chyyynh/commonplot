import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
	canonicalizeResourceLang,
	parseResourceIdentity,
	RESOURCE_TRANSLATION_SOURCES,
	type ResourceTranslationSource,
	ZH_HANT_RESOURCE_LANG,
} from '@core-shared/resource-types';
import { type CoreDb, connectCoreDb } from '@db/connection';
import { cleanString } from '@ingest/domain/resource-values';
import { sql } from 'drizzle-orm';
import { AI_SEARCH_SYNC_STEP_CONFIG, syncCorpusItem } from '../ai-search';
import {
	CONTENT_TRANSLATION_MAX_LENGTH,
	generateZhHantMetadataTranslation,
	planZhHantTranslation,
	type ResourceTranslationInput,
	translateZhHantContent,
} from './domain/resource-translation';

type ResourceTranslationPayload = { resourceId: string; sourceRevision: string };

type ResourceTranslationInputRow = {
	file_type: string | null;
	id: string;
	kind: string;
	resource_platform: string | null;
	original_lang: string;
	title: string | null;
	summary: string | null;
	content: string | null;
	zh_hant_title: string | null;
	zh_hant_summary: string | null;
	zh_hant_content: string | null;
	zh_hant_source: string | null;
	source_revision: string;
	url: string | null;
};

const RESOURCE_TRANSLATION_WORKFLOW_REVISION = 'canonical-v5';
const RESOURCE_TRANSLATION_REVISION_RE = /^[0-9a-f]{32}$/;

function isResourceTranslationRevision(value: unknown): value is string {
	return typeof value === 'string' && RESOURCE_TRANSLATION_REVISION_RE.test(value);
}

function parseTranslationSource(value: unknown): ResourceTranslationSource | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string' || !(RESOURCE_TRANSLATION_SOURCES as readonly string[]).includes(value)) {
		throw new Error(`Invalid translation source: ${String(value)}`);
	}
	return value as ResourceTranslationSource;
}

async function loadResourceTranslationInput(
	db: CoreDb,
	resourceId: string,
): Promise<{ resource: ResourceTranslationInput; sourceRevision: string } | null> {
	const result = await db.execute<ResourceTranslationInputRow>(sql`
		SELECT
			resource.file_type,
			resource.id::text AS id,
			resource.kind,
			resource.resource_platform,
			resource.original_lang,
			original.title AS title,
			original.summary AS summary,
			original.content AS content,
			zh_hant.title AS zh_hant_title,
			zh_hant.summary AS zh_hant_summary,
			zh_hant.content AS zh_hant_content,
			zh_hant.source AS zh_hant_source,
			resource.url,
			MD5(jsonb_build_array(
				original.lang,
				original.title,
				original.summary,
				original.content
			)::text) AS source_revision
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		LEFT JOIN resource_translations zh_hant
		  ON zh_hant.resource_id = resource.id
		 AND zh_hant.lang = ${ZH_HANT_RESOURCE_LANG}
		WHERE resource.id = ${resourceId}::uuid
		  AND resource.scope = 'corpus'
		LIMIT 1
	`);
	const row = result.rows[0];
	if (!row) return null;
	const identity = parseResourceIdentity(row.kind, row.resource_platform);
	if (!identity) throw new Error(`Invalid translation resource identity: ${row.kind} / ${String(row.resource_platform)}`);
	if (!isResourceTranslationRevision(row.source_revision)) {
		throw new Error(`Invalid translation source revision for ${resourceId}`);
	}
	const zhHantSource = parseTranslationSource(row.zh_hant_source);
	return {
		resource: {
			...identity,
			fileType: row.file_type,
			id: row.id,
			originalLang: canonicalizeResourceLang(row.original_lang),
			title: row.title ?? '',
			summary: row.summary,
			content: row.content ?? '',
			url: row.url,
			zhHantTranslation: zhHantSource
				? {
						title: cleanString(row.zh_hant_title),
						summary: cleanString(row.zh_hant_summary),
						content: cleanString(row.zh_hant_content),
						source: zhHantSource,
					}
				: null,
		},
		sourceRevision: row.source_revision,
	};
}

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
