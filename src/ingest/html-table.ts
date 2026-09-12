import type { Element, ElementContent } from 'hast';
import { fromHtml } from 'hast-util-from-html';
import { sanitize, type Schema } from 'hast-util-sanitize';
import { toHtml } from 'hast-util-to-html';
import type { Nodes } from 'mdast';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { mathToMarkdown } from 'mdast-util-math';
import { toHast } from 'mdast-util-to-hast';
import { toMarkdown } from 'mdast-util-to-markdown';

export const TABLE_TAGS = ['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption'];
export const TABLE_INLINE_TAGS = ['strong', 'b', 'em', 'i', 'code', 'sub', 'sup', 'br', 'a', 'del'];
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

export function readHtmlTable(source: string): Element | null {
	if (!/^\s*<table(?:\s[^>]*)?>[\s\S]*<\/table>\s*$/iu.test(source)) return null;
	const roots = fromHtml(source, { fragment: true }).children.filter((node) => node.type !== 'text' || node.value.trim());
	return roots.length === 1 && roots[0]?.type === 'element' && roots[0].tagName === 'table' ? roots[0] : null;
}

export function sanitizeTable(table: Element): Element {
	const safe = sanitize(table, TABLE_SCHEMA);
	if (safe.type !== 'element') throw new TypeError('Expected a sanitized table element');
	return safe;
}

export function serializeTableHtml(node: Parameters<typeof toHtml>[0]): string {
	// A raw Markdown HTML block ends at a blank line, even inside <pre>. Entities
	// keep the table in one block while HTML readers recover the exact line breaks.
	return toHtml(node, { allowDangerousHtml: true }).replaceAll('\n', '&#10;').replaceAll('\r', '&#13;');
}

function nativeMarkdown(node: Nodes): string {
	return toMarkdown(node, { extensions: [gfmToMarkdown(), mathToMarkdown()] }).trimEnd();
}

/** Standard HTML formatting, with native Markdown notes/math kept for the reader. */
export function tableContentHast(node: Nodes): ElementContent[] {
	const inline = node.type === 'tableCell';
	const html = toHast(inline ? { type: 'paragraph', children: node.children } : node, {
		allowDangerousHtml: true,
		handlers: {
			footnoteReference: (_state, reference) => ({ type: 'text', value: nativeMarkdown(reference) }),
			inlineMath: (_state, formula) => ({ type: 'text', value: nativeMarkdown(formula) }),
			math: (_state, formula) => ({ type: 'text', value: nativeMarkdown(formula) }),
		},
	})!;
	if (html.type === 'root') return html.children.filter((child): child is ElementContent => child.type !== 'doctype');
	if (inline && html.type === 'element') return html.children;
	return html.type === 'doctype' ? [] : [html];
}

export function tableContentHtml(node: Nodes): string {
	return serializeTableHtml(tableContentHast(node));
}
