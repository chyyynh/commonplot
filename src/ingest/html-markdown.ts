import { fromHtml } from 'hast-util-from-html';
import { toMdast } from 'hast-util-to-mdast';
import type { Nodes } from 'mdast';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';

/** Convert an HTML fragment to canonical Markdown. */
export function htmlFragmentToMarkdown(html: string): string {
	// HTML comments are invisible implementation metadata. The converter
	// preserves them as raw Markdown by default, so opt out at its AST boundary.
	const tree = toMdast(fromHtml(html, { fragment: true }), { nodeHandlers: { comment() {} } });
	normalizeCodeBlocks(tree);
	return toMarkdown(tree, { extensions: [gfmToMarkdown()] }).trim();
}

function normalizeCodeBlocks(node: Nodes): void {
	if (node.type === 'code') {
		node.value = normalizeCodeWhitespace(node.value);
		return;
	}
	if ('children' in node) for (const child of node.children) normalizeCodeBlocks(child);
}

/**
 * Publisher markup leaks into code: a newline after the opening tag becomes a
 * blank first line, and template nesting indents every line. Drop that
 * framing but keep the author's relative indentation and tabs, since
 * expanding tabs would break copied Makefiles and Go.
 */
export function normalizeCodeWhitespace(value: string): string {
	const lines = value
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map((line) => line.trimEnd());
	while (lines.length && !lines[0]) lines.shift();
	while (lines.length && !lines.at(-1)) lines.pop();
	let common: string | undefined;
	for (const line of lines) {
		if (!line) continue;
		const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
		common ??= indent;
		while (common && !indent.startsWith(common)) common = common.slice(0, -1);
	}
	const width = common?.length ?? 0;
	return lines.map((line) => line.slice(width)).join('\n');
}
