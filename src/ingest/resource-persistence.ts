import { NonRetryableError } from 'cloudflare:workflows';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { type HostedResourceImage, hostedResourceImageFields } from '../shared/image-mapping';
import { isPaperIdentifierScheme } from '../shared/paper-identity';
import {
	RESOURCE_KIND_METADATA,
	RESOURCE_PLATFORMS,
	ResourceCreatorsSchema,
	type ResourceIdentifier,
	ResourceIdentifiersSchema,
} from '../shared/resource';
import type { AcquiredResource } from './acquisition';
import type { ResourceDraftRelation } from './admission';
import type { ResourceClassification } from './analysis';
import { hasPrivatePdfImages, withoutPrivatePdfImages, withoutDuplicatePdfTitle } from './pdf-markdown.ts';
import { resolveResourceUrl, type ResolvedResourceUrl } from './platforms/resource-url';
import type { YouTubeResourceData } from './platforms/youtube';
import { canonicalizeResourceLang } from './resource-language';

export type ResourcePersistenceTarget = { ownedBlobId?: string } & (
	| Readonly<{ kind: 'draft'; relation?: ResourceDraftRelation; preservePublishedPdf?: boolean }>
	| Readonly<{ kind: 'existing'; resourceId: string }>
);

type LockedResource = Readonly<{
	has_original: boolean;
	id: string;
	original_lang: string;
	scope: 'corpus' | 'private';
	subject_resource_id: string | null;
}>;

type PreparedResource = ReturnType<typeof prepareResolvedResource>;

/** Update only the original that this acquisition published, never a newer import or human edit. */
export async function persistResourceClassification(
	db: NodePgDatabase,
	target: { resourceId: string; acquisitionRevision: string; translationRevision: string },
	classification: ResourceClassification,
) {
	const updated = await db.execute(sql`
		WITH target AS (
			SELECT resource.id, resource.original_lang
			FROM resources resource
			JOIN resource_translations original ON original.resource_id = resource.id AND original.lang = resource.original_lang
			WHERE resource.id = ${target.resourceId}::uuid AND original.source = 'original'
			  AND MD5(EXTRACT(EPOCH FROM resource.scraped_date)::text) = ${target.acquisitionRevision}
			  AND MD5(jsonb_build_array(original.lang, original.title, original.summary, original.content)::text) = ${target.translationRevision}
			FOR UPDATE OF resource, original
		), updated_resource AS (
			UPDATE resources SET tags = ${sql.param(classification.tags)}::text[], updated_at = NOW()
			FROM target WHERE resources.id = target.id
			RETURNING resources.id, resources.original_lang
		)
		UPDATE resource_translations SET keywords = ${sql.param(classification.keywords)}::text[], updated_at = NOW()
		FROM updated_resource
		WHERE resource_translations.resource_id = updated_resource.id AND resource_translations.lang = updated_resource.original_lang
		RETURNING resource_translations.resource_id
	`);
	return updated.rowCount === 1;
}

/** A URL or exact identifier may point at an existing corpus resource; ambiguous identities must be reacquired. */
export async function findResourcesByUrls(db: NodePgDatabase, urls: readonly ResolvedResourceUrl[]) {
	if (!urls.length) return [];
	const { rows } = await db.execute<{ url: string; resourceId: string | null }>(sql`
		SELECT input.url,
		  CASE WHEN COUNT(DISTINCT resource.id) = 1 THEN MIN(resource.id::text) END AS "resourceId"
		FROM jsonb_to_recordset(${JSON.stringify(urls)}::jsonb) AS input(url text, "normalizedUrl" text, identifiers jsonb)
		LEFT JOIN LATERAL (
			SELECT id FROM resources WHERE normalized_url = input."normalizedUrl"
			UNION SELECT id FROM resources WHERE url = input.url
			UNION SELECT stored.resource_id AS id
			FROM jsonb_to_recordset(input.identifiers) AS incoming(scheme text, value text)
			JOIN resource_identifiers stored USING (scheme, value)
		) candidate ON true
		LEFT JOIN resources resource ON resource.id = candidate.id AND resource.scope = 'corpus'
		GROUP BY input.url
	`);
	const owners = new Map(rows.map(({ url, resourceId }) => [url, resourceId]));
	return urls.map(({ url, normalizedUrl }) => ({ url, normalizedUrl, resourceId: owners.get(url) ?? null }));
}

