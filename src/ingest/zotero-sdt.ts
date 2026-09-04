import { getFulltextFromStructuredText } from 'structured-document-text/src/fulltext.js';
import { getPartBoundarySeparator, getPartChain, shouldDropHardHyphenAtPartBoundary } from 'structured-document-text/src/parts.js';
import { refKey } from 'structured-document-text/src/range.js';
import type { LocalPdfSummary } from './platforms/pdf-fallback-policy.ts';

const MAX_DOCUMENT_JSON_BYTES = 32 * 1024 * 1024;
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
const POSTGRES_NUL = String.fromCharCode(0);
const INPUT_HASH_PATTERN = /^[a-f\d]{64}$/u;

export const ZOTERO_SDT_ARTIFACT_VERSION = 'newsence-zotero-sdt-v1';
export const ZOTERO_SDT_CONTAINER_NAME = 'structured-pdf-v1';
export const ZOTERO_SDT_CONTENT_TYPE = 'application/vnd.newsence.structured-document+json';
export const ZOTERO_SDT_MAX_RESPONSE_BYTES = MAX_DOCUMENT_JSON_BYTES;

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

type PdfAnchor = Readonly<{
	pageRects?: readonly (readonly [number, number, number, number, number])[];
	textMap?: string;
}>;

type SdtTextNode = Readonly<{
	anchor?: PdfAnchor;
	refs?: readonly RefPath[];
	style?: Readonly<{ bold?: boolean; italic?: boolean; monospace?: boolean; sub?: boolean; sup?: boolean }>;
	target?: Readonly<{ url?: string }>;
	text: string;
}>;

type SdtBlockNode = Readonly<{
	anchor?: PdfAnchor;
	content: readonly SdtNode[];
	flowClass?: 'auxiliary' | 'excluded';
	nextPart?: RefPath;
	previousPart?: RefPath;
	reference?: boolean;
	refs?: readonly RefPath[];
	type:
		| 'blockquote'
		| 'caption'
		| 'heading'
		| 'image'
		| 'list'
		| 'listitem'
		| 'math'
		| 'note'
		| 'paragraph'
		| 'preformatted'
		| 'table'
		| 'tablecell'
		| 'tablerow';
	ordered?: boolean;
	startIndex?: number;
}>;

type SdtNode = SdtBlockNode | SdtTextNode;

export type StructuredPdfDocument = Readonly<{
	catalog: Readonly<{
		outline: readonly SdtOutlineItem[];
		pages: readonly Readonly<{
			contentRange: readonly [RefPath, RefPath];
			extractionDegraded?: boolean;
			textSource?: 'born-digital' | 'ocr';
		}>[];
	}>;
	content: readonly SdtBlockNode[];
	metadata: Readonly<{
		characterCount?: number;
		processor: Readonly<{ type: 'pdf'; version: number }>;
		source: Readonly<{
			contentType: 'application/pdf';
			hash: string;
			properties?: Readonly<Record<string, unknown>>;
		}>;
	}>;
	schemaVersion: string;
}>;

type SdtOutlineItem = Readonly<{
	children?: readonly SdtOutlineItem[];
	ref?: RefPath;
	title: string;
}>;

export type StructuredPdfReference = Readonly<{
	key: string;
	label: string | null;
	text: string;
}>;

export type StructuredPdfCitationMention = Readonly<{
	contentEnd: number;
	contentStart: number;
	context: string;
	markerText: string;
	section: string | null;
	targetKeys: string[];
}>;

export type StructuredPdfSourceCrop = Readonly<{
	altText: string;
	blockPath: string;
	id: string;
	kind: 'image' | 'table';
	pageIndex: number;
	rect: readonly [number, number, number, number];
}>;

