import type { Element, Nodes as HtmlNodes } from 'hast';
import { fromHtml } from 'hast-util-from-html';
import { sanitize, type Schema } from 'hast-util-sanitize';
import { toHtml } from 'hast-util-to-html';
import type { Nodes, Parent, PhrasingContent, Root, TableCell } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown, mathToMarkdown } from 'mdast-util-math';
import { toHast } from 'mdast-util-to-hast';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';

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
export function tableContentHtml(node: Nodes): string {
	const inline = node.type === 'tableCell';
	const html = toHast(inline ? { type: 'paragraph', children: node.children } : node, {
		allowDangerousHtml: true,
		handlers: {
			footnoteReference: (_state, reference) => ({ type: 'text', value: nativeMarkdown(reference) }),
			inlineMath: (_state, formula) => ({ type: 'text', value: nativeMarkdown(formula) }),
			math: (_state, formula) => ({ type: 'text', value: nativeMarkdown(formula) }),
		},
	})!;
	return serializeTableHtml(inline && 'children' in html ? html.children : html);
}

/** Workflow-local representation: fixed table markup surrounds ordinary prose cells. */
export interface HtmlTable extends Parent {
	type: 'htmlTable';
	children: TableCell[];
	parts: string[];
	captions: number[];
}

declare module 'mdast' {
	interface HtmlData {
		tableMarkup?: boolean;
	}
	interface RootContentMap {
		htmlTable: HtmlTable;
	}
}

function tableText(value: string, definitions: string): PhrasingContent[] {
	// HTML text is literal. Use the native parser only to locate notes and formulas;
	// punctuation and decoded entities must not turn into new Markdown formatting.
	const parsed = fromMarkdown(`${value}\n\n${definitions}`, {
		extensions: [
			gfm(),
			math(),
			{
				disable: {
					null: [
						'attention',
						'autolink',
						'blockQuote',
						'characterReference',
						'codeFenced',
						'codeIndented',
						'codeText',
						'headingAtx',
						'htmlFlow',
						'htmlText',
						'list',
						'setextUnderline',
						'thematicBreak',
					],
				},
			},
		],
		mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
	});
	const children: PhrasingContent[] = [];
	let offset = 0;
	function prose(value: string): void {
		// HTML whitespace may contain blank lines; the existing translation contract
		// forbids creating paragraph breaks inside a text value. Keep those gaps fixed.
		for (const part of value.split(/(\r?\n[\t ]*\r?\n)/u)) {
			if (part)
				children.push(
					/^\r?\n[\t ]*\r?\n$/u.test(part) ? { type: 'html', value: part, data: { tableMarkup: true } } : { type: 'text', value: part },
				);
		}
	}
	function visit(node: Nodes): void {
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		if (
			start !== undefined &&
			end !== undefined &&
			end <= value.length &&
			(node.type === 'footnoteReference' || node.type === 'math' || (node.type === 'inlineMath' && !isCurrencyMath(value, start, end)))
		) {
			if (start > offset) prose(value.slice(offset, start));
			children.push(
				node.type === 'math'
					? { type: 'html', value: toHtml({ type: 'text', value: value.slice(start, end) }), data: { tableMarkup: true } }
					: node,
			);
			offset = end;
		} else if ('children' in node) node.children.forEach(visit);
	}
	visit(parsed);
	if (offset < value.length) prose(value.slice(offset));
	return children;
}

function cellPhrasing(nodes: HtmlNodes[], definitions: string): PhrasingContent[] {
	return nodes.flatMap((node): PhrasingContent[] => {
		if (node.type === 'text') return tableText(node.value, definitions);
		if (node.type !== 'element') return [];
		const literal =
			node.tagName === 'code' ||
			node.tagName === 'pre' ||
			(node.tagName === 'a' &&
				node.children.length === 1 &&
				node.children[0]?.type === 'text' &&
				node.children[0].value === node.properties.href);
		const atom = (value: string): PhrasingContent => ({ type: 'html', value, data: { tableMarkup: true } });
		if (literal) return [atom(toHtml(node))];
		const empty = toHtml({ ...node, children: [] });
		const close = `</${node.tagName}>`;
		return empty.endsWith(close)
			? [atom(empty.slice(0, -close.length)), ...cellPhrasing(node.children, definitions), atom(close)]
			: [atom(empty)];
	});
}

export function expandHtmlTables(tree: Root): Root {
	const labels: string[] = [];
	function collectNotes(node: Nodes): void {
		if (node.type === 'footnoteDefinition') labels.push(nativeMarkdown({ ...node, children: [] }));
		else if ('children' in node) node.children.forEach(collectNotes);
	}
	collectNotes(tree);
	const definitions = labels.join('\n');
	function visit(node: Nodes): void {
		if (!('children' in node)) return;
		for (const [index, child] of node.children.entries()) {
			const table = child.type === 'html' ? readHtmlTable(child.value) : null;
			if (!table) {
				visit(child);
				continue;
			}
			let prefix = 'NEW SENCE TABLE CELL';
			const source = toHtml(table);
			while (source.includes(prefix)) prefix += ' X';
			const children: TableCell[] = [];
			const captions: number[] = [];
			function cells(element: Element): void {
				if (['td', 'th', 'caption'].includes(element.tagName)) {
					if (element.tagName === 'caption') captions.push(children.length);
					children.push({ type: 'tableCell', children: cellPhrasing(element.children, definitions) });
					element.children = [{ type: 'text', value: prefix }];
				} else for (const item of element.children) if (item.type === 'element') cells(item);
			}
			cells(table);
			node.children[index] = { type: 'htmlTable', children, parts: serializeTableHtml(table).split(prefix), captions };
		}
	}
	visit(tree);
	return tree;
}

export function isCurrencyMath(source: string, start: number, end: number): boolean {
	return source.slice(start, start + 2) !== '$$' && /\p{Nd}/u.test(source[start + 1] ?? '') && /\p{Nd}/u.test(source[end] ?? '');
}

export function serializeHtmlTable(node: HtmlTable): string {
	return node.parts.map((part, index) => part + (node.children[index] ? tableContentHtml(node.children[index]!) : '')).join('');
}

export function htmlCellMarkdown(table: HtmlTable, index: number): string {
	const content = tableContentHtml(table.children[index]!);
	return table.captions.includes(index) ? `<table><caption>${content}</caption></table>` : `<table><tr><td>${content}</td></tr></table>`;
}
