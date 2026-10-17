import { NonRetryableError } from 'cloudflare:workflows';
import { type SQL, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { HostedPreview } from '../contracts/image-mapping';
import type { NormalizedResource } from '../contracts/normalize-resource';
import {
	type EntityType,
	type ResourceKind,
	type ResourcePlatform,
	RESOURCE_KINDS,
	ResourceIdentifiersSchema,
} from '../contracts/resource';
import { linkedResourceUrls, resourceLinks } from '../contracts/resource-links';
import { type ResolvedResourceUrl, ResourceUrlSchema } from '../contracts/resource-url';
import { blobKey } from '../contracts/storage-keys';
import { type Derivation, replaceResourceEntities, requireDerivations, SUMMARY_LANGS } from './derivations';
import { kindWhere, READABLE_ORIGINAL_SQL } from './kind-sql';
import { fulfillRequests } from './requests';

/** Web's `storedBlobs` advisory lock namespace (`web-tanstack/src/server/db/locks.server.ts`). */
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
	| Readonly<{ kind: 'draft'; uploadId?: string }>
	| Readonly<{ kind: 'existing'; resourceId: string; fence: number; force?: boolean }>
	/** An unidentified upload's private file, which shares its stored object's id. */
	| Readonly<{ kind: 'upload'; objectId: string }>;

/** A reacquired original this much shorter than the stored one is kept out unless forced (error or challenge pages). */
const MIN_REACQUIRED_CONTENT_RATIO = 0.5;

/** A Resource row as its transaction sees it, locked; also what persistence hands its follow-ups. */
type StoredResource = Readonly<{
	id: string;
	hasOriginal: boolean;
	originalChars: number;
	committedSeq: number;
	subjectResourceId: string | null;
	textHash: string | null;
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
			SELECT resource_id AS id FROM resource_keys WHERE scheme = 'url' AND value = input.value->>'normalizedUrl'
			UNION SELECT stored.resource_id AS id
			FROM jsonb_to_recordset(input.value->'identifiers') AS incoming(scheme text, value text)
			JOIN resource_keys stored USING (scheme, value)
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
		       resource.text_hash AS "textHash"
		FROM resources resource
		LEFT JOIN resource_translations original ON original.resource_id = resource.id AND original.lang = resource.original_lang
		WHERE resource.id = ${resourceId}::uuid
		FOR UPDATE OF resource
	`);
	return result.rows[0] ?? null;
}

const NO_PREVIEW = { url: null, width: null, height: null } as const;
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
	if (!url || !resource.url || !RESOURCE_KINDS[resource.kind].sitePreview) return preview;
	if (width !== null && height !== null && (width < 300 || height < 150)) return NO_PREVIEW;
	const host = HOST_SQL(sql`${resource.url}::text`);
	const known = await db.execute(sql`SELECT 1 FROM site_default_images WHERE host = ${host} AND image_url = ${url}`);
	if (known.rows.length) return NO_PREVIEW;
	const holders = sql`
		SELECT id FROM resources
		WHERE og_image_url = ${url} AND id <> ${resourceId}::uuid AND scope = 'corpus'
		  AND ${kindWhere(sql`kind`, 'sitePreview')} AND ${HOST_SQL(sql`url`)} = ${host}
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

/**
 * Replaces a Resource's platform and paper ids and records its own URL; the Hacker News threads that discussed it stay. A URL it was known by before, its earlier URL or
 * one that redirected to it, stays as an alias. A key another Resource holds is left to it.
 */
async function writeResourceKeys(
	db: NodePgDatabase,
	resourceId: string,
	normalizedUrl: string | null,
	identifiers: NormalizedResource['resourceIdentifiers'],
	existing: boolean,
) {
	if (existing) {
		// Hacker News threads that discussed it stay; a thread Resource keeps its own id below.
		await db.execute(sql`DELETE FROM resource_keys WHERE resource_id = ${resourceId}::uuid AND scheme NOT IN ('url', 'hackernews')`);
		await db.execute(sql`
			UPDATE resource_keys SET preferred = false
			WHERE resource_id = ${resourceId}::uuid AND scheme = 'url' AND preferred AND value IS DISTINCT FROM ${normalizedUrl}
		`);
	}
	const keys = [...(normalizedUrl ? [{ scheme: 'url', value: normalizedUrl, preferred: true }] : []), ...identifiers];
	if (!keys.length) return;
	await db.execute(sql`
		INSERT INTO resource_keys AS stored (resource_id, scheme, value, preferred)
		SELECT ${resourceId}::uuid, scheme, value, preferred
		FROM jsonb_to_recordset(${JSON.stringify(keys)}::jsonb) AS incoming(scheme text, value text, preferred boolean)
		ON CONFLICT (scheme, value) DO UPDATE SET preferred = EXCLUDED.preferred WHERE stored.resource_id = EXCLUDED.resource_id
	`);
}

/**
 * Replaces a Resource's byline. Each platform account it names is upserted by the id the platform never reassigns, so
 * its handle, name and avatar follow this latest acquisition.
 */
async function writeResourceCreators(db: NodePgDatabase, resourceId: string, creators: NormalizedResource['creators'], existing: boolean) {
	if (existing) await db.execute(sql`DELETE FROM resource_creators WHERE resource_id = ${resourceId}::uuid`);
	if (!creators.length) return;
	const rows = creators.map((creator, position) => ({
		position,
		role: creator.role,
		name: creator.literal ?? [creator.given, creator.family].filter(Boolean).join(' '),
		platform: creator.account?.platform ?? null,
		platform_id: creator.account?.id ?? null,
		handle: creator.handle ?? null,
		avatar_url: creator.avatarUrl ?? null,
		profile_url: creator.profileUrl ?? null,
		verified: creator.verified ?? null,
	}));
	await db.execute(sql`
		WITH incoming AS (
			SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS creator(
				position integer, role text, name text, platform text, platform_id text,
				handle text, avatar_url text, profile_url text, verified boolean
			)
		), accounts AS (
			INSERT INTO creator_accounts AS stored (platform, platform_id, handle, name, avatar_url, profile_url, verified)
			SELECT DISTINCT ON (platform, platform_id) platform, platform_id, handle, name, avatar_url, profile_url, verified
			FROM incoming WHERE platform IS NOT NULL
			ORDER BY platform, platform_id, position
			ON CONFLICT (platform, platform_id) DO UPDATE SET
				(handle, name, avatar_url, profile_url, verified, updated_at) =
				(EXCLUDED.handle, EXCLUDED.name, COALESCE(EXCLUDED.avatar_url, stored.avatar_url), EXCLUDED.profile_url,
				 COALESCE(EXCLUDED.verified, stored.verified), NOW())
			RETURNING id, platform, platform_id
		)
		INSERT INTO resource_creators (resource_id, position, role, name, account_id)
		SELECT ${resourceId}::uuid, incoming.position, incoming.role, incoming.name, accounts.id
		FROM incoming LEFT JOIN accounts USING (platform, platform_id)
	`);
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
		kind, resource_platform, source_name, title, description, url, file_type, pdf_hash, original_lang, published_date,
		og_image_url, og_image_width, og_image_height, kind_metadata, subject_resource_id, text_hash,
		scraped_date, updated_at
	`;
	const preview = await articlePreview(db, resourceId, resource);
	const values = sql`
		${resource.kind}, ${resource.resourcePlatform}, ${resource.source}, ${resource.title}, ${resource.summary}, ${resource.url},
		${resource.fileType}, ${existing ? sql`COALESCE(${resource.pdfHash ?? null}, pdf_hash)` : (resource.pdfHash ?? null)}, ${resource.originalLang}, ${resource.publishedDate}::timestamptz,
		${preview.url}, ${preview.width}, ${preview.height},
		${resource.kindMetadata === null ? null : JSON.stringify(resource.kindMetadata)}::jsonb, ${subjectResourceId}::uuid,
		(SELECT MD5(jsonb_build_array(lang, title, content)::text) FROM incoming), NOW(), NOW()
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
				(EXCLUDED.title, COALESCE(EXCLUDED.summary, CASE
					-- A derived summary outlives a reacquisition that left the text as it was.
					WHEN jsonb_build_array(resource_translations.title, resource_translations.content) = jsonb_build_array(EXCLUDED.title, EXCLUDED.content)
					THEN resource_translations.summary END),
				 EXCLUDED.content, EXCLUDED.source, NULL, EXCLUDED.updated_at)
			RETURNING resource_id
		), written_content AS (
			INSERT INTO resource_content (resource_id, markdown)
			SELECT written_resource.id, incoming.content FROM written_resource CROSS JOIN incoming WHERE incoming.content <> ''
			ON CONFLICT (resource_id) DO UPDATE SET markdown = EXCLUDED.markdown
		), cleared_content AS (
			DELETE FROM resource_content WHERE resource_id = ${resourceId}::uuid AND ${existing} AND (SELECT content FROM incoming) = ''
		)
		SELECT 1 FROM written_resource JOIN written_original ON written_original.resource_id = written_resource.id
	`);
	if (!written.rows.length) throw new Error(`Resource ${resourceId} has no authoritative original translation`);
	await writeResourceKeys(db, resourceId, privateObjectId ? null : resource.normalizedUrl, resource.resourceIdentifiers, existing);
	await writeResourceCreators(db, resourceId, resource.creators, existing);
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
	// Only corpus originals relate through entities, like links; theirs are derived after this write.
	if (privateObjectId) await replaceResourceEntities(db, resourceId, []);
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
		await db.execute(sql`
			UPDATE resource_content SET transcript = ${JSON.stringify(transcript.lines)}::jsonb, chapters = ${JSON.stringify(transcript.chapters)}::jsonb
			WHERE resource_id = ${resourceId}::uuid
		`);
	}
	// Every titled Resource is summarized in each reader language, whatever its source said about itself.
	return requireDerivations(db, resourceId, [
		...(RESOURCE_KINDS[resource.kind].titled ? SUMMARY_LANGS.map((lang) => ({ kind: 'summary' as const, lang })) : []),
		...(privateObjectId ? [] : [{ kind: 'entities' as const, lang: '' as const }]),
	]);
}

export type EntityCandidate = Readonly<{
	/** The key without its maker qualifier, which a name in a text is looked up by. */
	bare: string;
	name: string;
	type: EntityType;
	/** How many Resources name it. */
	uses: number;
	/** The Resource most about it, so a reader can tell same-named entities apart. */
	example: string | null;
}>;

/** Stored entities whose name, without a maker qualifier, has one of the keys. */
export async function listEntityCandidates(db: NodePgDatabase, keys: readonly string[]): Promise<EntityCandidate[]> {
	if (!keys.length) return [];
	const result = await db.execute<EntityCandidate>(sql`
		SELECT split_part(e.key, '(', 1) AS bare, e.name, e.type,
		       (SELECT count(*)::int FROM resource_entities used WHERE used.entity_id = e.id) AS uses,
		       (SELECT left(COALESCE(t.title, t.content), 120)
		        FROM resource_entities top
		        JOIN resources r ON r.id = top.resource_id
		        JOIN resource_translations t ON t.resource_id = r.id AND t.lang = r.original_lang
		        WHERE top.entity_id = e.id
		        ORDER BY top.weight DESC LIMIT 1) AS example
		FROM entities e
		WHERE split_part(e.key, '(', 1) = ANY(${sql.param([...keys])}::text[])
	`);
	return result.rows;
}

/** Links stored before this Resource existed, under any URL it is known by, now point to it. */
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
		INSERT INTO resource_keys (resource_id, scheme, value, preferred)
		SELECT ${resourceId}::uuid, incoming.scheme, incoming.value, incoming.preferred AND NOT EXISTS (
			SELECT 1 FROM resource_keys stored WHERE stored.resource_id = ${resourceId}::uuid AND stored.scheme = incoming.scheme AND stored.preferred
		)
		FROM jsonb_to_recordset(${JSON.stringify(identifiers)}::jsonb) AS incoming(scheme text, value text, preferred boolean)
		ON CONFLICT (scheme, value) DO NOTHING
	`);
}