export type NormalizedStructuredPdf = Readonly<{
	markdown: string;
	mentions: StructuredPdfCitationMention[];
	paperIdentifierText: string | null;
	parse: LocalPdfSummary;
	references: StructuredPdfReference[];
	sourceCrops: readonly StructuredPdfSourceCrop[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRefPath(value: unknown, field: string): asserts value is number[] {
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > MAX_REF_PATH_DEPTH ||
		value.some((part) => !Number.isInteger(part) || part < 0)
	) {
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

function assertSdtNodes(value: unknown, state: { characters: number; nodes: number }, path: string): asserts value is SdtNode[] {
	if (!Array.isArray(value)) throw new Error(`Zotero SDT ${path} is not an array`);
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
			assertSdtNodes(node.content, state, `${path}[${index}].content`);
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
	if (new TextEncoder().encode(json).byteLength > MAX_DOCUMENT_JSON_BYTES) {
		throw new Error(`Zotero SDT JSON exceeded ${MAX_DOCUMENT_JSON_BYTES} bytes`);
	}
	const value: unknown = JSON.parse(json);
	if (!isRecord(value) || typeof value.schemaVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value.schemaVersion)) {
		throw new Error('Zotero SDT schema version is invalid');
	}
	if (!isRecord(value.metadata) || !isRecord(value.metadata.processor) || !isRecord(value.metadata.source)) {
		throw new Error('Zotero SDT metadata is invalid');
	}
	if (
		value.metadata.processor.type !== 'pdf' ||
		!Number.isInteger(value.metadata.processor.version) ||
		value.metadata.source.contentType !== 'application/pdf' ||
		typeof value.metadata.source.hash !== 'string' ||
		!/^[a-f\d]{32}$/u.test(value.metadata.source.hash)
	) {
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
	return value.split(POSTGRES_NUL).join('').replace(/\s+/gu, ' ').trim();
}

function boundedText(value: string, maxChars: number): string {
	return value.length > maxChars ? `${value.slice(0, maxChars - 1).trimEnd()}…` : value;
}

function nodeText(node: SdtNode): string {
	return 'text' in node ? node.text : node.content.map(nodeText).join('');
}

function isInlineContent(nodes: readonly SdtNode[]): nodes is readonly SdtTextNode[] {
	return nodes.every((node) => 'text' in node);
}

type ParagraphPart = Readonly<{ block: SdtBlockNode; index: number }>;

function paragraphPartChain(document: StructuredPdfDocument, startIndex: number): ParagraphPart[] | null {
	const chain = getPartChain(document, [startIndex], {
		include: (path, value) => {
			const block = value as Partial<SdtBlockNode>;
			return path.length === 1 && block.type === 'paragraph' && block.flowClass !== 'excluded' && isInlineContent(block.content ?? []);
		},
	});
	if (chain.length < 2 || chain[0]?.ref[0] !== startIndex) return null;
	return chain.map(({ block, ref }) => ({ block: block as SdtBlockNode, index: ref[0]! }));
}

function mergeParagraphParts(chain: readonly ParagraphPart[]): SdtBlockNode {
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
	const entries: Array<{ node: SdtNode; path: number[] }> = [];
	for (const [index, node] of nodes.entries()) {
		const path = [...parentPath, index];
		entries.push({ node, path });
		if ('content' in node) entries.push(...walkNodes(node.content, path));
	}
	return entries;
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

function headingLevels(outline: readonly SdtOutlineItem[]): Map<string, number> {
	const levels = new Map<string, number>();
	const visit = (items: readonly SdtOutlineItem[], depth: number) => {
		for (const item of items) {
			if (item.ref) levels.set(refKey(item.ref), Math.min(6, Math.max(1, depth)));
			if (item.children) visit(item.children, depth + 1);
		}
	};
	visit(outline, 2);
	return levels;
}

function safeHttpUrl(value: string | undefined): string | null {
	if (!value || value.length > 2_048) return null;
	const url = URL.parse(value);
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
	return url.toString().replaceAll('\\', '%5C').replaceAll('(', '%28').replaceAll(')', '%29');
}

function escapeMarkdownText(value: string): string {
	return value.replace(/([\\`*_<>[\]])/gu, '\\$1');
}

class MarkdownWriter {
	private readonly chunks: string[] = [];
	private length = 0;
	readonly mentions: StructuredPdfCitationMention[] = [];

	append(value: string): void {
		if (!value) return;
		this.chunks.push(value);
		this.length += value.length;
	}

	appendCitation(markerText: string, context: string, section: string | null, targetKeys: readonly string[]): void {
		const normalized = markerText.replace(/\s+/gu, ' ');
		const trimmed = normalized.trim();
		if (!trimmed || trimmed.length > MAX_CITATION_MARKER_CHARS || trimmed.includes('\n') || this.mentions.length >= MAX_CITATION_MENTIONS) {
			this.append(escapeMarkdownText(normalized));
			return;
		}
		const leading = normalized.length - normalized.trimStart().length;
		const trailing = normalized.length - normalized.trimEnd().length;
		if (leading) this.append(escapeMarkdownText(normalized.slice(0, leading)));
		const contentStart = this.length;
		this.append(trimmed);
		const contentEnd = this.length;
		this.mentions.push({
			contentEnd,
			contentStart,
			context: boundedText(cleanText(context), MAX_CITATION_CONTEXT_CHARS),
			markerText: trimmed,
			section: section ? boundedText(cleanText(section), MAX_SECTION_CHARS) : null,
			targetKeys: [...new Set(targetKeys)],
		});
		if (trailing) this.append(escapeMarkdownText(normalized.slice(normalized.length - trailing)));
	}

	toString(): string {
		// Preserve any leading source whitespace because citation offsets were
		// recorded while writing. Removing trailing whitespace cannot shift them.
		return this.chunks.join('').trimEnd();
	}
}

function renderInline(
	writer: MarkdownWriter,
	nodes: readonly SdtNode[],
	context: string,
	section: string | null,
	referenceKeyByPath: ReadonlyMap<string, string>,
): void {
	for (const node of nodes) {
		if (!('text' in node)) {
			renderInline(writer, node.content, context, section, referenceKeyByPath);
			continue;
		}
		const citationTargets = (node.refs ?? []).flatMap((path) => referenceKeyByPath.get(refKey(path)) ?? []);
		if (citationTargets.length) {
			writer.appendCitation(node.text, context, section, citationTargets);
			continue;
		}
		const normalized = node.text.replace(/\s+/gu, ' ');
		let text = escapeMarkdownText(normalized);
		if (node.style?.monospace && text) text = `\`${text.replaceAll('`', '\\`')}\``;
		else {
			if (node.style?.bold && text) text = `**${text}**`;
			if (node.style?.italic && text) text = `_${text}_`;
		}
		const url = safeHttpUrl(node.target?.url);
		writer.append(url && cleanText(normalized) ? `[${text}](${url})` : text);
	}
}

function shouldRenderSourceCrop(node: SdtBlockNode): node is SdtBlockNode & { type: 'image' | 'table' } {
	return node.type === 'image' || (node.type === 'table' && isInlineContent(node.content));
}

/**
 * Zotero Reading Mode renders semantic image nodes and flat tables by
 * cropping their source rectangles from the PDF. Keep the same geometry as a
 * durable, bounded contract so the original PDF remains the rendering source.
 */
export function structuredPdfSourceCrops(document: StructuredPdfDocument): StructuredPdfSourceCrop[] {
	const crops: StructuredPdfSourceCrop[] = [];
	for (const [blockIndex, block] of document.content.entries()) {
		if (block.flowClass === 'excluded' || !shouldRenderSourceCrop(block)) continue;
		const rectByPage = new Map<number, [number, number, number, number]>();
		for (const [pageIndex, x1, y1, x2, y2] of block.anchor?.pageRects ?? []) {
			if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= document.catalog.pages.length || !(x2 > x1) || !(y2 > y1)) {
				continue;
			}
			const current = rectByPage.get(pageIndex);
			if (current) {
				current[0] = Math.min(current[0], x1);
				current[1] = Math.min(current[1], y1);
				current[2] = Math.max(current[2], x2);
				current[3] = Math.max(current[3], y2);
			} else {
				rectByPage.set(pageIndex, [x1, y1, x2, y2]);
			}
		}
		const blockPath = String(blockIndex);
		const altText = boundedText(cleanText(nodeText(block)), MAX_SOURCE_CROP_ALT_CHARS);
		for (const [pageIndex, rect] of [...rectByPage].sort((left, right) => left[0] - right[0])) {
			if (crops.length >= MAX_SOURCE_CROPS) return crops;
			crops.push({
				altText,
				blockPath,
				id: `${blockPath}-p${pageIndex}`,
				kind: block.type,
				pageIndex,
				rect,
			});
		}
	}
	return crops;
}

export function structuredPdfSourceCropUrl(inputContentHash: string, cropId: string): string {
	if (!INPUT_HASH_PATTERN.test(inputContentHash)) throw new TypeError('Structured PDF input content hash is invalid');
	if (!/^\d+(?:\.\d+)*-p\d+$/u.test(cropId)) throw new TypeError('Structured PDF source crop ID is invalid');
	return `/api/media/asset/pdf-crops/${inputContentHash}/${cropId}.png`;
}

function renderTableRow(
	writer: MarkdownWriter,
	row: SdtBlockNode,
	section: string | null,
	referenceKeyByPath: ReadonlyMap<string, string>,
): void {
	const cells = row.content.filter((node): node is SdtBlockNode => !('text' in node) && node.type === 'tablecell');
	writer.append('| ');
	for (const [index, cell] of cells.entries()) {
		if (index) writer.append(' | ');
		const text = cleanText(nodeText(cell));
		renderInline(writer, [{ text }], text, section, referenceKeyByPath);
	}
	writer.append(' |\n');
}

function renderBlock(
	writer: MarkdownWriter,
	node: SdtBlockNode,
	path: RefPath,
	section: string | null,
	referenceKeyByPath: ReadonlyMap<string, string>,
	headingLevelByPath: ReadonlyMap<string, number>,
	sourceCropsByBlock: ReadonlyMap<string, readonly Readonly<{ altText: string; url: string }>[]>,
): string | null {
	if (node.flowClass === 'excluded') return section;
	const context = cleanText(nodeText(node));
	const sourceCrops = shouldRenderSourceCrop(node) ? sourceCropsByBlock.get(refKey(path)) : undefined;
	if (sourceCrops?.length) {
		for (const crop of sourceCrops) writer.append(`![${escapeMarkdownText(crop.altText)}](${crop.url})\n\n`);
		return section;
	}
	if (node.type === 'heading') {
		const nextSection = context || section;
		const level = headingLevelByPath.get(refKey(path)) ?? 2;
		writer.append(`${'#'.repeat(level)} `);
		renderInline(writer, node.content, context, nextSection, referenceKeyByPath);
		writer.append('\n\n');
		return nextSection;
	}
	if (node.type === 'paragraph' || node.type === 'caption' || node.type === 'image' || node.type === 'math' || node.type === 'note') {
		if (node.type === 'caption') writer.append('_');
		if (node.type === 'math') writer.append('$$ ');
		renderInline(writer, node.content, context, section, referenceKeyByPath);
		if (node.type === 'math') writer.append(' $$');
		if (node.type === 'caption') writer.append('_');
		writer.append('\n\n');
		return section;
	}
	if (node.type === 'preformatted') {
		writer.append('```text\n');
		writer.append(nodeText(node).replaceAll(POSTGRES_NUL, '').trimEnd());
		writer.append('\n```\n\n');
		return section;
	}
	if (node.type === 'blockquote') {
		for (const child of node.content) {
			if ('text' in child) {
				writer.append('> ');
				renderInline(writer, [child], context, section, referenceKeyByPath);
				writer.append('\n');
			} else {
				section = renderBlock(writer, child, path, section, referenceKeyByPath, headingLevelByPath, sourceCropsByBlock);
			}
		}
		writer.append('\n');
		return section;
	}
	if (node.type === 'list') {
		for (const [index, item] of node.content.entries()) {
			if ('text' in item) continue;
			writer.append(node.ordered ? `${(node.startIndex ?? 1) + index}. ` : '- ');
			const itemContext = cleanText(nodeText(item));
			if (isInlineContent(item.content)) renderInline(writer, item.content, itemContext, section, referenceKeyByPath);
			else {
				for (const child of item.content) {
					if ('text' in child) renderInline(writer, [child], itemContext, section, referenceKeyByPath);
					else section = renderBlock(writer, child, [...path, index], section, referenceKeyByPath, headingLevelByPath, sourceCropsByBlock);
				}
			}
			writer.append('\n');
		}
		writer.append('\n');
		return section;
	}
	if (node.type === 'table') {
		const rows = node.content.filter((child): child is SdtBlockNode => !('text' in child) && child.type === 'tablerow');
		if (rows.length) {
			renderTableRow(writer, rows[0]!, section, referenceKeyByPath);
			const columns = rows[0]!.content.filter((child) => !('text' in child) && child.type === 'tablecell').length;
			writer.append(`| ${Array.from({ length: columns }, () => '---').join(' | ')} |\n`);
			for (const row of rows.slice(1)) renderTableRow(writer, row, section, referenceKeyByPath);
		} else {
			renderInline(writer, node.content, context, section, referenceKeyByPath);
		}
		writer.append('\n');
		return section;
	}
	if (isInlineContent(node.content)) renderInline(writer, node.content, context, section, referenceKeyByPath);
	else {
		for (const [index, child] of node.content.entries()) {
			if ('text' in child) renderInline(writer, [child], context, section, referenceKeyByPath);
			else section = renderBlock(writer, child, [...path, index], section, referenceKeyByPath, headingLevelByPath, sourceCropsByBlock);
		}
	}
	return section;
}

function firstPageIdentifierText(document: StructuredPdfDocument): string | null {
	const firstPage = document.catalog.pages[0];
	const start = firstPage?.contentRange[0][0] ?? 0;
	const end = firstPage?.contentRange[1][0] ?? Math.min(document.content.length, start + 20);
	const pageText = cleanText(
		document.content
			.slice(start, Math.min(document.content.length, end + 1))
			.map(nodeText)
			.join(' '),
	);
	const propertyText = Object.entries(document.metadata.source.properties ?? {})
		.filter(([, value]) => typeof value === 'string')
		.map(([key, value]) => `${key}: ${value}`)
		.join('\n');
	const combined = [propertyText, pageText].filter(Boolean).join('\n').slice(0, 20_000).trim();
	return combined || null;
}

export function normalizeStructuredPdf(
	document: StructuredPdfDocument,
	options: Readonly<{ inputContentHash?: string; readySourceCropIds?: ReadonlySet<string> }> = {},
): NormalizedStructuredPdf {
	const entries = walkNodes(document.content);
	const referenceEntries = entries.filter(
		(entry): entry is { node: SdtBlockNode; path: number[] } => !('text' in entry.node) && entry.node.reference === true,
	);
	if (referenceEntries.length > MAX_REFERENCES) throw new Error(`Zotero SDT returned more than ${MAX_REFERENCES} references`);
	const referenceKeyByPath = new Map(referenceEntries.map(({ path }, index) => [refKey(path), `sdt-${index + 1}`]));
	const references = referenceEntries.flatMap(({ node, path }) => {
		const parsed = referenceLabelAndText(nodeText(node));
		return parsed.text ? [{ key: referenceKeyByPath.get(refKey(path))!, ...parsed }] : [];
	});
	const writer = new MarkdownWriter();
	const headingLevelByPath = headingLevels(document.catalog.outline);
	const sourceCrops = structuredPdfSourceCrops(document);
	const sourceCropsByBlock = new Map<string, Array<{ altText: string; url: string }>>();
	if (options.inputContentHash && options.readySourceCropIds?.size) {
		for (const crop of sourceCrops) {
			if (!options.readySourceCropIds.has(crop.id)) continue;
			const entry = { altText: crop.altText, url: structuredPdfSourceCropUrl(options.inputContentHash, crop.id) };
			const existing = sourceCropsByBlock.get(crop.blockPath);
			if (existing) existing.push(entry);
			else sourceCropsByBlock.set(crop.blockPath, [entry]);
		}
	}
	let section: string | null = null;
	const renderedPartPaths = new Set<string>();
	for (let index = 0; index < document.content.length; index += 1) {
		const block = document.content[index];
		const blockPath: RefPath = [index];
		if (!block || block.flowClass === 'excluded' || renderedPartPaths.has(refKey(blockPath))) continue;
		const partChain = paragraphPartChain(document, index);
		const renderableBlock = partChain ? mergeParagraphParts(partChain) : block;
		for (const part of partChain?.slice(1) ?? []) renderedPartPaths.add(refKey([part.index]));
		section = renderBlock(writer, renderableBlock, blockPath, section, referenceKeyByPath, headingLevelByPath, sourceCropsByBlock);
	}
	const markdown = writer.toString();
	const fallbackReasons = new Set<string>();
	if (!markdown) fallbackReasons.add('empty-output');
	if (document.catalog.pages.some(({ extractionDegraded }) => extractionDegraded === true)) fallbackReasons.add('degraded-page');
	const fulltextDocument = document as unknown as Parameters<typeof getFulltextFromStructuredText>[0];
	const fullPageImagePages = document.catalog.pages.reduce(
		(count, _page, index) => count + (getFulltextFromStructuredText(fulltextDocument, [index]) ? 0 : 1),
		0,
	);
	return {
		markdown,
		mentions: writer.mentions.filter(({ context, targetKeys }) => context && targetKeys.length),
		paperIdentifierText: firstPageIdentifierText(document),
		parse: {
			fallbackReasons: [...fallbackReasons].sort(),
			fullPageImagePages,
			parsedPages: document.catalog.pages.length,
			parserVersion: `zotero-pdf-${document.metadata.processor.version}/sdt-${document.schemaVersion}`,
			totalPages: document.catalog.pages.length,
		},
		references,
		sourceCrops,
	};
}

export function structuredPdfStorageKey(pdfStorageKey: string): string {
	return `${pdfStorageKey}.structured-document.json`;
}
