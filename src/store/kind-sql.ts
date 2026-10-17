import { type SQL, sql } from 'drizzle-orm';
import { type ResourceKindRule, resourceKindsWhere } from '../contracts/resource-kinds';

/** `column IN (…)` over the kinds one `RESOURCE_KINDS` rule selects, written as literals so partial indexes still match. */
export function kindWhere(column: SQL, rule: ResourceKindRule, value = true): SQL {
	const kinds = resourceKindsWhere(rule, value);
	return kinds.length ? sql`${column} IN (${sql.raw(kinds.map((kind) => `'${kind}'`).join(', '))})` : sql`false`;
}

/** Whether a Resource has a readable original, over the `resource` and `original` aliases. An untitled kind needs no title. */
export const READABLE_ORIGINAL_SQL = sql`COALESCE((${kindWhere(sql`resource.kind`, 'titled', false)} OR BTRIM(resource.title) <> '')
	AND EXISTS (SELECT 1 FROM resource_content body WHERE body.resource_id = resource.id AND BTRIM(body.markdown) <> ''), false)`;
