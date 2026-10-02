import { NonRetryableError } from 'cloudflare:workflows';
import { type SQL, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { EntitySource, StoredPdf } from '../contracts/acquired-resource';
import type { HostedPreview } from '../contracts/image-mapping';
import type { NormalizedResource } from '../contracts/normalize-resource';
import { PDF_MIME } from '../contracts/pdf-policy';
import type { ResourceDraftRelation } from '../contracts/processing-target';
import { entityKey, type ResourceEntity, type ResourceKind, type ResourcePlatform, ResourceIdentifiersSchema } from '../contracts/resource';
import { linkedResourceUrls, resourceLinks } from '../contracts/resource-links';
import { type ResolvedResourceUrl, ResourceUrlSchema } from '../contracts/resource-url';
import { blobKey } from '../contracts/storage-keys';

/** Web's `storedBlobs` advisory lock namespace (`web-tanstack/src/server/prisma.server.ts`). */
const STORED_BLOB_LOCK_NAMESPACE = 330571;

/** A normalized resource whose images are already Hosted Images URLs. */
type HostedResource = NormalizedResource & HostedPreview;

/**
 * A draft writes an original only where none is readable yet. An existing Resource is
 * reacquired under a fencing token from `claimAcquisitionFence`: only a token newer than the
 * last committed one may replace its original, so an older attempt that finishes later loses.
 */
export type ResourcePersistenceTarget =
	/** `uploadId` is the stored object of an upload that identified this draft. */
	| Readonly<{ kind: 'draft'; relation?: ResourceDraftRelation; uploadId?: string }>
	| Readonly<{ kind: 'existing'; resourceId: string; fence: number; force?: boolean }>
	/** An unidentified upload's private file, which shares its stored object's id. */
	| Readonly<{ kind: 'upload'; objectId: string }>;

/** A reacquired original this much shorter than the stored one is kept out unless forced (error or challenge pages). */
const MIN_REACQUIRED_CONTENT_RATIO = 0.5;

/** Whether a Resource has a readable original, over the `resource` and `original` aliases. Posts need no title. */
const READABLE_ORIGINAL_SQL = sql`COALESCE((resource.kind = 'post' OR BTRIM(original.title) <> '') AND BTRIM(original.content) <> '', false)`;

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
	const resource = await lockResourceIfAny(db, resourceId);
	if (!resource) throw new Error(`Resource ${resourceId} was not found`);
	return resource;
}

async function lockResourceIfAny(db: NodePgDatabase, resourceId: string): Promise<StoredResource | null> {
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
	return result.rows[0] ?? null;
}

const NO_PREVIEW = { url: null, width: null, height: null } as const;
const SITE_PREVIEW_KINDS: ReadonlySet<ResourceKind> = new Set(['blog', 'forum', 'paper']);
/** Pages of one host sharing a preview before it counts as the site's card; fewer is a reused photo. */
const SITE_DEFAULT_PREVIEW_PAGES = 5;
const HOST_SQL = (url: SQL) => sql`lower(substring(${url} from '://([^/]+)'))`;

/**
 * An article's preview is its own picture, not the site's. Icons and avatars are dropped, and
 * so is a share image enough other pages of the same host carry: that is the site's default
 * card. It is recorded in `site_default_images` and cleared from the pages that had it.
 */
