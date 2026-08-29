import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { ResourceReference } from './bibliography';

export async function replaceResourceReferences(
	db: NodePgDatabase,
	resourceId: string,
	references: readonly ResourceReference[],
): Promise<void> {
	await db.execute(sql`DELETE FROM resource_references WHERE resource_id = ${resourceId}::uuid`);
	if (!references.length) return;
	const values = sql.join(
		references.map(
			(reference) =>
				sql`(${resourceId}::uuid, ${reference.ordinal}, ${reference.marker}, ${reference.text}, ${reference.doi}, ${reference.arxivId}, ${reference.url})`,
		),
		sql`, `,
	);
	await db.execute(sql`
		INSERT INTO resource_references (resource_id, ordinal, marker, text, doi, arxiv_id, url)
		VALUES ${values}
	`);
}
