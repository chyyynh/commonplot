import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { type ResourceEntityInput, toStoredResourceEntities } from '../entities/normalize';
import { type HostedResourceImage, hostedResourceImageFields, resourceImageFieldsAreHosted } from '../shared/image-mapping';
import {
	canonicalizeResourceLang,
	isPaperIdentifier,
	RESOURCE_TYPES,
	ResourceCreatorsSchema,
	type ResourceIdentifier,
	ResourceIdentifiersSchema,
} from '../shared/resource';
import type { ProcessingResource } from './acquisition';
import type { YouTubeResourceData } from './platforms/youtube';

type ResourceDraftRelation = Readonly<{ kind: 'source'; sourceId: string }> | Readonly<{ kind: 'subject'; parentResourceId: string }>;

export type ResourcePersistenceTarget =
	| Readonly<{ kind: 'draft'; relation?: ResourceDraftRelation }>
	| Readonly<{ kind: 'existing'; resourceId: string }>;

type ResourceClassification = Readonly<{
	entities: ResourceEntityInput[];
	keywords: readonly string[];
	tags: readonly string[];
}>;

type LockedResource = Readonly<{
	enrichment_status: string;
	id: string;
	original_lang: string;
	scope: 'corpus' | 'private';
	subject_resource_id: string | null;
}>;

type CanonicalResource = ReturnType<typeof canonicalResource>;

export type PersistMachineZhHantTranslationInput = Readonly<{
	resourceId: string;
	translationRevision: string;
	patch: Readonly<{ title?: string; summary?: string; content?: string }>;
}>;

const RESOURCE_TRANSLATION_REVISION_RE = /^[0-9a-f]{32}$/;

function httpUrl(value: string | null, field: string): string | null {
	if (value === null) return null;
	const url = URL.parse(value);
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
		throw new TypeError(`${field} must be an http(s) URL without credentials`);
	}
	return url.toString();
}

function identifierMatchesResource(identifier: ResourceIdentifier, resource: ProcessingResource): boolean {
	return resource.resourcePlatform !== null
		? identifier.scheme === resource.resourcePlatform
		: resource.kind === 'paper' && isPaperIdentifier(identifier);
}

function canonicalResource(
	resource: ProcessingResource,
	classification: ResourceClassification,
	hostedImages: readonly HostedResourceImage[],
) {
	const originalLang = canonicalizeResourceLang(resource.originalLang);
	const title = resource.title.trim();
	const content = resource.content.trim();
	if (!title || !content) throw new TypeError('Resolved Resource requires title and content');
	const creators = ResourceCreatorsSchema.parse(resource.creators);
	const kindMetadata = RESOURCE_TYPES[resource.kind].metadata.parse(resource.kindMetadata);
	const media = hostedResourceImageFields({ creators, kindMetadata, ogImageUrl: resource.previewImageUrl }, hostedImages);
	if (!resourceImageFieldsAreHosted(media)) throw new TypeError('Resource images must use canonical Hosted Images URLs');
	const identifiers = ResourceIdentifiersSchema.parse(resource.resourceIdentifiers);
	if (resource.kind === 'paper' && !identifiers.some(({ scheme }) => scheme === 'openalex')) {
		throw new TypeError('Paper Resource requires an OpenAlex identifier');
	}
	if (identifiers.some((identifier) => !identifierMatchesResource(identifier, resource))) {
		throw new TypeError('Resource identifiers do not match its identity');
	}
	if (resource.resourcePlatform !== null && !identifiers.some(({ scheme }) => scheme === resource.resourcePlatform)) {
		throw new TypeError('Platform Resource requires its exact identifier');
	}
	const url = httpUrl(resource.url, 'Resource URL');
	const normalizedUrl = httpUrl(resource.normalizedUrl ?? resource.url, 'Normalized Resource URL');
	if ((url === null) !== (normalizedUrl === null)) {
		throw new TypeError('Resource URL and normalized URL must either both be present or both be null');
	}
	const publishedDate = resource.publishedDate ? new Date(resource.publishedDate) : null;
	if (publishedDate && Number.isNaN(publishedDate.getTime())) throw new TypeError('Resource publication date is invalid');
	const youtubeVideoId = identifiers.find(({ scheme }) => scheme === 'youtube')?.value;
	if (resource.youtube && (resource.kind !== 'video' || resource.resourcePlatform !== 'youtube' || !youtubeVideoId)) {
		throw new TypeError('YouTube data requires a YouTube video Resource');
	}
	const highlightsGeneratedAt = resource.youtube?.highlights ? new Date(resource.youtube.highlights.generatedAt) : null;
	if (highlightsGeneratedAt && Number.isNaN(highlightsGeneratedAt.getTime())) {
		throw new TypeError('YouTube highlights generation date is invalid');
	}
	const subject = resource.subject
		? {
				identifiers: ResourceIdentifiersSchema.parse(resource.subject.identifiers),
				normalizedUrl: httpUrl(resource.subject.normalizedUrl, 'Normalized subject URL')!,
			}
		: null;
	return {
		content,
		creators: media.creators,
		entities: toStoredResourceEntities(classification.entities, resource.resourcePlatform, resource.source, resource.creators),
		fileType: resource.fileType ?? null,
		highlightsGeneratedAt,
		identifiers,
		keywords: [...classification.keywords],
		kind: resource.kind,
		kindMetadata: media.kindMetadata,
		normalizedUrl,
		ogImageUrl: media.ogImageUrl,
		originalLang,
		publishedDate,
		resourcePlatform: resource.resourcePlatform,
		subject,
		summary: resource.summary,
		tags: [...classification.tags],
		title,
		url,
		youtube: resource.youtube && youtubeVideoId ? { input: resource.youtube, videoId: youtubeVideoId } : null,
	};
}

