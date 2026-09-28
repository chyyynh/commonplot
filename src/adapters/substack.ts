import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';
import { readBoundedResponseText } from '../services/response';

const SUBSTACK_FETCH_TIMEOUT_MS = 8_000;
const MAX_SUBSTACK_RESPONSE_BYTES = 8 * 1024 * 1024;

const SubstackPostSchema = z.object({
	slug: z.string(),
	title: z.string(),
	subtitle: z.string().nullish(),
	post_date: z.string().nullish(),
	// `everyone` is the only audience whose body the public page carries in full.
	audience: z.string(),
	publishedBylines: z.array(z.object({ name: z.string().nullish() })).nullish(),
});

export type SubstackPost = {
	title: string;
	subtitle: string | null;
	publishedDate: string | null;
	authors: string[];
};

const PreloadsSchema = z.object({ post: z.unknown().optional() });

function toSubstackPost(input: unknown, slug: string): SubstackPost {
	const post = SubstackPostSchema.parse(input);
	if (post.audience !== 'everyone') throw new NonRetryableError(`Substack post ${slug} is limited to ${post.audience} readers`);
	return {
		title: post.title.trim(),
		subtitle: post.subtitle?.trim() || null,
		publishedDate: post.post_date?.trim() || null,
		authors: (post.publishedBylines ?? []).flatMap(({ name }) => (name?.trim() ? [name.trim()] : [])),
	};
}

/** The post page embeds the same post record as the API in `window._preloads`. */
function preloadedPost(html: string, slug: string): unknown {
	const literal = html.match(/window\._preloads\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\)/)?.[1];
	if (!literal) return null;
	const { post } = PreloadsSchema.parse(JSON.parse(JSON.parse(literal)));
	return z.object({ slug: z.literal(slug) }).safeParse(post).success ? post : null;
}

/**
 * Substack serves every publication, custom domains included, with the same post page and API.
 * The page's preloaded record is read first: the API rate-limits Cloudflare egress with HTTP 429.
 * Paid and subscriber-only posts expose only a preview, so they are not acquired.
 */
export async function fetchSubstackPost(html: string, url: string): Promise<SubstackPost> {
	const { origin, pathname } = new URL(url);
	const slug = pathname.match(/^\/p\/([^/]+)\/?$/)?.[1];
	if (!slug) throw new NonRetryableError(`Substack page ${url} is not a post`);
	const preloaded = preloadedPost(html, slug);
	if (preloaded) return toSubstackPost(preloaded, slug);
	const response = await fetch(`${origin}/api/v1/posts/${slug}`, {
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(SUBSTACK_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		await response.body?.cancel();
		if (response.status === 404) throw new NonRetryableError(`Substack post ${slug} was not found`);
		throw new Error(`Substack post API failed with HTTP ${response.status}`);
	}
	return toSubstackPost(JSON.parse(await readBoundedResponseText(response, MAX_SUBSTACK_RESPONSE_BYTES, 'Substack post')), slug);
}
