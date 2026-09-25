import { NonRetryableError } from 'cloudflare:workflows';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { type HostedResourceImage, hostedResourceImageFields } from '../shared/image-mapping';
import { isPaperIdentifierScheme } from '../shared/paper-identity';
import {
	RESOURCE_KIND_METADATA,
	RESOURCE_PLATFORMS,
	ResourceCreatorsSchema,
	type ResourceKind,
	type ResourcePlatform,
	ResourceIdentifiersSchema,
} from '../shared/resource';
import type { AcquiredResource } from './acquisition';
import type { ResourceDraftRelation } from './admission';
import type { ResourceClassification } from './analysis';
import { resolveResourceUrl, type ResolvedResourceUrl } from './platforms/resource-url';
import type { YouTubeHighlights, YouTubeTranscript } from './platforms/youtube';
import { ResourceLanguageSchema } from './resource-language';

export type ResourcePersistenceTarget = { ownedBlobId?: string } & (
	| Readonly<{ kind: 'draft'; relation?: ResourceDraftRelation }>
	| Readonly<{ kind: 'existing'; resourceId: string }>
);

type LockedResource = Readonly<{
	id: string;
	hasOriginal: boolean;
	subjectResourceId: string | null;
	translationRevision: string;
	acquisitionRevision: string;
	kind: ResourceKind;
	fileType: string | null;
	resourcePlatform: ResourcePlatform | null;
	originalLang: string;
	scope: 'corpus' | 'private';
	url: string | null;
}>;

type PreparedResource = ReturnType<typeof prepareResolvedResource>;

/** Original writes advance scraped_date in the same transaction; classification belongs to that acquisition. */
export async function persistResourceClassification(
	db: NodePgDatabase,
	targets: { resourceId: string; acquisitionRevision: string }[],
	classification: ResourceClassification,
): Promise<void> {
	if (!targets.length) return;
	await db.execute(sql`
		WITH target AS (
			SELECT resource.id
			FROM jsonb_to_recordset(${JSON.stringify(targets)}::jsonb)
			  AS expected("resourceId" uuid, "acquisitionRevision" text)
			JOIN resources resource ON resource.id = expected."resourceId"
			WHERE MD5(EXTRACT(EPOCH FROM resource.scraped_date)::text) = expected."acquisitionRevision"
			ORDER BY resource.id
			FOR UPDATE OF resource
		)
		UPDATE resources
		SET tags = ${sql.param(classification.tags)}::text[], keywords = ${sql.param(classification.keywords)}::text[], updated_at = NOW()
		FROM target WHERE resources.id = target.id
	`);
}

/** Lock the acquisition revision so an old AI result cannot overwrite a newer transcript. */
export async function persistYouTubeHighlights(
	db: NodePgDatabase,
	target: { resourceId: string; acquisitionRevision: string },
	highlights: YouTubeHighlights,
): Promise<void> {
	await db.execute(sql`
		WITH current_resource AS (
			SELECT id FROM resources
			WHERE id = ${target.resourceId}::uuid AND resource_platform = 'youtube'
			  AND MD5(EXTRACT(EPOCH FROM scraped_date)::text) = ${target.acquisitionRevision}
			FOR UPDATE
		)
		UPDATE youtube_transcripts SET ai_highlights = ${JSON.stringify(highlights)}::jsonb
		FROM current_resource WHERE youtube_transcripts.resource_id = current_resource.id
	`);
}

/** Use the same candidates for admission, canonical persistence, and subject attachment. */
async function findResourceCandidates(
	db: NodePgDatabase,
	identities: readonly { normalizedUrl: string | null; identifiers: ResolvedResourceUrl['identifiers'] }[],
) {
	if (!identities.length) return [];
	const { rows } = await db.execute<{
		owners: { id: string; sourceId: string | null; scope: 'corpus' | 'private'; hasOriginal: boolean }[];
	}>(sql`
		SELECT COALESCE(jsonb_agg(jsonb_build_object(
		  'id', resource.id, 'sourceId', resource.source_id, 'scope', resource.scope,
		  'hasOriginal', COALESCE((resource.kind = 'post' OR BTRIM(original.title) <> '') AND BTRIM(original.content) <> '', false)))
		  FILTER (WHERE resource.id IS NOT NULL), '[]'::jsonb) AS owners
		FROM jsonb_array_elements(${JSON.stringify(identities.map(({ normalizedUrl, identifiers }) => ({ normalizedUrl, identifiers })))}::jsonb) WITH ORDINALITY AS input(value, ordinal)
		LEFT JOIN LATERAL (
			SELECT id FROM resources WHERE scope = 'corpus' AND normalized_url = input.value->>'normalizedUrl'
			UNION SELECT stored.resource_id AS id
			FROM jsonb_to_recordset(input.value->'identifiers') AS incoming(scheme text, value text)
			JOIN resource_identifiers stored USING (scheme, value)
		) candidate ON true
		LEFT JOIN resources resource ON resource.id = candidate.id
		LEFT JOIN resource_translations original ON original.resource_id = resource.id AND original.lang = resource.original_lang
		GROUP BY input.ordinal ORDER BY input.ordinal
	`);
	return rows.map(({ owners }) => owners);
}