export function prepareResolvedResource(
	resource: AcquiredResource & { youtube?: YouTubeResourceData },
	hostedImages: readonly HostedResourceImage[],
	keywords: readonly string[] = [],
) {
	const title = resource.title.trim();
	const content = (resource.fileType === 'application/pdf' ? withoutDuplicatePdfTitle(resource.content, title) : resource.content).trim();
	const sourceName = resource.source.trim();
	if (!title || !content) throw new TypeError('Resolved Resource requires title and content');
	if (!sourceName) throw new TypeError('Resolved Resource requires a source name');
	const creators = ResourceCreatorsSchema.parse(resource.creators);
	const kindMetadata = RESOURCE_KIND_METADATA[resource.kind].parse(resource.kindMetadata);
	const media = hostedResourceImageFields({ creators, kindMetadata, ogImageUrl: resource.previewImageUrl }, hostedImages);
	const identifiers = ResourceIdentifiersSchema.parse(resource.resourceIdentifiers);
	if (
		resource.resourcePlatform !== null
			? RESOURCE_PLATFORMS[resource.resourcePlatform].kind !== resource.kind ||
				!identifiers.length ||
				identifiers.some(({ scheme }) => scheme !== resource.resourcePlatform)
			: resource.kind === 'paper'
				? !identifiers.length || identifiers.some((identifier) => !isPaperIdentifierScheme(identifier.scheme))
				: identifiers.length > 0
	) {
		throw new TypeError('Resource identifiers do not match its identity');
	}
	if (resource.resourcePlatform === 'youtube' ? !resource.youtube : resource.youtube !== undefined) {
		throw new TypeError('YouTube data requires a YouTube video Resource');
	}
	const resolvedUrl = resolveResourceUrl(resource.url);
	if (resource.url !== null && !resolvedUrl) throw new TypeError('Resource URL must be HTTP(S) without credentials');
	const publishedDate = resource.publishedDate ? new Date(resource.publishedDate) : null;
	if (publishedDate && Number.isNaN(publishedDate.getTime())) throw new TypeError('Resource publication date is invalid');
	const subjectUrl = resource.subject ? resolveResourceUrl(resource.subject.normalizedUrl) : null;
	if (resource.subject && !subjectUrl) throw new TypeError('Subject URL must be HTTP(S) without credentials');
	const subject = resource.subject
		? {
				identifiers: ResourceIdentifiersSchema.parse(resource.subject.identifiers),
				normalizedUrl: subjectUrl!.normalizedUrl,
			}
		: null;
	return {
		kind: resource.kind,
		resourcePlatform: resource.resourcePlatform,
		content,
		citations: resource.kind === 'paper' ? resource.citations : null,
		creators: media.creators,
		fileType: resource.fileType ?? null,
		identifiers,
		keywords: [...keywords],
		kindMetadata: media.kindMetadata,
		normalizedUrl: resolvedUrl?.normalizedUrl ?? null,
		ogImageHeight: media.ogImageHeight,
		ogImageUrl: media.ogImageUrl,
		ogImageWidth: media.ogImageWidth,
		originalLang: canonicalizeResourceLang(resource.originalLang),
		publishedDate,
		sourceName,
		subject,
		summary: resource.summary ?? '',
		tags: [],
		title,
		url: resolvedUrl?.url ?? null,
		youtube: resource.youtube ?? null,
	};
}

async function lockResource(db: NodePgDatabase, resourceId: string): Promise<LockedResource> {
	const result = await db.execute<LockedResource>(sql`
		SELECT resource.id::text, resource.original_lang, resource.scope, resource.subject_resource_id::text,
		       EXISTS (
		         SELECT 1 FROM resource_translations original
		         WHERE original.resource_id = resource.id AND original.lang = resource.original_lang
		           AND BTRIM(COALESCE(original.title, '')) <> ''
		           AND BTRIM(COALESCE(original.content, '')) <> ''
		       ) AS has_original
		FROM resources resource
		WHERE resource.id = ${resourceId}::uuid
		FOR UPDATE
	`);
	const resource = result.rows[0];
	if (!resource) throw new Error(`Resource ${resourceId} was not found`);
	return resource;
}

