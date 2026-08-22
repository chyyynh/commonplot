import type {
	PersistResolvedResourceInput,
	PersistResolvedResourceResult,
	PersistResolvedResourceTarget,
} from '@app-domain/resource-graph-contracts';
import { canonicalPaperUrl, paperIdentityFromIdentifiers } from '@core-shared/paper-identity';
import { isPaperIdentifier } from '@core-shared/resource-identifiers';
import { type HostedResourceImage, hostedResourceImageFields } from '@core-shared/resource-image-mapping';
import type { ResolvedResource } from '@core-shared/types';
import type { CoreDb } from '@db/connection';
import { toStoredResourceEntities } from '@entities/normalize';
import { sql } from 'drizzle-orm';
import type { ResourceClassificationResult } from './domain/resource-classification';

export type PersistProcessedTarget = PersistResolvedResourceTarget | { kind: 'storedPdf'; resourceId: string; storageKey: string };

type PersistProcessedInput = {
	classification: ResourceClassificationResult;
	processingId: string;
	resource: ResolvedResource;
	target: PersistProcessedTarget;
};

export async function markStoredBlobProcessingFailed(db: CoreDb, resourceId: string): Promise<void> {
	await db.execute(sql`
		UPDATE resources AS resource
		SET enrichment_status = 'failed',
		    updated_at = NOW()
		WHERE resource.id = ${resourceId}::uuid
		  AND resource.enrichment_status <> 'enriched'
		  AND resource.scope = 'private'
		  AND resource.storage_key IS NOT NULL
		  AND EXISTS (
		    SELECT 1
		    FROM user_files
		    WHERE user_files.resource_id = resource.id
		  )
	`);
}

export async function persistProcessedResource(
	env: CoreEnv,
	input: PersistProcessedInput,
	hostedImages: readonly HostedResourceImage[],
): Promise<PersistResolvedResourceResult> {
	const mutation = resolvedResourceMutation(input, hostedImages);
	let resolvedMutation = mutation;
	let target: PersistResolvedResourceTarget;
	switch (input.target.kind) {
		case 'existing':
		case 'draft':
			target = input.target;
			break;
		case 'storedPdf': {
			if (input.resource.kind !== 'paper') {
				target = {
					kind: 'existing',
					resourceId: input.target.resourceId,
					storageKey: input.target.storageKey,
				};
				break;
			}
			const paperIdentity = paperIdentityFromIdentifiers(input.resource.resourceIdentifiers.filter(isPaperIdentifier));
			if (!paperIdentity) throw new Error(`Private paper processing ${input.processingId} has no canonical identity`);
			target = {
				kind: 'draft',
				admission: {
					kind: 'userFilePaper',
					fileResourceId: input.target.resourceId,
				},
				providerSequence: null,
			};
			const url = canonicalPaperUrl(paperIdentity);
			resolvedMutation = { ...mutation, url, normalizedUrl: url };
			break;
		}
	}
	return env.DOMAIN.persistResolvedResource({ ...resolvedMutation, target });
}

function resolvedResourceMutation(
	input: PersistProcessedInput,
	hostedImages: readonly HostedResourceImage[],
): Omit<PersistResolvedResourceInput, 'target'> {
	const resource = input.resource;
	const ogImageUrl = resource.previewImageUrl;
	const media = hostedResourceImageFields({ creators: resource.creators, kindMetadata: resource.kindMetadata, ogImageUrl }, hostedImages);
	const youtube =
		resource.specialization?.kind === 'youtube'
			? { transcript: resource.specialization.transcript, highlights: resource.specialization.highlights }
			: null;
	return {
		identity: resource,
		identifiers: resource.resourceIdentifiers,
		creators: media.creators,
		kindMetadata: media.kindMetadata,
		youtube,
		originalLang: resource.originalLang,
		title: resource.title,
		summary: resource.summary,
		content: resource.content,
		keywords: input.classification.keywords,
		tags: input.classification.tags,
		category: input.classification.category,
		entities: toStoredResourceEntities(input.classification.entities, resource.resourcePlatform, resource.source, resource.creators),
		subjectReference: resource.subject
			? {
					identifiers: resource.subject.identifiers,
					normalizedUrl: resource.subject.normalizedUrl,
				}
			: null,
		url: resource.url,
		normalizedUrl: resource.normalizedUrl ?? resource.url,
		fileType: resource.fileType ?? null,
		publishedDate: resource.publishedDate,
		ogImageUrl: media.ogImageUrl,
	};
}
