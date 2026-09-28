import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export type StoredReference = { ordinal: number; text: string };
export type ReferenceDoi = StoredReference & { doi: string };

/** A corpus paper's publisher DOI (not an arXiv DOI) and its bibliography entries that have no DOI or arXiv id yet. */
export async function loadUnresolvedReferences(db: NodePgDatabase, resourceId: string) {
	const result = await db.execute<{ doi: string | null; references: StoredReference[] }>(sql`
		SELECT (
			SELECT identifier.value FROM resource_identifiers identifier
			WHERE identifier.resource_id = resource.id AND identifier.scheme = 'doi' AND identifier.value NOT LIKE '10.48550/%'
			ORDER BY identifier.is_preferred DESC, identifier.value LIMIT 1
		) AS doi, COALESCE((
			SELECT jsonb_agg(jsonb_build_object('ordinal', reference.ordinal, 'text', reference.text) ORDER BY reference.ordinal)
			FROM resource_references reference
			WHERE reference.resource_id = resource.id AND reference.doi IS NULL AND reference.arxiv_id IS NULL
		), '[]'::jsonb) AS references
		FROM resources resource
		WHERE resource.id = ${resourceId}::uuid AND resource.scope = 'corpus' AND resource.kind = 'paper'
	`);
	return result.rows[0] ?? { doi: null, references: [] };
}

export async function persistReferenceDois(db: NodePgDatabase, resourceId: string, updates: readonly ReferenceDoi[]): Promise<number> {
	// A DOI belongs to this exact bibliography entry, independently of title, summary or body edits.
	const result = await db.execute(sql`
		WITH target AS (
			SELECT resource.id
			FROM resources resource
			WHERE resource.id = ${resourceId}::uuid AND resource.scope = 'corpus' AND resource.kind = 'paper'
			FOR UPDATE
		)
		UPDATE resource_references AS reference
		SET doi = incoming.doi
		FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS incoming(ordinal integer, text text, doi text)
		CROSS JOIN target
		WHERE reference.resource_id = target.id AND reference.ordinal = incoming.ordinal
		  AND reference.text = incoming.text
		  AND reference.doi IS NULL AND reference.arxiv_id IS NULL
	`);
	return result.rowCount ?? 0;
}