/**
 * Writes an acquired Resource in one transaction, in three parts: `claimRow` decides which row it is and whether its
 * original is replaced, `writeOriginal` writes or keeps that original, and `fulfillRequests` settles every request waiting
 * on the one `requestId` leads. `blobExists` confirms, under the blob lock, that the PDF a Resource reads as was not purged
 * since it was stored.
 */
export async function persistResolvedResource(
	db: NodePgDatabase,
	resource: HostedResource,
	target: ResourcePersistenceTarget,
	requestId: string,
	blobExists: (contentHash: string) => Promise<boolean>,
) {
	return db.transaction(async (tx) => {
		const claim = await claimRow(tx, resource, target, blobExists);
		// A newer attempt that already committed did what these requests asked.
		if (claim.settled) return { ...claim.settled, derivations: [], requests: await fulfillRequests(tx, requestId, claim.resourceId) };
		const derivations = await writeOriginal(tx, resource, target, claim);
		if (resource.hackerNewsId && target.kind !== 'upload')
			await tx.execute(sql`
				INSERT INTO resource_keys AS stored (resource_id, scheme, value) VALUES (${claim.resourceId}::uuid, 'hackernews', ${resource.hackerNewsId})
				-- A thread Resource reacquired as its linked page no longer has the thread as its own id.
				ON CONFLICT (scheme, value) DO UPDATE SET preferred = false WHERE stored.resource_id = EXCLUDED.resource_id
			`);
		// Follow-ups read the committed row, which can differ from this draft; links stored before it existed now point to it.
		if (target.kind !== 'upload') await resolveLinksTo(tx, claim.resourceId, resource);
		const requests = await fulfillRequests(tx, requestId, claim.resourceId);
		return { ...committed(await lockResource(tx, claim.resourceId), claim.outcome), derivations, requests };
	});
}

