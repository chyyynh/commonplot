import { createHash } from 'node:crypto';
import type { BlockContent, Heading, Nodes, PhrasingContent, Root, RootContent, Table } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import type {
	ContentBlockNode,
	PdfAnchor,
	OutlineItem as SdtOutlineItem,
	RefPath as SdtRefPath,
	TextNode as SdtTextNode,
	StructuredDocumentText,
} from 'structured-document-text/schema';
import { getFulltextFromStructuredText } from 'structured-document-text/src/fulltext.js';
import {
	getLogicalBlockText,
	getPartBoundarySeparator,
	getPartChain,
	shouldDropHardHyphenAtPartBoundary,
} from 'structured-document-text/src/parts.js';
import { isContentBoundary, isLeafBlock, refKey, sameRef } from 'structured-document-text/src/range.js';
import { mergeTextNodes } from 'structured-document-text/src/text.js';

const MAX_DOCUMENT_NODES = 100_000;
const MAX_DOCUMENT_TEXT_CHARS = 2_000_000;
const MAX_REFERENCE_TEXT_CHARS = 600;
const MAX_REFERENCES = 1_000;
const MAX_CITATION_CONTEXT_CHARS = 1_200;
const MAX_CITATION_MARKER_CHARS = 128;
const MAX_CITATION_MENTIONS = 3_000;
const MAX_SECTION_CHARS = 300;
const MAX_SOURCE_CROP_ALT_CHARS = 500;
const MAX_SOURCE_CROPS = 64;
const MAX_REF_PATH_DEPTH = 16;
export const ZOTERO_SDT_ARTIFACT_VERSION = 'newsence-zotero-sdt-v2-02100446';

export function parseStructuredPdfFailure(status: number, body: string): { message: string; totalPages: number | null } {
	let message = `Zotero SDT parse failed with ${status}`;
	let totalPages: number | null = null;
	try {
		const parsed = JSON.parse(body) as { error?: unknown; totalPages?: unknown };
		if (typeof parsed.error === 'string' && parsed.error.trim()) message = `${message}: ${parsed.error.trim()}`;
		if (Number.isInteger(parsed.totalPages) && Number(parsed.totalPages) > 0) totalPages = Number(parsed.totalPages);
	} catch {
		// A malformed internal error response still fails safely without page-count admission.
	}
	return { message, totalPages };
}

type RefPath = readonly number[];

type SdtBlockNode = Readonly<{
	anchor?: PdfAnchor;
	content: readonly SdtNode[];
	flowClass?: 'auxiliary' | 'excluded';
	nextPart?: RefPath;
	previousPart?: RefPath;
	reference?: boolean;
	refs?: readonly RefPath[];
	type: ContentBlockNode['type'] | 'listitem' | 'tablecell' | 'tablerow';
	ordered?: boolean;
	startIndex?: number;
}>;

type SdtNode = SdtBlockNode | SdtTextNode;

export type StructuredPdfDocument = Readonly<{
	catalog: Readonly<Pick<StructuredDocumentText['catalog'], 'outline' | 'pages'>>;
	content: readonly SdtBlockNode[];
	metadata: Readonly<{
		processor: Readonly<{ type: 'pdf'; version: number }>;
		source: Readonly<Pick<StructuredDocumentText['metadata']['source'], 'properties'>>;
	}>;
	schemaVersion: string;
}>;

