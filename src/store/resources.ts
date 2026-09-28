import { NonRetryableError } from 'cloudflare:workflows';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { StoredPdf } from '../contracts/acquired-resource';
import { type HostedResourceImage, hostedResourceImageFields } from '../contracts/image-mapping';
import type { NormalizedResource } from '../contracts/normalize-resource';
import { PDF_MIME } from '../contracts/pdf-policy';
import type { ResourceDraftRelation } from '../contracts/processing-target';
import { ResourceCreatorsSchema, type ResourceKind, type ResourcePlatform, ResourceIdentifiersSchema } from '../contracts/resource';
import { type ResolvedResourceUrl, ResourceUrlSchema } from '../contracts/resource-url';

/**
 * A draft writes an original only where none is readable yet. An existing Resource is
 * reacquired under a fencing token from `claimAcquisitionFence`: only a token newer than the
 * last committed one may replace its original, so an older attempt that finishes later loses.
 */
export type ResourcePersistenceTarget = { ownedBlobId?: string } & (
	| Readonly<{ kind: 'draft'; relation?: ResourceDraftRelation }>
	| Readonly<{ kind: 'existing'; resourceId: string; fence: number; force?: boolean }>
);

/** A reacquired original this much shorter than the stored one is kept out unless forced (error or challenge pages). */
const MIN_REACQUIRED_CONTENT_RATIO = 0.5;

/** Whether a Resource has a readable original, over the `resource` and `original` aliases. Posts need no title. */
export const READABLE_ORIGINAL_SQL = sql`COALESCE((resource.kind = 'post' OR BTRIM(original.title) <> '') AND BTRIM(original.content) <> '', false)`;

/** A Resource row as its transaction sees it, locked; also what persistence hands its follow-ups. */
type StoredResource = Readonly<{
	id: string;
	hasOriginal: boolean;
	originalChars: number;
	committedSeq: number;
	subjectResourceId: string | null;
	originalHash: string | null;
	kind: ResourceKind;
	fileType: string | null;
	resourcePlatform: ResourcePlatform | null;
	originalLang: string;
	scope: 'corpus' | 'private';
	url: string | null;
}>;

/** A write replaced the original, a degraded reacquisition kept the stored one, or a newer attempt had already committed. */
type PersistOutcome = 'written' | 'kept' | 'superseded';

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
		  'hasOriginal', ${READABLE_ORIGINAL_SQL}))
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