async function identifierOwners(db: NodePgDatabase, identifiers: readonly ResourceIdentifier[]): Promise<string[]> {
	if (!identifiers.length) return [];
	const result = await db.execute<{ resource_id: string }>(sql`
		SELECT DISTINCT stored.resource_id::text
		FROM jsonb_to_recordset(${JSON.stringify(identifiers)}::jsonb) AS incoming(scheme text, value text)
		JOIN resource_identifiers stored USING (scheme, value)
	`);
	return result.rows.map(({ resource_id }) => resource_id);
}

async function corpusUrlOwner(db: NodePgDatabase, normalizedUrl: string | null): Promise<string | null> {
	if (!normalizedUrl) return null;
	const result = await db.execute<{ id: string }>(sql`
		SELECT id::text
		FROM resources
		WHERE normalized_url = ${normalizedUrl} AND scope = 'corpus'
	`);
	return result.rows[0]?.id ?? null;
}

async function draftRoot(db: NodePgDatabase, resource: PreparedResource): Promise<LockedResource | null> {
	const owners = await identifierOwners(db, resource.identifiers);
	if (owners.length > 1) throw new Error('Resolved identifiers belong to different Resources');
	const identifierOwner = owners[0] ?? null;
	const urlOwner = await corpusUrlOwner(db, resource.normalizedUrl);
	if (identifierOwner && urlOwner && identifierOwner !== urlOwner) {
		throw new Error('Resolved identifiers and URL belong to different Resources');
	}
	const existingId = identifierOwner ?? urlOwner;
	if (!existingId) return null;
	const existing = await lockResource(db, existingId);
	if (existing.scope !== 'corpus') throw new Error('A URL draft cannot resolve to a private Resource');
	return existing;
}

async function existingSubject(db: NodePgDatabase, parentId: string, subject: NonNullable<PreparedResource['subject']>) {
	const owners = await identifierOwners(db, subject.identifiers);
	if (owners.length > 1) return null;
	const identifierOwner = owners[0] ?? null;
	const urlOwner = await corpusUrlOwner(db, subject.normalizedUrl);
	if (identifierOwner && urlOwner && identifierOwner !== urlOwner) return null;
	const existingId = identifierOwner ?? urlOwner;
	if (!existingId || existingId === parentId) return null;
	const existing = await lockResource(db, existingId);
	return existing.scope === 'corpus' && existing.has_original ? existing.id : null;
}

