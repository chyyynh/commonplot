import type { PersistResolvedResourceGraphInput, PersistResolvedResourceGraphResult } from '@app-domain/resource-graph-contracts';
import { type HostedResourceImage, hostedResourceImageFields, resourceImageSourceUrls } from '@core-shared/resource-image-mapping';
import { parseResourceIdentity } from '@core-shared/resource-types';
import { type CoreDb, withCoreDb, withCoreTx } from '@db/client';
import { resources } from '@db/schema';
import { toStoredResourceEntities } from '@entities/normalize';
import { eq, sql } from 'drizzle-orm';
import { MAX_ENRICHMENT_ATTEMPTS } from './domain/resource-admission-store';
import type { ResourceClassificationResult } from './domain/resource-classification';
import { resourceSourceRevision } from './domain/resource-revision';
import type { HandledResourceResult } from './kind-handler';
import { privatePaperAttachment } from './platforms/paper';
import { persistYouTubeWorkflowData } from './platforms/youtube';
import { resolvedSubjectInput } from './resource-resolver';

type PersistProcessedResourceInput = {
	resourceId: string;
	expectedSourceRevision: string | null;
	handled: HandledResourceResult;
	classification: ResourceClassificationResult;
	previewImageUrl: string | null;
};

export type ResourceProcessingFailureOutcome = 'retry' | 'drop' | 'failed';

export async function settleResourceProcessingFailure(
	env: CoreEnv,
	resourceId: string,
	expectedSourceRevision: string | null,
	outcome: ResourceProcessingFailureOutcome,
): Promise<'dropped' | 'failed' | 'superseded'> {
	return withCoreDb(env, async (db) => {
		if (outcome === 'drop') {
			const dropped = await db.execute(sql`
				DELETE FROM resources AS resource
				WHERE resource.id = ${resourceId}::uuid
				  AND resource.enrichment_status <> 'enriched'
				  AND resource.source_revision IS NOT DISTINCT FROM ${expectedSourceRevision}
				  AND resource.scope = 'corpus'
				  AND resource.source_id IS NOT NULL
				  AND resource.storage_key IS NULL
				  AND NOT EXISTS (SELECT 1 FROM resource_saves save WHERE save.resource_id = resource.id)
				  AND NOT EXISTS (SELECT 1 FROM collection_resources edge WHERE edge.resource_id = resource.id)
				  AND NOT EXISTS (SELECT 1 FROM workspace_resources edge WHERE edge.resource_id = resource.id)
				  AND NOT EXISTS (
					  SELECT 1 FROM user_files file
					  WHERE file.resource_id = resource.id OR file.canonical_resource_id = resource.id
				  )
				RETURNING resource.id
			`);
			if (dropped.rows.length) return 'dropped';
		}
		const attempts = outcome === 'retry' ? sql`enrichment_attempts + 1` : sql`${MAX_ENRICHMENT_ATTEMPTS}`;
		const failed = await db.execute(sql`
			UPDATE resources
			SET enrichment_status = 'failed',
			    enrichment_attempts = ${attempts},
			    updated_at = NOW()
			WHERE id = ${resourceId}::uuid
			  AND enrichment_status <> 'enriched'
			  AND source_revision IS NOT DISTINCT FROM ${expectedSourceRevision}
			RETURNING id
		`);
		if (failed.rows.length) return 'failed';
		const existing = await db
			.select({ enrichmentStatus: resources.enrichmentStatus, sourceRevision: resources.sourceRevision })
			.from(resources)
			.where(eq(resources.id, resourceId))
			.limit(1);
		console.info({
			tag: 'RESOURCE_PERSIST',
			event: 'resource_processing_settlement_skipped',
			resource_id: resourceId,
			outcome,
			expected_source_revision: expectedSourceRevision,
			current_source_revision: existing[0]?.sourceRevision ?? null,
			current_status: existing[0]?.enrichmentStatus ?? 'deleted',
		});
		return 'superseded';
	});
}

async function graphMutation(
	input: PersistProcessedResourceInput,
	hostedImages: readonly HostedResourceImage[],
): Promise<PersistResolvedResourceGraphInput> {
	const resource = input.handled.resource;
	const identity = parseResourceIdentity(input.handled.kind, input.handled.resourcePlatform);
	if (!identity) throw new Error(`Resource ${input.resourceId} resolved to an invalid identity`);
	const sourceRevision = await resourceSourceRevision(resource);
	const content = resource.content;
	if (!content?.trim()) throw new Error(`Refusing to persist enriched resource ${input.resourceId} without content`);
	const ogImageUrl = input.previewImageUrl?.trim() || null;
	const media = hostedResourceImageFields({ creators: resource.creators, kindMetadata: resource.kind_metadata, ogImageUrl }, hostedImages);
	return {
		resourceId: input.resourceId,
		expectedSourceRevision: input.expectedSourceRevision,
		identity,
		identifiers: resource.resource_identifiers,
		creators: media.creators,
		kindMetadata: media.kindMetadata,
		sourceRevision,
		subject: resolvedSubjectInput(input.handled),
		privatePaperAttachment: input.handled.kind === 'paper' ? privatePaperAttachment(resource) : null,
		originalLang: resource.original_lang,
		title: resource.title,
		summary: resource.summary,
		content,
		keywords: input.classification.keywords ?? resource.keywords,
		tags: input.classification.tags ?? resource.tags,
		category: input.classification.category,
		entities: toStoredResourceEntities(input.classification.entities, resource.resource_platform, resource.source, resource.creators),
		url: resource.url,
		normalizedUrl: resource.normalized_url ?? resource.url,
		storageKey: resource.storage_key ?? null,
		fileType: resource.file_type ?? null,
		publishedDate: resource.published_date,
		ogImageUrl: media.ogImageUrl,
	};
}

export function processedResourceImageSources(input: Pick<PersistProcessedResourceInput, 'handled' | 'previewImageUrl'>): string[] {
	const resource = input.handled.resource;
	if (input.handled.kind === 'paper' && privatePaperAttachment(resource)) return [];
	return resourceImageSourceUrls({
		creators: resource.creators,
		kindMetadata: resource.kind_metadata,
		ogImageUrl: input.previewImageUrl?.trim() || null,
	});
}

async function persistVideoSpecialization(env: CoreEnv, handled: Extract<HandledResourceResult, { kind: 'video' }>): Promise<void> {
	if (!handled.youtubeTranscript && !handled.youtubeHighlights) return;
	await withCoreTx(env, (db: CoreDb) =>
		persistYouTubeWorkflowData(db, {
			transcript: handled.youtubeTranscript,
			highlights: handled.youtubeHighlights,
		}),
	);
}

export async function persistProcessedResource(
	env: CoreEnv,
	input: PersistProcessedResourceInput,
	hostedImages: readonly HostedResourceImage[],
): Promise<PersistResolvedResourceGraphResult> {
	const mutation = await graphMutation(input, hostedImages);
	const result = await env.DOMAIN.persistResolvedResourceGraph(mutation);
	if (result.persisted && input.handled.kind === 'video') await persistVideoSpecialization(env, input.handled);
	return result;
}
