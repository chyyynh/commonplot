import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import Defuddle from 'defuddle';
import { fromHtml } from 'hast-util-from-html';
import { toHtml } from 'hast-util-to-html';
import { defaultHandlers } from 'hast-util-to-mdast';
import { toText } from 'hast-util-to-text';
import { DOMParser } from 'linkedom';
import stripIndent from 'strip-indent';
import type { AcquiredResource } from '../contracts/acquired-resource';
import { normalizedExternalMediaUrl, normalizedResourceImageUrl } from '../contracts/image-mapping';
import { htmlToMdast, stringifyMarkdown } from '../contracts/markdown';
import { PDF_MIME } from '../contracts/pdf-policy';
import { resolveResourceUrl, type ResolvedResourceUrl } from '../contracts/resource-url';
import { rehostInlineImages } from '../services/image-rehosting';
import { limitByteStream } from '../services/response';
import { storePublicPdfResponse } from '../services/zotero-sdt-service.ts';
import { stagePublicPdfAcquisition } from './pdf';

const GENERIC_FETCH_TIMEOUT_MS = 8_000;
const GENERIC_HTML_MAX_BYTES = 5 * 1024 * 1024;
const GENERIC_WEB_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const MIN_ARTICLE_CONTENT_CHARS = 180;
const LOOP_VIDEO_PATH = /\.(?:mp4|webm|m4v|mov)$/i;
// Defuddle strips a site name it knows; pages without one keep it on the <title>
// ("Site: Headline", "Headline − example.org"). A page h1 that is most of that
// title is the headline itself, and a trailing segment naming the host is the site.
function articleTitle(extracted: string, h1: string, url: string): string {
	const title = extracted.replace(/\s+/g, ' ').trim();
	const heading = h1.replace(/\s+/g, ' ').trim();
	if (heading && title !== heading && title.includes(heading) && heading.length >= title.length * 0.6) return heading;
	const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
	const suffix = title.match(/\s+[-–—−|·:]\s+([^-–—−|·:]+)$/);
	const name = suffix?.[1].trim().toLowerCase();
	if (suffix && name && (name === host || name === host.split('.')[0])) return title.slice(0, suffix.index).trim();
	return title;
}