type RowClaim = Readonly<{
	resourceId: string;
	root: StoredResource | null;
	outcome: PersistOutcome;
	subjectCandidates: Awaited<ReturnType<typeof findResourceCandidates>>[number];
	/** Set when a newer or identical attempt already committed, so nothing is written. */
	settled?: ReturnType<typeof committed>;
}>;

/** Locks every identity the Resource and its subject are known by, then decides which row it is and whether its original is replaced. */
async function claimRow(
	tx: NodePgDatabase,
	resource: HostedResource,
	target: ResourcePersistenceTarget,
	blobExists: (contentHash: string) => Promise<boolean>,
): Promise<RowClaim> {
	const lockKeys = [
		...(resource.normalizedUrl ? [`url:${resource.normalizedUrl}`] : []),
		...resource.resourceIdentifiers.map(({ scheme, value }) => `id:${scheme}:${value}`),
		...(resource.subject
			? [`url:${resource.subject.normalizedUrl}`, ...resource.subject.identifiers.map(({ scheme, value }) => `id:${scheme}:${value}`)]
			: []),
	];
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
		// Core's one read of Web's stored_objects: every Web path that ends ownership (file deletion, unsaving,
		// account purge) marks the object `deleting` in the same transaction, so a ready, locked row is still owned.
		const owned = await tx.execute(sql`SELECT id FROM stored_objects WHERE id = ${uploadId}::uuid AND status = 'ready' FOR UPDATE`);
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
		return { resourceId, root, outcome: 'superseded', subjectCandidates, settled: committed(root, 'superseded') };
	}
	// A retried step whose commit already landed replays it instead of writing again.
	if (root && fence !== null && root.committedSeq === fence)
		return { resourceId, root, outcome: 'written', subjectCandidates, settled: committed(root, 'written') };
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
	return { resourceId, root, outcome, subjectCandidates };
}

