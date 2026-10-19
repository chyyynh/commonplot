import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import Defuddle from 'defuddle';
import { fromHtml } from 'hast-util-from-html';
import { toHtml } from 'hast-util-to-html';
import { defaultHandlers } from 'hast-util-to-mdast';
import { toText } from 'hast-util-to-text';
import { DOMParser } from 'linkedom';
import type { FootnoteDefinition } from 'mdast';
import type { ReadDocument } from '../contracts/acquired-resource';
import { normalizedExternalMediaUrl, normalizedResourceImageUrl } from '../contracts/image-mapping';
import { cleanText, htmlToMdast, stringifyMarkdown } from '../contracts/markdown';
import { PDF_MIME } from '../contracts/pdf-policy';
import { resolveResourceUrl } from '../contracts/resource-url';
import { rehostInlineImages } from '../services/image-rehosting';
import { fetchOk, limitByteStream } from '../services/response';
import { FETCH_STEP_RETRIES } from '../services/workflow-step';
import { stagePdfDocument, storePublicPdfResponse } from '../services/zotero-sdt-service.ts';

const GENERIC_FETCH_TIMEOUT_MS = 8_000;
const GENERIC_HTML_MAX_BYTES = 5 * 1024 * 1024;
const GENERIC_WEB_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const MIN_ARTICLE_CONTENT_CHARS = 180;
const LOOP_VIDEO_PATH = /\.(?:mp4|webm|m4v|mov)$/i;
const FOOTNOTE_TARGET = /^#fn:(.+)$/;
const FOOTNOTE_ID = /^fn:(.+)$/;
// Defuddle strips a site name it knows; pages without one keep it on the <title>
// ("Site: Headline", "Headline − example.org"). A page h1 that is most of that
// title is the headline itself, and a trailing segment naming the host is the site.
function articleTitle(extracted: string, h1: string, url: string): string {
	const title = cleanText(extracted);
	const heading = cleanText(h1);
	if (heading && title !== heading && title.includes(heading) && heading.length >= title.length * 0.6) return heading;
	const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
	const suffix = title.match(/\s+[-–—−|·:]\s+([^-–—−|·:]+)$/);
	const name = suffix?.[1].trim().toLowerCase();
	if (suffix && name && (name === host || name === host.split('.')[0])) return title.slice(0, suffix.index).trim();
	return title;
}

/** The candidate with the largest width (or density) descriptor; a URL may itself contain commas. */
function widestSrcsetCandidate(srcset: string): string | null {
	let widest: { url: string; size: number } | null = null;
	for (const [, url, size] of srcset.matchAll(/\s*(\S+?),?\s+(\d+(?:\.\d+)?)[wx](?:,|$)/g)) {
		if (url && (!widest || Number(size) > widest.size)) widest = { url, size: Number(size) };
	}
	return widest?.url ?? null;
}

function htmlDocument(html: string, url: string) {
	// linkedom does not imply the <head>/<body> that HTML lets pages omit, and Defuddle
	// needs <body>. Serialize the spec parser's tree so linkedom reads the implied structure.
	const document = new DOMParser().parseFromString(toHtml(fromHtml(html)), 'text/html');
	// Linkedom resolves baseURI from <base>; Defuddle resolves relative links and images against it.
	const base = document.createElement('base', {});
	base.setAttribute('href', url);
	document.head.prepend(base);
	return document;
}

async function acquireHtmlArticle(html: string, url: string): Promise<ReadDocument> {
	const document = htmlDocument(html, url);
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

	// Defuddle sets a <picture>'s image to the first candidate of its <source> srcset, which
	// is usually the smallest. Each image instead keeps the widest candidate it offers.
	for (const image of document.querySelectorAll('img')) {
		const picture = image.closest('picture');
		const sources = picture
			? [...picture.querySelectorAll('source')].filter((source) => !/dark/.test(source.getAttribute('media') ?? ''))
			: [];
		const widest = widestSrcsetCandidate([image, ...sources].map((candidate) => candidate.getAttribute('srcset') ?? '').join(','));
		if (widest) image.setAttribute('src', widest);
		if (!image.getAttribute('src')) continue;
		image.removeAttribute('srcset');
		for (const source of picture?.querySelectorAll('source') ?? []) source.remove();
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
				// linkedom keeps the newline after <pre> that HTML parsing drops.
				pre(state, node) {
					const code = defaultHandlers.pre(state, node);
					code.value = code.value.replace(/^\n+/, '');
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
				// Defuddle rewrites every site's footnotes to one shape: <sup><a href="#fn:N"> markers and
				// a <div id="footnotes"> list whose items end in a "↩" back-link. Markdown footnotes keep them notes.
				sup(state, node) {
					const [link, ...rest] = node.children;
					const target = !rest.length && link?.type === 'element' && link.tagName === 'a' ? String(link.properties.href ?? '') : '';
					const identifier = FOOTNOTE_TARGET.exec(target)?.[1];
					return identifier ? { type: 'footnoteReference', identifier, label: identifier } : defaultHandlers.sup(state, node);
				},
				div(state, node) {
					if (node.properties.id !== 'footnotes') return defaultHandlers.div(state, node);
					return node.children.flatMap((list) =>
						list.type === 'element' && list.tagName === 'ol'
							? list.children.flatMap((item) => {
									const identifier =
										item.type === 'element' && item.tagName === 'li' ? FOOTNOTE_ID.exec(String(item.properties.id))?.[1] : undefined;
									if (item.type !== 'element' || !identifier) return [];
									const children = state.toFlow(state.all(item)) as FootnoteDefinition['children'];
									return [{ type: 'footnoteDefinition' as const, identifier, label: identifier, children }];
								})
							: [],
					);
				},
				a(state, node) {
					const className = node.properties.className;
					return Array.isArray(className) && className.includes('footnote-backref') ? undefined : defaultHandlers.a(state, node);
				},
			},
		}),
	).trim();
	if (content.length < MIN_ARTICLE_CONTENT_CHARS) {
		throw new NonRetryableError(`Extracted HTML content is too short (${content.length} chars)`);
	}
	return {
		url,
		fileType: null,
		title,
		content,
		source: siteName,
		originalLang: article.language.trim() || 'und',
		publishedDate: article.published.trim() || null,
		// Defuddle reads publisher metadata only, never a body excerpt.
		summary: article.description.trim() || null,
		creators: authors.map((literal) => ({ role: 'author', literal })),
		kindMetadata: null,
		previewImageUrl: normalizedResourceImageUrl(article.image, url),
		subjectUrl: null,
	};
}

