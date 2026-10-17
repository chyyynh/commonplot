import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { RequestTarget, ResourceProcessingTarget } from '../contracts/processing-target';
import { resolveResourceUrl } from '../contracts/resource-url';
import { READABLE_ORIGINAL_SQL } from './kind-sql';

/**
 * Who asked for a Resource. A source and a subject carrier ask once per URL; a user's import names its own request
 * id, which is the UUID in Web's handle for it. `userId` is read from the stored object when an upload omits it.
 */
export type Requester =
	| Readonly<{ requester: 'source'; sourceId: string }>
	| Readonly<{ requester: 'subject'; parentResourceId: string; parentTextHash: string }>
	| Readonly<{ requester: 'user'; id: string; userId: string | null; notebookId: string | null }>
	| Readonly<{ requester: 'resync' }>;

export type ResourceRequest = Requester & Readonly<{ target: RequestTarget }>;

/** Waiting for an acquisition another request leads is joining it; a request that leads one runs it. */
type RequestRow = Readonly<{
	id: string;
	targetKey: string;
	requester: Requester['requester'];
	url: string | null;
	storedObjectId: string | null;
	resourceId: string | null;
	hints: Record<string, unknown> | null;
	workflowId: string | null;
	status: 'pending' | 'fulfilled' | 'failed';
}>;

export type RequestLead = Readonly<{ id: string; workflowId: string; params: ResourceProcessingTarget | null }>;

/** Failed source requests wait this long, doubling per failure up to 30 days, before a feed listing the URL asks again. */
const SOURCE_RETRY = sql`interval '1 day'`;
/** A lead whose workflow is quiet this long is checked; a waiting request this long without a lead takes over. */
const STALE_REQUEST = sql`interval '10 minutes'`;

const REQUEST_COLUMNS = sql`id::text, target_key AS "targetKey", requester, url, stored_object_id::text AS "storedObjectId",
	resource_id::text AS "resourceId", hints, workflow_id AS "workflowId", status`;

/** What every request for the same thing shares: a draft's normalized URL, an upload's object, a resync's Resource. */
export function requestKey(target: RequestTarget): string | null {
	switch (target.kind) {
		case 'draft': {
			const url = resolveResourceUrl(target.url);
			return url && `url:${url.normalizedUrl}`;
		}
		case 'storedBlob':
			return `object:${target.objectId}`;
		case 'reacquire':
			return `resource:${target.resourceId}`;
	}
}