async function lockResource(db: NodePgDatabase, resourceId: string): Promise<StoredResource> {
	const result = await db.execute<StoredResource>(sql`
		SELECT resource.id::text, resource.scope, resource.kind, resource.url,
		       resource.original_lang AS "originalLang", resource.file_type AS "fileType", resource.resource_platform AS "resourcePlatform",
		       resource.subject_resource_id::text AS "subjectResourceId",
		       ${READABLE_ORIGINAL_SQL} AS "hasOriginal",
		       COALESCE(CHAR_LENGTH(original.content), 0) AS "originalChars",
		       resource.committed_seq AS "committedSeq",
		       resource.original_hash AS "originalHash"
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
	resource: NormalizedResource,
	hostedImages: readonly HostedResourceImage[],
	existing: boolean,
	subjectResourceId: string | null,
	fence: number | null,
) {
	const media = hostedResourceImageFields(
		{ creators: resource.creators, kindMetadata: resource.kindMetadata, ogImageUrl: resource.previewImageUrl },
		hostedImages,
	);
	const columns = sql`
		kind, resource_platform, source_name, url, normalized_url, file_type, original_lang, published_date,
		og_image_url, og_image_width, og_image_height, creators, kind_metadata, subject_resource_id, original_hash,
		scraped_date, updated_at
	`;
	const values = sql`
		${resource.kind}, ${resource.resourcePlatform}, ${resource.source}, ${resource.url}, ${resource.normalizedUrl},
		${resource.fileType}, ${resource.originalLang}, ${resource.publishedDate}::timestamptz,
		${media.ogImageUrl}, ${media.ogImageWidth}, ${media.ogImageHeight}, ${JSON.stringify(media.creators)}::jsonb,
		${media.kindMetadata === null ? null : JSON.stringify(media.kindMetadata)}::jsonb, ${subjectResourceId}::uuid,
		(SELECT MD5(jsonb_build_array(lang, title, summary, content)::text) FROM incoming), NOW(), NOW()
	`;
	// The cleanup excludes the incoming language: no CTE deletes a row another CTE writes.
	const written = await db.execute(sql`
		WITH incoming AS (
			SELECT ${resource.originalLang}::text AS lang, ${resource.title}::text AS title,
			       ${resource.summary}::text AS summary, ${resource.content}::text AS content
		), written_resource AS (
			${
				!existing
					? sql`INSERT INTO resources (id, scope, ${columns}) VALUES (${resourceId}::uuid, 'corpus', ${values})`
					: sql`UPDATE resources SET (${columns}) = (${values}), committed_seq = COALESCE(${fence}::integer, committed_seq)
					      WHERE id = ${resourceId}::uuid`
			}
			RETURNING id
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
			SELECT written_resource.id, incoming.lang, incoming.title, incoming.summary, incoming.content, 'original', NOW()
			FROM written_resource CROSS JOIN incoming
			ON CONFLICT (resource_id, lang) DO UPDATE SET
				(title, summary, content, source, alignment, updated_at) =
				(EXCLUDED.title, EXCLUDED.summary, EXCLUDED.content, EXCLUDED.source, NULL, EXCLUDED.updated_at)
			RETURNING resource_id
		)
		SELECT 1 FROM written_resource JOIN written_original ON written_original.resource_id = written_resource.id
	`);
	if (!written.rows.length) throw new Error(`Resource ${resourceId} has no authoritative original translation`);
	if (resource.resourceIdentifiers.length) {
		// Identifier replacement must follow its DELETE; both can target the same keys.
		await db.execute(sql`
			INSERT INTO resource_identifiers (resource_id, scheme, value, is_preferred)
			SELECT ${resourceId}::uuid, scheme, value, preferred
			FROM jsonb_to_recordset(${JSON.stringify(resource.resourceIdentifiers)}::jsonb) AS incoming(scheme text, value text, preferred boolean)
		`);
	}
	if (resource.references?.length) {
		// These references describe exactly the original written in this transaction.
		await db.execute(sql`
			INSERT INTO resource_references
				(resource_id, ordinal, label, text, doi, arxiv_id, title, year, authors, lead_author, has_coauthors, venue)
			SELECT ${resourceId}::uuid, incoming.ordinal::integer, incoming.value->>'label', incoming.value->>'text',
			       incoming.value->>'doi', incoming.value->>'arxivId', incoming.value->>'title', (incoming.value->>'year')::integer,
			       incoming.value->>'authors', incoming.value->>'leadAuthor', coalesce((incoming.value->>'hasCoauthors')::boolean, false), incoming.value->>'venue'
			FROM jsonb_array_elements(${JSON.stringify(resource.references)}::jsonb)
			WITH ORDINALITY AS incoming(value, ordinal)
		`);
	}
	if (resource.youtube) {
		const transcript = resource.youtube;
		const savedTranscript = await db.execute(sql`
			INSERT INTO youtube_transcripts (resource_id, transcript, chapters)
			VALUES (${resourceId}::uuid, ${JSON.stringify(transcript.lines)}::jsonb, ${JSON.stringify(transcript.chapters)}::jsonb)
			ON CONFLICT (resource_id) DO UPDATE SET
				transcript = EXCLUDED.transcript,
				chapters = EXCLUDED.chapters
			WHERE youtube_transcripts.transcript = '[]'::jsonb OR EXCLUDED.transcript <> '[]'::jsonb
			RETURNING resource_id
		`);
		if (!savedTranscript.rows.length) throw new NonRetryableError('YouTube reacquisition returned no captions for an existing transcript');
	}
}

/** Another version's identifiers join the paper that is already stored, so both find it next time. */
async function mergePaperIdentifiers(db: NodePgDatabase, resourceId: string, identifiers: NormalizedResource['resourceIdentifiers']) {
	if (!identifiers.length) return;
	await db.execute(sql`
		INSERT INTO resource_identifiers (resource_id, scheme, value, is_preferred)
		SELECT ${resourceId}::uuid, incoming.scheme, incoming.value, incoming.preferred AND NOT EXISTS (
			SELECT 1 FROM resource_identifiers stored WHERE stored.resource_id = ${resourceId}::uuid AND stored.scheme = incoming.scheme
		)
		FROM jsonb_to_recordset(${JSON.stringify(identifiers)}::jsonb) AS incoming(scheme text, value text, preferred boolean)
		ON CONFLICT (scheme, value) DO NOTHING
	`);
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
		UPDATE resources resource SET subject_resource_id = ${resourceId}::uuid, updated_at = NOW()
		FROM resource_translations original
		WHERE resource.id = ${relation.parentResourceId}::uuid
		  AND original.resource_id = resource.id AND original.lang = resource.original_lang
		  AND resource.scope = 'corpus'
		  AND ${READABLE_ORIGINAL_SQL}
		  AND resource.id <> ${resourceId}::uuid
		  AND resource.original_hash = ${relation.parentOriginalHash}
	`);
	if (attached.rowCount !== 1) throw new NonRetryableError('Subject parent was reacquired or is no longer eligible for attachment');
}

