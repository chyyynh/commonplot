import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { EntityKeyScheme, EntityType } from '../contracts/resource-kinds';

/** An entity waiting to be matched against the others: one an account became, or one Resources name. */
export type UnmatchedEntity = Readonly<{
	id: string;
	name: string;
	type: EntityType;
	/** The account it is, if it is one. */
	scheme: EntityKeyScheme | null;
	value: string | null;
	handle: string | null;
	/** Its most used names. */
	names: string[];
	/** How many Resources name it. */
	uses: number;
	/** Titles of the account's latest Resources, or of the Resources most about the entity. */
	titles: string[];
}>;

/** Takes the most named unmatched entities, marking them matched so the next sweep skips them. */
export async function claimUnmatchedEntities(db: NodePgDatabase, limit: number): Promise<UnmatchedEntity[]> {
	const { rows } = await db.execute<UnmatchedEntity>(sql`
		WITH claimed AS (
			UPDATE entities SET matched_at = NOW()
			WHERE id IN (
				SELECT id FROM entities e WHERE matched_at IS NULL
				ORDER BY (SELECT count(*) FROM resource_entities used WHERE used.entity_id = e.id) DESC, created_at
				LIMIT ${limit} FOR UPDATE SKIP LOCKED
			)
			RETURNING id, name, type
		)
		SELECT claimed.id::text, claimed.name, claimed.type, account.scheme, account.value, account.profile ->> 'handle' AS handle,
		       ARRAY(SELECT known.name FROM entity_names known WHERE known.entity_id = claimed.id ORDER BY known.uses DESC LIMIT 5) AS names,
		       (SELECT count(*)::int FROM resource_entities used WHERE used.entity_id = claimed.id) AS uses,
		       CASE WHEN account.scheme IS NULL THEN ARRAY(
		         SELECT r.title FROM resource_entities used JOIN resources r ON r.id = used.resource_id
		         WHERE used.entity_id = claimed.id AND r.title IS NOT NULL
		         ORDER BY used.weight DESC LIMIT 3
		       ) ELSE array_remove(ARRAY(
		         SELECT COALESCE(r.title, left(body.markdown, 120))
		         FROM resource_creators creator
		         JOIN resources r ON r.id = creator.resource_id
		         LEFT JOIN resource_content body ON body.resource_id = r.id
		         WHERE creator.account_scheme = account.scheme AND creator.account_value = account.value
		         ORDER BY r.published_date DESC NULLS LAST LIMIT 3
		       ), NULL) END AS titles
		FROM claimed
		LEFT JOIN LATERAL (SELECT * FROM entity_keys k WHERE k.entity_id = claimed.id ORDER BY k.scheme LIMIT 1) account ON true
	`);
	return rows;
}

/** A product line: a product named at least this often whose name another product's name starts with. */
const PRODUCT_LINE_MIN_USES = 5;

/** Products this product's name starts with, as Claude Opus 4.5 starts with Claude, the shortest first. */
export async function listProductLines(db: NodePgDatabase, id: string, name: string) {
	const { rows } = await db.execute<{ id: string; key: string; name: string }>(sql`
		SELECT line.id::text, line.key, line.name FROM entities line
		WHERE line.type = 'product' AND line.id <> ${id}::uuid
			AND (starts_with(lower(${name}), lower(line.name) || ' ') OR starts_with(lower(${name}), lower(line.name) || '-'))
			AND NOT EXISTS (SELECT 1 FROM entity_keys k WHERE k.entity_id = line.id)
			AND (SELECT count(*) FROM resource_entities used WHERE used.entity_id = line.id) >= ${PRODUCT_LINE_MIN_USES}
		ORDER BY length(line.name) LIMIT 3
	`);
	return rows;
}

/** Puts an entity back for the next sweep, after matching it failed. */
export async function releaseEntity(db: NodePgDatabase, id: string) {
	await db.execute(sql`UPDATE entities SET matched_at = NULL WHERE id = ${id}::uuid`);
}

/** Entities already judged the same as or different from this one. */
export async function listJudgedEntities(db: NodePgDatabase, id: string) {
	const { rows } = await db.execute<{ id: string }>(sql`
		SELECT CASE WHEN entity_id = ${id}::uuid THEN other_id ELSE entity_id END::text AS id
		FROM entity_judgements WHERE entity_id = ${id}::uuid OR other_id = ${id}::uuid
	`);
	return new Set(rows.map((row) => row.id));
}

/** Records that an entity is none of these. */
export async function recordDistinct(db: NodePgDatabase, id: string, others: readonly string[]) {
	if (!others.length) return;
	await db.execute(sql`
		INSERT INTO entity_judgements (entity_id, other_id, same, by)
		SELECT LEAST(${id}::uuid, other), GREATEST(${id}::uuid, other), false, 'jev'
		FROM unnest(${sql.param([...others])}::uuid[]) AS other
		ON CONFLICT (entity_id, other_id) DO UPDATE SET same = false, by = 'jev', created_at = NOW()
	`);
}

/**
 * Merges `loserId` into `winnerId`: its links (keeping the higher weight), accounts, names and followers move to the
 * winner, and it is deleted with what stayed on it. False when either is gone, merged by another sweep meanwhile.
 */
export async function mergeEntities(db: NodePgDatabase, loserId: string, winnerId: string) {
	const loser = sql`${loserId}::uuid`;
	const winner = sql`${winnerId}::uuid`;
	return db.transaction(async (tx) => {
		const { rows } = await tx.execute(sql`SELECT id FROM entities WHERE id IN (${loser}, ${winner}) ORDER BY id FOR UPDATE`);
		if (rows.length < 2) return false;
		await tx.execute(sql`
			INSERT INTO resource_entities AS link (resource_id, entity_id, weight)
			SELECT resource_id, ${winner}, weight FROM resource_entities WHERE entity_id = ${loser}
			ON CONFLICT (resource_id, entity_id) DO UPDATE SET weight = GREATEST(link.weight, EXCLUDED.weight)
		`);
		await tx.execute(sql`UPDATE entity_keys SET entity_id = ${winner} WHERE entity_id = ${loser}`);
		await tx.execute(sql`
			INSERT INTO entity_names AS known (key, entity_id, name, uses)
			SELECT key, ${winner}, name, uses FROM entity_names WHERE entity_id = ${loser}
			ON CONFLICT (key, entity_id) DO UPDATE SET uses = known.uses + EXCLUDED.uses
		`);
		// A follower of both keeps following the winner.
		await tx.execute(sql`
			UPDATE user_topics topic SET entity_id = ${winner}
			WHERE topic.entity_id = ${loser} AND (topic.removed_at IS NOT NULL OR NOT EXISTS (
				SELECT 1 FROM user_topics kept WHERE kept.user_id = topic.user_id AND kept.entity_id = ${winner} AND kept.removed_at IS NULL
			))
		`);
		await tx.execute(sql`DELETE FROM entities WHERE id = ${loser}`);
		return true;
	});
}