type StructuredPdfCitationMention = Readonly<{
	context: string;
	markerText: string;
	section: string | null;
	targetKeys: string[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRefPath(value: unknown, field: string): asserts value is number[] {
	if (!isContentBoundary(value) || (value as unknown[]).length > MAX_REF_PATH_DEPTH) {
		throw new Error(`Zotero SDT ${field} is not a valid node path`);
	}
}

function assertRefPaths(value: unknown, field: string): asserts value is number[][] {
	if (!Array.isArray(value)) throw new Error(`Zotero SDT ${field} is not an array`);
	for (const path of value) assertRefPath(path, field);
}

function assertAnchor(value: unknown, field: string): asserts value is PdfAnchor {
	if (!isRecord(value)) throw new Error(`Zotero SDT ${field} is not an anchor`);
	if (value.textMap !== undefined && typeof value.textMap !== 'string') {
		throw new Error(`Zotero SDT ${field}.textMap is invalid`);
	}
	if (value.pageRects !== undefined) {
		if (!Array.isArray(value.pageRects)) throw new Error(`Zotero SDT ${field}.pageRects is invalid`);
		for (const rect of value.pageRects) {
			if (!Array.isArray(rect) || rect.length !== 5 || rect.some((part) => typeof part !== 'number' || !Number.isFinite(part))) {
				throw new Error(`Zotero SDT ${field}.pageRects contains an invalid rectangle`);
			}
		}
	}
}

const BLOCK_TYPES = new Set([
	'blockquote',
	'caption',
	'heading',
	'image',
	'list',
	'listitem',
	'math',
	'note',
	'paragraph',
	'preformatted',
	'table',
	'tablecell',
	'tablerow',
]);

function assertSdtNodes(value: unknown, state: { characters: number; nodes: number }, path: string, depth = 1): asserts value is SdtNode[] {
	if (!Array.isArray(value)) throw new Error(`Zotero SDT ${path} is not an array`);
	if (value.length && depth > MAX_REF_PATH_DEPTH) throw new Error(`Zotero SDT exceeded ${MAX_REF_PATH_DEPTH} node path depth`);
	for (const [index, node] of value.entries()) {
		state.nodes += 1;
		if (state.nodes > MAX_DOCUMENT_NODES) throw new Error(`Zotero SDT exceeded ${MAX_DOCUMENT_NODES} nodes`);
		if (!isRecord(node)) throw new Error(`Zotero SDT ${path}[${index}] is not a node`);
		if (typeof node.text === 'string') {
			state.characters += node.text.length;
			if (state.characters > MAX_DOCUMENT_TEXT_CHARS) throw new Error(`Zotero SDT exceeded ${MAX_DOCUMENT_TEXT_CHARS} text characters`);
		} else {
			if (typeof node.type !== 'string' || !BLOCK_TYPES.has(node.type) || !Array.isArray(node.content)) {
				throw new Error(`Zotero SDT ${path}[${index}] is not a supported block`);
			}
			if (node.flowClass !== undefined && node.flowClass !== 'auxiliary' && node.flowClass !== 'excluded') {
				throw new Error(`Zotero SDT ${path}[${index}].flowClass is invalid`);
			}
			if (node.previousPart !== undefined) assertRefPath(node.previousPart, `${path}[${index}].previousPart`);
			if (node.nextPart !== undefined) assertRefPath(node.nextPart, `${path}[${index}].nextPart`);
			assertSdtNodes(node.content, state, `${path}[${index}].content`, depth + 1);
		}
		if (node.anchor !== undefined) assertAnchor(node.anchor, `${path}[${index}].anchor`);
		if (node.refs !== undefined) assertRefPaths(node.refs, `${path}[${index}].refs`);
	}
}

function assertOutline(value: unknown, depth = 0): asserts value is SdtOutlineItem[] {
	if (!Array.isArray(value) || depth > MAX_REF_PATH_DEPTH) throw new Error('Zotero SDT outline is invalid');
	for (const item of value) {
		if (!isRecord(item) || typeof item.title !== 'string') throw new Error('Zotero SDT outline entry is invalid');
		if (item.ref !== undefined) assertRefPath(item.ref, 'outline.ref');
		if (item.children !== undefined) assertOutline(item.children, depth + 1);
	}
}

export function parseStructuredPdfDocumentJson(json: string): StructuredPdfDocument {
	const value: unknown = JSON.parse(json);
	if (!isRecord(value) || typeof value.schemaVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value.schemaVersion)) {
		throw new Error('Zotero SDT schema version is invalid');
	}
	if (!isRecord(value.metadata) || !isRecord(value.metadata.processor) || !isRecord(value.metadata.source)) {
		throw new Error('Zotero SDT metadata is invalid');
	}
	if (value.metadata.processor.type !== 'pdf' || !Number.isInteger(value.metadata.processor.version)) {
		throw new Error('Zotero SDT PDF source metadata is invalid');
	}
	if (!isRecord(value.catalog) || !Array.isArray(value.catalog.pages)) throw new Error('Zotero SDT catalog is invalid');
	assertOutline(value.catalog.outline);
	for (const page of value.catalog.pages) {
		if (!isRecord(page) || !Array.isArray(page.contentRange) || page.contentRange.length !== 2) {
			throw new Error('Zotero SDT page catalog entry is invalid');
		}
		assertRefPath(page.contentRange[0], 'page.contentRange');
		assertRefPath(page.contentRange[1], 'page.contentRange');
		if (page.textSource !== undefined && page.textSource !== 'born-digital' && page.textSource !== 'ocr') {
			throw new Error('Zotero SDT page text source is invalid');
		}
	}
	const state = { characters: 0, nodes: 0 };
	assertSdtNodes(value.content, state, 'content');
	return value as StructuredPdfDocument;
}

function cleanText(value: string): string {
	return value.replaceAll('\0', '').replace(/\s+/gu, ' ').trim();
}

function boundedText(value: string, maxChars: number): string {
	return value.length > maxChars ? `${value.slice(0, maxChars - 1).trimEnd()}…` : value;
}

function nodeText(node: SdtNode): string {
	return 'text' in node ? node.text : node.content.map(nodeText).join('');
}

function mergeParagraphParts(chain: readonly { block: SdtBlockNode }[]): SdtBlockNode {
	const first = chain[0]!.block;
	const content: SdtNode[] = [...first.content];
	for (let index = 1; index < chain.length; index += 1) {
		const previous = chain[index - 1]!.block;
		const next = chain[index]!.block;
		if (shouldDropHardHyphenAtPartBoundary(previous, next)) {
			const lastIndex = content.length - 1;
			const last = content[lastIndex];
			if (last && 'text' in last) content[lastIndex] = { ...last, text: last.text.slice(0, -1) };
		}
		const separator = getPartBoundarySeparator(previous, next);
		if (separator) content.push({ text: separator });
		content.push(...next.content);
	}
	return { ...first, content };
}

function walkNodes(nodes: readonly SdtNode[], parentPath: RefPath = []): Array<{ node: SdtNode; path: number[] }> {
	return nodes.flatMap((node, index) => {
		if ('content' in node && node.flowClass === 'excluded') return [];
		const path = [...parentPath, index];
		return [{ node, path }, ...('content' in node ? walkNodes(node.content, path) : [])];
	});
}

function referenceLabelAndText(value: string): { label: string | null; text: string } {
	const text = cleanText(value);
	const match = /^(?:\[([^\]]{1,64})\]|(\d{1,6})[.)])\s*/u.exec(text);
	const label = cleanText(match?.[1] ?? match?.[2] ?? '') || null;
	const withoutLabel = match ? text.slice(match[0].length).trim() : text;
	return {
		label,
		text: boundedText(withoutLabel || text, MAX_REFERENCE_TEXT_CHARS),
	};
}