async function writeCanonicalResource(
	db: NodePgDatabase,
	resourceId: string,
	resource: PreparedResource,
	existing: boolean,
	subjectResourceId: string | null,
) {
	const columns = sql`
		kind, resource_platform, source_name, url, normalized_url, file_type, original_lang, published_date,
		tags, og_image_url, og_image_width, og_image_height, creators, kind_metadata, subject_resource_id,
		scraped_date, updated_at
	`;
	const values = sql`
		${resource.kind}, ${resource.resourcePlatform}, ${resource.sourceName}, ${resource.url}, ${resource.normalizedUrl},
		${resource.fileType}, ${resource.originalLang}, ${resource.publishedDate}, ${sql.param(resource.tags)}::text[],
		${resource.ogImageUrl}, ${resource.ogImageWidth}, ${resource.ogImageHeight}, ${JSON.stringify(resource.creators)}::jsonb,
		${resource.kindMetadata === null ? null : JSON.stringify(resource.kindMetadata)}::jsonb, ${subjectResourceId}::uuid,
		NOW(), NOW()
	`;
	// The cleanup excludes the incoming language: no CTE deletes a row another CTE writes.
	const written = await db.execute<{ revision: string; acquisition_revision: string }>(sql`
		WITH written_resource AS (
			${
				!existing
					? sql`INSERT INTO resources (id, scope, ${columns}) VALUES (${resourceId}::uuid, 'corpus', ${values})`
					: sql`UPDATE resources SET (${columns}) = (${values}) WHERE id = ${resourceId}::uuid`
			}
			RETURNING id, MD5(EXTRACT(EPOCH FROM scraped_date)::text) AS acquisition_revision
		), cleared_identifiers AS (
			DELETE FROM resource_identifiers WHERE resource_id = ${resourceId}::uuid AND ${existing}
		), cleared_references AS (
			DELETE FROM resource_references WHERE resource_id = ${resourceId}::uuid AND ${existing}
		), cleared_translations AS (
			DELETE FROM resource_translations
			WHERE resource_id = ${resourceId}::uuid AND ${existing}
			  AND lang <> ${resource.originalLang}
		), written_original AS (
			INSERT INTO resource_translations (resource_id, lang, title, summary, content, keywords, source, updated_at)
			SELECT id, ${resource.originalLang}, ${resource.title}, ${resource.summary}, ${resource.content},
			       ${sql.param(resource.keywords)}::text[], 'original', NOW()
			FROM written_resource
			WHERE true
			ON CONFLICT (resource_id, lang) DO UPDATE SET
				(title, summary, content, keywords, source, alignment, updated_at) =
				(EXCLUDED.title, EXCLUDED.summary, EXCLUDED.content, EXCLUDED.keywords, EXCLUDED.source, NULL, EXCLUDED.updated_at)
			RETURNING MD5(jsonb_build_array(lang, title, summary, content)::text) AS revision
		)
		SELECT revision, acquisition_revision FROM written_resource CROSS JOIN written_original
	`);
	if (resource.identifiers.length) {
		// Identifier replacement must follow its DELETE; both can target the same keys.
		await db.execute(sql`
			INSERT INTO resource_identifiers (resource_id, scheme, value, is_preferred)
			SELECT ${resourceId}::uuid, scheme, value, preferred
			FROM jsonb_to_recordset(${JSON.stringify(resource.identifiers)}::jsonb) AS incoming(scheme text, value text, preferred boolean)
		`);
	}
	if (resource.citations?.references.length) {
		const { references } = resource.citations;
		// These references describe exactly the original written in this transaction.
		await db.execute(sql`
			INSERT INTO resource_references (resource_id, ordinal, label, text)
			SELECT ${resourceId}::uuid, incoming.ordinal::integer, incoming.value->>'label', incoming.value->>'text'
			FROM jsonb_array_elements(${JSON.stringify(references)}::jsonb)
			WITH ORDINALITY AS incoming(value, ordinal)
		`);
	}
	if (resource.youtube) {
		const { transcript, highlights } = resource.youtube;
		await db.execute(sql`
			INSERT INTO youtube_transcripts (resource_id, transcript, language, chapters, ai_highlights)
			VALUES (
				${resourceId}::uuid, ${JSON.stringify(transcript.segments)}::jsonb, ${transcript.language},
				${JSON.stringify(transcript.chapters)}::jsonb, ${highlights ? JSON.stringify(highlights) : null}::jsonb
			)
			ON CONFLICT (resource_id) DO UPDATE SET
				transcript = EXCLUDED.transcript,
				language = EXCLUDED.language,
				chapters = EXCLUDED.chapters,
				ai_highlights = CASE
					WHEN jsonb_array_length(EXCLUDED.chapters) > 0 THEN NULL
					ELSE COALESCE(EXCLUDED.ai_highlights, youtube_transcripts.ai_highlights)
				END
		`);
	}
	const original = written.rows[0];
	if (!original) throw new Error(`Resource ${resourceId} has no authoritative original translation`);
	return { translationRevision: original.revision, acquisitionRevision: original.acquisition_revision };
}

async function applyDraftRelation(db: NodePgDatabase, resourceId: string, relation: ResourceDraftRelation) {
	if (relation.kind === 'source') {
		const source = await db.execute<{ id: string }>(sql`SELECT id::text FROM sources WHERE id = ${relation.sourceId}::uuid`);
		if (!source.rows[0]) throw new Error('Resource source was not found');
		await db.execute(sql`
			UPDATE resources SET source_id = ${relation.sourceId}::uuid, updated_at = NOW()
			WHERE id = ${resourceId}::uuid AND source_id IS NULL
		`);
		return;
	}
	const attached = await db.execute(sql`
		UPDATE resources SET subject_resource_id = ${resourceId}::uuid, updated_at = NOW()
		WHERE id = ${relation.parentResourceId}::uuid
		  AND scope = 'corpus'
		  AND EXISTS (
		    SELECT 1 FROM resource_translations original
		    WHERE original.resource_id = resources.id AND original.lang = resources.original_lang
		      AND BTRIM(COALESCE(original.content, '')) <> ''
		  )
		  AND id <> ${resourceId}::uuid
		  AND MD5(EXTRACT(EPOCH FROM scraped_date)::text) = ${relation.parentAcquisitionRevision}
	`);
	if (attached.rowCount !== 1) throw new NonRetryableError('Subject parent was reacquired or is no longer eligible for attachment');
}

