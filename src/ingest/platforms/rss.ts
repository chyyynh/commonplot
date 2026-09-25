import { extractFromJson, extractFromXml } from '@extractus/feed-extractor';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DOMParser } from 'linkedom';
import { readBoundedResponseText } from '../../shared/response';
import { enqueueSourceDrafts } from '../admission';
import { resolveResourceUrl, ResourceUrlSchema } from './resource-url';

const MAX_FEED_BYTES = 3 * 1024 * 1024;
const MAX_FEED_ITEMS = 30;
const FEED_SUMMARY_MAX_CHARS = 500;
const RSS_FETCH_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const FEED_CONCURRENCY = 4;

type MonitoredFeedSource = {
	id: string;
	name: string;
	handle: string;
};

async function processFeed(env: CoreEnv, db: NodePgDatabase, feed: MonitoredFeedSource): Promise<void> {
	const requestedUrl = ResourceUrlSchema.safeParse(feed.handle).data;
	if (!requestedUrl) {
		throw new Error('Enter a valid feed URL (http/https).');
	}
	const response = await fetch(requestedUrl, {
		headers: {
			'User-Agent': RSS_FETCH_USER_AGENT,
			Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml, */*',
		},
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		const status = response.status;
		await response.body?.cancel();
		throw new Error(`Feed fetch failed with HTTP ${status}.`);
	}
	const effectiveUrl = ResourceUrlSchema.safeParse(response.url).data;
	if (!effectiveUrl) {
		await response.body?.cancel();
		throw new Error('Feed redirected to an invalid URL.');
	}

	const content = await readBoundedResponseText(response, MAX_FEED_BYTES, 'Feed');
	const parserOptions = {
		baseUrl: effectiveUrl,
		getExtraEntryFields: (entry: Record<string, unknown>) => ({ description: feedEntryDescription(entry) }),
	};
	const parsed =
		response.headers.get('content-type')?.toLowerCase().includes('json') || content.trimStart().startsWith('{')
			? extractFromJson(content, parserOptions)
			: extractFromXml(content, parserOptions);
	const items = (parsed.entries ?? []).slice(0, MAX_FEED_ITEMS);
	const drafts = items.flatMap((item) => {
		const link = resolveResourceUrl(item.link);
		// Check the source link before canonical identity erases the Shorts path.
		if (link?.resourcePlatform === 'youtube' && new URL(link.url).pathname.startsWith('/shorts/')) return [];
		const id = resolveResourceUrl(item.id);
		const url = id?.resourcePlatform ? id : link;
		if (!url) return [];
		return [
			{
				url: url.url,
				sourceHints: {
					// Platform adapters own their text; a feed description only fills in for a generic page.
					summary: (!url.resourcePlatform && item.description) || undefined,
					publishedDate: item.published || undefined,
					originalLang: parsed.language?.trim() || undefined,
				},
			},
		];
	});
	const admission = await enqueueSourceDrafts(env, db, feed.id, drafts);
	console.info({
		tag: 'RSS',
		msg: 'Feed processed',
		feed: feed.name,
		...admission,
		skipped: items.length - drafts.length + admission.skipped,
		totalCount: items.length,
	});
	const scrapedAt = new Date();
	await db.execute(sql`
		UPDATE sources
		SET scraped_at = ${scrapedAt}, updated_at = NOW()
		WHERE id = ${feed.id}::uuid
		  AND (scraped_at IS NULL OR scraped_at <= ${scrapedAt})
	`);
}

const FEED_BLOCK_TAG_RE =
	/<\/?(?:address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|ol|p|pre|section|table|td|th|tr|ul)\b[^>]*>/gi;

function feedFieldText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object') {
		const node = value as Record<string, unknown>;
		const text = node._text ?? node['#text'] ?? node._cdata ?? node.$t;
		if (typeof text === 'string') return text;
	}
	return '';
}

/**
 * The extractor strips tags without a separator, gluing adjacent blocks
 * ("Thomas KwaConstellation"). Break at block boundaries before taking text.
 */
function feedEntryDescription(entry: Record<string, unknown>): string {
	const html = [entry.description, entry.summary, entry['content:encoded'], entry.content, entry.content_text, entry.content_html]
		.map(feedFieldText)
		.find((value) => value.trim());
	if (!html) return '';
	const document = new DOMParser().parseFromString(`<html><body>${html.replace(FEED_BLOCK_TAG_RE, ' $&')}</body></html>`, 'text/html');
	for (const node of document.querySelectorAll('script, style')) node.remove();
	const text = (document.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
	if (text.length <= FEED_SUMMARY_MAX_CHARS) return text;
	const cut = text.slice(0, FEED_SUMMARY_MAX_CHARS);
	const wordEnd = cut.lastIndexOf(' ');
	return `${(wordEnd > FEED_SUMMARY_MAX_CHARS * 0.8 ? cut.slice(0, wordEnd) : cut).trimEnd()}…`;
}

export async function handleRSSCron(env: CoreEnv, db: NodePgDatabase): Promise<void> {
	console.info({ tag: 'RSS', msg: 'start' });
	// Every feed source uses the same parser. A YouTube channel handle is an Atom
	// feed URL, so there is nothing for a separate monitor to do.
	// Its entries still resolve to resource_platform='youtube' at acquisition.
	const { rows: feeds } = await db.execute<MonitoredFeedSource>(sql`
		SELECT id::text AS id, name, handle
		FROM sources
		WHERE enabled = true
		  AND monitor_kind = 'feed'
		  AND (handle NOT LIKE 'https://www.youtube.com/feeds/videos.xml?channel_id=%'
		    OR scraped_at IS NULL
		    OR scraped_at < NOW() - INTERVAL '30 minutes')
	`);
	const failures: unknown[] = [];
	for (let index = 0; index < feeds.length; index += FEED_CONCURRENCY) {
		const batch = feeds.slice(index, index + FEED_CONCURRENCY);
		const results = await Promise.allSettled(batch.map((feed) => processFeed(env, db, feed)));
		for (const [resultIndex, result] of results.entries()) {
			if (result.status === 'fulfilled') continue;
			const failedFeed = batch[resultIndex];
			failures.push(result.reason);
			console.error({
				tag: 'RSS',
				msg: 'Feed processing failed',
				feed: failedFeed.name,
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
	}

	console.info({ tag: 'RSS', msg: 'end', sources: feeds.length, failed_sources: failures.length });
	if (failures.length) throw new AggregateError(failures, `${failures.length} feed monitor operations failed`);
}
