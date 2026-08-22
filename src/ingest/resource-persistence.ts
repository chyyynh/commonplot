import type {
	PersistResolvedResourceDraftInput,
	PersistResolvedResourceGraphInput,
	PersistResolvedResourceGraphResult,
	ResourceDraftAdmission,
	YouTubeSpecializationMutation,
} from '@app-domain/resource-graph-contracts';
import { type HostedResourceImage, hostedResourceImageFields } from '@core-shared/resource-image-mapping';
import { parseResourceIdentity } from '@core-shared/resource-types';
import type { ResolvedResource } from '@core-shared/types';
import type { CoreDb } from '@db/connection';
import { toStoredResourceEntities } from '@entities/normalize';
import { sql } from 'drizzle-orm';
import type { ResourceClassificationResult } from './domain/resource-classification';
import type { ResolvedSubjectInput } from './resource-resolver';

type PersistProcessedInput = {
	classification: ResourceClassificationResult;
	processingId: string;
	previewImageUrl: string | null;
	resource: ResolvedResource;
	subject: ResolvedSubjectInput | null;
	target:
		| { kind: 'draft'; admission: ResourceDraftAdmission; providerSequence: string | null }
		| { kind: 'existing'; resourceId: string; expectedSourceRevision: string | null; storageKey: string | null }
		| { kind: 'privatePaper'; canonicalUrl: string; fileResourceId: string; expectedFileRevision: string | null };
	youtube: YouTubeSpecializationMutation | null;
};

export async function markStoredBlobProcessingFailed(
	db: CoreDb,
	resourceId: string,
	expectedSourceRevision: string | null,
): Promise<'failed' | 'superseded'> {
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
	const existing = await db.execute<{ enrichment_status: string; source_revision: string | null }>(sql`
		SELECT enrichment_status, source_revision
		FROM resources
		WHERE id = ${resourceId}::uuid
		LIMIT 1
	`);
	const current = existing.rows[0];
	console.info({
		tag: 'RESOURCE_PERSIST',
		event: 'stored_blob_failure_mark_skipped',
		resource_id: resourceId,
		expected_source_revision: expectedSourceRevision,
		current_source_revision: current?.source_revision ?? null,
		current_status: current?.enrichment_status ?? 'deleted',
	});
	return 'superseded';
}

export async function persistProcessedResource(
	env: CoreEnv,
	input: PersistProcessedInput,
	hostedImages: readonly HostedResourceImage[],
): Promise<PersistResolvedResourceGraphResult> {
	const mutation = resolvedResourceMutation(input, hostedImages);
	switch (input.target.kind) {
		case 'existing': {
			const storedMutation: PersistResolvedResourceGraphInput = {
				...mutation,
				resourceId: input.target.resourceId,
				expectedSourceRevision: input.target.expectedSourceRevision,
			};
			return env.DOMAIN.persistResolvedResourceGraph(storedMutation);
		}
		case 'privatePaper': {
			const draftMutation: PersistResolvedResourceDraftInput = {
				...mutation,
				admission: {
					kind: 'userFilePaper',
					fileResourceId: input.target.fileResourceId,
					expectedFileRevision: input.target.expectedFileRevision,
				},
				url: input.target.canonicalUrl,
				normalizedUrl: input.target.canonicalUrl,
				providerSequence: null,
				storageKey: null,
			};
			return env.DOMAIN.persistResolvedResourceDraft(draftMutation);
		}
		case 'draft': {
			const draftMutation: PersistResolvedResourceDraftInput = {
				...mutation,
				admission: input.target.admission,
				providerSequence: input.target.providerSequence,
				storageKey: null,
			};
			return env.DOMAIN.persistResolvedResourceDraft(draftMutation);
		}
	}
}

function resolvedResourceMutation(
	input: PersistProcessedInput,
	hostedImages: readonly HostedResourceImage[],
): Omit<PersistResolvedResourceGraphInput, 'resourceId' | 'expectedSourceRevision'> {
	const resource = input.resource;
	const identity = parseResourceIdentity(resource.kind, resource.resourcePlatform);
	if (!identity) throw new Error(`Resource processing ${input.processingId} resolved to an invalid identity`);
	const ogImageUrl = input.previewImageUrl?.trim() || null;
	const media = hostedResourceImageFields({ creators: resource.creators, kindMetadata: resource.kindMetadata, ogImageUrl }, hostedImages);
	return {
		identity,
		identifiers: resource.resourceIdentifiers,
		creators: media.creators,
		kindMetadata: media.kindMetadata,
		sourceRevision: resource.sourceRevision,
		youtube: resource.kind === 'video' ? input.youtube : null,
		originalLang: resource.originalLang,
		title: resource.title,
		summary: resource.summary,
		content: resource.content,
		keywords: input.classification.keywords ?? resource.keywords,
		tags: input.classification.tags ?? resource.tags,
		category: input.classification.category,
		entities: toStoredResourceEntities(input.classification.entities, resource.resourcePlatform, resource.source, resource.creators),
		subjectReference: input.subject
			? {
					identifiers: input.subject.identifiers,
					normalizedUrl: input.subject.normalizedUrl,
				}
			: null,
		url: resource.url,
		normalizedUrl: resource.normalizedUrl ?? resource.url,
		storageKey: input.target.kind === 'existing' ? input.target.storageKey : null,
		fileType: resource.fileType ?? null,
		publishedDate: resource.publishedDate,
		ogImageUrl: media.ogImageUrl,
	};
}