function headingLevels(outline: readonly SdtOutlineItem[], depth = 2, levels = new Map<string, number>()): Map<string, number> {
	for (const item of outline) {
		if (item.ref) levels.set(refKey(item.ref), Math.min(depth, levels.get(refKey(item.ref)) ?? 6));
		if (item.children) headingLevels(item.children, depth + 1, levels);
	}
	return levels;
}

function safeHttpUrl(value: string | undefined): string | null {
	if (!value || value.length > 2_048) return null;
	const url = URL.parse(value);
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
	return url.toString();
}

function statisticalReferenceNodes(nodes: readonly SdtNode[], referenceKeyByPath: ReadonlyMap<string, string>): ReadonlySet<SdtTextNode> {
	const ignored = new Set<SdtTextNode>();
	const targetSignature = (node: SdtTextNode) =>
		[...new Set((node.refs ?? []).flatMap((path) => referenceKeyByPath.get(refKey(path)) ?? []))].sort().join('\0');
	for (let index = 1; index < nodes.length; index += 1) {
		const previous = nodes[index - 1];
		const open = nodes[index];
		if (!previous || !('text' in previous) || !/(?:^|[^\p{L}])(?:[tfz]|χ(?:2|²)?)\s*$/iu.test(previous.text)) continue;
		if (!open || !('text' in open) || open.text.trim() !== '(') continue;
		const signature = targetSignature(open);
		if (!signature) continue;
		const run: SdtTextNode[] = [];
		for (const node of nodes.slice(index)) {
			if (!('text' in node) || targetSignature(node) !== signature) break;
			run.push(node);
			if (node.text.trim() === ')') break;
		}
		if (!/^\(\s*\d+(?:\s*,\s*\d+)*\s*\)$/u.test(run.map(({ text }) => text).join('')) || !run.some(({ style }) => style?.monospace))
			continue;
		for (const node of run) ignored.add(node);
	}
	return ignored;
}

type PdfRect = [number, number, number, number];
type PageRect = [number, number, number, number, number];
const SOURCE_CROP_RECIPE_VERSION = 'caption-regions-v2';

export type StructuredPdfSourceCrop = Readonly<{
	altText: string;
	blockPath: string;
	figureId: string | null;
	id: string;
	pageIndex: number;
	placement: 'before' | 'replace';
	rect: PdfRect;
	source: 'semantic' | 'caption-region';
	suppressedBlockPaths: readonly string[];
}>;

type MissingFigure = Readonly<{ figureId: string; reason: string }>;

function pageRects(node: SdtNode): PageRect[] {
	const rects = node.anchor && 'pageRects' in node.anchor ? node.anchor.pageRects : [];
	return (rects ?? []).filter((rect): rect is PageRect => Number.isInteger(rect[0]) && rect[3] > rect[1] && rect[4] > rect[2]);
}

/** Text-map runs, unlike block bounds, do not include nearby unrecognized graphics. */
function textRects(node: SdtNode): PageRect[] {
	if ('content' in node) return node.content.flatMap(textRects);
	if (node.anchor && 'textMap' in node.anchor && node.anchor.textMap) {
		try {
			const runs: unknown = JSON.parse(node.anchor.textMap);
			if (Array.isArray(runs)) {
				const rects: PageRect[] = [];
				for (const run of runs) {
					if (!Array.isArray(run) || run.length < 6 || !run.slice(0, 6).every((part) => typeof part === 'number' && Number.isFinite(part)))
						continue;
					const [, page, x1, y1, x2, y2] = run as number[];
					if (Number.isInteger(page) && x2! > x1! && y2! > y1!) rects.push([page!, x1!, y1!, x2!, y2!]);
				}
				if (rects.length) return rects;
			}
		} catch {
			// The SDT text-map contract permits unknown encodings. Use bounded anchors.
		}
	}
	return pageRects(node);
}

