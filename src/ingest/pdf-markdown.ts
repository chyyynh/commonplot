import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';

const PRIVATE_PDF_CROP_PATH = '/api/media/asset/pdf-crops/';

/** Private upload visuals stay on the owned rendition, never on shared corpus content. */
export function withoutPrivatePdfImages(markdown: string): string {
	const tree = fromMarkdown(markdown, { extensions: [gfm(), math()], mdastExtensions: [...gfmFromMarkdown(), mathFromMarkdown()] });
	const definitions = new Map<string, string>();
	const images: Extract<Nodes, { type: 'image' | 'imageReference' | 'definition' }>[] = [];
	const visit = (node: Nodes): void => {
		if (node.type === 'definition') {
			// Markdown resolves the first definition, including those inside containers.
			if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
			images.push(node);
		} else if (node.type === 'image' || node.type === 'imageReference') {
			images.push(node);
		}
		if ('children' in node) for (const child of node.children) visit(child);
	};
	visit(tree);
	const removals = images.flatMap((node) => {
		const url = node.type === 'imageReference' ? definitions.get(node.identifier) : node.url;
		if (!url || !URL.parse(url, 'https://pdf.invalid')?.pathname.startsWith(PRIVATE_PDF_CROP_PATH)) return [];
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		return start !== undefined && end !== undefined ? [{ start, end }] : [];
	});
	let content = markdown;
	for (const { start, end } of removals.sort((left, right) => right.start - left.start)) {
		content = `${content.slice(0, start)}${content.slice(end)}`;
	}
	return content.trim();
}