async function articlePreview(db: NodePgDatabase, resourceId: string, resource: HostedResource) {
	const { previewImageUrl: url, previewImageWidth: width, previewImageHeight: height } = resource;
	const preview = { url, width, height };
	if (!url || !resource.url || !SITE_PREVIEW_KINDS.has(resource.kind)) return preview;
	if (width !== null && height !== null && (width < 300 || height < 150)) return NO_PREVIEW;
	const host = HOST_SQL(sql`${resource.url}::text`);
	const known = await db.execute(sql`SELECT 1 FROM site_default_images WHERE host = ${host} AND image_url = ${url}`);
	if (known.rows.length) return NO_PREVIEW;
	const holders = sql`
		SELECT id FROM resources
		WHERE og_image_url = ${url} AND id <> ${resourceId}::uuid AND scope = 'corpus'
		  AND kind IN ('blog', 'forum', 'paper') AND ${HOST_SQL(sql`url`)} = ${host}
	`;
	const recorded = await db.execute(sql`
		WITH recorded AS (
			INSERT INTO site_default_images (host, image_url)
			SELECT ${host}, ${url} WHERE (SELECT count(*) FROM (${holders}) holder) >= ${SITE_DEFAULT_PREVIEW_PAGES - 1}
			ON CONFLICT DO NOTHING
			RETURNING host
		), cleared AS (
			UPDATE resources SET og_image_url = NULL, og_image_width = NULL, og_image_height = NULL
			WHERE id IN (${holders}) AND EXISTS (SELECT 1 FROM recorded)
		)
		SELECT 1 FROM recorded
	`);
	return recorded.rows.length ? NO_PREVIEW : preview;
}

