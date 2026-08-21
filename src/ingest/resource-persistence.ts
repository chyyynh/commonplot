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
import type { ResourceClassificationResult } from './domain/resource-classification';
import { resourceSourceRevision } from './domain/resource-revision';
import type { HandledResourceResult } from './kind-handler';
import type { ResolvedSubjectInput } from './resource-resolver';

type PersistProcessedInput = {
	handled: HandledResourceResult;
	classification: ResourceClassificationResult;
	previewImageUrl: string | null;
	subject: ResolvedSubjectInput | null;
};

type PersistProcessedResourceInput = PersistProcessedInput & {
	resourceId: string;
	expectedSourceRevision: string | null;
};

type PersistProcessedPrivatePaperInput = PersistProcessedResourceInput & {
	canonicalUrl: string;
};

type PersistProcessedDraftInput = PersistProcessedInput & {
	admission: ResourceDraftAdmission;
};

export async function settleStoredBlobProcessingFailure(
	env: CoreEnv,
	resourceId: string,
	expectedSourceRevision: string | null,
): Promise<'failed' | 'superseded'> {
	return withCoreDb(env, async (db) => {
		const failed = await db.execute(sql`
			UPDATE resources AS resource
			SET enrichment_status = 'failed',
			    updated_at = NOW()
			WHERE resource.id = ${resourceId}::uuid
			  AND resource.enrichment_status <> 'enriched'
			  AND resource.source_revision IS NOT DISTINCT FROM ${expectedSourceRevision}
			  AND resource.scope = 'private'
			  AND resource.storage_key IS NOT NULL
			  AND EXISTS (
			    SELECT 1
			    FROM user_files
			    WHERE user_files.resource_id = resource.id
			  )
			RETURNING resource.id
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
	};
	return env.DOMAIN.persistResolvedResourceGraph(storedMutation);
}

export async function persistProcessedPrivatePaperDraft(
	env: CoreEnv,
	input: PersistProcessedPrivatePaperInput,
	hostedImages: readonly HostedResourceImage[],
): Promise<PersistResolvedResourceGraphResult> {
	const mutation: PersistResolvedResourceDraftInput = {
		...(await resolvedResourceMutation(input, hostedImages)),
		admission: {
			kind: 'userFilePaper',
			fileResourceId: input.resourceId,
			expectedFileRevision: input.expectedSourceRevision,
		},
		url: input.canonicalUrl,
		normalizedUrl: input.canonicalUrl,
		storageKey: null,
	};
	return env.DOMAIN.persistResolvedResourceDraft(mutation);
}

export async function persistProcessedDraft(
	env: CoreEnv,
	input: PersistProcessedDraftInput,
	hostedImages: readonly HostedResourceImage[],
): Promise<PersistResolvedResourceGraphResult> {
	const mutation: PersistResolvedResourceDraftInput = {
		...(await resolvedResourceMutation(input, hostedImages)),
		admission: input.admission,
		storageKey: null,
	};
	return env.DOMAIN.persistResolvedResourceDraft(mutation);
}

async function resolvedResourceMutation(
	input: PersistProcessedInput,
	hostedImages: readonly HostedResourceImage[],
): Promise<Omit<PersistResolvedResourceGraphInput, 'resourceId' | 'expectedSourceRevision'>> {
	const resource = input.handled.resource;
	const identity = parseResourceIdentity(resource.kind, resource.resource_platform);
	if (!identity) throw new Error(`Resource processing ${resource.processing_id} resolved to an invalid identity`);
	const sourceRevision = await resourceSourceRevision(resource);
	const content = resource.content;
	if (!content?.trim()) throw new Error(`Refusing to persist resource processing ${resource.processing_id} without content`);
	const ogImageUrl = input.previewImageUrl?.trim() || null;
	const media = hostedResourceImageFields({ creators: resource.creators, kindMetadata: resource.kind_metadata, ogImageUrl }, hostedImages);
	return {
		identity,
		identifiers: resource.resource_identifiers,
		creators: media.creators,
		kindMetadata: media.kindMetadata,
		sourceRevision,
		youtube:
			resource.kind === 'video' && input.handled.youtube
				? {
						transcript: input.handled.youtube.transcript
							? {
									segments: input.handled.youtube.transcript.segments,
									language: input.handled.youtube.transcript.language,
									chapters: input.handled.youtube.transcript.chapters,
									chaptersFromDescription: input.handled.youtube.transcript.chaptersFromDescription,
								}
							: null,
						highlights: input.handled.youtube.highlights?.value ?? null,
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
		subjectReference: input.subject
			? {
					identifiers: input.subject.identifiers,
					normalizedUrl: input.subject.normalizedUrl,
				}
			: null,
		url: resource.url,
		normalizedUrl: resource.normalized_url ?? resource.url,
		storageKey: resource.scope === 'private' ? (resource.storage_key ?? null) : null,
		fileType: resource.file_type ?? null,
		publishedDate: resource.published_date,
		ogImageUrl: media.ogImageUrl,
	};
}

export function processedResourceImageSources(input: Pick<PersistProcessedInput, 'handled' | 'previewImageUrl'>): string[] {
	const resource = input.handled.resource;
	return resourceImageSourceUrls({
		creators: resource.creators,
		kindMetadata: resource.kind_metadata,
		ogImageUrl: input.previewImageUrl?.trim() || null,
	});
}