/** Web's handle for an import is fixed by Web; Core's own requests get a fresh workflow per attempt. */
function leadWorkflowId(row: RequestRow) {
	return row.requester === 'user' ? `app-ingest-v1-${row.id}` : `rq-v1-${row.id}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Rebuilds what the lead's workflow acquires; null when a resync's Resource was deleted meanwhile. */
function processingParams(row: RequestRow): ResourceProcessingTarget | null {
	if (row.storedObjectId) return { kind: 'storedBlob', objectId: row.storedObjectId, requestId: row.id };
	if (row.requester === 'resync')
		return row.resourceId
			? { kind: 'reacquire', resourceId: row.resourceId, ...(row.hints?.force ? { force: true } : {}), requestId: row.id }
			: null;
	return { kind: 'draft', url: row.url!, ...(row.hints ? { sourceHints: row.hints } : {}), requestId: row.id };
}

/** Records the request, or returns it again when already recorded; null when it is not waiting for an acquisition. */
async function recordRequest(tx: NodePgDatabase, request: ResourceRequest & { key: string }) {
	const { target } = request;
	const objectId = target.kind === 'storedBlob' ? target.objectId : null;
	const hints =
		target.kind === 'draft' ? (target.sourceHints ?? null) : target.kind === 'reacquire' && target.force ? { force: true } : null;
	const columns = {
		id: request.requester === 'user' ? request.id : null,
		url: target.kind === 'draft' ? target.url : null,
		hints: hints === null ? null : JSON.stringify(hints),
		sourceId: request.requester === 'source' ? request.sourceId : null,
		parentResourceId: request.requester === 'subject' ? request.parentResourceId : null,
		parentTextHash: request.requester === 'subject' ? request.parentTextHash : null,
		userId: request.requester === 'user' ? request.userId : null,
		notebookId: request.requester === 'user' ? request.notebookId : null,
		resourceId: target.kind === 'reacquire' ? target.resourceId : null,
	};
	// A source and a carrier ask for a URL once: asking again revives only a failed or settled request. Web redispatching
	// an import finds the request it already recorded.
	const { rows } = await tx.execute<RequestRow>(sql`
		INSERT INTO resource_requests
			(id, target_key, url, stored_object_id, hints, requester, source_id, parent_resource_id, parent_text_hash, user_id, notebook_id, resource_id)
		VALUES (
			COALESCE(${columns.id}::uuid, gen_random_uuid()), ${request.key}, ${columns.url}, ${objectId}::uuid, ${columns.hints}::jsonb,
			${request.requester}, ${columns.sourceId}::uuid, ${columns.parentResourceId}::uuid, ${columns.parentTextHash},
			COALESCE(${columns.userId}, (SELECT user_id FROM stored_objects WHERE id = ${objectId}::uuid)),
			${columns.notebookId}::uuid, ${columns.resourceId}::uuid
		)
		${
			request.requester === 'source'
				? sql`ON CONFLICT (source_id, target_key) WHERE requester = 'source' DO UPDATE SET
					(status, url, hints, error, retry_after, updated_at) = ('pending', EXCLUDED.url, EXCLUDED.hints, NULL, NULL, NOW())
					WHERE resource_requests.status = 'failed'`
				: request.requester === 'subject'
					? sql`ON CONFLICT (parent_resource_id, target_key) WHERE requester = 'subject' DO UPDATE SET
						(status, parent_text_hash, url, hints, resource_id, error, retry_after, updated_at) =
						('pending', EXCLUDED.parent_text_hash, EXCLUDED.url, EXCLUDED.hints, NULL, NULL, NULL, NOW())
						WHERE resource_requests.status <> 'pending'`
					: sql`ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id`
		}
		RETURNING ${REQUEST_COLUMNS}
	`);
	const row = rows[0];
	return row?.status === 'pending' ? row : null;
}

/** Makes a waiting request the lead of its key's acquisition, unless one is already in flight. Run under the key's lock. */
async function claimLead(tx: NodePgDatabase, row: RequestRow) {
	const { rows } = await tx.execute<RequestRow>(sql`
		UPDATE resource_requests SET workflow_id = ${leadWorkflowId(row)}, updated_at = NOW()
		WHERE id = ${row.id}::uuid AND status = 'pending' AND workflow_id IS NULL
		  AND NOT EXISTS (
			SELECT 1 FROM resource_requests lead
			WHERE lead.target_key = ${row.targetKey} AND lead.status = 'pending' AND lead.workflow_id IS NOT NULL
		  )
		RETURNING ${REQUEST_COLUMNS}
	`);
	return rows[0] ?? null;
}

async function lockKeys(tx: NodePgDatabase, keys: readonly string[]) {
	await tx.execute(sql`
		SELECT pg_advisory_xact_lock(hashtextextended('newsence:request:' || key, 0))
		FROM unnest(${sql.param([...new Set(keys)].sort())}::text[]) WITH ORDINALITY AS locks(key, ordinal)
		ORDER BY ordinal
	`);
}

function toLead(row: RequestRow): RequestLead {
	return { id: row.id, workflowId: row.workflowId!, params: processingParams(row) };
}

/**
 * Records requests, each joining the acquisition already in flight for its key or leading a new one. Returns the leads,
 * whose workflows the caller starts; starting one again is harmless, and a lead whose workflow never started is restarted
 * by `reconcileRequests`.
 */
export async function recordRequests(db: NodePgDatabase, requests: readonly ResourceRequest[]): Promise<RequestLead[]> {
	const keyed = requests.flatMap((request) => {
		const key = requestKey(request.target);
		return key ? [{ ...request, key }] : [];
	});
	if (!keyed.length) return [];
	return db.transaction(async (tx) => {
		await lockKeys(
			tx,
			keyed.map(({ key }) => key),
		);
		const leads: RequestLead[] = [];
		for (const request of keyed) {
			const row = await recordRequest(tx, request);
			const lead = row && (row.workflowId ? row : await claimLead(tx, row));
			if (lead) leads.push(toLead(lead));
		}
		return leads;
	});
}

/** Source requests a feed listing the URL again must not repeat: done, in flight, or failed and still waiting. */
export async function settledSourceRequestKeys(db: NodePgDatabase, sourceId: string, keys: readonly string[]) {
	if (!keys.length) return new Set<string>();
	const { rows } = await db.execute<{ key: string }>(sql`
		SELECT target_key AS key FROM resource_requests
		WHERE requester = 'source' AND source_id = ${sourceId}::uuid AND target_key = ANY(${sql.param([...keys])}::text[])
		  AND (status <> 'failed' OR retry_after IS NULL OR retry_after > NOW())
	`);
	return new Set(rows.map(({ key }) => key));
}

/** A feed listed a URL Core already has: its request is fulfilled without an acquisition. */
export async function recordFulfilledSourceRequests(
	db: NodePgDatabase,
	sourceId: string,
	fulfilled: readonly Readonly<{ key: string; url: string; resourceId: string }>[],
) {
	if (!fulfilled.length) return;
	await db.execute(sql`
		INSERT INTO resource_requests AS current (target_key, url, requester, source_id, resource_id, status)
		SELECT incoming.key, incoming.url, 'source', ${sourceId}::uuid, incoming.resource_id, 'fulfilled'
		FROM jsonb_to_recordset(${JSON.stringify(fulfilled.map(({ key, url, resourceId }) => ({ key, url, resource_id: resourceId })))}::jsonb)
			AS incoming(key text, url text, resource_id uuid)
		ON CONFLICT (source_id, target_key) WHERE requester = 'source' DO UPDATE SET
			(status, resource_id, error, retry_after, updated_at) = ('fulfilled', EXCLUDED.resource_id, NULL, NULL, NOW())
		WHERE current.status = 'failed'
	`);
}

/** A user request whose Resource is written; the workflow completes the save before it is fulfilled. */
export type UserRequest = Readonly<{ id: string; userId: string; notebookId: string | null; storedObjectId: string | null }>;

/**
 * In the transaction that wrote or kept the Resource: settles every request waiting on the lead's key. A source becomes
 * the Resource's discovery source if it has none, a carrier whose text is unchanged gains it as its subject, and user
 * requests keep waiting for their saves. Returns those, and the carriers that gained the subject.
 */
export async function fulfillRequests(tx: NodePgDatabase, requestId: string, resourceId: string) {
	const { rows } = await tx.execute<{
		id: string;
		requester: Requester['requester'];
		sourceId: string | null;
		parentResourceId: string | null;
		parentTextHash: string | null;
		userId: string | null;
		notebookId: string | null;
		storedObjectId: string | null;
	}>(sql`
		SELECT waiting.id::text, waiting.requester, waiting.source_id::text AS "sourceId",
		       waiting.parent_resource_id::text AS "parentResourceId", waiting.parent_text_hash AS "parentTextHash",
		       waiting.user_id AS "userId", waiting.notebook_id::text AS "notebookId", waiting.stored_object_id::text AS "storedObjectId"
		FROM resource_requests lead
		JOIN resource_requests waiting ON waiting.target_key = lead.target_key AND waiting.status = 'pending'
		WHERE lead.id = ${requestId}::uuid
		ORDER BY waiting.created_at
		FOR UPDATE OF waiting
	`);
	// The URL asked for finds this Resource next time, even when it redirected to another one.
	await tx.execute(sql`
		INSERT INTO resource_keys (resource_id, scheme, value, preferred)
		SELECT resource.id, 'url', substr(lead.target_key, 5), false
		FROM resource_requests lead JOIN resources resource ON resource.id = ${resourceId}::uuid AND resource.scope = 'corpus'
		WHERE lead.id = ${requestId}::uuid AND lead.target_key LIKE 'url:%'
		ON CONFLICT (scheme, value) DO NOTHING
	`);
	if (!rows.length) return { users: [] as UserRequest[], carriers: [] as string[] };
	const sourceId = rows.find(({ requester }) => requester === 'source')?.sourceId;
	if (sourceId)
		await tx.execute(sql`
			UPDATE resources SET source_id = ${sourceId}::uuid, updated_at = NOW() WHERE id = ${resourceId}::uuid AND source_id IS NULL
		`);
	const subjects = rows.filter(({ requester }) => requester === 'subject');
	const carriers = subjects.length
		? (
				await tx.execute<{ id: string }>(sql`
					UPDATE resources resource SET subject_resource_id = ${resourceId}::uuid, updated_at = NOW()
					FROM jsonb_to_recordset(${JSON.stringify(subjects.map(({ parentResourceId, parentTextHash }) => ({ id: parentResourceId, hash: parentTextHash })))}::jsonb)
					     AS parent(id uuid, hash text)
					WHERE resource.id = parent.id AND resource.text_hash = parent.hash
					  AND resource.scope = 'corpus' AND ${READABLE_ORIGINAL_SQL}
					  AND resource.id <> ${resourceId}::uuid
					RETURNING resource.id::text
				`)
			).rows.map(({ id }) => id)
		: [];
	await tx.execute(sql`
		UPDATE resource_requests SET
			resource_id = ${resourceId}::uuid, updated_at = NOW(),
			status = CASE WHEN requester = 'user' THEN 'pending'
			              WHEN requester = 'subject' AND NOT (parent_resource_id = ANY(${sql.param(carriers)}::uuid[])) THEN 'failed'
			              ELSE 'fulfilled' END,
			error = CASE WHEN requester = 'subject' AND NOT (parent_resource_id = ANY(${sql.param(carriers)}::uuid[]))
			             THEN 'Subject carrier was reacquired or is no longer eligible' END
		WHERE id = ANY(${sql.param(rows.map(({ id }) => id))}::uuid[])
	`);
	const users = rows.flatMap(({ id, requester, userId, notebookId, storedObjectId }) =>
		requester === 'user' && userId ? [{ id, userId, notebookId, storedObjectId }] : [],
	);
	return { users, carriers };
}

/** A user request whose save landed; its import now follows its Resource's translations. */
export async function completeUserRequests(db: NodePgDatabase, ids: readonly string[]) {
	if (!ids.length) return;
	await db.execute(sql`
		UPDATE resource_requests SET status = 'fulfilled', updated_at = NOW()
		WHERE id = ANY(${sql.param([...ids])}::uuid[]) AND status = 'pending'
	`);
}

/**
 * Fails the lead and every request waiting on its key, or only the lead when `alone`. A request whose Resource is
 * already written is fulfilled instead. A source request retries after a doubling wait; any other gives up.
 */
export async function failRequests(db: NodePgDatabase, requestId: string, error: string, alone = false) {
	await db.execute(sql`
		UPDATE resource_requests SET
			status = CASE WHEN resource_id IS NOT NULL AND requester <> 'resync' THEN 'fulfilled' ELSE 'failed' END,
			attempts = attempts + 1, error = LEFT(${error}, 500), updated_at = NOW(),
			retry_after = CASE WHEN requester = 'source' THEN NOW() + ${SOURCE_RETRY} * LEAST(power(2, attempts), 30) END
		WHERE status = 'pending'
		  AND (id = ${requestId}::uuid OR (${!alone} AND target_key = (SELECT target_key FROM resource_requests WHERE id = ${requestId}::uuid)))
	`);
}

/** Leads whose workflow has been quiet a while, touched so the next sweep checks others first. */
export async function claimStaleLeads(db: NodePgDatabase, limit: number) {
	const { rows } = await db.execute<RequestRow>(sql`
		UPDATE resource_requests SET updated_at = NOW()
		WHERE id IN (
			SELECT id FROM resource_requests
			WHERE status = 'pending' AND workflow_id IS NOT NULL AND updated_at < NOW() - ${STALE_REQUEST}
			ORDER BY updated_at LIMIT ${limit}
			FOR UPDATE SKIP LOCKED
		)
		RETURNING ${REQUEST_COLUMNS}
	`);
	return rows.map(toLead);
}

/** Requests still waiting after their lead settled without them, such as behind a superseded upload; one per key takes over. */
export async function promoteOrphanRequests(db: NodePgDatabase, limit: number) {
	const { rows } = await db.execute<RequestRow>(sql`
		SELECT DISTINCT ON (target_key) ${REQUEST_COLUMNS} FROM resource_requests waiting
		WHERE status = 'pending' AND workflow_id IS NULL AND resource_id IS NULL AND updated_at < NOW() - ${STALE_REQUEST}
		  AND NOT EXISTS (
			SELECT 1 FROM resource_requests lead
			WHERE lead.target_key = waiting.target_key AND lead.status = 'pending' AND lead.workflow_id IS NOT NULL
		  )
		ORDER BY target_key, created_at LIMIT ${limit}
	`);
	if (!rows.length) return [];
	return db.transaction(async (tx) => {
		await lockKeys(
			tx,
			rows.map(({ targetKey }) => targetKey),
		);
		const leads: RequestLead[] = [];
		for (const row of rows) {
			const lead = await claimLead(tx, row);
			if (lead) leads.push(toLead(lead));
		}
		return leads;
	});
}

/** User requests whose Resource was written by a workflow that never completed their saves. */
export async function unsavedUserRequests(db: NodePgDatabase, limit: number) {
	const { rows } = await db.execute<UserRequest & { resourceId: string }>(sql`
		SELECT id::text, user_id AS "userId", notebook_id::text AS "notebookId", stored_object_id::text AS "storedObjectId",
		       resource_id::text AS "resourceId"
		FROM resource_requests
		WHERE status = 'pending' AND requester = 'user' AND workflow_id IS NULL AND resource_id IS NOT NULL AND user_id IS NOT NULL
		  AND updated_at < NOW() - interval '30 minutes'
		ORDER BY updated_at LIMIT ${limit}
	`);
	return rows;
}

/** Each import's request as Web reads its progress, with the text its translation follows. */
export async function loadImportRequests(db: NodePgDatabase, ids: readonly string[]) {
	if (!ids.length) return [];
	const { rows } = await db.execute<{
		id: string;
		status: RequestRow['status'];
		resourceId: string | null;
		textHash: string | null;
	}>(sql`
		SELECT request.id::text, request.status, request.resource_id::text AS "resourceId", resource.text_hash AS "textHash"
		FROM resource_requests request
		LEFT JOIN resources resource ON resource.id = request.resource_id
		WHERE request.id = ANY(${sql.param([...ids])}::uuid[])
	`);
	return rows;
}