async function lockResource(db: NodePgDatabase, resourceId: string): Promise<LockedResource> {
	const result = await db.execute<LockedResource>(sql`
		SELECT enrichment_status, id::text, original_lang, scope, subject_resource_id::text
		FROM resources
		WHERE id = ${resourceId}::uuid
		FOR UPDATE
	`);
	const resource = result.rows[0];
	if (!resource) throw new Error(`Resource ${resourceId} was not found`);
	if (resource.scope !== 'corpus' && resource.scope !== 'private') throw new Error(`Resource ${resourceId} has invalid scope`);
	return resource;
}

async function identifierOwners(db: NodePgDatabase, identifiers: readonly ResourceIdentifier[]): Promise<string[]> {
	if (!identifiers.length) return [];
	const pairs = sql.join(
		identifiers.map(({ scheme, value }) => sql`(${scheme}, ${value})`),
		sql`, `,
	);
	const result = await db.execute<{ resource_id: string }>(sql`
		SELECT DISTINCT resource_id::text
		FROM resource_identifiers
		WHERE (scheme, value) IN (${pairs})
	`);
	return result.rows.map(({ resource_id }) => resource_id);
}

async function corpusUrlOwner(db: NodePgDatabase, normalizedUrl: string | null): Promise<string | null> {
	if (!normalizedUrl) return null;
	const result = await db.execute<{ id: string }>(sql`
		SELECT id::text
		FROM resources
		WHERE normalized_url = ${normalizedUrl} AND scope = 'corpus'
		LIMIT 1
	`);
	return result.rows[0]?.id ?? null;
}

async function draftRoot(db: NodePgDatabase, resource: CanonicalResource): Promise<LockedResource> {
	const owners = await identifierOwners(db, resource.identifiers);
	if (owners.length > 1) throw new Error('Resolved identifiers belong to different Resources');
	const identifierOwner = owners[0] ?? null;
	const urlOwner = await corpusUrlOwner(db, resource.normalizedUrl);
	if (identifierOwner && urlOwner && identifierOwner !== urlOwner) {
		throw new Error('Resolved identifiers and URL belong to different Resources');
	}
	const existingId = identifierOwner ?? urlOwner;
	if (existingId) {
		const existing = await lockResource(db, existingId);
		if (existing.scope !== 'corpus') throw new Error('A URL draft cannot resolve to a private Resource');
		return existing;
	}
	const result = await db.execute<LockedResource>(sql`
		INSERT INTO resources (
			kind, resource_platform, scope, url, normalized_url, original_lang,
			tags, creators, enrichment_status, updated_at
		) VALUES (
			${resource.kind}, ${resource.resourcePlatform}, 'corpus', ${resource.url}, ${resource.normalizedUrl}, ${resource.originalLang},
			ARRAY[]::text[], '[]'::jsonb, 'enriched', NOW()
		)
		RETURNING enrichment_status, id::text, original_lang, scope, subject_resource_id::text
	`);
	const created = result.rows[0];
	if (!created) throw new Error('Failed to create canonical Resource');
	return created;
}

async function existingSubject(db: NodePgDatabase, parentId: string, subject: NonNullable<CanonicalResource['subject']>) {
	const owners = await identifierOwners(db, subject.identifiers);
	if (owners.length > 1) return null;
	const identifierOwner = owners[0] ?? null;
	const urlOwner = await corpusUrlOwner(db, subject.normalizedUrl);
	if (identifierOwner && urlOwner && identifierOwner !== urlOwner) return null;
	const existingId = identifierOwner ?? urlOwner;
	if (!existingId || existingId === parentId) return null;
	const existing = await lockResource(db, existingId);
	return existing.scope === 'corpus' && existing.enrichment_status === 'enriched' ? existing.id : null;
}

