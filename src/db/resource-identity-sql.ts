import { RESOURCE_KIND_DISPLAY_LABELS, RESOURCE_PLATFORM_DISPLAY_LABELS } from '@core-shared/resource-types';
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
			WHEN 'twitter' THEN ${RESOURCE_PLATFORM_DISPLAY_LABELS.twitter}
			WHEN 'youtube' THEN ${RESOURCE_PLATFORM_DISPLAY_LABELS.youtube}
			WHEN 'hackernews' THEN ${RESOURCE_PLATFORM_DISPLAY_LABELS.hackernews}
			WHEN 'lesswrong' THEN ${RESOURCE_PLATFORM_DISPLAY_LABELS.lesswrong}
		END,
		CASE ${fields.kind}
			WHEN 'blog' THEN ${RESOURCE_KIND_DISPLAY_LABELS.blog}
			WHEN 'forum' THEN ${RESOURCE_KIND_DISPLAY_LABELS.forum}
			WHEN 'post' THEN ${RESOURCE_KIND_DISPLAY_LABELS.post}
			WHEN 'video' THEN ${RESOURCE_KIND_DISPLAY_LABELS.video}
			WHEN 'paper' THEN ${RESOURCE_KIND_DISPLAY_LABELS.paper}
			WHEN 'image' THEN ${RESOURCE_KIND_DISPLAY_LABELS.image}
			WHEN 'file' THEN ${RESOURCE_KIND_DISPLAY_LABELS.file}
		END
	)`;
}
