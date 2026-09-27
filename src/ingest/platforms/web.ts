import { Readability } from '@mozilla/readability';
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { fromHtml } from 'hast-util-from-html';
import { toHtml } from 'hast-util-to-html';
import { defaultHandlers, toMdast } from 'hast-util-to-mdast';
import { DOMParser } from 'linkedom';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import stripIndent from 'strip-indent';
import { normalizedResourceImageUrl } from '../../shared/image-mapping';
import { limitByteStream } from '../../shared/response';
import type { AcquiredResource } from '../acquisition';
import { rehostInlineImages } from '../image-rehosting';
import { storePublicPdfResponse } from '../zotero-sdt-service.ts';
import { stagePublicPdfAcquisition } from './pdf';
import { PDF_MIME, type PaidPdfFallbackGrant } from './pdf-policy';
import { resolveResourceUrl, type ResolvedResourceUrl } from './resource-url';
import { fetchSubstackPost, type SubstackPost } from './substack';

const GENERIC_FETCH_TIMEOUT_MS = 8_000;
const GENERIC_HTML_MAX_BYTES = 5 * 1024 * 1024;
const GENERIC_WEB_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const MIN_ARTICLE_CONTENT_CHARS = 180;
async function acquireHtmlArticle(html: string, url: string): Promise<AcquiredResource & { kind: 'blog'; resourcePlatform: null }> {
	// linkedom does not imply the <head>/<body> that HTML lets pages omit, and Readability
	// needs <body>. Serialize the spec parser's tree so linkedom reads the implied structure.
	const document = new DOMParser().parseFromString(toHtml(fromHtml(html)), 'text/html');
	const summary = sourceHtmlSummary(document);
	// Linkedom resolves baseURI from <base>; Readability uses it for relative links and images.
	const base = document.createElement('base', {});
	base.setAttribute('href', url);
	document.head.prepend(base);
	const image = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.getAttribute('content');
	// Normalize explicit code-language metadata before Readability/conversion.
	// SyntaxHighlighter's brush syntax is also used outside WordPress.
	for (const pre of document.querySelectorAll('pre')) {
		const code = pre.querySelector('code');
		const classes = `${code?.getAttribute('class') ?? ''} ${pre.getAttribute('class') ?? ''}`;
		const language =
			classes.match(/(?:language-|lang-|brush:\s*)([\w+-]+)/i)?.[1] ??
			code?.getAttribute('data-language') ??
			pre.getAttribute('data-language');
		if (!language || !/^[\w+-]+$/.test(language)) continue;
		const target = code ?? document.createElement('code', {});
		target.classList.add(`language-${language.toLowerCase()}`);
		if (!code) {
			while (pre.firstChild) target.appendChild(pre.firstChild);
			pre.appendChild(target);
		}
	}

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
	let substackPost: SubstackPost | null = null;
	if (substackArticle) {
		// The post API owns access, bylines, and dates; a paid post is refused before extraction.
		substackPost = await fetchSubstackPost(url);
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
			const blockquote = document.createElement('blockquote', {});
			while (callout.firstChild) blockquote.appendChild(callout.firstChild);
			callout.parentNode?.replaceChild(blockquote, callout);
		}
	}
	// Keep the existing TechCrunch article boundary; author/affiliate cards share its parent.
	if (/^(?:www\.)?techcrunch\.com$/i.test(new URL(url).hostname)) {
		const article = document.querySelector('.entry-content.wp-block-post-content');
		if (article) document.body.replaceChildren(article.cloneNode(true));
		for (const caption of document.querySelectorAll('figcaption')) caption.remove();
	}
	const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], {
		nbTopCandidates: 4,
		charThreshold: 400,
		keepClasses: true,
	}).parse();
	if (!article?.content?.trim()) throw new NonRetryableError('No readable article content found');
	const articleHtml = article.content.trim();
	const title = substackPost?.title || article.title?.trim();
	if (!title) throw new NonRetryableError('Extracted article has no title');
	const siteName = article.siteName?.trim() || new URL(url).hostname;
	const author = article.byline?.trim();
	const authors = substackPost?.authors.length ? substackPost.authors : author ? [author] : [];

	const content = toMarkdown(
		toMdast(fromHtml(articleHtml, { fragment: true }), {
			handlers: {
				// linkedom keeps the newline after <pre> that HTML parsing drops, and
				// publisher templates indent whole blocks; neither is the author's code.
				pre(state, node) {
					const code = defaultHandlers.pre(state, node);
					code.value = stripIndent(code.value.replace(/^\n+/, ''));
					return code;
				},
			},
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
		originalLang: article.lang || 'und',
		publishedDate: substackPost?.publishedDate ?? (article.publishedTime?.trim() || null),
		summary: substackPost?.subtitle ?? summary,
		creators: authors.map((literal) => ({ role: 'author', literal })),
		kindMetadata: { siteName },
		previewImageUrl: normalizedResourceImageUrl(image, url),
		subjectUrl: null,
	} satisfies AcquiredResource;
}

// The extractor's description may be a generated body excerpt. Only publisher
// metadata counts as a source summary; otherwise feed hints or analysis supply it.
function sourceHtmlSummary(document: ReturnType<DOMParser['parseFromString']>): string | null {
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
	for (const node of document.querySelectorAll('meta, script[type="application/ld+json"]')) {
		if (node.closest('template, noscript')) continue;
		if (node.localName === 'meta') {
			const names = ['name', 'property', 'itemprop'].map((name) => node.getAttribute(name));
			if (
				names.some(
					(name) => typeof name === 'string' && /^(?:description|og:description|twitter:description|parsely-description)$/i.test(name),
				)
			) {
				metaSummary ??= node.getAttribute('content')?.trim() || null;
			}
		} else {
			try {
				schemaSummary ??= schemaDescription(JSON.parse(node.textContent ?? ''));
			} catch {
				// Malformed optional metadata does not make the article unreadable.
			}
		}
	}
	return schemaSummary ?? metaSummary;
}

type WebAcquisition =
	| { platform: ResolvedResourceUrl }
	| Awaited<ReturnType<typeof acquireHtmlArticle>>
	| Awaited<ReturnType<typeof storePublicPdfResponse>>;

async function acquireWebResource(env: CoreEnv, url: string): Promise<WebAcquisition> {
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
		if ([400, 401, 403, 404, 410, 422].includes(response.status)) {
			throw new NonRetryableError(`Fetched resource returned HTTP ${response.status}`);
		}
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}
	const resolved = resolveResourceUrl(response.url);
	if (!resolved) {
		await response.body?.cancel();
		throw new Error('Fetch response has no valid final URL');
	}
	// A redirect to a platform or a paper re-enters acquisition at its own adapter.
	if (resolved.resourcePlatform || resolved.identifiers.length) {
		await response.body?.cancel();
		return { platform: resolved };
	}
	const finalUrl = resolved.url;

	const contentType = response.headers.get('content-type')?.toLowerCase() || '';
	if (contentType.includes(PDF_MIME) || new URL(finalUrl).pathname.toLowerCase().endsWith('.pdf')) {
		return storePublicPdfResponse(env, response, finalUrl);
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
	const article = await acquireHtmlArticle(html, finalUrl);
	return { ...article, content: await rehostInlineImages(env.IMAGES, article.content) };
}

export async function stageWebAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: { paidPdfFallback: PaidPdfFallbackGrant | null; processingId: string; url: string },
) {
	const result = await step.do(
		'acquire-web-v14',
		{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
		async () => {
			const acquired = await acquireWebResource(env, input.url);
			return 'platform' in acquired ? acquired : Response.json(acquired).body!;
		},
	);
	if ('platform' in result) return result;
	const acquired = await new Response(result).json<Exclude<WebAcquisition, { platform: ResolvedResourceUrl }>>();
	return 'pdfStorageKey' in acquired
		? stagePublicPdfAcquisition(env, step, {
				source: acquired,
				grant: input.paidPdfFallback,
				processingId: input.processingId,
			})
		: acquired;
}
