import { fromHtml } from 'hast-util-from-html';
import { toMdast } from 'hast-util-to-mdast';
import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown, mathToMarkdown } from 'mdast-util-math';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';

type Range = { start: number; end: number };
type Replacement = Range & { value: string };
type HtmlRoot = ReturnType<typeof fromHtml>;
type Element = Extract<HtmlRoot['children'][number], { type: 'element' }>;
type ElementContent = Element['children'][number];
const TABLE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption']);
const INLINE_TAGS = new Set(['strong', 'em', 'code', 'sub', 'sup', 'br', 'a', 'del']);
const PROSE_HTML_TAGS = new Set([
	...TABLE_TAGS,
	...INLINE_TAGS,
	'a',
	'b',
	'i',
	'u',
	'span',
	'font',
	'script',
	'style',
	'iframe',
	'img',
	'svg',
	'math',
	'object',
	'embed',
	'div',
	'p',
	'input',
	'button',
	'form',
	'video',
	'audio',
	'source',
	'link',
	'meta',
	'html',
	'body',
	'head',
	'pre',
]);

function parseMarkdown(value: string) {
	return fromMarkdown(value, {
		// Recognize code and math even when extraction tags surround them at a line start.
		extensions: [gfm(), math(), { disable: { null: ['htmlFlow', 'htmlText'] } }],
		mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
	});
}

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function safeLink(value: unknown): string | null {
	if (typeof value !== 'string' || [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127))
		return null;
	if (/^#[^<>]*$/u.test(value)) return value;
	const url = URL.parse(value);
	return url && ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password ? value : null;
}

function normalizeProse(value: string): string {
	return (
		value
			.replace(/(?<!\\)\[\s*<u>\s*(\[[^<>\n]{1,160}\])\s*<\/u>\s*\]/giu, '$1')
			.replace(/(?<!\\)<([A-Za-z][A-Za-z'-]*)(\s+\([^<>\n]{1,40}\))<\/\1>/gu, '$1$2')
			.replace(/(?<!\\)<br\s*\/?>/giu, ' ')
			.replace(/(?<!\\)<\/?(?:b|strong|em|i|u|sup|sub|span|font)(?:\s[^<>]*)?>/giu, '')
			.replace(/(?<!\\)<\/?(?:table|thead|tbody|tfoot|tr|th|td)(?:\s[^<>]*)?>/giu, '')
			.replace(/(?<!\\)<([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*)+)>/gu, (match, prose: string) =>
				PROSE_HTML_TAGS.has(prose.split(/\s/u)[0]!.toLowerCase()) ? match : prose,
			)
			.replace(
				/(?<!\\)<((?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}(?:\/[^<>\s]*)?)>/giu,
				(_match, url: string) => `[${url}](https://${url})`,
			)
			// Remaining HTML is literal evidence, not permission to execute provider markup.
			.replace(/(?<!\\)<\/?[A-Za-z][^<>]*>/gu, (tag) => escapeHtml(tag))
	);
}

function protectedRanges(markdown: string): { all: Range[]; literal: Range[]; inline: Range[] } {
	const all: Range[] = [];
	const literal: Range[] = [];
	const inline: Range[] = [];
	function visit(node: Nodes): void {
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		if (
			start !== undefined &&
			end !== undefined &&
			[
				'inlineCode',
				'inlineMath',
				'link',
				'image',
				'linkReference',
				'imageReference',
				'footnoteReference',
				'strong',
				'emphasis',
				'delete',
			].includes(node.type)
		) {
			inline.push({ start, end });
		}
		const isLiteral = ['code', 'inlineCode', 'math', 'inlineMath'].includes(node.type);
		if (isLiteral || ['link', 'image', 'definition', 'linkReference', 'imageReference'].includes(node.type)) {
			if (start !== undefined && end !== undefined) {
				all.push({ start, end });
				if (isLiteral) literal.push({ start, end });
			}
			return;
		}
		if ('children' in node) node.children.forEach(visit);
	}
	visit(parseMarkdown(markdown));
	const tags = [...markdown.matchAll(/<\/?[A-Za-z][A-Za-z\d-]*(?:\s[^<>]*?)?\/?>/gu)].map((match) => ({
		start: match.index,
		end: match.index + match[0].length,
	}));
	// Literal Markdown wins even when malformed provider markup looks like an
	// HTML attribute around its opening delimiter (for example `</` before a fence).
	const outsideAttributes = (range: Range) =>
		literal.some((item) => item.start === range.start && item.end === range.end) ||
		!tags.some((tag) => range.start > tag.start && range.start < tag.end);
	return { all: all.filter(outsideAttributes), literal, inline: inline.filter(outsideAttributes) };
}

function serializeHtml(node: HtmlRoot['children'][number] | HtmlRoot): string {
	if (node.type === 'text') return escapeHtml(node.value);
	if (node.type !== 'element' && node.type !== 'root') return '';
	const content = node.children.map(serializeHtml).join('');
	if (node.type === 'root') return content;
	const attributes = Object.entries(node.properties)
		.map(([name, value]) => ` ${name === 'colSpan' ? 'colspan' : name === 'rowSpan' ? 'rowspan' : name}="${escapeHtml(String(value))}"`)
		.join('');
	return node.tagName === 'br' ? '<br>' : `<${node.tagName}${attributes}>${content}</${node.tagName}>`;
}

function safeInlineHtml(source: string): string {
	function render(node: Nodes): string {
		if (node.type === 'inlineCode') return `<code>${escapeHtml(node.value)}</code>`;
		if (node.type === 'text') return escapeHtml(node.value);
		const children = 'children' in node ? node.children.map(render).join('') : '';
		const tag = node.type === 'strong' ? 'strong' : node.type === 'emphasis' ? 'em' : node.type === 'delete' ? 'del' : null;
		if (tag) return `<${tag}>${children}</${tag}>`;
		if (node.type === 'link') {
			const href = safeLink(node.url);
			return href ? `<a href="${escapeHtml(href)}"${node.title ? ` title="${escapeHtml(node.title)}"` : ''}>${children}</a>` : children;
		}
		if ('children' in node) return children;
		const raw = source.slice(node.position?.start.offset, node.position?.end.offset);
		// Raw HTML cells decode entities once, including mathematical text. Re-escape
		// the decoded text so subsequent normalization cannot double-encode it.
		return fromHtml(raw.replaceAll('<', '&lt;').replaceAll('>', '&gt;'), { fragment: true })
			.children.map((child) => (child.type === 'text' ? escapeHtml(child.value) : ''))
			.join('');
	}
	return render(parseMarkdown(source));
}

/** Rebuild provider tables from a small, inert grammar; never retain arbitrary attributes. */
function normalizeTable(source: string, inline: Range[]): string | null {
	// HTML cells often also contain native Markdown. Shield those source spans from
	// both HTML parsing and serializers that would otherwise consume their syntax.
	let prefix = 'PDFMARKDOWN';
	while (source.includes(prefix)) prefix += 'X';
	const tags = [...source.matchAll(/<\/?[A-Za-z][A-Za-z\d-]*(?:\s[^<>]*?)?\/?>/gu)].map((match) => ({
		start: match.index,
		end: match.index + match[0].length,
	}));
	const tokens: Array<{ token: string; value: string }> = [];
	let masked = '';
	let offset = 0;
	for (const range of inline.sort((left, right) => left.start - right.start || right.end - left.end)) {
		if (range.start < offset || tags.some((tag) => range.start >= tag.start && range.start < tag.end)) continue;
		const token = `${prefix}${tokens.length}END`;
		tokens.push({ token, value: source.slice(range.start, range.end) });
		masked += source.slice(offset, range.start) + token;
		offset = range.end;
	}
	if (tokens.length) source = masked + source.slice(offset);
	const tree = fromHtml(source, { fragment: true });
	const roots = tree.children.filter((node) => node.type !== 'text' || node.value.trim());
	if (roots.length !== 1 || roots[0]?.type !== 'element' || roots[0].tagName !== 'table') return null;
	let merged = false;
	let nested = false;
	let invalidSpan = false;
	let cells = 0;
	function sanitize(node: HtmlRoot['children'][number], depth = 0): ElementContent[] {
		if (node.type === 'text') return [{ type: 'text', value: node.value }];
		if (node.type !== 'element') return [];
		if (node.tagName === 'table' && depth > 0) nested = true;
		const tagName = node.tagName === 'b' ? 'strong' : node.tagName === 'i' ? 'em' : node.tagName;
		if (['u', 'span', 'font'].includes(tagName)) return node.children.flatMap((child) => sanitize(child, depth + 1));
		if (!TABLE_TAGS.has(tagName) && !INLINE_TAGS.has(tagName)) {
			const start = node.position?.start.offset;
			const end = node.position?.end.offset;
			return [{ type: 'text', value: start !== undefined && end !== undefined ? source.slice(start, end) : '' }];
		}
		const children = node.children.flatMap((child) => sanitize(child, depth + 1));
		const properties: Element['properties'] = {};
		if (tagName === 'td' || tagName === 'th') {
			cells += 1;
			for (const attribute of ['colSpan', 'rowSpan'] as const) {
				if (node.properties[attribute] === undefined) continue;
				const span = Number(node.properties[attribute]);
				if (!Number.isInteger(span) || span > 1000 || span < (attribute === 'rowSpan' ? 0 : 1)) {
					invalidSpan = true;
					continue;
				}
				if (span !== 1) {
					properties[attribute] = span;
					merged = true;
				}
			}
		}
		if (tagName === 'a') {
			const href = safeLink(node.properties.href);
			if (!href) return children;
			properties.href = href;
			if (typeof node.properties.title === 'string') properties.title = node.properties.title;
		}
		return [{ type: 'element', tagName, properties, children }];
	}
	const table = sanitize(roots[0])[0];
	if (!table || nested || invalidSpan || !cells) return null;
	const markdownTree = merged ? null : toMdast({ type: 'root', children: [table] });
	let result = markdownTree
		? toMarkdown(markdownTree, { extensions: [gfmToMarkdown({ tablePipeAlign: false }), mathToMarkdown()] }).trimEnd()
		: serializeHtml(table);
	for (const { token, value } of tokens) result = result.replaceAll(token, merged ? safeInlineHtml(value) : value.replaceAll('|', '\\|'));
	return result;
}

/** Normalize LlamaParse PDF output before persistence, leaving native Markdown syntax intact. */
export function normalizeExtractedPdfMarkdown(markdown: string): string {
	const ranges = protectedRanges(markdown);
	const replacements: Replacement[] = [];
	let tableStart = -1;
	let tableDepth = 0;
	for (const match of markdown.matchAll(/(?<!\\)<\/?table\b[^<>]*>/giu)) {
		if (ranges.literal.some((range) => match.index >= range.start && match.index < range.end)) continue;
		if (!match[0].startsWith('</')) {
			if (tableDepth === 0) tableStart = match.index;
			tableDepth += 1;
			continue;
		}
		if (!tableDepth) continue;
		tableDepth -= 1;
		if (tableDepth) continue;
		const start = tableStart;
		const end = match.index + match[0].length;
		const inline = ranges.inline
			.filter((range) => range.start >= start && range.end <= end)
			.map((range) => ({ start: range.start - start, end: range.end - start }));
		const source = markdown.slice(start, end);
		const table = normalizeTable(source, inline);
		const prefix = start > 0 && !/\n\s*\n$/u.test(markdown.slice(0, start)) ? '\n\n' : '';
		const suffix = end < markdown.length && !/^\s*\n\s*\n/u.test(markdown.slice(end)) ? '\n\n' : '';
		replacements.push({ start, end, value: table === null ? escapeHtml(source) : prefix + table + suffix });
	}
	const protectedSource = [...ranges.all, ...replacements].sort((left, right) => left.start - right.start || right.end - left.end);
	let offset = 0;
	let result = '';
	for (const range of protectedSource) {
		if (range.start < offset) continue;
		result += normalizeProse(markdown.slice(offset, range.start));
		result += 'value' in range ? range.value : markdown.slice(range.start, range.end);
		offset = range.end;
	}
	return result + normalizeProse(markdown.slice(offset));
}
