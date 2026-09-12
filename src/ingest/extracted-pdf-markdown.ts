import { fromHtml } from 'hast-util-from-html';
import { toHtml } from 'hast-util-to-html';
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
import type { Element } from 'hast';
import { readHtmlTable, sanitizeTable, serializeTableHtml, tableContentHtml, TABLE_TAGS, TABLE_INLINE_TAGS } from './html-table.ts';
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
	const safe = sanitizeTable(table);
	const markdownTree = merged ? null : toMdast({ type: 'root', children: [safe] });
	let result = markdownTree
		? toMarkdown(markdownTree, { extensions: [gfmToMarkdown({ tablePipeAlign: false }), mathToMarkdown()] }).trimEnd()
		: toHtml(safe);
	for (const { token, value } of tokens) {
		const tree = parseMarkdown(value);
		function decodeMath(node: Nodes): void {
			if (node.type === 'inlineMath' || node.type === 'math') {
				node.value = fromHtml(node.value.replaceAll('<', '&lt;').replaceAll('>', '&gt;'), { fragment: true })
					.children.map((child) => (child.type === 'text' ? child.value : ''))
					.join('');
			} else if ('children' in node) node.children.forEach(decodeMath);
		}
		decodeMath(tree);
		const first = tree.children[0];
		const html = tableContentHtml(
			tree.children.length === 1 && first?.type === 'paragraph' ? { type: 'tableCell', children: first.children } : tree,
		);
		result = result.replaceAll(token, merged ? html : value.replaceAll('|', '\\|'));
	}
	if (!merged) return result;
	// Markdown placeholders can introduce links; sanitize after their final expansion.
	const restored = readHtmlTable(result);
	return restored ? serializeTableHtml(sanitizeTable(restored)) : null;
}

/** Normalize LlamaParse PDF output before persistence, leaving native Markdown syntax intact. */
export function normalizeExtractedPdfMarkdown(markdown: string): string {
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
