import { addTransformations, extractFromHtml } from '@extractus/article-extractor';
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { fromHtml } from 'hast-util-from-html';
import { toMdast } from 'hast-util-to-mdast';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import { normalizedResourceImageUrl } from '../../shared/image-mapping';
import type { PlatformResourceUrl } from '../../shared/resource';
import { type AcquiredResource, type ResourceAcquisitionHints, resolveResourceHints } from '../../shared/resource';
import { limitByteStream } from '../../shared/response';
import { acquireFetchedPdfResponse, completeFetchedPdfAcquisition, type PaidPdfFallbackGrant, PDF_MIME } from './pdf';

const GENERIC_FETCH_TIMEOUT_MS = 8_000;
const GENERIC_HTML_MAX_BYTES = 5 * 1024 * 1024;
const GENERIC_WEB_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const MIN_ARTICLE_CONTENT_CHARS = 180;
const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'mc_eid', 'mc_cid'];

export function canonicalizeWebResourceUrl(url: URL): string {
	url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
	for (const parameter of TRACKING_PARAMS) url.searchParams.delete(parameter);
	url.searchParams.sort();
	return url.toString();
}

// Normalize narrow source-DOM quirks before Readability so the extracted HTML
// still contains the semantics carried into the Markdown syntax tree.
addTransformations({
	patterns: [/^https?:\/\//i],
	pre(document) {
		// Readability removes aria-hidden images. Preserve the narrow case where
		// the parent figure carries the image's accessible description instead.
		for (const figure of document.querySelectorAll('figure[role="img"][aria-label]')) {
			const label = figure.getAttribute('aria-label')?.trim();
			if (!label) continue;
			for (const image of figure.querySelectorAll('img[aria-hidden="true"]')) {
				if (!image.getAttribute('alt')?.trim()) image.setAttribute('alt', label);
				image.removeAttribute('aria-hidden');
			}
		}

		// Substack/Pencraft uses this article-body hierarchy on custom domains too,
		// so detect its source DOM instead of hard-coding substack.com hostnames.
		const substackArticle = document.querySelector('.dt-post-body .available-content .body.markup');
		if (substackArticle) {
			// @mozilla/readability's `unlikelyCandidates` rule contains "header", so
			// Substack's class would make it discard the otherwise semantic h2/h3.
			for (const heading of substackArticle.querySelectorAll('.header-anchor-post')) {
				// This child is Substack's copy-link UI, not article content.
				for (const anchorChrome of heading.querySelectorAll('.header-anchor-parent')) anchorChrome.remove();
				heading.classList.remove('header-anchor-post');
				if (!heading.getAttribute('class')?.trim()) heading.removeAttribute('class');
			}
			// Substack marks callouts with this data attribute. CommonMark has no
			// callout node, so normalize it to a blockquote instead of leaking platform data to Web.
			for (const callout of substackArticle.querySelectorAll('[data-callout="true"]')) {
				const blockquote = document.createElement('blockquote');
				while (callout.firstChild) blockquote.appendChild(callout.firstChild);
				callout.parentNode?.replaceChild(blockquote, callout);
			}
		}
		return document;
	},
});

// Static extractor configuration: TechCrunch places author cards and affiliate
// chrome beside the real post body inside the same Readability candidate. Its
// figcaptions are omitted because CommonMark would flatten them into body text;
// publisher-provided image alt text remains intact, but is not invented.
addTransformations({
	patterns: [/^https?:\/\/(?:www\.)?techcrunch\.com\//i],
	pre(document) {
		const article = document.querySelector('.entry-content.wp-block-post-content');
		if (article) document.body.replaceChildren(article.cloneNode(true));
		return document;
	},
	post(document) {
		for (const caption of document.querySelectorAll('figcaption')) caption.remove();
		return document;
	},
});

async function acquireHtmlArticle(html: string, url: string, hints: ResourceAcquisitionHints) {
	const article = await extractFromHtml(html, url, {
		contentLengthThreshold: MIN_ARTICLE_CONTENT_CHARS,
	});
	if (!article?.content?.trim()) throw new NonRetryableError('No readable article content found');
	const articleHtml = article.content.trim();
	const title = article.title?.trim();
	if (!title) throw new NonRetryableError('Extracted article has no title');
	const siteName = article.source?.trim();
	if (!siteName) throw new NonRetryableError('Extracted article has no source');
	const author = article.author?.trim();

	const content = toMarkdown(
		toMdast(fromHtml(articleHtml, { fragment: true }), {
			// HTML comments are invisible implementation metadata. The converter
			// preserves them as raw Markdown by default, so opt out at its AST boundary.
			nodeHandlers: { comment() {} },
		}),
		{
			extensions: [gfmToMarkdown()],
		},
	).trim();
	if (content.length < MIN_ARTICLE_CONTENT_CHARS) {
		throw new NonRetryableError(`Extracted HTML content is too short (${content.length} chars)`);
	}
	return {
		kind: 'blog',
		resourcePlatform: null,
		resourceIdentifiers: [],
		url,
		fileType: null,
		title,
		content,
		source: siteName,
		...resolveResourceHints(
			{ originalLang: null, publishedDate: article.published?.trim() || null, summary: sourceHtmlSummary(html) },
			hints,
		),
		creators: author ? [{ role: 'author', literal: author }] : [],
		kindMetadata: { siteName },
		previewImageUrl: normalizedResourceImageUrl(article.image, url),
		subject: null,
	} satisfies AcquiredResource;
}

// The extractor's description may be a generated body excerpt. Only publisher
// metadata counts as a source summary; otherwise feed hints or analysis supply it.
function sourceHtmlSummary(html: string): string | null {
	const nodes = [...fromHtml(html).children];
	let metaSummary: string | null = null;
	let schemaSummary: string | null = null;
	function schemaDescription(value: unknown): string | null {
		if (Array.isArray(value)) return value.map(schemaDescription).find(Boolean) ?? null;
		if (!value || typeof value !== 'object') return null;
		const entry = value as Record<string, unknown>;
		const types = Array.isArray(entry['@type']) ? entry['@type'] : [entry['@type']];
		if (types.some((type) => typeof type === 'string' && /(?:Article|BlogPosting|Report|Review|WebPage)$/.test(type))) {
			if (typeof entry.description === 'string' && entry.description.trim()) return entry.description.trim();
		}
		return schemaDescription(entry['@graph']);
	}
	for (const node of nodes) {
		if (node.type !== 'element') continue;
		nodes.push(...node.children);
		if (node.tagName === 'meta') {
			const names = [node.properties.name, node.properties.property, node.properties.itemProp];
			if (
				names.some(
					(name) => typeof name === 'string' && /^(?:description|og:description|twitter:description|parsely-description)$/i.test(name),
				)
			) {
				const content = node.properties.content;
				if (typeof content === 'string' && content.trim()) metaSummary ??= content.trim();
			}
		}
		if (node.tagName === 'script' && node.properties.type === 'application/ld+json') {
			try {
				const text = node.children.map((child) => (child.type === 'text' ? child.value : '')).join('');
				schemaSummary ??= schemaDescription(JSON.parse(text));
			} catch {
				// Malformed optional metadata does not make the article unreadable.
			}
		}
	}
	return schemaSummary ?? metaSummary;
}

type WebAcquisition = Awaited<ReturnType<typeof acquireWebResource>>;

async function acquireWebResource(
	env: CoreEnv,
	url: string,
	hints: ResourceAcquisitionHints,
	platformUrl: (url: URL) => PlatformResourceUrl | null,
) {
	const response = await fetch(url, {
		headers: {
			'User-Agent': GENERIC_WEB_USER_AGENT,
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.5',
			'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
		},
		signal: AbortSignal.timeout(GENERIC_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		await response.body?.cancel();
		if (response.status === 404 || response.status === 410) {
			throw new NonRetryableError(`Fetched resource returned HTTP ${response.status}`);
		}
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}
	const parsedFinalUrl = URL.parse(response.url);
	if (
		!parsedFinalUrl ||
		(parsedFinalUrl.protocol !== 'http:' && parsedFinalUrl.protocol !== 'https:') ||
		parsedFinalUrl.username ||
		parsedFinalUrl.password
	) {
		await response.body?.cancel();
		throw new Error('Fetch response has no valid final URL');
	}
	const platform = platformUrl(parsedFinalUrl);
	if (platform) {
		await response.body?.cancel();
		return { platform };
	}
	const finalUrl = canonicalizeWebResourceUrl(parsedFinalUrl);

	const contentType = response.headers.get('content-type')?.toLowerCase() || '';
	if (contentType.includes(PDF_MIME) || parsedFinalUrl.pathname.toLowerCase().endsWith('.pdf')) {
		return acquireFetchedPdfResponse(env, response, finalUrl, hints);
	}
	if (
		contentType &&
		!contentType.includes('text/html') &&
		!contentType.includes('text/xml') &&
		!contentType.includes('application/xhtml') &&
		!contentType.includes('application/xml')
	) {
		await response.body?.cancel();
		throw new NonRetryableError(`Unsupported response content type: ${contentType}`);
	}

	const body =
		response.body &&
		limitByteStream(
			response.body,
			GENERIC_HTML_MAX_BYTES,
			() => new NonRetryableError(`HTML response exceeded ${GENERIC_HTML_MAX_BYTES} bytes`),
		);
	const html = await new Response(body).text();
	return acquireHtmlArticle(html, finalUrl, hints);
}

export async function stageWebAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: { hints: ResourceAcquisitionHints; paidPdfFallback: PaidPdfFallbackGrant | null; processingId: string; url: string },
	platformUrl: (url: URL) => PlatformResourceUrl | null,
) {
	const result = await step.do(
		'acquire-web-v8',
		{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
		async () => {
			const acquired = await acquireWebResource(env, input.url, input.hints, platformUrl);
			return 'platform' in acquired ? acquired : Response.json(acquired).body!;
		},
	);
	if ('platform' in result) return result;
	const acquired = await new Response(result).json<Exclude<WebAcquisition, { platform: PlatformResourceUrl }>>();
	return 'parse' in acquired
		? completeFetchedPdfAcquisition(env, step, {
				acquisition: acquired,
				grant: input.paidPdfFallback,
				processingId: input.processingId,
				sourceUrl: acquired.resource.url ?? input.url,
			})
		: acquired;
}