async function acquireHtmlArticle(html: string, url: string): Promise<AcquiredResource & { kind: 'blog'; resourcePlatform: null }> {
	// linkedom does not imply the <head>/<body> that HTML lets pages omit, and Defuddle
	// needs <body>. Serialize the spec parser's tree so linkedom reads the implied structure.
	const document = new DOMParser().parseFromString(toHtml(fromHtml(html)), 'text/html');
	const summary = sourceHtmlSummary(document);
	// Linkedom resolves baseURI from <base>; Defuddle uses it for relative links and images.
	const base = document.createElement('base', {});
	base.setAttribute('href', url);
	document.head.prepend(base);
	const image = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.getAttribute('content');
	// A <br> separates lines but leaves no text, so a byline like "by Name<br>Date" would read as one string.
	for (const br of document.querySelectorAll('br')) if (!br.closest('pre')) br.before('\n');
	// Defuddle reads language-*/brush-* classes and data-language, but not SyntaxHighlighter's "brush: js;".
	for (const pre of document.querySelectorAll('pre[class*="brush:"]')) {
		const language = pre.getAttribute('class')?.match(/brush:\s*([\w+-]+)/i)?.[1];
		if (language) pre.setAttribute('data-language', language.toLowerCase());
	}

	// Defuddle removes aria-hidden images. Preserve the narrow case where
	// the parent figure carries the image's accessible description instead.
	for (const figure of document.querySelectorAll('figure[role="img"][aria-label]')) {
		const label = figure.getAttribute('aria-label')?.trim();
		if (!label) continue;
		for (const image of figure.querySelectorAll('img[aria-hidden="true"]')) {
			if (!image.getAttribute('alt')?.trim()) image.setAttribute('alt', label);
			image.removeAttribute('aria-hidden');
		}
	}

	// Markdown has no <video>. Muted autoplay loops are a page's animated figures (what GIFs
	// used to be), so each becomes a Markdown image of its light-theme file for the reader to
	// loop. Lazy players keep the URL in data-src until their script runs; their <noscript>
	// copy parses as a second player here.
	for (const video of document.querySelectorAll('noscript video')) video.closest('noscript')?.remove();
	for (const video of document.querySelectorAll('video[autoplay][loop][muted]')) {
		const source = [video, ...video.querySelectorAll('source')].find(
			(candidate) =>
				candidate.getAttribute('data-theme') !== 'dark' &&
				!/dark/.test(candidate.getAttribute('media') ?? '') &&
				(candidate.getAttribute('src') || candidate.getAttribute('data-src')),
		);
		const src = URL.parse(normalizedExternalMediaUrl(source?.getAttribute('src') || source?.getAttribute('data-src'), url) ?? '');
		if (!src || !LOOP_VIDEO_PATH.test(src.pathname)) continue;
		src.hash = '';
		const image = document.createElement('img', {});
		image.setAttribute('src', src.toString());
		image.setAttribute('alt', video.getAttribute('aria-label')?.trim() ?? '');
		// The image replaces its player chrome (wrappers, posters) up to the first text or other media,
		// so no media-classed wrapper is left for the extractor to judge as page chrome.
		let player: typeof video | NonNullable<typeof video.parentElement> = video;
		for (let parent = player.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
			const media = parent.querySelectorAll('img:not([aria-hidden="true"]), picture, video, iframe, svg');
			const text = parent.textContent?.replace(video.textContent ?? '', '').trim();
			if (text || media.length > 1) break;
			player = parent;
		}
		player.replaceWith(image);
	}

	// Pull quotes repeat a sentence of the body as decoration.
	for (const quote of document.querySelectorAll('.pullquote, .pull-quote')) quote.remove();
	const article = new Defuddle(document as unknown as ConstructorParameters<typeof Defuddle>[0], { url }).parse();
	// On table-laid-out pages the content root can be the layout cell itself, which
	// Markdown conversion would read as a table cell and flatten into one line.
	const articleHtml = article.content.trim().replace(/^<(td|th)\b[^>]*>([\s\S]*)<\/\1>$/, '<div>$2</div>');
	if (!articleHtml) throw new NonRetryableError('No readable article content found');
	const siteName = article.site.trim() || new URL(url).hostname;
	const title = articleTitle(article.title, document.querySelector('h1')?.textContent ?? '', url);
	if (!title) throw new NonRetryableError('Extracted article has no title');
	const author = article.author.trim();
	const authors = author ? [author] : [];

	const content = stringifyMarkdown(
		htmlToMdast(articleHtml, {
			handlers: {
				// linkedom keeps the newline after <pre> that HTML parsing drops, and
				// publisher templates indent whole blocks; neither is the author's code.
				pre(state, node) {
					const code = defaultHandlers.pre(state, node);
					code.value = stripIndent(code.value.replace(/^\n+/, ''));
					return code;
				},
				// Markdown has no caption, so a captioned figure stays an HTML block around
				// Markdown blocks: the caption remains a translatable paragraph with its links.
				figure(state, node) {
					const caption = node.children.find((child) => child.type === 'element' && child.tagName === 'figcaption');
					const media = state.toFlow(state.all({ ...node, children: node.children.filter((child) => child !== caption) }));
					if (caption?.type !== 'element' || !toText(caption).trim()) return media;
					// Publishers often italicize the whole caption; the reader styles captions itself.
					const [only, ...rest] = caption.children.filter((child) => child.type !== 'text' || child.value.trim());
					const wrapper = !rest.length && only?.type === 'element' && (only.tagName === 'em' || only.tagName === 'i') ? only : caption;
					return [
						{ type: 'html', value: '<figure>' },
						...media,
						{ type: 'html', value: '<figcaption>' },
						...state.toFlow(state.all(wrapper)),
						{ type: 'html', value: '</figcaption>' },
						{ type: 'html', value: '</figure>' },
					];
				},
			},
		}),
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
		originalLang: article.language.trim() || 'und',
		publishedDate: article.published.trim() || null,
		summary,
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

export async function stageWebAcquisition(env: CoreEnv, step: WorkflowStep, input: { url: string }) {
	const result = await step.do(
		'acquire-web-v15',
		{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
		async () => {
			const acquired = await acquireWebResource(env, input.url);
			return 'platform' in acquired ? acquired : Response.json(acquired).body!;
		},
	);
	if ('platform' in result) return result;
	const acquired = await new Response(result).json<Exclude<WebAcquisition, { platform: ResolvedResourceUrl }>>();
	return 'pdfStorageKey' in acquired ? stagePublicPdfAcquisition(env, step, acquired) : acquired;
}