function blockRects(node: SdtBlockNode): PageRect[] {
	const rects = pageRects(node);
	return rects.length ? rects : textRects(node);
}

function figureLabel(node: SdtBlockNode): string | null {
	if (node.type !== 'caption' || node.flowClass === 'excluded') return null;
	const match = /^(?:figure|fig\.?)\s+(\d+[a-z]?)(?=[\s:.,])/iu.exec(cleanText(nodeText(node)));
	return match ? `Figure ${match[1]}` : null;
}

function authorTablePaths(document: StructuredPdfDocument): Set<string> {
	const firstBody = document.content.findIndex(
		(node) =>
			node.type === 'caption' || (node.type === 'heading' && /^(?:abstract|(?:1\.?\s+)?introduction)$/iu.test(cleanText(nodeText(node)))),
	);
	if (firstBody < 1) return new Set();
	const front = document.content.slice(0, firstBody);
	const emails = front.filter((node) => /[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu.test(nodeText(node)));
	if (emails.length < 2 || !front.some((node) => /\b(?:university|institute|laborator(?:y|ies))\b/iu.test(nodeText(node))))
		return new Set();
	return new Set(
		front.flatMap((node, index) => {
			const rects = blockRects(node);
			return node.type === 'table' &&
				isLeafBlock(node) &&
				cleanText(nodeText(node)).length <= 240 &&
				rects.length &&
				rects.every(([page, , y1, , y2]) => page === 0 && y2 - y1 <= 50)
				? [String(index)]
				: [];
		}),
	);
}

function horizontalOverlap(a: PdfRect, b: PdfRect): number {
	return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
}

function isChartLabels(node: SdtBlockNode, caption: PageRect): boolean {
	if (node.type !== 'paragraph') return false;
	const value = cleanText(nodeText(node));
	if (value.length > 700 || !/\d/u.test(value) || /[.!?]\s+[A-Z]/u.test(value) || /[.!?]$/u.test(value)) return false;
	const rects = blockRects(node);
	const rect = rects.length === 1 ? rects[0] : null;
	if (!rect || rect[0] !== caption[0] || rect[2] < caption[4] || rect[2] - caption[4] > 40 || rect[4] - rect[2] < 48) return false;
	const area = (rect[3] - rect[1]) * (rect[4] - rect[2]);
	const runs = textRects(node);
	return value.length / area < 0.01 && runs.length >= 3 && new Set(runs.map((run) => Math.round(run[2] / 10))).size >= 3;
}

/** Plan semantic crops plus conservative caption-bounded recoveries; never infer an entire page. */
export function structuredPdfVisualPlan(document: StructuredPdfDocument) {
	const crops: StructuredPdfSourceCrop[] = [];
	const missing: MissingFigure[] = [];
	const excludedAuthorTables = authorTablePaths(document);
	const captions = document.content.flatMap((node, index) => {
		const figureId = figureLabel(node);
		return figureId ? [{ node, index, figureId }] : [];
	});
	function addCrop(crop: Omit<StructuredPdfSourceCrop, 'id'>) {
		if (crops.length >= MAX_SOURCE_CROPS) return false;
		const digest = createHash('sha256')
			.update(
				JSON.stringify([
					ZOTERO_SDT_ARTIFACT_VERSION,
					document.schemaVersion,
					document.metadata.processor.version,
					SOURCE_CROP_RECIPE_VERSION,
					crop.blockPath,
					crop.source,
					crop.pageIndex,
					crop.rect,
				]),
			)
			.digest('hex')
			.slice(0, 16);
		crops.push({ ...crop, id: `${crop.blockPath}-p${crop.pageIndex}-${digest}` });
		return true;
	}
	for (const [blockIndex, block] of document.content.entries()) {
		if (
			block.flowClass === 'excluded' ||
			excludedAuthorTables.has(String(blockIndex)) ||
			(block.type !== 'image' && (block.type !== 'table' || !isLeafBlock(block)))
		)
			continue;
		const rectByPage = new Map<number, PdfRect>();
		for (const [pageIndex, x1, y1, x2, y2] of blockRects(block)) {
			if (pageIndex < 0 || pageIndex >= document.catalog.pages.length) continue;
			const current = rectByPage.get(pageIndex);
			if (current) {
				current[0] = Math.min(current[0], x1);
				current[1] = Math.min(current[1], y1);
				current[2] = Math.max(current[2], x2);
				current[3] = Math.max(current[3], y2);
			} else rectByPage.set(pageIndex, [x1, y1, x2, y2]);
		}
		if (!rectByPage.size) missing.push({ figureId: `block-${blockIndex}`, reason: 'graphic-geometry-unavailable' });
		for (const [pageIndex, rect] of [...rectByPage].sort((left, right) => left[0] - right[0])) {
			const added = addCrop({
				altText: boundedText(cleanText(nodeText(block)), MAX_SOURCE_CROP_ALT_CHARS),
				blockPath: String(blockIndex),
				figureId: null,
				pageIndex,
				placement: 'replace',
				rect,
				source: 'semantic',
				suppressedBlockPaths: [],
			});
			if (!added) missing.push({ figureId: `block-${blockIndex}-p${pageIndex}`, reason: 'crop-budget-exceeded' });
		}
	}
	if (captions.length > MAX_SOURCE_CROPS)
		missing.push({ figureId: `${captions.length - MAX_SOURCE_CROPS} additional figures`, reason: 'visual-analysis-budget-exceeded' });
	const barriers = document.content.map((node) => (node.type === 'paragraph' ? textRects(node) : blockRects(node)));
	for (const { node, index, figureId } of captions.slice(0, MAX_SOURCE_CROPS)) {
		const anchors = blockRects(node);
		if (anchors.length !== 1) {
			missing.push({ figureId, reason: 'caption-geometry-ambiguous' });
			continue;
		}
		const caption = anchors[0]!;
		const [pageIndex, x1, , x2, top] = caption;
		if (pageIndex < 0 || pageIndex >= document.catalog.pages.length) {
			missing.push({ figureId, reason: 'caption-page-unavailable' });
			continue;
		}
		const captionRect: PdfRect = [x1, caption[2], x2, top];
		const semantic = crops.filter(
			(crop) =>
				crop.source === 'semantic' &&
				crop.figureId === null &&
				crop.pageIndex === pageIndex &&
				horizontalOverlap(crop.rect, captionRect) >= Math.min(crop.rect[2] - crop.rect[0], x2 - x1) * 0.5 &&
				crop.rect[1] >= top - 1 &&
				crop.rect[1] - top <= 64,
		);
		if (semantic.length === 1) {
			const cropIndex = crops.indexOf(semantic[0]!);
			crops[cropIndex] = { ...semantic[0]!, figureId };
			continue;
		}
		if (semantic.length > 1) {
			missing.push({ figureId, reason: 'multiple-adjacent-graphics' });
			continue;
		}
		if (crops.length >= MAX_SOURCE_CROPS) {
			missing.push({ figureId, reason: 'crop-budget-exceeded' });
			continue;
		}
		const view = document.catalog.pages[pageIndex]?.viewRect;
		if (!view || view.length !== 4 || !view.every(Number.isFinite)) {
			missing.push({ figureId, reason: 'page-geometry-unavailable' });
			continue;
		}
		const previous = document.content[index - 1];
		const chartPath = previous && isChartLabels(previous, caption) ? String(index - 1) : null;
		const left = Math.max(view[0], x1 - 1),
			right = Math.min(view[2], x2 + 1),
			bottom = top + 6;
		let upper = view[3] - 24;
		let intersectsProse = false;
		for (const [otherIndex, otherRects] of barriers.entries()) {
			if (otherIndex === index || String(otherIndex) === chartPath) continue;
			// Image/table boxes are barriers. For paragraphs prefer actual glyph geometry.
			for (const [page, rx1, ry1, rx2, ry2] of otherRects) {
				if (
					page !== pageIndex ||
					horizontalOverlap([left, bottom, right, upper], [rx1, ry1, rx2, ry2]) < Math.min(right - left, rx2 - rx1) * 0.15
				)
					continue;
				if (ry1 >= bottom) upper = Math.min(upper, ry1 - 3);
				else if (ry2 > bottom) intersectsProse = true;
			}
		}
		const height = upper - bottom,
			width = right - left;
		if (
			intersectsProse ||
			height < 48 ||
			width < 60 ||
			height > (view[3] - view[1]) * 0.58 ||
			width * height > (view[2] - view[0]) * (view[3] - view[1]) * 0.6
		) {
			missing.push({ figureId, reason: intersectsProse ? 'region-overlaps-text' : 'region-not-bounded' });
			continue;
		}
		const rect: PdfRect = [left, bottom, right, upper].map((value) => Math.round(value * 100) / 100) as PdfRect;
		if (
			!addCrop({
				altText: boundedText(cleanText(nodeText(node)), MAX_SOURCE_CROP_ALT_CHARS),
				blockPath: String(index),
				figureId,
				pageIndex,
				placement: 'before',
				rect,
				source: 'caption-region',
				suppressedBlockPaths: chartPath ? [chartPath] : [],
			})
		)
			missing.push({ figureId, reason: 'crop-budget-exceeded' });
	}
	return { crops, excludedAuthorTables: [...excludedAuthorTables], missing };
}

export function structuredPdfSourceCrops(document: StructuredPdfDocument): StructuredPdfSourceCrop[] {
	return structuredPdfVisualPlan(document).crops;
}

export function structuredPdfSourceCropUrl(inputContentHash: string, cropId: string, cropUrlPrefix = '/api/media/asset/pdf-crops'): string {
	return `${cropUrlPrefix}/${inputContentHash}/${cropId}.png`;
}

function firstPageIdentifierText(document: StructuredPdfDocument): string | null {
	const fulltextDocument = document as unknown as Parameters<typeof getFulltextFromStructuredText>[0];
	const pageText = cleanText(getFulltextFromStructuredText(fulltextDocument, [0]));
	const propertyText = Object.entries(document.metadata.source.properties ?? {})
		.filter(([, value]) => typeof value === 'string')
		.map(([key, value]) => `${key}: ${value}`)
		.join('\n');
	const combined = [propertyText, pageText].filter(Boolean).join('\n').slice(0, 20_000).trim();
	return combined || null;
}

export function normalizeStructuredPdf(
	document: StructuredPdfDocument,
	options: Readonly<{ cropUrlPrefix?: string; inputContentHash?: string; readySourceCrops?: readonly StructuredPdfSourceCrop[] }> = {},
) {
	const entries = walkNodes(document.content);
	const referenceEntries = entries.filter(
		(entry): entry is { node: SdtBlockNode; path: number[] } => !('text' in entry.node) && entry.node.reference === true,
	);
	if (referenceEntries.length > MAX_REFERENCES) throw new Error(`Zotero SDT returned more than ${MAX_REFERENCES} references`);
	const referenceKeyByPath = new Map<string, string>();
	const visitedReferencePaths = new Set<string>();
	const references: Array<{ key: string; label: string | null; text: string }> = [];
	const referencePaths = new Set(referenceEntries.map(({ path }) => refKey(path)));
	const includeReferencePart = (path: SdtRefPath, value: unknown) =>
		referencePaths.has(refKey(path)) && !visitedReferencePaths.has(refKey(path)) && isLeafBlock(value as Partial<SdtBlockNode>);
	for (const { node, path } of referenceEntries) {
		if (visitedReferencePaths.has(refKey(path))) continue;
		const candidate = getPartChain(document, path as SdtRefPath, { include: includeReferencePart });
		const chain = candidate.some((part) => sameRef(part.ref, path)) ? candidate : [];
		const parts = chain.length ? chain : [{ block: node, ref: path }];
		const parsed = referenceLabelAndText(
			chain.length ? getLogicalBlockText(document, chain[0]!.ref, { include: includeReferencePart }) : nodeText(node),
		);
		const key = `sdt-${references.length + 1}`;
		for (const part of parts) {
			const partKey = refKey(part.ref);
			visitedReferencePaths.add(partKey);
			if (parsed.text) referenceKeyByPath.set(partKey, key);
		}
		if (parsed.text) references.push({ key, ...parsed });
	}
	const headingLevelByPath = headingLevels(document.catalog.outline);
	const visualPlan = structuredPdfVisualPlan(document);
	const suppressedBlockPaths = new Set<string>();
	const sourceCropsByBlock = new Map<string, Array<{ altText: string; placement: 'before' | 'replace'; url: string }>>();
	if (options.inputContentHash && options.readySourceCrops?.length) {
		const readyIds = new Set(options.readySourceCrops.map(({ id }) => id));
		for (const crop of visualPlan.crops.filter(({ id }) => readyIds.has(id))) {
			const entry = {
				altText: crop.altText,
				placement: crop.placement,
				url: structuredPdfSourceCropUrl(options.inputContentHash, crop.id, options.cropUrlPrefix),
			};
			for (const path of crop.suppressedBlockPaths) suppressedBlockPaths.add(path);
			const existing = sourceCropsByBlock.get(crop.blockPath);
			if (existing) existing.push(entry);
			else sourceCropsByBlock.set(crop.blockPath, [entry]);
		}
	}
	let section: string | null = null;
	const renderedPartPaths = new Set<string>();
	const mentions: StructuredPdfCitationMention[] = [];
	const citedKeys = new Set<string>();
	function inline(nodes: readonly SdtNode[], inheritedItalic = false): PhrasingContent[] {
		const children: PhrasingContent[] = [];
		const context = boundedText(cleanText(nodes.map(nodeText).join('')), MAX_CITATION_CONTEXT_CHARS);
		const ignoredReferences = statisticalReferenceNodes(nodes, referenceKeyByPath);
		let plain: SdtTextNode[] = [];
		function flush() {
			// PDF glyph runs have different anchors. Once projected to prose, let SDT
			// merge equal styles/links so adjacent emphasis delimiters cannot collide.
			for (const node of mergeTextNodes(plain)) {
				let child: PhrasingContent = { type: 'text', value: node.text };
				if (node.style?.bold) child = { type: 'strong', children: [child] };
				if (node.style?.italic) child = { type: 'emphasis', children: [child] };
				if (node.target?.url && node.text.trim()) child = { type: 'link', url: node.target.url, children: [child] };
				const previous = children.at(-1);
				if (child.type === 'emphasis' && previous?.type === 'emphasis') previous.children.push(...child.children);
				else children.push(child);
			}
			plain = [];
		}
		for (const node of nodes) {
			if (!('text' in node)) continue;
			const value = node.text.replaceAll('\0', '').replace(/\s+/gu, ' ');
			const markerText = value.trim();
			const targetKeys = ignoredReferences.has(node) ? [] : (node.refs ?? []).flatMap((path) => referenceKeyByPath.get(refKey(path)) ?? []);
			if (
				context &&
				targetKeys.length &&
				markerText &&
				markerText.length <= MAX_CITATION_MARKER_CHARS &&
				mentions.length < MAX_CITATION_MENTIONS
			) {
				flush();
				if (value.startsWith(' ')) children.push({ type: 'text', value: ' ' });
				mentions.push({
					context,
					markerText,
					section: section ? boundedText(cleanText(section), MAX_SECTION_CHARS) : null,
					targetKeys: [...new Set(targetKeys)],
				});
				for (const key of new Set(targetKeys)) {
					citedKeys.add(key);
					children.push({ type: 'footnoteReference', identifier: `paper-${key}` });
				}
				if (value.endsWith(' ')) children.push({ type: 'text', value: ' ' });
			} else if (value) {
				const url = safeHttpUrl(node.target?.url);
				plain.push({
					text: value,
					style: { bold: !!node.style?.bold, italic: !inheritedItalic && !!node.style?.italic },
					...(url ? { target: { url } } : {}),
				});
			}
		}
		flush();
		return children;
	}
	function blocks(nodes: readonly SdtNode[], path: RefPath): BlockContent[] {
		const children: BlockContent[] = [];
		let phrasing: SdtTextNode[] = [];
		function flush() {
			if (phrasing.length) children.push({ type: 'paragraph', children: inline(phrasing) });
			phrasing = [];
		}
		for (const [index, node] of nodes.entries()) {
			if ('text' in node) phrasing.push(node);
			else {
				flush();
				children.push(...toBlock(node, [...path, index]));
			}
		}
		flush();
		return children;
	}
	function cellPhrasing(nodes: readonly RootContent[]): PhrasingContent[] {
		return nodes.flatMap((node, index): PhrasingContent[] => {
			const children: PhrasingContent[] =
				node.type === 'paragraph' || node.type === 'heading'
					? node.children
					: 'value' in node
						? [{ type: 'text', value: cleanText(node.value) }]
						: 'children' in node
							? cellPhrasing(node.children)
							: [];
			return index && children.length ? [{ type: 'text', value: ' ' }, ...children] : children;
		});
	}
	function toBlock(node: SdtBlockNode, path: RefPath): BlockContent[] {
		if (node.flowClass === 'excluded' || renderedPartPaths.has(refKey(path))) return [];
		const parentPath = path.slice(0, -1);
		const parts = getPartChain(document, path as SdtRefPath, {
			include: (partPath, value) => {
				const part = value as Partial<SdtBlockNode>;
				return (
					sameRef(partPath.slice(0, -1), parentPath) &&
					!renderedPartPaths.has(refKey(partPath)) &&
					part.type === 'paragraph' &&
					part.flowClass !== 'excluded' &&
					isLeafBlock(part)
				);
			},
		});
		if (parts.length >= 2 && sameRef(parts[0]!.ref, path)) {
			node = mergeParagraphParts(parts as Array<{ block: SdtBlockNode }>);
			for (const part of parts.slice(1)) renderedPartPaths.add(refKey(part.ref));
		}
		renderedPartPaths.add(refKey(path));
		if (suppressedBlockPaths.has(refKey(path))) return [];
		const crops = sourceCropsByBlock.get(refKey(path));
		if (crops?.length) {
			const images: BlockContent[] = crops.map(({ altText, url }) => ({
				type: 'paragraph',
				children: [{ type: 'image', alt: altText, url }],
			}));
			if (crops[0]?.placement === 'before')
				images.push({ type: 'paragraph', children: [{ type: 'emphasis', children: inline(node.content, true) }] });
			return images;
		}
		if (node.type === 'heading') {
			section = cleanText(nodeText(node)) || section;
			return [{ type: 'heading', depth: (headingLevelByPath.get(refKey(path)) ?? 2) as Heading['depth'], children: inline(node.content) }];
		}
		if (node.type === 'preformatted') return [{ type: 'code', lang: 'text', value: nodeText(node).replaceAll('\0', '').trimEnd() }];
		if (node.type === 'blockquote') return [{ type: 'blockquote', children: blocks(node.content, path) }];
		if (node.type === 'list') {
			return [
				{
					type: 'list',
					ordered: node.ordered ?? false,
					start: node.startIndex ?? 1,
					children: node.content.flatMap((item, index) =>
						'text' in item || item.flowClass === 'excluded'
							? []
							: [
									{
										type: 'listItem' as const,
										children: blocks(item.content, [...path, index]),
									},
								],
					),
				},
			];
		}
		if (node.type === 'table' && !isLeafBlock(node)) {
			const children: Table['children'] = [];
			for (const [rowIndex, row] of node.content.entries()) {
				if ('text' in row || row.type !== 'tablerow' || row.flowClass === 'excluded') continue;
				children.push({
					type: 'tableRow',
					children: row.content.flatMap((cell, cellIndex) => {
						if ('text' in cell || cell.type !== 'tablecell') return [];
						// GFM cells are inline-only; reuse the block pipeline before flattening.
						const parentSection = section;
						const content = cellPhrasing(toBlock(cell, [...path, rowIndex, cellIndex]));
						section = parentSection;
						return [{ type: 'tableCell' as const, children: content }];
					}),
				});
			}
			return children.length ? [{ type: 'table', children }] : blocks(node.content, path);
		}
		if (!isLeafBlock(node)) return blocks(node.content, path);
		const children = inline(node.content, node.type === 'caption');
		// SDT math contains extracted text, not guaranteed LaTeX; do not invent TeX.
		return children.length ? [{ type: 'paragraph', children: node.type === 'caption' ? [{ type: 'emphasis', children }] : children }] : [];
	}
	const tree: Root = { type: 'root', children: blocks(document.content, []) };
	// Citation identity is native Markdown, so removing images or translating prose
	// never requires remapping character offsets. The printed bibliography stays intact.
	for (const reference of references) {
		if (!citedKeys.has(reference.key)) continue;
		tree.children.push({
			type: 'footnoteDefinition',
			identifier: `paper-${reference.key}`,
			children: [{ type: 'paragraph', children: [{ type: 'text', value: reference.text }] }],
		});
	}
	const markdown = toMarkdown(tree, {
		bullet: '-',
		emphasis: '_',
		extensions: [gfmToMarkdown({ tablePipeAlign: false })],
	}).trimEnd();
	const readyCropIds = new Set((options.readySourceCrops ?? []).map(({ id }) => id));
	const missingCrops = visualPlan.crops.filter(({ id }) => !readyCropIds.has(id));
	const visual = {
		planned: visualPlan.crops.length,
		ready: visualPlan.crops.length - missingCrops.length,
		missing: [...visualPlan.missing, ...missingCrops.map(({ figureId, id }) => ({ figureId: figureId ?? id, reason: 'crop-not-ready' }))],
		inferred: visualPlan.crops.filter(({ source }) => source === 'caption-region').length,
		excludedAuthorTables: visualPlan.excludedAuthorTables.length,
	};
	const fallbackReasons = new Set<string>();
	if (visual.missing.length) fallbackReasons.add('incomplete-visuals');
	if (visual.inferred) fallbackReasons.add('caption-region-inferred');
	if (!markdown) fallbackReasons.add('empty-output');
	if (document.catalog.pages.some(({ extractionDegraded }) => extractionDegraded === true)) fallbackReasons.add('degraded-page');
	const fulltextDocument = document as unknown as Parameters<typeof getFulltextFromStructuredText>[0];
	const fullPageImagePages = document.catalog.pages.filter((_, index) => !getFulltextFromStructuredText(fulltextDocument, [index])).length;
	return {
		markdown,
		mentions,
		paperIdentifierText: firstPageIdentifierText(document),
		parse: {
			fallbackReasons: [...fallbackReasons].sort(),
			visual,
			fullPageImagePages,
			parserVersion: `zotero-pdf-${document.metadata.processor.version}/sdt-${document.schemaVersion}`,
			totalPages: document.catalog.pages.length,
		},
		references,
	};
}

export function structuredPdfStorageKey(pdfStorageKey: string): string {
	return `${pdfStorageKey}.structured-document.json`;
}

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

export function hasPrivatePdfImages(markdown: string): boolean {
	return markdown.includes(PRIVATE_PDF_CROP_PATH) && withoutPrivatePdfImages(markdown) !== markdown.trim();
}

/** A newly attached upload cannot replace citations from a different retained public body. */
export function matchesUploadedPdfRendition(storedContent: string, uploadedContent: string): boolean {
	return storedContent === uploadedContent || storedContent === withoutPrivatePdfImages(uploadedContent);
}
