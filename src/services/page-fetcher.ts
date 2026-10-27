import { DurableObject } from 'cloudflare:workers';
import { coreExports } from '../exports.ts';

/**
 * Some sites answer 429 to whole Cloudflare egress machines, which many Workers share, rather than to us. A fresh
 * Durable Object lands on another machine, so a page refused that way is asked for again from a few of them, one
 * after another; any other answer is final.
 */
const FETCHER_HINTS: readonly DurableObjectLocationHint[] = ['wnam', 'enam', 'weur', 'apac'];

type PageRequest = { headers: Record<string, string>; timeoutMs: number };
type FetchedPage = { status: number; url: string; headers: Record<string, string>; body: ReadableStream<Uint8Array> | null };

async function fetchPageHere(url: string, { headers, timeoutMs }: PageRequest): Promise<FetchedPage> {
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
	return { status: response.status, url: response.url, headers: Object.fromEntries(response.headers), body: response.body };
}

/** Stateless: each instance exists only to fetch from another egress machine. */
export class PageFetcher extends DurableObject<CoreEnv> {
	attempt(url: string, request: PageRequest): Promise<FetchedPage> {
		return fetchPageHere(url, request);
	}
}

/** A page as fetched, with the URL it ended at after redirects. */
export async function fetchPage(url: string, request: PageRequest): Promise<{ response: Response; url: string }> {
	let page = await fetchPageHere(url, request);
	for (const locationHint of FETCHER_HINTS) {
		if (page.status !== 429) break;
		await page.body?.cancel();
		page = await coreExports.PageFetcher.get(coreExports.PageFetcher.newUniqueId(), { locationHint }).attempt(url, request);
	}
	return { response: new Response(page.body, { status: page.status, headers: page.headers }), url: page.url };
}