/** A page that moved to a platform's or a paper's URL, which acquisition reads in its place. */
type Redirect = { redirect: string };

function decoderFor(label: string | undefined) {
	try {
		return label ? new TextDecoder(label) : null;
	} catch {
		return null;
	}
}

/**
 * Decodes a page the way a browser picks its encoding: a byte order mark, then the header's charset, then a meta
 * charset in the first 1024 bytes. A page that declares none is UTF-8 when it decodes as UTF-8, and windows-1252
 * otherwise, as older sites written on Windows are.
 */
function decodeHtml(bytes: Uint8Array, contentType: string): string {
	const bom = [
		[[0xef, 0xbb, 0xbf], 'utf-8'],
		[[0xff, 0xfe], 'utf-16le'],
		[[0xfe, 0xff], 'utf-16be'],
	] as const;
	const marked = bom.find(([mark]) => mark.every((byte, index) => bytes[index] === byte))?.[1];
	if (marked) return new TextDecoder(marked).decode(bytes);
	const header = decoderFor(/charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1]);
	if (header) return header.decode(bytes);
	const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 1024));
	const meta = decoderFor(/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1]);
	// A meta tag read as ASCII cannot be declaring UTF-16; browsers read such a page as UTF-8.
	if (meta) return (meta.encoding.startsWith('utf-16') ? new TextDecoder() : meta).decode(bytes);
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		return new TextDecoder('windows-1252').decode(bytes);
	}
}

type WebAcquisition = Redirect | ReadDocument | Awaited<ReturnType<typeof storePublicPdfResponse>>;

/**
 * Fetches a page and sorts what came back. A redirect to a platform or a paper hands back its resolved URL;
 * a PDF is stored; an HTML or XML page is read as an article.
 */
async function acquireWebResource(env: CoreEnv, url: string): Promise<WebAcquisition> {
	const response = await fetchOk(url, {
		label: 'Fetched resource',
		timeoutMs: GENERIC_FETCH_TIMEOUT_MS,
		permanent: [400, 401, 403, 404, 410, 422],
		headers: {
			'User-Agent': GENERIC_WEB_USER_AGENT,
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.5',
			'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
		},
	});
	const resolved = resolveResourceUrl(response.url);
	if (!resolved) {
		await response.body?.cancel();
		throw new Error('Fetch response has no valid final URL');
	}
	if (resolved.resourcePlatform || resolved.identifiers.length) {
		await response.body?.cancel();
		return { redirect: resolved.url };
	}
	const contentType = response.headers.get('content-type')?.toLowerCase() || '';
	if (contentType.includes(PDF_MIME) || new URL(resolved.url).pathname.toLowerCase().endsWith('.pdf')) {
		return storePublicPdfResponse(env, response, resolved.url);
	}
	if (contentType && !/text\/(?:html|xml)|application\/(?:xhtml|xml)/.test(contentType)) {
		await response.body?.cancel();
		throw new NonRetryableError(`Unsupported response content type: ${contentType}`);
	}
	if (!response.body) throw new NonRetryableError('Fetched page has no body');
	const body = limitByteStream(
		response.body,
		GENERIC_HTML_MAX_BYTES,
		() => new NonRetryableError(`HTML response exceeded ${GENERIC_HTML_MAX_BYTES} bytes`),
	);
	const html = decodeHtml(new Uint8Array(await new Response(body).arrayBuffer()), contentType);
	const article = await acquireHtmlArticle(html, resolved.url);
	return { ...article, content: await rehostInlineImages(env.IMAGES, article.content) };
}

/** A page or a PDF as read; a redirect to a platform or a paper re-enters acquisition at its own adapter. */
export async function stageWebAcquisition(env: CoreEnv, step: WorkflowStep, url: string): Promise<Redirect | ReadDocument> {
	const result = await step.do('acquire-web-v17', { retries: FETCH_STEP_RETRIES, timeout: '300 seconds' }, async () => {
		const acquired = await acquireWebResource(env, url);
		return 'redirect' in acquired ? acquired : Response.json(acquired).body!;
	});
	if ('redirect' in result) return result;
	const acquired = await new Response(result).json<Exclude<WebAcquisition, Redirect>>();
	// A stored PDF, including one from an older checkpoint that also carries its storage key and crop URL prefix.
	return 'inputContentHash' in acquired ? stagePdfDocument(env, step, acquired) : acquired;
}
