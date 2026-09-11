import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

function nodeText(node: Nodes): string {
	return 'value' in node ? node.value : 'children' in node ? node.children.map(nodeText).join('') : '';
}

/** Remove a duplicate heading only after Core has resolved the resource title. */
export function withoutDuplicatePdfTitle(markdown: string, title: string): string {
	const first = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: gfmFromMarkdown() }).children[0];
	const comparable = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
	if (first?.type !== 'heading' || comparable(nodeText(first)) !== comparable(title)) return markdown;
	const end = first.position?.end.offset;
	if (end === undefined) return markdown;
	const body = markdown.slice(end).trimStart();
	return body || markdown;
}
