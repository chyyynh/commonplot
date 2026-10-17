import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** What a feed last answered with, sent back so an unchanged feed answers 304. */
export type FeedValidators = { etag: string | null; lastModified: string | null };
export type MonitoredFeedSource = { id: string; name: string; handle: string } & FeedValidators;
export type TwitterSource = { id: string; handle: string; scrapedAt: string | null; createdAt: string };

/**
 * Every feed source uses the same parser. A YouTube channel handle is an Atom feed URL polled at a slower cadence;
 * its entries still resolve to resource_platform='youtube' at acquisition.
 */
export async function listDueFeedSources(db: NodePgDatabase) {
	const { rows } = await db.execute<MonitoredFeedSource>(sql`
		SELECT id::text AS id, name, handle, etag, last_modified AS "lastModified"
		FROM sources
		WHERE enabled = true
		  AND monitor_kind = 'feed'
		  AND (handle NOT LIKE 'https://www.youtube.com/feeds/videos.xml?channel_id=%'
		    OR scraped_at IS NULL
		    OR scraped_at < NOW() - INTERVAL '30 minutes')
	`);
	return rows;
}

export async function listTwitterSources(db: NodePgDatabase) {
	const { rows } = await db.execute<TwitterSource>(sql`
		SELECT id::text AS id, handle, scraped_at AS "scrapedAt", created_at AS "createdAt"
		FROM sources
		WHERE enabled = true AND monitor_kind = 'twitter'
	`);
	return rows;
}

/** Move a source's watermark forward only; returns whether it moved. A feed read in full also records its new `validators`. */
export async function advanceSourceWatermark(
	db: NodePgDatabase,
	sourceId: string,
	scrapedAt: Date,
	validators?: FeedValidators,
): Promise<boolean> {
	const { rows } = await db.execute(sql`
		UPDATE sources
		SET scraped_at = ${scrapedAt}, updated_at = NOW()
		    ${validators ? sql`, etag = ${validators.etag}, last_modified = ${validators.lastModified}` : sql``}
		WHERE id = ${sourceId}::uuid
		  AND (scraped_at IS NULL OR scraped_at <= ${scrapedAt})
		RETURNING id
	`);
	return rows.length > 0;
}