export async function persistResolvedResource(
	db: NodePgDatabase,
	resource: NormalizedResource,
	hostedImages: readonly HostedResourceImage[],
	target: ResourcePersistenceTarget,
) {
	const lockKeys = [
		...(resource.normalizedUrl ? [`url:${resource.normalizedUrl}`] : []),
		...resource.resourceIdentifiers.map(({ scheme, value }) => `id:${scheme}:${value}`),
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
			...(target.kind === 'draft' ? [{ normalizedUrl: resource.normalizedUrl, identifiers: resource.resourceIdentifiers }] : []),
			...(resource.subject ? [resource.subject] : []),
		]);
		const rootCandidates = target.kind === 'draft' ? candidates.shift()! : [];
		const subjectCandidates = candidates[0] ?? [];
		// Each candidate is already committed; another attempt finds the same ones.
		if (target.kind === 'draft' && (rootCandidates.length > 1 || rootCandidates[0]?.scope === 'private'))
			throw new NonRetryableError('Resolved identity is ambiguous or belongs to a private Resource');
		const existingId = target.kind === 'existing' ? target.resourceId : rootCandidates[0]?.id;
		const root = existingId ? await lockResource(tx, existingId) : null;
		const resourceId = root?.id ?? crypto.randomUUID();
		const fence = target.kind === 'existing' ? target.fence : null;
		if (root && fence !== null && root.committedSeq > fence) {
			console.info({
				tag: 'PERSIST',
				msg: 'Superseded by a newer acquisition',
				resource_id: resourceId,
				fence,
				committed: root.committedSeq,
			});
			return committed(root, 'superseded');
		}
		// A retried step whose commit already landed replays it instead of writing again.
		if (root && fence !== null && root.committedSeq === fence) return committed(root, 'written');
		const outcome: PersistOutcome =
			!root?.hasOriginal || (target.kind === 'existing' && (target.force || !isDegradedOriginal(resource.content, root)))
				? 'written'
				: 'kept';
		if (outcome === 'written') {
			const subject = subjectCandidates.length === 1 && subjectCandidates[0]?.scope === 'corpus' ? subjectCandidates[0] : null;
			const subjectResourceId =
				subject && subject.id !== resourceId && (await lockResource(tx, subject.id)).hasOriginal ? subject.id : null;
			await writeCanonicalResource(tx, resourceId, resource, hostedImages, root !== null, subjectResourceId, fence);
		} else {
			if (target.kind === 'existing')
				console.warn({ tag: 'PERSIST', msg: 'Reacquired original is much shorter; kept the stored one', resource_id: resourceId });
			if (root?.kind === 'paper' && resource.kind === 'paper') await mergePaperIdentifiers(tx, resourceId, resource.resourceIdentifiers);
		}
		if (target.kind === 'draft' && target.relation) await applyDraftRelation(tx, resourceId, target.relation);
		// Follow-ups read the committed row, which can differ from this draft.
		return committed(await lockResource(tx, resourceId), outcome);
	});
}

function isDegradedOriginal(content: string, stored: StoredResource): boolean {
	return stored.hasOriginal && content.length < stored.originalChars * MIN_REACQUIRED_CONTENT_RATIO;
}

function committed(stored: StoredResource, outcome: PersistOutcome) {
	if (!stored.originalHash) throw new Error(`Resource ${stored.id} has no recorded original revision`);
	return { ...stored, originalHash: stored.originalHash, outcome };
}

