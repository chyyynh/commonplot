import { type SQL, sql } from 'drizzle-orm';

type ResourceIdentitySqlFields = {
	kind: SQL;
	resourcePlatform: SQL;
};

export function resourceDisplaySourceSql(
	fields: ResourceIdentitySqlFields & {
		creatorName: SQL;
		monitoredSourceName: SQL;
	},
): SQL {
	return sql`COALESCE(
		NULLIF(BTRIM(${fields.monitoredSourceName}), ''),
		NULLIF(BTRIM(${fields.creatorName}), ''),
		CASE ${fields.resourcePlatform}
			WHEN 'twitter' THEN 'Twitter'
			WHEN 'youtube' THEN 'YouTube'
			WHEN 'hackernews' THEN 'Hacker News'
			WHEN 'lesswrong' THEN 'LessWrong'
		END,
		INITCAP(${fields.kind})
	)`;
}
