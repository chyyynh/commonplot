import { parseFeed } from 'feedsmith';
import { decode } from 'html-entities';

const MAX_FEED_BYTES = 3 * 1024 * 1024;
const MAX_FEED_ITEMS = 30;
const FEED_SUMMARY_MAX_CHARS = 500;
const RSS_FETCH_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'mc_eid', 'mc_cid'];

type ParsedFeed = ReturnType<typeof parseFeed>;
type RawFeedItem = {
	id: string;
	link?: string;
	title?: string;
	summary?: string;
	published?: string;
	language?: string;
};

export type FeedEntry = {
	url: string;
	title: string | null;
	summary: string | null;
	publishedDate: Date | null;
	originalLang?: string;
};

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function decodedString(value: unknown): string | undefined {
	const text = optionalString(value);
	return text ? decode(text).trim() || undefined : undefined;
}

function feedItems(parsed: ParsedFeed): RawFeedItem[] {
	if (parsed.format === 'rss') {
		const language = optionalString(parsed.feed.language);
		return (parsed.feed.items ?? []).map((item) => {
			const itemLink = optionalString(item.link);
			const guid = optionalString(item.guid?.value);
			const link = item.guid?.isPermaLink !== false && guid?.match(/^https?:\/\//i) ? guid : itemLink;
			return {
				id: guid ?? link ?? '',
				link,
				title: decodedString(item.title),
				summary: optionalString(item.description),
				published: optionalString(item.pubDate) ?? optionalString(item.dc?.dates?.[0]),
				language,
			};
		});
	}
	if (parsed.format === 'atom') {
		return (parsed.feed.entries ?? []).map((entry) => {
			const links = entry.links ?? [];
			const link =
				optionalString(links.find((candidate) => !candidate.rel || candidate.rel === 'alternate')?.href) ?? optionalString(links[0]?.href);
			return {
				id: optionalString(entry.id) ?? link ?? '',
				link,
				title: decodedString(entry.title),
				summary: optionalString(entry.summary),
				published: optionalString(entry.published) ?? optionalString(entry.updated),
				language: optionalString(entry.dc?.languages?.[0]),
			};
		});
	}
	if (parsed.format === 'rdf') {
		const language = optionalString(parsed.feed.dc?.languages?.[0]);
		return (parsed.feed.items ?? []).map((item) => {
			const link = optionalString(item.link);
			return {
				id: optionalString(item.rdf?.about) ?? link ?? '',
				link,
				title: decodedString(item.title),
				summary: optionalString(item.description),
				published: optionalString(item.dc?.dates?.[0]),
				language,
			};
		});
	}
	const language = optionalString(parsed.feed.language);
	return (parsed.feed.items ?? []).map((item) => {
		const link = optionalString(item.url) ?? optionalString(item.external_url);
		return {
			id: optionalString(item.id) ?? link ?? '',
			link,
			title: decodedString(item.title),
			summary: optionalString(item.summary),
			published: optionalString(item.date_published) ?? optionalString(item.date_modified),
			language: optionalString(item.language) ?? language,
		};
	});
}

function feedEntryUrl(item: RawFeedItem, resolvePlatformUrl: (url: URL) => { canonicalUrl: string } | null): string | null {
	const idUrl = URL.parse(item.id);
	if (idUrl && (idUrl.protocol === 'http:' || idUrl.protocol === 'https:') && !idUrl.username && !idUrl.password) {
		const platform = resolvePlatformUrl(idUrl);
		if (platform) return platform.canonicalUrl;
	}

	const itemUrl = item.link ? URL.parse(item.link) : null;
	if (!itemUrl || (itemUrl.protocol !== 'http:' && itemUrl.protocol !== 'https:') || itemUrl.username || itemUrl.password) return null;
	const platform = resolvePlatformUrl(itemUrl);
	if (platform) return platform.canonicalUrl;

	itemUrl.hostname = itemUrl.hostname.toLowerCase().replace(/^www\./, '');
	for (const parameter of TRACKING_PARAMS) itemUrl.searchParams.delete(parameter);
	itemUrl.searchParams.sort();
	return itemUrl.toString();
}

function normalizedFeedEntries(items: RawFeedItem[], resolvePlatformUrl: (url: URL) => { canonicalUrl: string } | null): FeedEntry[] {
	const entries = new Map<string, FeedEntry>();
	for (const item of items) {
		const url = feedEntryUrl(item, resolvePlatformUrl);
		if (!url || entries.has(url)) continue;
		const date = item.published ? new Date(item.published) : null;
		const summary = item.summary
			? decode(item.summary.replace(/<[^>]*>/g, ' '))
					.replace(/\s+/g, ' ')
					.trim()
					.slice(0, FEED_SUMMARY_MAX_CHARS) || null
			: null;
		entries.set(url, {
			url,
			title: item.title ?? null,
			summary,
			publishedDate: date && !Number.isNaN(date.getTime()) ? date : null,
			originalLang: item.language,
		});
	}
	return [...entries.values()];
}

/** Fetches and normalizes one RSS, Atom, RDF, or JSON Feed document. */
export async function loadFeed(
	feedUrl: string,
	resolvePlatformUrl: (url: URL) => { canonicalUrl: string } | null,
): Promise<{
	effectiveUrl: URL;
	title: string | null;
	itemCount: number;
	entries: FeedEntry[];
}> {
	const requestedUrl = URL.parse(feedUrl);
	if (
		!requestedUrl ||
		(requestedUrl.protocol !== 'http:' && requestedUrl.protocol !== 'https:') ||
		requestedUrl.username ||
		requestedUrl.password
	) {
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
	const effectiveUrl = URL.parse(response.url);
	if (
		!effectiveUrl ||
		(effectiveUrl.protocol !== 'http:' && effectiveUrl.protocol !== 'https:') ||
		effectiveUrl.username ||
		effectiveUrl.password
	) {
		await response.body?.cancel();
		throw new Error('Feed redirected to an invalid URL.');
	}

	let parsed: ParsedFeed;
	try {
		let feedBytes = 0;
		const body = response.body?.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					feedBytes += chunk.byteLength;
					if (feedBytes > MAX_FEED_BYTES) throw new Error(`Feed exceeded ${MAX_FEED_BYTES} bytes`);
					controller.enqueue(chunk);
				},
			}),
		);
		parsed = parseFeed(await new Response(body).text(), {
			maxItems: MAX_FEED_ITEMS,
		});
	} catch {
		throw new Error('URL did not return a readable feed.');
	}
	effectiveUrl.hash = '';
	effectiveUrl.hostname = effectiveUrl.hostname.toLowerCase();
	if (effectiveUrl.pathname.length > 1 && effectiveUrl.pathname.endsWith('/')) {
		effectiveUrl.pathname = effectiveUrl.pathname.slice(0, -1);
	}

	const items = feedItems(parsed);
	const entries = normalizedFeedEntries(items, resolvePlatformUrl);
	return {
		effectiveUrl,
		title: decodedString(parsed.feed.title) ?? null,
		itemCount: items.length,
		entries,
	};
}