/** Reprocessing owns this repair; reads never rewrite existing user or corpus content. */
async function removeStoredPrivatePdfImages(db: NodePgDatabase, resourceId: string) {
	const translations = await db.execute<{ content: string; lang: string }>(sql`
		SELECT content, lang FROM resource_translations
		WHERE resource_id = ${resourceId}::uuid AND content LIKE '%/api/media/asset/pdf-crops/%'
	`);
	for (const translation of translations.rows) {
		const content = withoutPrivatePdfImages(translation.content);
		if (content === translation.content.trim()) continue;
		await db.execute(sql`
			UPDATE resource_translations SET content = ${content}, alignment = NULL, updated_at = NOW()
			WHERE resource_id = ${resourceId}::uuid AND lang = ${translation.lang}
		`);
	}
}

export async function persistResolvedResource(db: NodePgDatabase, resource: PreparedResource, target: ResourcePersistenceTarget) {
	const lockKeys = [
		...(resource.normalizedUrl ? [`url:${resource.normalizedUrl}`] : []),
		...resource.identifiers.map(({ scheme, value }) => `id:${scheme}:${value}`),
		...(resource.subject
			? [`url:${resource.subject.normalizedUrl}`, ...resource.subject.identifiers.map(({ scheme, value }) => `id:${scheme}:${value}`)]
			: []),
	];
	return db.transaction(async (tx) => {
		for (const key of [...new Set(lockKeys)].sort()) {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`newsence:resource:${key}`}, 0))`);
		}
		if (target.ownedBlobId) {
			const owned = await tx.execute(sql`SELECT resource_id FROM user_files WHERE resource_id = ${target.ownedBlobId}::uuid FOR UPDATE`);
			if (!owned.rows.length) throw new NonRetryableError('Uploaded PDF ownership was deleted');
		}
		const root = target.kind === 'draft' ? await draftRoot(tx, resource) : await lockResource(tx, target.resourceId);
		const resourceId = root?.id ?? crypto.randomUUID();
		// A private rendition may enrich a new paper, but must not replace an
		// independently acquired public rendition (and its public images).
		if (target.kind === 'draft' && target.preservePublishedPdf && root?.has_original) {
			const original = await tx.execute<{ content: string | null; translation_revision: string; acquisition_revision: string }>(sql`
				SELECT original.content,
				       MD5(jsonb_build_array(original.lang, original.title, original.summary, original.content)::text) AS translation_revision,
				       MD5(EXTRACT(EPOCH FROM resource.scraped_date)::text) AS acquisition_revision
				FROM resources resource
				JOIN resource_translations original ON original.resource_id = resource.id AND original.lang = resource.original_lang
				WHERE resource.id = ${resourceId}::uuid
			`);
			const published = original.rows[0];
			// Human text and translations remain authoritative, but old private asset
			// links cannot stay on a shared rendition after this explicit reprocess.
			await removeStoredPrivatePdfImages(tx, resourceId);
			if (published?.content?.trim() && !hasPrivatePdfImages(published.content)) {
				return {
					resourceId,
					scope: root.scope,
					subjectAttached: root.subject_resource_id !== null,
					translationRevision: published.translation_revision,
					acquisitionRevision: published.acquisition_revision,
					originalWritten: false,
				};
			}
		}
		const resolvedSubjectId = resource.subject ? await existingSubject(tx, resourceId, resource.subject) : null;
		const subjectResourceId = resolvedSubjectId ?? root?.subject_resource_id ?? null;
		const revisions = await writeCanonicalResource(tx, resourceId, resource, root !== null, subjectResourceId);
		if (target.kind === 'draft' && target.relation) {
			await applyDraftRelation(tx, resourceId, target.relation);
		}
		return {
			resourceId,
			scope: root?.scope ?? 'corpus',
			subjectAttached: resolvedSubjectId !== null,
			originalWritten: true,
			...revisions,
		};
	});
}

/** Read the accepted corpus rendition, which may differ from the incoming private PDF. */
export async function loadPublicPdfContent(db: NodePgDatabase, resourceId: string): Promise<string> {
	const result = await db.execute<{ content: string }>(sql`
		SELECT original.content
		FROM resources resource
		JOIN resource_translations original ON original.resource_id = resource.id AND original.lang = resource.original_lang
		WHERE resource.id = ${resourceId}::uuid AND resource.scope = 'corpus'
	`);
	return result.rows[0]?.content ?? '';
}