/** Issue the next fencing token for reacquiring an existing Resource; call it inside the attempt's first durable step. */
export async function claimAcquisitionFence(db: NodePgDatabase, resourceId: string): Promise<number> {
	const { rows } = await db.execute<{ fence: number }>(sql`
		UPDATE resources SET acquisition_seq = acquisition_seq + 1 WHERE id = ${resourceId}::uuid RETURNING acquisition_seq AS fence
	`);
	if (!rows[0]) throw new NonRetryableError(`Resource ${resourceId} was not found`);
	return rows[0].fence;
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

/** The external URL and identifiers a reacquisition starts from. */
export async function loadReacquisitionSource(db: NodePgDatabase, resourceId: string) {
	const { rows } = await db.execute<{ url: string | null; identifiers: unknown }>(sql`
		SELECT resource.url, COALESCE((
			SELECT jsonb_agg(jsonb_build_object('scheme', scheme, 'value', value, 'preferred', is_preferred)
				ORDER BY scheme, is_preferred DESC, value)
			FROM resource_identifiers WHERE resource_id = resource.id
		), '[]'::jsonb) AS identifiers
		FROM resources resource WHERE resource.id = ${resourceId}::uuid
	`);
	if (!rows[0]) throw new NonRetryableError(`Failed to fetch resource ${resourceId}: not found`);
	const url = ResourceUrlSchema.safeParse(rows[0].url).data;
	if (!url) throw new NonRetryableError(`Resource ${resourceId} has no valid external HTTP URL and cannot be reacquired`);
	return { url, identifiers: ResourceIdentifiersSchema.parse(rows[0].identifiers) };
}

type StoredPdfRow = {
	content_hash: string;
	creators: unknown;
	original_lang: string;
	published_date: string | null;
	source: string;
	storage_key: string;
	summary: string | null;
	title: string | null;
};

/** An owned private PDF upload, as its owner stored it. */
export async function loadStoredPdf(db: NodePgDatabase, resourceId: string): Promise<StoredPdf> {
	const result = await db.execute<StoredPdfRow>(sql`
		SELECT
			resource.content_hash,
			original.title,
			original.summary,
			resource.original_lang,
			COALESCE(resource.source_name, 'File') AS source,
			resource.published_date,
			resource.creators,
			resource.storage_key
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		WHERE resource.id = ${resourceId}::uuid
		  AND resource.scope = 'private'
		  AND resource.kind = 'file'
		  AND resource.file_type = ${PDF_MIME}
		  AND resource.storage_key IS NOT NULL
		  AND EXISTS (SELECT 1 FROM user_files file WHERE file.resource_id = resource.id)
	`);
	const row = result.rows[0];
	if (!row) throw new NonRetryableError(`Failed to fetch stored PDF ${resourceId}: not found or not an owned private blob`);
	const title = row.title?.trim();
	if (!title) throw new NonRetryableError(`Stored PDF ${resourceId} has no title`);
	const publishedDate = row.published_date === null ? null : new Date(row.published_date);
	if (publishedDate && !Number.isFinite(publishedDate.getTime())) throw new NonRetryableError('Invalid published_date: expected date');
	const creators = ResourceCreatorsSchema.safeParse(row.creators);
	if (!creators.success) throw new NonRetryableError(`Invalid creators for ${resourceId}: ${creators.error.message}`);
	return {
		contentHash: row.content_hash,
		creators: creators.data,
		originalLang: row.original_lang,
		publishedDate: publishedDate?.toISOString() ?? null,
		source: row.source,
		storageKey: row.storage_key,
		summary: row.summary,
		title,
	};
}

/** Attach a discovery source to known Resources that already have a readable original; returns the attached ids. */
export async function attachSourceToReadableResources(db: NodePgDatabase, sourceId: string, resourceIds: readonly string[]) {
	if (!resourceIds.length) return new Set<string>();
	const { rows } = await db.execute<{ id: string }>(sql`
		UPDATE resources resource
		SET source_id = ${sourceId}::uuid, updated_at = NOW()
		FROM resource_translations original
		WHERE resource.id = ANY(${sql.param([...resourceIds])}::uuid[]) AND resource.scope = 'corpus' AND resource.source_id IS NULL
		  AND original.resource_id = resource.id AND original.lang = resource.original_lang AND ${READABLE_ORIGINAL_SQL}
		RETURNING resource.id::text
	`);
	return new Set(rows.map(({ id }) => id));
}
