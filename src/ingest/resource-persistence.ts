import type { PersistResolvedResourceGraphInput } from '@app-domain/resource-graph-contracts';
import { canonicalPaperUrl, paperIdentityFromIdentifiers } from '@core-shared/paper-identity';
import { isPaperIdentifier } from '@core-shared/resource-identifiers';
import type { PaperMetadata, ResourceForProcessing } from '@core-shared/types';
import { type CoreDb, withCoreDb, withCoreTx } from '@db/client';
import { resources } from '@db/schema';
import { toStoredResourceEntities } from '@entities/normalize';
import { eq, sql } from 'drizzle-orm';
import { withPaperCanonicalFields } from './canonical-resource';
import type { ProcessorResult } from './domain/ai-utils';
import { resourceSourceRevision } from './domain/resource-store';
import type { HandledResourceResult } from './kind-handler';
import { persistYouTubeWorkflowData } from './platforms/youtube';
import { resolvedSubjectInput } from './resource-resolver';

type PersistProcessedResourceInput = {
	resourceId: string;
	expectedSourceRevision: string | null;
	handled: HandledResourceResult;
	processorResult: ProcessorResult;
	previewImageUrl: string | null;
};

function withAcademicPublishedDate(resource: ResourceForProcessing, paper: PaperMetadata | null): ResourceForProcessing {
	if (resource.published_date || !paper?.publicationDate) return resource;
	const publishedDate = new Date(`${paper.publicationDate}T00:00:00.000Z`);
	return Number.isNaN(publishedDate.getTime()) ? resource : { ...resource, published_date: publishedDate.toISOString() };
}

function withPaperAbstractSummary(resource: ResourceForProcessing, paper: PaperMetadata | null): ResourceForProcessing {
	const abstract = paper?.abstract?.trim();
	return abstract ? { ...resource, summary: abstract } : resource;
}

function finalizedResource(handled: HandledResourceResult): ResourceForProcessing {
	return handled.kind === 'paper'
		? withPaperCanonicalFields(
				withPaperAbstractSummary(withAcademicPublishedDate(handled.resource, handled.paperEnrichment), handled.paperEnrichment),
				handled.paperEnrichment,
			)
		: handled.resource;
}

export async function markResourceEnrichmentFailed(
	env: CoreEnv,
	resourceId: string,
	expectedSourceRevision: string | null,
): Promise<boolean> {
	return withCoreDb(env, async (db) => {
		const updated = await db.execute(sql`
			UPDATE resources
			SET enrichment_status = 'failed',
			    enrichment_attempts = enrichment_attempts + 1,
			    updated_at = NOW()
			WHERE id = ${resourceId}::uuid
			  AND enrichment_status <> 'enriched'
			  AND source_revision IS NOT DISTINCT FROM ${expectedSourceRevision}
			RETURNING id
		`);
		if (updated.rows.length) return true;
		const existing = await db
			.select({ enrichmentStatus: resources.enrichmentStatus, sourceRevision: resources.sourceRevision })
			.from(resources)
			.where(eq(resources.id, resourceId))
			.limit(1);
		if (!existing.length) throw new Error(`Failed to mark resource ${resourceId} as failed: not found`);
		console.info({
			tag: 'RESOURCE_PERSIST',
			event: 'superseded_resource_failure_skipped',
			resource_id: resourceId,
			expected_source_revision: expectedSourceRevision,
			current_source_revision: existing[0]?.sourceRevision,
		});
		return false;
	});
}

async function graphMutation(input: PersistProcessedResourceInput): Promise<PersistResolvedResourceGraphInput> {
	const resource = finalizedResource(input.handled);
	const sourceRevision = await resourceSourceRevision(resource);
	const content = input.processorResult.content ?? resource.content;
	if (!content?.trim()) throw new Error(`Refusing to persist enriched resource ${input.resourceId} without content`);
	const privatePaperAttachment = (() => {
		if (input.handled.kind !== 'paper' || resource.scope !== 'private' || !resource.storage_key) return null;
		const identity = paperIdentityFromIdentifiers(resource.resource_identifiers.filter(isPaperIdentifier));
		if (!identity) throw new Error(`Private paper ${input.resourceId} has no canonical identity`);
		return { canonicalUrl: canonicalPaperUrl(identity) };
	})();
	return {
		resourceId: input.resourceId,
		expectedSourceRevision: input.expectedSourceRevision,
		identity: input.handled.resolution,
		identifiers: resource.resource_identifiers,
		creators: resource.creators,
		kindMetadata: resource.kind_metadata,
		sourceRevision,
		subject: resolvedSubjectInput(input.handled.resolution),
		privatePaperAttachment,
		originalLang: resource.original_lang,
		title: resource.title,
		summary: resource.summary,
		content,
		keywords: input.processorResult.keywords ?? resource.keywords,
		tags: input.processorResult.tags ?? resource.tags,
		category: input.processorResult.category,
		entities: toStoredResourceEntities(input.processorResult.entities, resource.resource_platform, resource.source, resource.creators),
		url: resource.url,
		normalizedUrl: resource.normalized_url ?? resource.url,
		storageKey: resource.storage_key ?? null,
		fileType: resource.file_type ?? null,
		publishedDate: resource.published_date,
		ogImageUrl: input.previewImageUrl?.trim() || resource.og_image_url?.trim() || null,
	};
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
): Promise<{
	persisted: boolean;
	resourceId: string;
	resourceNeedsProcessing: boolean;
	subjectResourceId: string | null;
	subjectNeedsProcessing: boolean;
}> {
	const result = await env.DOMAIN.persistResolvedResourceGraph(await graphMutation(input));
	if (result.persisted && input.handled.kind === 'video') await persistVideoSpecialization(env, input.handled);
	return result;
}