async function persistYouTube(db: NodePgDatabase, videoId: string, input: YouTubeResourceData, highlightsGeneratedAt: Date | null) {
	await db.execute(sql`
		INSERT INTO youtube_transcripts (
			video_id, transcript, language, chapters, chapters_from_description,
			fetched_at, ai_highlights, highlights_generated_at
		) VALUES (
			${videoId}, ${JSON.stringify(input.transcript.segments)}::jsonb, ${input.transcript.language},
			${JSON.stringify(input.transcript.chapters)}::jsonb, ${input.transcript.chaptersFromDescription},
			NOW(), ${input.highlights ? JSON.stringify(input.highlights) : null}::jsonb, ${highlightsGeneratedAt}
		)
		ON CONFLICT (video_id) DO UPDATE SET
			transcript = EXCLUDED.transcript,
			language = EXCLUDED.language,
			chapters = EXCLUDED.chapters,
			chapters_from_description = EXCLUDED.chapters_from_description,
			fetched_at = NOW(),
			ai_highlights = COALESCE(EXCLUDED.ai_highlights, youtube_transcripts.ai_highlights),
			highlights_generated_at = COALESCE(EXCLUDED.highlights_generated_at, youtube_transcripts.highlights_generated_at)
	`);
}

async function writeCanonicalResource(
	db: NodePgDatabase,
	resourceId: string,
	resource: CanonicalResource,
	previousOriginalLang: string,
	subjectResourceId: string | null,
) {
	const current = await db.execute<{ content: string | null; source: string; summary: string | null; title: string | null }>(sql`
		SELECT content, source, summary, title
		FROM resource_translations
		WHERE resource_id = ${resourceId}::uuid AND lang = ${resource.originalLang}
		LIMIT 1
	`);
	const currentOriginal = current.rows[0];
	const preserveHuman = currentOriginal?.source === 'human';
	const originalChanged =
		previousOriginalLang !== resource.originalLang ||
		(!preserveHuman &&
			(!currentOriginal ||
				currentOriginal.title !== resource.title ||
				currentOriginal.summary !== resource.summary ||
				currentOriginal.content !== resource.content));

	await db.execute(sql`
		UPDATE resources SET
			kind = ${resource.kind},
			resource_platform = ${resource.resourcePlatform},
			url = ${resource.url},
			normalized_url = ${resource.normalizedUrl},
			file_type = ${resource.fileType},
			original_lang = ${resource.originalLang},
			published_date = ${resource.publishedDate},
			scraped_date = NOW(),
			tags = ${resource.tags}::text[],
			og_image_url = ${resource.ogImageUrl},
			creators = ${JSON.stringify(resource.creators)}::jsonb,
			kind_metadata = ${resource.kindMetadata === null ? null : JSON.stringify(resource.kindMetadata)}::jsonb,
			subject_resource_id = ${subjectResourceId}::uuid,
			entities = ${JSON.stringify(resource.entities)}::jsonb,
			enrichment_status = 'enriched',
			updated_at = NOW()
		WHERE id = ${resourceId}::uuid
	`);
	await db.execute(sql`DELETE FROM resource_identifiers WHERE resource_id = ${resourceId}::uuid`);
	if (resource.identifiers.length) {
		const values = sql.join(
			resource.identifiers.map(({ scheme, value, preferred }) => sql`(${resourceId}::uuid, ${scheme}, ${value}, ${preferred})`),
			sql`, `,
		);
		await db.execute(sql`
			INSERT INTO resource_identifiers (resource_id, scheme, value, is_preferred)
			VALUES ${values}
		`);
	}
	if (originalChanged) {
		await db.execute(sql`DELETE FROM resource_translations WHERE resource_id = ${resourceId}::uuid AND source = 'machine'`);
	}
	await db.execute(sql`
		UPDATE resource_translations
		SET source = 'machine', updated_at = NOW()
		WHERE resource_id = ${resourceId}::uuid AND lang <> ${resource.originalLang} AND source = 'original'
	`);
	if (!preserveHuman) {
		await db.execute(sql`
			INSERT INTO resource_translations (resource_id, lang, title, summary, content, keywords, source, updated_at)
			VALUES (
				${resourceId}::uuid, ${resource.originalLang}, ${resource.title}, ${resource.summary}, ${resource.content},
				${resource.keywords}::text[], 'original', NOW()
			)
			ON CONFLICT (resource_id, lang) DO UPDATE SET
				title = EXCLUDED.title,
				summary = EXCLUDED.summary,
				content = EXCLUDED.content,
				keywords = EXCLUDED.keywords,
				source = 'original',
				updated_at = NOW()
		`);
	}
	if (resource.youtube) {
		await persistYouTube(db, resource.youtube.videoId, resource.youtube.input, resource.highlightsGeneratedAt);
	}
	const revision = await db.execute<{ revision: string }>(sql`
		SELECT MD5(jsonb_build_array(original.lang, original.title, original.summary, original.content)::text) AS revision
		FROM resource_translations original
		JOIN resources resource ON resource.id = original.resource_id
		WHERE resource.id = ${resourceId}::uuid AND original.lang = resource.original_lang
		LIMIT 1
	`);
	return revision.rows[0]?.revision ?? null;
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
		  AND enrichment_status = 'enriched'
		  AND id <> ${resourceId}::uuid
	`);
	if (attached.rowCount !== 1) throw new Error('Subject parent is no longer eligible for attachment');
}

export async function persistResolvedResource(
	db: NodePgDatabase,
	input: Readonly<{
		resource: ProcessingResource;
		classification: ResourceClassification;
		hostedImages: readonly HostedResourceImage[];
		target: ResourcePersistenceTarget;
	}>,
) {
	const resource = canonicalResource(input.resource, input.classification, input.hostedImages);
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
		const root = input.target.kind === 'draft' ? await draftRoot(tx, resource) : await lockResource(tx, input.target.resourceId);
		const resolvedSubjectId = resource.subject ? await existingSubject(tx, root.id, resource.subject) : null;
		const subjectResourceId = resolvedSubjectId ?? root.subject_resource_id;
		const translationRevision = await writeCanonicalResource(tx, root.id, resource, root.original_lang, subjectResourceId);
		if (input.target.kind === 'draft' && input.target.relation) {
			await applyDraftRelation(tx, root.id, input.target.relation);
		}
		if (!translationRevision) throw new Error(`Resource ${root.id} has no original translation`);
		return {
			resourceId: root.id,
			scope: root.scope,
			subjectAttached: subjectResourceId !== null,
			translationRevision,
		};
	});
}

export async function persistMachineZhHantTranslation(db: NodePgDatabase, input: PersistMachineZhHantTranslationInput): Promise<boolean> {
	if (!RESOURCE_TRANSLATION_REVISION_RE.test(input.translationRevision)) {
		throw new TypeError('Resource translation revision is invalid');
	}
	if (input.patch.title === undefined && input.patch.summary === undefined && input.patch.content === undefined) {
		throw new TypeError('Resource translation patch is empty');
	}
	const result = await db.execute<{ resource_id: string }>(sql`
		WITH target_resource AS (
			SELECT resource.id
			FROM resources resource
			WHERE resource.id = ${input.resourceId}::uuid
			  AND (
				resource.scope = 'corpus'
				OR (
				  resource.scope = 'private'
				  AND resource.kind = 'blog'
				  AND resource.resource_platform IS NULL
				  AND resource.file_type = 'application/pdf'
				  AND resource.storage_key IS NOT NULL
				  AND EXISTS (SELECT 1 FROM user_files file WHERE file.resource_id = resource.id)
				)
			  )
			  AND EXISTS (
				SELECT 1
				FROM resource_translations original
				WHERE original.resource_id = resource.id
				  AND original.lang = resource.original_lang
				  AND MD5(jsonb_build_array(original.lang, original.title, original.summary, original.content)::text) = ${input.translationRevision}
			  )
			FOR UPDATE OF resource
		)
		INSERT INTO resource_translations AS current_translation (
			resource_id, lang, title, summary, content, keywords, source, updated_at
		)
		SELECT
			target_resource.id, 'zh-Hant', ${input.patch.title ?? null}, ${input.patch.summary ?? null}, ${input.patch.content ?? null},
			ARRAY[]::text[], 'machine', NOW()
		FROM target_resource
		ON CONFLICT (resource_id, lang) DO UPDATE SET
			title = CASE
				WHEN current_translation.source IN ('human', 'original') OR ${input.patch.title === undefined}
					THEN current_translation.title
				ELSE EXCLUDED.title
			END,
			summary = CASE
				WHEN current_translation.source IN ('human', 'original') OR ${input.patch.summary === undefined}
					THEN current_translation.summary
				ELSE EXCLUDED.summary
			END,
			content = CASE
				WHEN current_translation.source IN ('human', 'original') OR ${input.patch.content === undefined}
					THEN current_translation.content
				ELSE EXCLUDED.content
			END,
			keywords = CASE
				WHEN current_translation.source IN ('human', 'original') THEN current_translation.keywords
				ELSE EXCLUDED.keywords
			END,
			source = CASE
				WHEN current_translation.source IN ('human', 'original') THEN current_translation.source
				ELSE EXCLUDED.source
			END,
			updated_at = NOW()
		RETURNING resource_id::text
	`);
	return result.rows.length > 0;
}
