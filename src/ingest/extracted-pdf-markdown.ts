import type { Element } from 'hast';
import { fromHtml } from 'hast-util-from-html';
import { sanitize, type Schema } from 'hast-util-sanitize';
import { toHtml } from 'hast-util-to-html';
import { toMdast } from 'hast-util-to-mdast';
import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown, mathToMarkdown } from 'mdast-util-math';
import type {} from 'mdast-util-to-hast';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';

type Range = { start: number; end: number };
type Replacement = Range & { value: string };
const TABLE_TAGS = ['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption'];
const TABLE_INLINE_TAGS = ['strong', 'b', 'em', 'i', 'code', 'sub', 'sup', 'br', 'a', 'del'];
const TABLE_SCHEMA: Schema = {
	tagNames: [...TABLE_TAGS, ...TABLE_INLINE_TAGS, 'p', 'ul', 'ol', 'li', 'blockquote', 'pre'],
	attributes: {
		a: ['href', 'title'],
		td: ['colSpan', 'rowSpan'],
		th: ['colSpan', 'rowSpan', ['scope', 'row', 'col', 'rowgroup', 'colgroup']],
		ol: ['start'],
	},
	protocols: { href: ['http', 'https', 'mailto'] },
	strip: ['script', 'style', 'iframe', 'object', 'embed'],
};

function readHtmlTable(source: string): Element | null {
	if (!/^\s*<table(?:\s[^>]*)?>[\s\S]*<\/table>\s*$/iu.test(source)) return null;
	const roots = fromHtml(source, { fragment: true }).children.filter((node) => node.type !== 'text' || node.value.trim());
	return roots.length === 1 && roots[0]?.type === 'element' && roots[0].tagName === 'table' ? roots[0] : null;
}