async function writeCanonicalResource(
	db: NodePgDatabase,
	resourceId: string,
	resource: HostedResource,
	existing: boolean,
	subjectResourceId: string | null,
	fence: number | null,
	privateObjectId: string | null,
) {
	const columns = sql`
		kind, resource_platform, source_name, url, normalized_url, file_type, pdf_hash, original_lang, published_date,
		og_image_url, og_image_width, og_image_height, creators, kind_metadata, subject_resource_id, original_hash,
		scraped_date, updated_at
	`;
	const preview = await articlePreview(db, resourceId, resource);
	const values = sql`
		${resource.kind}, ${resource.resourcePlatform}, ${resource.source}, ${resource.url}, ${resource.normalizedUrl},
		${resource.fileType}, ${existing ? sql`COALESCE(${resource.pdfHash ?? null}, pdf_hash)` : (resource.pdfHash ?? null)}, ${resource.originalLang}, ${resource.publishedDate}::timestamptz,
		${preview.url}, ${preview.width}, ${preview.height}, ${JSON.stringify(resource.creators)}::jsonb,
		${resource.kindMetadata === null ? null : JSON.stringify(resource.kindMetadata)}::jsonb, ${subjectResourceId}::uuid,
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
					? sql`INSERT INTO resources (id, scope, stored_object_id, ${columns})
					      VALUES (${resourceId}::uuid, ${privateObjectId ? 'private' : 'corpus'}, ${privateObjectId}::uuid, ${values})`
					: sql`UPDATE resources SET (${columns}) = (${values}), committed_seq = COALESCE(${fence}::integer, committed_seq)
					      WHERE id = ${resourceId}::uuid`
			}
			RETURNING id
		), cleared_identifiers AS (
			DELETE FROM resource_identifiers WHERE resource_id = ${resourceId}::uuid AND ${existing}
		), cleared_references AS (
			DELETE FROM resource_references WHERE resource_id = ${resourceId}::uuid AND ${existing}
		), cleared_links AS (
			DELETE FROM resource_links WHERE source_resource_id = ${resourceId}::uuid AND ${existing}
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
	// Only corpus originals link; a private file's links are its owner's alone.
	const links = privateObjectId ? [] : resourceLinks(resource.content, [resource.normalizedUrl, resource.subject?.normalizedUrl ?? null]);
	if (links.length) {
		const candidates = await findResourceCandidates(db, links);
		const rows = links.map(({ url, normalizedUrl }, index) => {
			const owners = candidates[index]!.filter(({ scope }) => scope === 'corpus');
			return { url, normalizedUrl, target: owners.length === 1 && owners[0]!.id !== resourceId ? owners[0]!.id : null };
		});
		await db.execute(sql`
			INSERT INTO resource_links (source_resource_id, ordinal, url, normalized_url, target_resource_id)
			SELECT ${resourceId}::uuid, incoming.ordinal::integer, incoming.value->>'url', incoming.value->>'normalizedUrl', (incoming.value->>'target')::uuid
			FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) WITH ORDINALITY AS incoming(value, ordinal)
		`);
	}
	// Only corpus originals relate through entities, like links; a reacquisition without an extraction keeps them.
	if (resource.entities !== undefined) await replaceResourceEntities(db, resourceId, privateObjectId ? [] : resource.entities);
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

/** Links stored before this Resource existed, under any URL it is known by, now point to it. */
/** Replaces what a Resource is about. Run inside the caller's transaction. */
export async function replaceResourceEntities(db: NodePgDatabase, resourceId: string, entities: readonly ResourceEntity[]) {
	await db.execute(sql`DELETE FROM resource_entities WHERE resource_id = ${resourceId}::uuid`);
	if (!entities.length) return;
	// Sorted keys lock entity rows in one order across concurrent writers.
	const rows = entities
		.map((entity, ordinal) => ({ ...entity, key: entityKey(entity.name), ordinal }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	await db.execute(sql`
		WITH incoming AS (
			SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
			AS incoming(key text, name text, type text, salience text, ordinal integer)
		), entity AS (
			INSERT INTO entities (key, name, type)
			SELECT key, name, type FROM incoming
			ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
			RETURNING id, key
		)
		INSERT INTO resource_entities (resource_id, entity_id, salience, ordinal)
		SELECT ${resourceId}::uuid, entity.id, incoming.salience, incoming.ordinal
		FROM incoming JOIN entity USING (key)
	`);
}

/** Corpus Resources published in a window that have no entities yet, by id after `after`. */
export async function listResourcesWithoutEntities(
	db: NodePgDatabase,
	{ since, until, after, limit }: { since: string; until: string | null; after: string | null; limit: number },
) {
	const result = await db.execute<{ id: string }>(sql`
		SELECT r.id::text FROM resources r
		WHERE r.scope = 'corpus' AND r.kind <> 'image'
		  AND r.published_date >= ${since}::timestamptz
		  AND (${until}::timestamptz IS NULL OR r.published_date < ${until}::timestamptz)
		  AND (${after}::uuid IS NULL OR r.id > ${after}::uuid)
		  AND NOT EXISTS (SELECT 1 FROM resource_entities re WHERE re.resource_id = r.id)
		ORDER BY r.id
		LIMIT ${limit}
	`);
	return result.rows.map(({ id }) => id);
}

/** A stored corpus original, as entity extraction reads it. */
export async function loadEntitySource(db: NodePgDatabase, resourceId: string): Promise<EntitySource | null> {
	const result = await db.execute<EntitySource>(sql`
		SELECT r.kind, r.resource_platform AS "resourcePlatform", COALESCE(r.source_name, '') AS source,
		       r.original_lang AS "originalLang", original.title, original.summary, COALESCE(original.content, '') AS content
		FROM resources r
		JOIN resource_translations original ON original.resource_id = r.id AND original.lang = r.original_lang
		WHERE r.id = ${resourceId}::uuid AND r.scope = 'corpus'
	`);
	return result.rows[0] ?? null;
}

async function resolveLinksTo(db: NodePgDatabase, resourceId: string, resource: HostedResource) {
	await db.execute(sql`
		UPDATE resource_links SET target_resource_id = ${resourceId}::uuid
		WHERE normalized_url = ANY(${sql.param(linkedResourceUrls(resource.normalizedUrl, resource.resourceIdentifiers))}::text[])
		  AND target_resource_id IS NULL AND source_resource_id <> ${resourceId}::uuid
	`);
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

/** `blobExists` confirms, under the blob lock, that the PDF a Resource reads as was not purged since it was stored. */
export async function persistResolvedResource(
	db: NodePgDatabase,
	resource: HostedResource,
	target: ResourcePersistenceTarget,
	blobExists: (contentHash: string) => Promise<boolean>,
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
		if (resource.pdfHash) {
			// Web purges a blob only while holding this lock and finding no Resource that reads it.
			await tx.execute(sql`SELECT pg_advisory_xact_lock(${STORED_BLOB_LOCK_NAMESPACE}, hashtext(${blobKey(resource.pdfHash)}))`);
			if (!(await blobExists(resource.pdfHash))) throw new NonRetryableError('Stored PDF was purged before its Resource committed');
		}
		const uploadId = target.kind === 'upload' ? target.objectId : target.kind === 'draft' ? target.uploadId : undefined;
		if (uploadId) {
			const owned = await tx.execute(
				sql`SELECT id FROM stored_objects WHERE id = ${uploadId}::uuid AND status = 'ready' AND user_resource_id IS NOT NULL FOR UPDATE`,
			);
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
		// A private file that an earlier attempt removed, when its upload became a paper, is written again.
		const existingId = target.kind === 'existing' ? target.resourceId : target.kind === 'upload' ? target.objectId : rootCandidates[0]?.id;
		const root = existingId ? await lockResourceIfAny(tx, existingId) : null;
		if (target.kind === 'existing' && !root) throw new Error(`Resource ${target.resourceId} was not found`);
		if (target.kind === 'upload' && root && root.scope !== 'private') throw new NonRetryableError('Uploaded file Resource is not private');
		const resourceId = root?.id ?? existingId ?? crypto.randomUUID();
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
		// An uploaded copy of a paper also replaces a stored original it far outgrows, such as an abstract.
		const outcome: PersistOutcome =
			target.kind === 'upload' ||
			!root?.hasOriginal ||
			(target.kind === 'existing' && (target.force || !isDegradedOriginal(resource.content, root))) ||
			(target.kind === 'draft' &&
				target.uploadId !== undefined &&
				resource.content.length * MIN_REACQUIRED_CONTENT_RATIO > root.originalChars)
				? 'written'
				: 'kept';
		if (outcome === 'written') {
			const subject = subjectCandidates.length === 1 && subjectCandidates[0]?.scope === 'corpus' ? subjectCandidates[0] : null;
			const subjectResourceId =
				subject && subject.id !== resourceId && (await lockResource(tx, subject.id)).hasOriginal ? subject.id : null;
			await writeCanonicalResource(
				tx,
				resourceId,
				resource,
				root !== null,
				subjectResourceId,
				fence,
				target.kind === 'upload' ? target.objectId : null,
			);
		} else {
			if (target.kind === 'existing')
				console.warn({ tag: 'PERSIST', msg: 'Reacquired original is much shorter; kept the stored one', resource_id: resourceId });
			if (root?.kind === 'paper' && resource.kind === 'paper') {
				await mergePaperIdentifiers(tx, resourceId, resource.resourceIdentifiers);
				// A kept full text without a PDF of its own, such as arXiv HTML, still gains the copy for the PDF view.
				if (resource.pdfHash)
					await tx.execute(sql`UPDATE resources SET pdf_hash = ${resource.pdfHash} WHERE id = ${resourceId}::uuid AND pdf_hash IS NULL`);
			}
		}
		if (target.kind === 'draft' && target.relation) await applyDraftRelation(tx, resourceId, target.relation);
		// Follow-ups read the committed row, which can differ from this draft.
		if (target.kind !== 'upload') await resolveLinksTo(tx, resourceId, resource);
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
	file_name: string | null;
	storage_key: string;
};

/**
 * An owned PDF upload, as uploaded. It is read from its stored object alone: an upload that became its paper keeps no
 * private file, and an unidentified result is titled by its file name again.
 */
export async function loadStoredPdf(db: NodePgDatabase, objectId: string): Promise<StoredPdf> {
	const result = await db.execute<StoredPdfRow>(sql`
		SELECT object.content_hash, object.file_name, object.key AS storage_key
		FROM stored_objects object
		WHERE object.id = ${objectId}::uuid
		  AND object.status = 'ready'
		  AND object.store = 'r2'
		  AND object.media_type = ${PDF_MIME}
		  AND object.content_hash IS NOT NULL
		  AND object.user_resource_id IS NOT NULL
	`);
	const row = result.rows[0];
	if (!row) throw new NonRetryableError(`Failed to fetch stored PDF ${objectId}: not found or not an owned upload`);
	// Web titles a new upload by its file name the same way.
	const fileName = row.file_name?.trim() || 'PDF';
	return {
		contentHash: row.content_hash,
		// Core analysis replaces this BCP-47 undetermined marker, as for a new upload.
		originalLang: 'und',
		source: 'File',
		storageKey: row.storage_key,
		title: fileName.replace(/\.[a-z0-9]{1,8}$/i, '') || fileName,
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