/** Admission only reuses an unambiguous public identity with a readable original. */
export async function findResourcesByUrls(db: NodePgDatabase, urls: readonly ResolvedResourceUrl[]) {
	const candidates = await findResourceCandidates(db, urls);
	return urls.map(({ url, normalizedUrl }, index) => {
		const owners = candidates[index]!.filter(({ scope }) => scope === 'corpus');
		const owner = owners.length === 1 && owners[0]!.hasOriginal ? owners[0] : null;
		return { url, normalizedUrl, resourceId: owner?.id ?? null, sourceId: owner?.sourceId ?? null };
	});
}

export function prepareResolvedResource(
	resource: AcquiredResource & { youtube?: YouTubeTranscript },
	hostedImages: readonly HostedResourceImage[],
) {
	const title = resource.title?.trim() || null;
	const content = resource.content.trim();
	const sourceName = resource.source.trim();
	if (!content) throw new TypeError('Resolved Resource requires content');
	if (resource.kind === 'post' ? title !== null || resource.summary !== null : !title) {
		throw new TypeError('Posts have no title or summary; every other Resource requires a title');
	}
	if (!sourceName) throw new TypeError('Resolved Resource requires a source name');
	const creators = ResourceCreatorsSchema.parse(resource.creators);
	const kindMetadata = RESOURCE_KIND_METADATA[resource.kind].parse(resource.kindMetadata);
	const media = hostedResourceImageFields({ creators, kindMetadata, ogImageUrl: resource.previewImageUrl }, hostedImages);
	const identifiers = ResourceIdentifiersSchema.parse(resource.resourceIdentifiers);
	if (
		resource.resourcePlatform !== null
			? !(RESOURCE_PLATFORMS[resource.resourcePlatform].kinds as readonly string[]).includes(resource.kind) ||
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
	let publishedDate = resource.publishedDate ? new Date(resource.publishedDate) : null;
	if (publishedDate && Number.isNaN(publishedDate.getTime())) throw new TypeError('Resource publication date is invalid');
	const today = new Date().toISOString().slice(0, 10);
	if (publishedDate && publishedDate.toISOString().slice(0, 10) > today) publishedDate = new Date(today);
	const subject = resolveResourceUrl(resource.subjectUrl);
	if (resource.subjectUrl !== null && !subject) throw new TypeError('Subject URL must be HTTP(S) without credentials');
	return {
		kind: resource.kind,
		resourcePlatform: resource.resourcePlatform,
		content,
		references: resource.kind === 'paper' ? resource.references : undefined,
		creators: media.creators,
		fileType: resource.fileType ?? null,
		identifiers,
		kindMetadata: media.kindMetadata,
		normalizedUrl: resolvedUrl?.normalizedUrl ?? null,
		ogImageHeight: media.ogImageHeight,
		ogImageUrl: media.ogImageUrl,
		ogImageWidth: media.ogImageWidth,
		originalLang: ResourceLanguageSchema.parse(resource.originalLang),
		publishedDate,
		sourceName,
		subject,
		summary: resource.summary?.trim() || null,
		title,
		url: resolvedUrl?.url ?? null,
		youtube: resource.youtube ?? null,
	};
}

async function lockResource(db: NodePgDatabase, resourceId: string): Promise<LockedResource> {
	const result = await db.execute<LockedResource>(sql`
		SELECT resource.id::text, resource.scope, resource.kind, resource.url,
		       resource.original_lang AS "originalLang", resource.file_type AS "fileType", resource.resource_platform AS "resourcePlatform",
		       resource.subject_resource_id::text AS "subjectResourceId",
		       COALESCE((resource.kind = 'post' OR BTRIM(original.title) <> '') AND BTRIM(original.content) <> '', false) AS "hasOriginal",
		       MD5(jsonb_build_array(original.lang, original.title, original.summary, original.content)::text) AS "translationRevision",
		       MD5(EXTRACT(EPOCH FROM resource.scraped_date)::text) AS "acquisitionRevision"
		FROM resources resource
		LEFT JOIN resource_translations original ON original.resource_id = resource.id AND original.lang = resource.original_lang
		WHERE resource.id = ${resourceId}::uuid
		FOR UPDATE OF resource
	`);
	const resource = result.rows[0];
	if (!resource) throw new Error(`Resource ${resourceId} was not found`);
	return resource;
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
		tags, keywords, og_image_url, og_image_width, og_image_height, creators, kind_metadata, subject_resource_id,
		scraped_date, updated_at
	`;
	const values = sql`
		${resource.kind}, ${resource.resourcePlatform}, ${resource.sourceName}, ${resource.url}, ${resource.normalizedUrl},
		${resource.fileType}, ${resource.originalLang}, ${resource.publishedDate}, ARRAY[]::text[], ARRAY[]::text[],
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
			INSERT INTO resource_translations (resource_id, lang, title, summary, content, source, updated_at)
			SELECT id, ${resource.originalLang}, ${resource.title}, ${resource.summary}, ${resource.content},
			       'original', NOW()
			FROM written_resource
			WHERE true
			ON CONFLICT (resource_id, lang) DO UPDATE SET
				(title, summary, content, source, alignment, updated_at) =
				(EXCLUDED.title, EXCLUDED.summary, EXCLUDED.content, EXCLUDED.source, NULL, EXCLUDED.updated_at)
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
	if (resource.references?.length) {
		// These references describe exactly the original written in this transaction.
		await db.execute(sql`
			INSERT INTO resource_references (resource_id, ordinal, label, text, doi, arxiv_id)
			SELECT ${resourceId}::uuid, incoming.ordinal::integer, incoming.value->>'label', incoming.value->>'text',
			       incoming.value->>'doi', incoming.value->>'arxivId'
			FROM jsonb_array_elements(${JSON.stringify(resource.references)}::jsonb)
			WITH ORDINALITY AS incoming(value, ordinal)
		`);
	}
	if (resource.youtube) {
		const transcript = resource.youtube;
		const savedTranscript = await db.execute(sql`
			INSERT INTO youtube_transcripts (resource_id, transcript, chapters, ai_highlights)
			VALUES (
				${resourceId}::uuid, ${JSON.stringify(transcript.segments)}::jsonb,
				${JSON.stringify(transcript.chapters)}::jsonb, NULL
			)
			ON CONFLICT (resource_id) DO UPDATE SET
				transcript = EXCLUDED.transcript,
				chapters = EXCLUDED.chapters,
				ai_highlights = EXCLUDED.ai_highlights
			WHERE youtube_transcripts.transcript = '[]'::jsonb OR EXCLUDED.transcript <> '[]'::jsonb
			RETURNING resource_id
		`);
		if (!savedTranscript.rows.length) throw new NonRetryableError('YouTube reacquisition returned no captions for an existing transcript');
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

export async function persistResolvedResource(db: NodePgDatabase, resource: PreparedResource, target: ResourcePersistenceTarget) {
	const lockKeys = [
		...(resource.normalizedUrl ? [`url:${resource.normalizedUrl}`] : []),
		...resource.identifiers.map(({ scheme, value }) => `id:${scheme}:${value}`),
		...(resource.subject
			? [`url:${resource.subject.normalizedUrl}`, ...resource.subject.identifiers.map(({ scheme, value }) => `id:${scheme}:${value}`)]
			: []),
	];
	return db.transaction(async (tx) => {
		if (lockKeys.length) {
			// Preserve the same lock order while acquiring all identities in one round trip.
			await tx.execute(sql`
				SELECT pg_advisory_xact_lock(hashtextextended('newsence:resource:' || key, 0))
				FROM unnest(${sql.param([...new Set(lockKeys)].sort())}::text[]) WITH ORDINALITY AS locks(key, ordinal)
				ORDER BY ordinal
			`);
		}
		if (target.ownedBlobId) {
			const owned = await tx.execute(sql`SELECT resource_id FROM user_files WHERE resource_id = ${target.ownedBlobId}::uuid FOR UPDATE`);
			if (!owned.rows.length) throw new NonRetryableError('Uploaded PDF ownership was deleted');
		}
		const candidates = await findResourceCandidates(tx, [
			...(target.kind === 'draft' ? [resource] : []),
			...(resource.subject ? [resource.subject] : []),
		]);
		const rootCandidates = target.kind === 'draft' ? candidates.shift()! : [];
		const subjectCandidates = candidates[0] ?? [];
		if (target.kind === 'draft' && (rootCandidates.length > 1 || rootCandidates[0]?.scope === 'private'))
			throw new Error('Resolved identity is ambiguous or belongs to a private Resource');
		const existingId = target.kind === 'existing' ? target.resourceId : rootCandidates[0]?.id;
		const root = existingId ? await lockResource(tx, existingId) : null;
		const resourceId = root?.id ?? crypto.randomUUID();
		const originalWritten = target.kind === 'existing' || !root?.hasOriginal;
		let subjectResourceId = root?.subjectResourceId ?? null;
		let accepted = root;
		if (originalWritten) {
			const subject = subjectCandidates.length === 1 && subjectCandidates[0]?.scope === 'corpus' ? subjectCandidates[0] : null;
			subjectResourceId = subject && subject.id !== resourceId && (await lockResource(tx, subject.id)).hasOriginal ? subject.id : null;
			const written = await writeCanonicalResource(tx, resourceId, resource, root !== null, subjectResourceId);
			accepted = { ...resource, ...written, id: resourceId, scope: root?.scope ?? 'corpus', hasOriginal: true, subjectResourceId };
		}
		if (target.kind === 'draft' && target.relation) await applyDraftRelation(tx, resourceId, target.relation);
		// Follow-ups use the accepted original, which can differ from this draft.
		const { scope, kind, fileType, resourcePlatform, originalLang, url, translationRevision, acquisitionRevision } = accepted!;
		return {
			resourceId,
			scope,
			kind,
			fileType,
			resourcePlatform,
			originalLang,
			url,
			translationRevision,
			acquisitionRevision,
			originalWritten,
			subjectAttached: subjectResourceId !== null,
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