const PROSE_HTML_TAGS = new Set([
	...TABLE_TAGS,
	...TABLE_INLINE_TAGS,
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

function parseMarkdown(value: string, html = false) {
	return fromMarkdown(value, {
		// Recognize code and math even when extraction tags surround them at a line start.
		extensions: [gfm(), math(), ...(html ? [] : [{ disable: { null: ['htmlFlow', 'htmlText'] } }])],
		mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
	});
}

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
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
				'code',
				'math',
				'break',
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
	// Expose HTML block boundaries to the Markdown tokenizer without changing offsets.
	// Otherwise a closing `$$</p>` can consume the following footnote definitions.
	const prose = markdown.replace(
		/<\/?(?:table|thead|tbody|tfoot|tr|th|td|caption|p|pre|ul|ol|li|blockquote)\b[^<>]*>/giu,
		(tag) => `\n${' '.repeat(tag.length - 2)}\n`,
	);
	visit(parseMarkdown(prose));
	// Content already expressed as native Markdown between HTML blocks must pass
	// through unchanged, including paragraph breaks and list indentation.
	for (const block of parseMarkdown(markdown, true).children) {
		if (
			block.type !== 'html' &&
			block.position &&
			!/<\/?(?:table|thead|tbody|tfoot|tr|th|td|caption|p|pre|ul|ol|li|blockquote)\b/iu.test(
				markdown.slice(block.position.start.offset, block.position.end.offset),
			)
		)
			inline.push({ start: block.position.start.offset!, end: block.position.end.offset! });
	}
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

/** Rebuild provider tables from a small, inert grammar; never retain arbitrary attributes. */
function normalizeTable(source: string, inline: Range[]): string | null {
	const literals: Range[] = [];
	function protectCode(node: Element): void {
		if (node.tagName === 'code' || node.tagName === 'pre') {
			const start = node.position?.start.offset;
			const end = node.position?.end.offset;
			if (start !== undefined && end !== undefined) literals.push({ start, end });
		} else for (const child of node.children) if (child.type === 'element') protectCode(child);
	}
	const original = readHtmlTable(source);
	if (original) protectCode(original);
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
		if (range.start < offset || [...tags, ...literals].some((tag) => range.start >= tag.start && range.start < tag.end)) continue;
		const token = `${prefix}${tokens.length}END`;
		tokens.push({ token, value: source.slice(range.start, range.end) });
		masked += source.slice(offset, range.start) + token;
		offset = range.end;
	}
	if (tokens.length) source = masked + source.slice(offset);
	const table = readHtmlTable(source);
	if (!table) return null;
	let merged = false;
	let invalid = false;
	let rows = 0;
	let cells = 0;
	function inspect(node: Element, depth = 0): void {
		if (node.tagName === 'table' && depth) invalid = true;
		if (node.tagName === 'tr') rows += 1;
		if (
			node.tagName === 'tr' &&
			node.children.some((cell) => cell.type === 'element' && cell.tagName === 'th') &&
			node.children.some((cell) => cell.type === 'element' && cell.tagName === 'td')
		)
			merged = true;
		if (['caption', 'p', 'ul', 'ol', 'blockquote', 'pre', 'sub', 'sup'].includes(node.tagName)) merged = true;
		if (node.tagName === 'th' && (rows > 1 || node.properties.scope === 'row')) merged = true;
		if (node.tagName === 'th' || node.tagName === 'td') {
			cells += 1;
			for (const name of ['colSpan', 'rowSpan'] as const) {
				const span = node.properties[name];
				if (span === undefined) continue;
				if (typeof span !== 'number' || !Number.isInteger(span) || span > 1000 || span < (name === 'rowSpan' ? 0 : 1)) invalid = true;
				if (span !== 1) merged = true;
			}
		}
		// Canonicalize formatting aliases once at acquisition.
		if (node.tagName === 'b') node.tagName = 'strong';
		if (node.tagName === 'i') node.tagName = 'em';
		for (const child of node.children) if (child.type === 'element') inspect(child, depth + 1);
	}
	inspect(table);
	if (invalid || !cells) return null;
	const safe = sanitize(table, TABLE_SCHEMA);
	if (safe.type !== 'element') return null;
	const markdownOptions = { extensions: [gfmToMarkdown({ tablePipeAlign: false }), mathToMarkdown()] };
	function markdownCells(node: Element): void {
		if (['td', 'th', 'caption'].includes(node.tagName)) {
			const content = toMdast(
				{ type: 'root', children: node.children },
				{
					document: true,
					newlines: true,
					// Markdown has no native sub/sup nodes; preserve only these inline tags.
					handlers: {
						sub: (_state, element) => ({ type: 'html', value: toHtml(element), data: { hName: element.tagName } }),
						sup: (_state, element) => ({ type: 'html', value: toHtml(element), data: { hName: element.tagName } }),
					},
				},
			);
			node.children = [{ type: 'raw', value: `\n\n${toMarkdown(content, markdownOptions).trimEnd()}\n\n` }];
		} else for (const child of node.children) if (child.type === 'element') markdownCells(child);
	}
	if (merged) markdownCells(safe);
	let result = merged
		? toHtml(safe, { allowDangerousHtml: true })
		: toMarkdown(toMdast({ type: 'root', children: [safe] }), markdownOptions).trimEnd();
	for (const { token, value } of tokens) {
		let restored = value;
		const replacements: Replacement[] = [];
		function decodeMath(node: Nodes): void {
			if ((node.type === 'inlineMath' || node.type === 'math') && node.position) {
				node.value = fromHtml(node.value.replaceAll('<', '&lt;').replaceAll('>', '&gt;'), { fragment: true })
					.children.map((child) => (child.type === 'text' ? child.value : ''))
					.join('');
				replacements.push({
					start: node.position.start.offset!,
					end: node.position.end.offset!,
					value: toMarkdown(node, markdownOptions).trimEnd(),
				});
			} else if ('children' in node) node.children.forEach(decodeMath);
		}
		decodeMath(parseMarkdown(value));
		for (const replacement of replacements.reverse())
			restored = restored.slice(0, replacement.start) + replacement.value + restored.slice(replacement.end);
		result = result.replaceAll(token, () => (merged ? restored : restored.replaceAll('|', '\\|')));
	}
	return result;
}

/** Normalize LlamaParse PDF output before persistence, leaving native Markdown syntax intact. */
function normalizeExtractedPdfMarkdown(markdown: string): string {
	const ranges = protectedRanges(markdown);
	const replacements: Replacement[] = [];
	let tableStart = -1;
	let tableDepth = 0;
	for (const match of markdown.matchAll(/(?<!\\)<\/?table\b[^<>]*>/giu)) {
		if (
			ranges.literal.some(
				(range) => match.index >= range.start && match.index < range.end && (tableDepth === 0 || range.start < tableStart),
			)
		)
			continue;
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

type MarkdownPage = Readonly<{ markdown?: string; page_number: number; success: boolean }>;

/** Accept only a complete, exactly-once page set; never persist a truncated cloud result. */
export function wholeDocumentMarkdown(pages: readonly MarkdownPage[] | null | undefined, expectedPages: number): string | null {
	if (pages?.length !== expectedPages || expectedPages < 1) return null;
	const ordered = [...pages].sort((left, right) => left.page_number - right.page_number);
	if (ordered.some((page, index) => !page.success || page.page_number !== index + 1 || typeof page.markdown !== 'string')) return null;
	return (
		normalizeExtractedPdfMarkdown(
			ordered
				.map((page) => page.markdown)
				.join('\n\n')
				.replaceAll('\0', '')
				.trim(),
		) || null
	);
}
