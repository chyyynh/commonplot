import type {
	PersistResolvedResourceDraftInput,
	PersistResolvedResourceGraphInput,
	PersistResolvedResourceGraphResult,
	ResourceDraftAdmission,
} from '@app-domain/resource-graph-contracts';
import { type HostedResourceImage, hostedResourceImageFields, resourceImageSourceUrls } from '@core-shared/resource-image-mapping';
import { parseResourceIdentity } from '@core-shared/resource-types';
import { withCoreDb } from '@db/client';
import { resources } from '@db/schema';
import { toStoredResourceEntities } from '@entities/normalize';
import { eq, sql } from 'drizzle-orm';
import { MAX_ENRICHMENT_ATTEMPTS } from './domain/resource-admission-store';
import type { ResourceClassificationResult } from './domain/resource-classification';
import { resourceSourceRevision } from './domain/resource-revision';
import type { HandledResourceResult } from './kind-handler';
import { privatePaperAttachment } from './platforms/paper';
import { resolvedSubjectInput } from './resource-resolver';

type PersistProcessedInput = {
	handled: HandledResourceResult;
	classification: ResourceClassificationResult;
	previewImageUrl: string | null;
};

type PersistProcessedResourceInput = PersistProcessedInput & {
	resourceId: string;
	expectedSourceRevision: string | null;
};

type PersistProcessedDraftInput = PersistProcessedInput & {
	admission: ResourceDraftAdmission;
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

export async function persistProcessedResource(
	env: CoreEnv,
	input: PersistProcessedResourceInput,
	hostedImages: readonly HostedResourceImage[],
): Promise<PersistResolvedResourceGraphResult> {
	const mutation = await resolvedResourceMutation(input, hostedImages);
	const storedMutation: PersistResolvedResourceGraphInput = {
		...mutation,
		resourceId: input.resourceId,
		expectedSourceRevision: input.expectedSourceRevision,
		privatePaperAttachment: privatePaperAttachment(input.handled.resource),
		subject: resolvedSubjectInput(input.handled),
	};
	return env.DOMAIN.persistResolvedResourceGraph(storedMutation);
}

export async function persistProcessedDraft(
	env: CoreEnv,
	input: PersistProcessedDraftInput,
	hostedImages: readonly HostedResourceImage[],
): Promise<PersistResolvedResourceGraphResult> {
	const mutation: PersistResolvedResourceDraftInput = {
		...(await resolvedResourceMutation(input, hostedImages)),
		admission: input.admission,
	};
	return env.DOMAIN.persistResolvedResourceDraft(mutation);
}

async function resolvedResourceMutation(
	input: PersistProcessedInput,
	hostedImages: readonly HostedResourceImage[],
): Promise<Omit<PersistResolvedResourceDraftInput, 'admission'>> {
	const resource = input.handled.resource;
	const identity = parseResourceIdentity(input.handled.kind, input.handled.resourcePlatform);
	if (!identity) throw new Error(`Resource processing ${resource.processing_id} resolved to an invalid identity`);
	const sourceRevision = await resourceSourceRevision(resource);
	const content = resource.content;
	if (!content?.trim()) throw new Error(`Refusing to persist resource processing ${resource.processing_id} without content`);
	const ogImageUrl = input.previewImageUrl?.trim() || null;
	const paperAttachment = input.handled.kind === 'paper' ? privatePaperAttachment(resource) : null;
	const media = paperAttachment
		? { creators: [], kindMetadata: null, ogImageUrl: null }
		: hostedResourceImageFields({ creators: resource.creators, kindMetadata: resource.kind_metadata, ogImageUrl }, hostedImages);
	return {
		identity,
		identifiers: resource.resource_identifiers,
		creators: media.creators,
		kindMetadata: media.kindMetadata,
		sourceRevision,
		youtube:
			input.handled.kind === 'video' && (input.handled.youtubeTranscript || input.handled.youtubeHighlights)
				? {
						transcript: input.handled.youtubeTranscript
							? {
									segments: input.handled.youtubeTranscript.segments,
									language: input.handled.youtubeTranscript.language,
									chapters: input.handled.youtubeTranscript.chapters,
									chaptersFromDescription: input.handled.youtubeTranscript.chaptersFromDescription,
								}
							: null,
						highlights: input.handled.youtubeHighlights?.value ?? null,
					}
				: null,
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

export function processedResourceImageSources(input: Pick<PersistProcessedInput, 'handled' | 'previewImageUrl'>): string[] {
	const resource = input.handled.resource;
	if (input.handled.kind === 'paper' && privatePaperAttachment(resource)) return [];
	return resourceImageSourceUrls({
		creators: resource.creators,
		kindMetadata: resource.kind_metadata,
		ogImageUrl: input.previewImageUrl?.trim() || null,
	});
}
