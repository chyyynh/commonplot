import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { Element as HastElement } from 'hast';
import { DOMParser } from 'linkedom';
import type { FootnoteDefinition, Root } from 'mdast';
import type { AcquiredResource } from '../contracts/acquired-resource';
import { cleanText, htmlToMdast, stringifyMarkdown } from '../contracts/markdown';
import { paperIdentityFromText } from '../contracts/paper-identity';
import { parseReferenceCitation } from '../contracts/reference-citation';
import { crawlerUserAgent } from '../services/crawler-identity';
import { limitByteStream, responseError } from '../services/response';
import { stepJson } from '../services/workflow-step';

const ARXIV_HTML_STEP = { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' } as const;
const ARXIV_HTML_TIMEOUT_MS = 60_000;
const ARXIV_HTML_MAX_BYTES = 40 * 1024 * 1024;
const ARXIV_USER_AGENT = crawlerUserAgent();
const MIN_ARXIV_BODY_CHARS = 2_000;
const MAX_REFERENCES = 1_000;
/** Front matter the paper's metadata already describes, and LaTeXML conversion residue. */
const REMOVED_SELECTORS = [
	'h1.ltx_title_document',
	'.ltx_authors',
	'.ltx_dates',
	'.ltx_classification',
	'.ltx_keywords',
	'.ltx_TOC',
	'.ltx_ERROR',
	'.ltx_note_frontmatter',
	'.ltx_bibliography',
	'.ltx_pagination',
	'.ltx_rule',
	'script',
	'style',
	'button',
].join(', ');

type Dom = ReturnType<DOMParser['parseFromString']>;
type DomElement = NonNullable<ReturnType<Dom['querySelector']>>;

function mathTex(math: DomElement): string {
	return cleanText(math.getAttribute('alttext') ?? math.querySelector('annotation[encoding="application/x-tex"]')?.textContent);
}

/** An inline span the Markdown conversion turns into one math or footnote node; spans keep the spaces around them. */
function markerElement(document: Dom, attributes: Record<string, string>) {
	const element = document.createElement('span', {});
	for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
	// An empty span would let whitespace collapsing join the words on either side of it.
	element.textContent = '·';
	return element;
}

function bibliography(document: Dom, baseUrl: string) {
	const items = [...document.querySelectorAll('.ltx_bibliography li.ltx_bibitem')].slice(0, MAX_REFERENCES);
	return items
		.flatMap((item) => {
			const id = item.getAttribute('id');
			if (!id) return [];
			const label = cleanText(item.querySelector('.ltx_tag_bibitem')?.textContent).replace(/^[[(](.*)[\])]$/u, '$1') || null;
			const text = cleanText([...item.querySelectorAll('.ltx_bibblock')].map((block) => block.textContent).join(' '));
			if (!text) return [];
			const links = [...item.querySelectorAll('a[href]')].map(
				(link) => URL.parse(link.getAttribute('href') ?? '', baseUrl)?.toString() ?? '',
			);
			const identity = paperIdentityFromText([text, ...links].join(' '));
			return [
				{
					id,
					label,
					text,
					doi: identity?.doi ?? null,
					arxivId: identity?.arxivId ?? null,
					...parseReferenceCitation(text),
				},
			];
		})
		.map((reference, index) => ({
			...reference,
			// The persisted reference ordinal, which the reader resolves to its parsed citation.
			key: `arxiv-${index + 1}`,
		}));
}

function arxivMdast(html: string): Root {
	return htmlToMdast(html, {
		handlers: {
			span(state, node: HastElement) {
				const { dataMath, dataDisplay, dataCites, dataNote } = node.properties;
				if (typeof dataMath === 'string') return { type: dataDisplay === 'block' ? 'math' : 'inlineMath', value: dataMath };
				if (typeof dataCites === 'string')
					return dataCites.split(' ').map((key) => ({ type: 'footnoteReference', identifier: `paper-${key}` }));
				if (typeof dataNote === 'string') return { type: 'footnoteReference', identifier: dataNote };
				return state.all(node);
			},
		},
	});
}

/** Visible text with math as its TeX source, for image descriptions. */
function readableText(element: DomElement | null | undefined): string {
	if (!element) return '';
	const copy = element.cloneNode(true) as DomElement;
	for (const marked of copy.querySelectorAll('span[data-math], span[data-cites], span[data-note]')) {
		const tex = marked.getAttribute('data-math');
		if (tex) marked.textContent = tex;
		else marked.remove();
	}
	return cleanText(copy.textContent);
}

/** Convert arXiv's LaTeXML rendering to the Markdown shape PDF parsing produces. */
function arxivHtmlDocument(html: string, url: string) {
	const document = new DOMParser().parseFromString(html, 'text/html');
	const article = document.querySelector('article.ltx_document');
	if (!article) return null;
	const title =
		cleanText(article.querySelector('h1.ltx_title_document')?.textContent) || cleanText(document.querySelector('title')?.textContent);
	// A person block runs name, affiliation, and address together; the name ends at the first line break.
	const authors = [...article.querySelectorAll('.ltx_authors .ltx_personname')].flatMap((person) => {
		let name = '';
		for (const node of person.childNodes) {
			if (node.nodeName.toLowerCase() === 'br') break;
			// Affiliation marks are notes, superscripts, or math.
			if (['math', 'sup'].includes(node.nodeName.toLowerCase()) || (node as DomElement).classList?.contains('ltx_note')) continue;
			name += node.textContent ?? '';
		}
		const author = cleanText(name)
			.replace(/[\d,*†‡§¶∗]+$/u, '')
			.trim();
		return author && author.length <= 80 ? [author] : [];
	});
	const references = bibliography(document, url);
	const referenceKeys = new Map(references.map(({ id, key }) => [id, key]));
	const citedKeys = new Set<string>();
	const notes: { id: string; html: string }[] = [];

	for (const element of article.querySelectorAll(REMOVED_SELECTORS)) element.remove();
	for (const heading of article.querySelectorAll('h6.ltx_title_abstract')) {
		const replacement = document.createElement('h2', {});
		replacement.textContent = cleanText(heading.textContent) || 'Abstract';
		heading.replaceWith(replacement);
	}
	// Display equations are tables of cells; one TeX block per equation keeps its number as \tag.
	for (const table of article.querySelectorAll('table.ltx_equation, table.ltx_equationgroup')) {
		const rows = [...table.querySelectorAll('tr')]
			.map((row) => [...row.querySelectorAll('math')].map(mathTex).filter(Boolean).join(' '))
			.filter(Boolean);
		const tag = cleanText(table.querySelector('.ltx_tag_equation')?.textContent).replace(/^\((.*)\)$/u, '$1');
		const tex = rows.length > 1 ? `\\begin{gathered}${rows.join(' \\\\ ')}\\end{gathered}` : (rows[0] ?? '');
		if (tex) table.replaceWith(markerElement(document, { 'data-math': tag ? `${tex} \\tag{${tag}}` : tex, 'data-display': 'block' }));
		else table.remove();
	}
	for (const math of article.querySelectorAll('math')) {
		const tex = mathTex(math);
		if (tex) math.replaceWith(markerElement(document, { 'data-math': tex, 'data-display': math.getAttribute('display') ?? 'inline' }));
		else math.remove();
	}
	// A numeric citation becomes its footnote markers; an author-year citation keeps its words.
	for (const cite of article.querySelectorAll('cite.ltx_cite')) {
		const anchors = [...cite.querySelectorAll('a[href^="#bib."]')];
		const keys = anchors.flatMap((anchor) => referenceKeys.get(anchor.getAttribute('href')!.slice(1)) ?? []);
		if (!keys.length) continue;
		for (const key of keys) citedKeys.add(key);
		const words = cleanText(cite.textContent)
			.replace(/[\d\s[\](),;–-]/gu, '')
			.trim();
		if (!words) {
			cite.replaceWith(markerElement(document, { 'data-cites': [...new Set(keys)].join(' ') }));
			continue;
		}
		for (const anchor of anchors) {
			const key = referenceKeys.get(anchor.getAttribute('href')!.slice(1));
			const text = document.createTextNode(anchor.textContent ?? '');
			anchor.replaceWith(text);
			if (key) text.after(markerElement(document, { 'data-cites': key }));
		}
	}
	for (const note of article.querySelectorAll('.ltx_note.ltx_role_footnote')) {
		const content = note.querySelector('.ltx_note_content');
		for (const mark of content?.querySelectorAll('.ltx_note_mark, .ltx_tag_note') ?? []) mark.remove();
		const text = cleanText(content?.textContent);
		if (!text) {
			note.remove();
			continue;
		}
		const id = `arxiv-note-${notes.length + 1}`;
		notes.push({ id, html: content!.innerHTML });
		note.replaceWith(markerElement(document, { 'data-note': id }));
	}
	// Cross-references point into arXiv's page; only external links survive.
	for (const anchor of article.querySelectorAll('a[href]')) {
		const href = anchor.getAttribute('href') ?? '';
		const external = URL.parse(href, url);
		if (href.startsWith('#') || !external || !['http:', 'https:'].includes(external.protocol)) {
			anchor.replaceWith(document.createTextNode(anchor.textContent ?? ''));
		} else anchor.setAttribute('href', external.toString());
	}
	for (const image of article.querySelectorAll('img')) {
		const source = URL.parse(image.getAttribute('src') ?? '', url);
		if (!source || source.protocol !== 'https:') {
			image.remove();
			continue;
		}
		image.setAttribute('src', source.toString());
		const alt = cleanText(image.getAttribute('alt'));
		if (!alt || /^(?:Refer to caption|\[?Uncaptioned image\]?)$/u.test(alt))
			image.setAttribute('alt', readableText(image.closest('figure')?.querySelector('figcaption')));
	}
	// Layout tables (author blocks, logos) carry no text of their own.
	for (const table of article.querySelectorAll('table')) {
		if (!cleanText(table.textContent) && !table.querySelector('img, span[data-math]')) table.remove();
	}

	const tree = arxivMdast(article.innerHTML);
	const definitions: FootnoteDefinition[] = [
		...notes.map(({ id, html }) => ({
			type: 'footnoteDefinition' as const,
			identifier: id,
			children: arxivMdast(`<p>${html}</p>`).children as FootnoteDefinition['children'],
		})),
		...references
			.filter(({ key }) => citedKeys.has(key))
			.map(({ key, text }) => ({
				type: 'footnoteDefinition' as const,
				identifier: `paper-${key}`,
				children: [{ type: 'paragraph' as const, children: [{ type: 'text' as const, value: text }] }],
			})),
	];
	tree.children.push(...definitions);
	const content = stringifyMarkdown(tree).trim();
	if (!title || content.length < MIN_ARXIV_BODY_CHARS) return null;
	return { title, authors, content, references: references.map(({ id: _id, ...reference }) => reference) };
}

async function fetchArxivHtml(arxivId: string) {
	const response = await fetch(`https://arxiv.org/html/${arxivId}`, {
		headers: { Accept: 'text/html', 'User-Agent': ARXIV_USER_AGENT },
		signal: AbortSignal.timeout(ARXIV_HTML_TIMEOUT_MS),
	});
	if (!response.ok) {
		const error = await responseError(response, [400, 403, 410], `arXiv HTML request failed with HTTP ${response.status}`);
		// arXiv has no HTML rendering for this paper.
		if (response.status === 404) return null;
		throw error;
	}
	const body =
		response.body &&
		limitByteStream(response.body, ARXIV_HTML_MAX_BYTES, () => new NonRetryableError(`arXiv HTML exceeded ${ARXIV_HTML_MAX_BYTES} bytes`));
	return arxivHtmlDocument(await new Response(body).text(), response.url || `https://arxiv.org/html/${arxivId}`);
}

/** arXiv's own HTML rendering of the paper; null when arXiv has none. */
export async function stageArxivHtmlAcquisition(
	step: WorkflowStep,
	arxivId: string,
): Promise<(AcquiredResource & { kind: 'paper'; resourcePlatform: null }) | null> {
	const document = await stepJson(step, 'acquire-arxiv-html-v3', ARXIV_HTML_STEP, () => fetchArxivHtml(arxivId));
	if (!document) return null;
	return {
		kind: 'paper',
		resourcePlatform: null,
		resourceIdentifiers: [{ preferred: true, scheme: 'arxiv', value: arxivId }],
		url: `https://arxiv.org/abs/${arxivId}`,
		fileType: null,
		title: document.title,
		summary: null,
		content: document.content,
		references: document.references,
		source: 'arxiv.org',
		originalLang: 'und',
		publishedDate: null,
		creators: document.authors.map((literal) => ({ role: 'author', literal })),
		kindMetadata: {},
		previewImageUrl: null,
		subjectUrl: null,
	};
}
