import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { EntityKeyScheme } from '../contracts/resource-kinds';

/** An entity made from an account, waiting to be matched against the others. */
export type UnmatchedAccount = Readonly<{
	id: string;
	name: string;
	scheme: EntityKeyScheme;
	value: string;
	handle: string | null;
	/** Titles of the account's latest Resources. */
	titles: string[];
}>;

/** Takes the oldest unmatched entities of accounts, marking them matched so the next sweep skips them. */
export async function claimUnmatchedAccounts(db: NodePgDatabase, limit: number): Promise<UnmatchedAccount[]> {
	const { rows } = await db.execute<UnmatchedAccount>(sql`
		WITH claimed AS (
			UPDATE entities SET matched_at = NOW()
			WHERE id IN (
				SELECT id FROM entities WHERE matched_at IS NULL AND merged_into IS NULL
				ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
			)
			RETURNING id, name
		)
		SELECT claimed.id::text, claimed.name, account.scheme, account.value, account.profile ->> 'handle' AS handle,
		       array_remove(ARRAY(
		         SELECT COALESCE(r.title, left(body.markdown, 120))
		         FROM resource_creators creator
		         JOIN resources r ON r.id = creator.resource_id
		         LEFT JOIN resource_content body ON body.resource_id = r.id
		         WHERE creator.account_scheme = account.scheme AND creator.account_value = account.value
		         ORDER BY r.published_date DESC NULLS LAST LIMIT 3
		       ), NULL) AS titles
		FROM claimed
		JOIN LATERAL (SELECT * FROM entity_keys k WHERE k.entity_id = claimed.id ORDER BY k.scheme LIMIT 1) account ON true
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

const judge = (id: string, others: readonly string[], same: boolean) => sql`
	INSERT INTO entity_judgements (entity_id, other_id, same, by)
	SELECT LEAST(${id}::uuid, other), GREATEST(${id}::uuid, other), ${same}, 'jev'
	FROM unnest(${sql.param([...others])}::uuid[]) AS other
	ON CONFLICT (entity_id, other_id) DO UPDATE SET same = EXCLUDED.same, by = EXCLUDED.by, created_at = NOW()
`;

/** Records that an entity is none of these. */
export async function recordDistinct(db: NodePgDatabase, id: string, others: readonly string[]) {
	if (others.length) await db.execute(judge(id, others, false));
}

/**
 * Merges `loserId` into `winnerId`: its links (keeping the higher weight), accounts, names and followers move to the
 * winner, and it stays as a redirect, as does every entity merged into it before.
 */
export async function mergeEntities(db: NodePgDatabase, loserId: string, winnerId: string) {
	const loser = sql`${loserId}::uuid`;
	const winner = sql`${winnerId}::uuid`;
	await db.transaction(async (tx) => {
		await tx.execute(judge(loserId, [winnerId], true));
		await tx.execute(sql`
			INSERT INTO resource_entities AS link (resource_id, entity_id, weight)
			SELECT resource_id, ${winner}, weight FROM resource_entities WHERE entity_id = ${loser}
			ON CONFLICT (resource_id, entity_id) DO UPDATE SET weight = GREATEST(link.weight, EXCLUDED.weight)
		`);
		await tx.execute(sql`DELETE FROM resource_entities WHERE entity_id = ${loser}`);
		await tx.execute(sql`UPDATE entity_keys SET entity_id = ${winner} WHERE entity_id = ${loser}`);
		await tx.execute(sql`
			INSERT INTO entity_names AS known (key, entity_id, name, uses)
			SELECT key, ${winner}, name, uses FROM entity_names WHERE entity_id = ${loser}
			ON CONFLICT (key, entity_id) DO UPDATE SET uses = known.uses + EXCLUDED.uses
		`);
		await tx.execute(sql`DELETE FROM entity_names WHERE entity_id = ${loser}`);
		// A follower of both keeps following the winner; the loser's follow ends.
		await tx.execute(sql`
			UPDATE user_topics topic SET entity_id = ${winner}
			WHERE topic.entity_id = ${loser} AND (topic.removed_at IS NOT NULL OR NOT EXISTS (
				SELECT 1 FROM user_topics kept WHERE kept.user_id = topic.user_id AND kept.entity_id = ${winner} AND kept.removed_at IS NULL
			))
		`);
		await tx.execute(sql`UPDATE user_topics SET removed_at = NOW() WHERE entity_id = ${loser} AND removed_at IS NULL`);
		await tx.execute(sql`UPDATE entities SET merged_into = ${winner} WHERE id = ${loser} OR merged_into = ${loser}`);
	});
}
