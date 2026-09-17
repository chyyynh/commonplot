import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';

const PRIVATE_PDF_CROP_PATH = '/api/media/asset/pdf-crops/';

function isPrivatePdfCropUrl(value: string): boolean {
	return value.startsWith(PRIVATE_PDF_CROP_PATH) || URL.parse(value)?.pathname.startsWith(PRIVATE_PDF_CROP_PATH) === true;
}

/** Private upload visuals stay on the owned rendition, never on shared corpus content. */
export function withoutPrivatePdfImages(markdown: string): string {
	const tree = fromMarkdown(markdown);
	const privateDefinitions = new Set(
		tree.children.flatMap((node) => (node.type === 'definition' && isPrivatePdfCropUrl(node.url) ? [node.identifier] : [])),
	);
	const removals: Array<{ start: number; end: number }> = [];
	const visit = (node: Nodes): void => {
		if (
			(node.type === 'image' && isPrivatePdfCropUrl(node.url)) ||
			(node.type === 'imageReference' && privateDefinitions.has(node.identifier)) ||
			(node.type === 'definition' && privateDefinitions.has(node.identifier))
		) {
			const start = node.position?.start.offset;
			const end = node.position?.end.offset;
			if (start !== undefined && end !== undefined) removals.push({ start, end });
			return;
		}
		if ('children' in node) for (const child of node.children) visit(child);
	};
	visit(tree);
	let content = markdown;
	for (const { start, end } of removals.sort((left, right) => right.start - left.start)) {
		content = `${content.slice(0, start)}${content.slice(end)}`;
	}
	return content.trim();
}