/**
 * Writes the original where the claim replaces it, returning the derivations that now wait for it; a kept paper still
 * gains the new version's identifiers and PDF.
 */
async function writeOriginal(
	tx: NodePgDatabase,
	resource: HostedResource,
	target: ResourcePersistenceTarget,
	claim: RowClaim,
): Promise<Derivation[]> {
	const { resourceId, root, outcome, subjectCandidates } = claim;
	if (outcome === 'written') {
		const subject = subjectCandidates.length === 1 && subjectCandidates[0]?.scope === 'corpus' ? subjectCandidates[0] : null;
		const subjectResourceId = subject && subject.id !== resourceId && (await lockResource(tx, subject.id)).hasOriginal ? subject.id : null;
		return writeCanonicalResource(
			tx,
			resourceId,
			resource,
			root !== null,
			subjectResourceId,
			target.kind === 'existing' ? target.fence : null,
			target.kind === 'upload' ? target.objectId : null,
		);
	}
	if (target.kind === 'existing')
		console.warn({ tag: 'PERSIST', msg: 'Reacquired original is much shorter; kept the stored one', resource_id: resourceId });
	if (root?.kind === 'paper' && resource.kind === 'paper') {
		await mergePaperIdentifiers(tx, resourceId, resource.resourceIdentifiers);
		// A kept full text without a PDF of its own, such as arXiv HTML, still gains the copy for the PDF view.
		if (resource.pdfHash)
			await tx.execute(sql`UPDATE resources SET pdf_hash = ${resource.pdfHash} WHERE id = ${resourceId}::uuid AND pdf_hash IS NULL`);
	}
	return [];
}

function isDegradedOriginal(content: string, stored: StoredResource): boolean {
	return stored.hasOriginal && content.length < stored.originalChars * MIN_REACQUIRED_CONTENT_RATIO;
}

function committed(stored: StoredResource, outcome: PersistOutcome) {
	if (!stored.textHash) throw new Error(`Resource ${stored.id} has no recorded original revision`);
	return { ...stored, textHash: stored.textHash, outcome };
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
			SELECT jsonb_agg(jsonb_build_object('scheme', scheme, 'value', value, 'preferred', preferred)
				ORDER BY scheme, preferred DESC, value)
			-- A Hacker News thread that discussed it is not how it is fetched.
			FROM resource_keys WHERE resource_id = resource.id AND scheme <> 'url' AND (scheme <> 'hackernews' OR resource.resource_platform = 'hackernews')
		), '[]'::jsonb) AS identifiers
		FROM resources resource WHERE resource.id = ${resourceId}::uuid
	`);
	if (!rows[0]) throw new NonRetryableError(`Failed to fetch resource ${resourceId}: not found`);
	const url = ResourceUrlSchema.safeParse(rows[0].url).data;
	if (!url) throw new NonRetryableError(`Resource ${resourceId} has no valid external HTTP URL and cannot be reacquired`);
	return { url, identifiers: ResourceIdentifiersSchema.parse(rows[0].identifiers) };
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
