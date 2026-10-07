import { hash } from 'node:crypto';
import type { Heading, Nodes, Paragraph, Parents, PhrasingContent, Root, RootContent, TableCell, Text } from 'mdast';
import { parseMarkdown as parseDialect, stringifyMarkdown } from '../contracts/markdown';

// Batches are sized by source length (about 1k source tokens) so a response, reasoning included, stays far below its cap.
const MAX_BATCH_CHARACTERS = 4_000;
const MAX_BATCH_SEGMENTS = 24;
const MAX_CONTEXT_CHARACTERS = 800;
const MAX_SEGMENT_CHARACTERS = 3_000;
const MAX_ATOM_HINT_CHARACTERS = 120;
const TRANSLATABLE_CHARACTER = /[\p{L}\p{N}]/u;
const URL_OR_EMAIL = /^(?:https?:\/\/|mailto:|www\.)\S+$|^[^\s@]+@[^\s@]+\.[^\s@]+$/iu;
// `<1>…</1>` wraps formatted text the model translates and may move; `{{1}}` stands for an inline it keeps verbatim.
const MARKER = /<(\/?)(\d+)>|\{\{(\d+)\}\}/gu;
const HAS_MARKER = /<\/?\d+>|\{\{\d+\}\}/u;
const BLANK_LINE = /\n[\t ]*\n/u;

type ProseBlock = Heading | Paragraph | TableCell;

type BlockShape = Readonly<{ type: 'heading'; depth: Heading['depth'] } | { type: 'paragraph' } | { type: 'tableCell' }>;

type MarkedInline = Readonly<{ kind: 'atom' | 'tag'; node: PhrasingContent }>;

export type MarkdownTranslationSegment = Readonly<{
	/** Model-facing hints for `{{n}}` atoms whose wording shapes the sentence, such as code or formulas. */
	atoms: Readonly<Record<string, string>>;
	block: BlockShape;
	context: string | null;
	id: string;
	inlines: Readonly<Record<string, MarkedInline>>;
	/** The block's prose with its formatting as numbered tags and its atoms as placeholders. */
	text: string;
}>;

/** A segment's verified translation in the segment's own tag syntax, keyed by segment ID. */
export type MarkdownSegmentTranslations = Readonly<Record<string, string>>;

type MarkdownBlockTranslationPart = Readonly<{ segmentId: string }> | Readonly<{ source: PhrasingContent[] }>;

type MarkdownBlockTranslationTarget = Readonly<{
	parts: readonly MarkdownBlockTranslationPart[];
	path: readonly number[];
}>;

type PlanAccumulator = {
	segments: MarkdownTranslationSegment[];
	targets: MarkdownBlockTranslationTarget[];
};

type VisitContext = Readonly<{
	heading: string | null;
	path: readonly number[];
}>;

type MarkdownTranslationInvariantCode = 'invalid-plan' | 'invalid-result' | 'markdown-structure-changed' | 'source-not-roundtrippable';

export class MarkdownTranslationInvariantError extends Error {
	readonly code: MarkdownTranslationInvariantCode;

	constructor(code: MarkdownTranslationInvariantCode, message: string) {
		super(message);
		this.code = code;
		this.name = 'MarkdownTranslationInvariantError';
	}
}

function parseMarkdown(markdown: string): Root {
	const tree = parseDialect(markdown);
	const offsets = currencyDelimiterOffsets(tree, markdown);
	if (!offsets.length) return tree;
	let escaped = markdown;
	for (const offset of offsets.sort((left, right) => right - left)) {
		escaped = `${escaped.slice(0, offset)}\\${escaped.slice(offset)}`;
	}
	return parseDialect(escaped);
}

function isCurrencyMath(source: string, start: number, end: number): boolean {
	return source.slice(start, start + 2) !== '$$' && /\p{Nd}/u.test(source[start + 1] ?? '') && /\p{Nd}/u.test(source[end] ?? '');
}

function isParent(node: Nodes): node is Parents {
	return 'children' in node && Array.isArray(node.children);
}

function currencyDelimiterOffsets(tree: Root, source: string): number[] {
	const offsets: number[] = [];
	const visit = (node: Nodes): void => {
		if (node.type === 'inlineMath') {
			const start = node.position?.start.offset;
			const end = node.position?.end.offset;
			// micromark can read two prices such as "$57 ... $60" as one inline-math node. Override the package only
			// when both delimiters introduce numeric currency amounts; formula length and contents are not evidence,
			// because valid TeX is often long and may contain Markdown-like punctuation.
			if (
				start !== undefined &&
				end !== undefined &&
				source[start] === '$' &&
				source[end - 1] === '$' &&
				isCurrencyMath(source, start, end)
			) {
				offsets.push(start, end - 1);
			}
		}
		if (isParent(node)) {
			for (const child of node.children) visit(child);
		}
	};
	visit(tree);
	return offsets;
}

function isProseBlock(node: Nodes): node is ProseBlock {
	return node.type === 'heading' || node.type === 'paragraph' || node.type === 'tableCell';
}

function translatablePlainText(node: Nodes, ancestors: readonly Nodes[] = []): string {
	if (node.type === 'text') return isProtectedLinkText(node.value, ancestors) ? '' : node.value;
	if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
	if (node.type === 'break') return '\n';
	if (!isParent(node)) return '';
	return node.children.map((child) => translatablePlainText(child, [...ancestors, node])).join('');
}

function normalizedAutolinkDestination(value: string): string {
	return value.toLowerCase().startsWith('mailto:') ? value.slice('mailto:'.length) : value;
}

function isProtectedLinkText(value: string, ancestors: readonly Nodes[]): boolean {
	const link = [...ancestors].reverse().find((ancestor) => ancestor.type === 'link');
	if (link?.type !== 'link') return false;
	return normalizedAutolinkDestination(link.url) === normalizedAutolinkDestination(value);
}

function isTranslatableProse(value: string): boolean {
	const trimmed = value.trim();
	return Boolean(trimmed && TRANSLATABLE_CHARACTER.test(trimmed) && !URL_OR_EMAIL.test(trimmed));
}

function containsTranslatableProse(node: Nodes, ancestors: readonly Nodes[] = []): boolean {
	if (node.type === 'text') return !isProtectedLinkText(node.value, ancestors) && isTranslatableProse(node.value);
	if (node.type === 'image' || node.type === 'imageReference') return Boolean(node.alt && isTranslatableProse(node.alt));
	if (!isParent(node)) return false;
	return node.children.some((child) => containsTranslatableProse(child, [...ancestors, node]));
}

function containsTranslatableText(node: Nodes, ancestors: readonly Nodes[] = []): boolean {
	if (node.type === 'text') return !isProtectedLinkText(node.value, ancestors) && isTranslatableProse(node.value);
	if (!isParent(node)) return false;
	return node.children.some((child) => containsTranslatableText(child, [...ancestors, node]));
}

function sentences(value: string): string[] {
	return [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(value)].map(({ segment }) => segment);
}

function appendText(children: PhrasingContent[], value: string): void {
	if (!value) return;
	const previous = children.at(-1);
	if (previous?.type === 'text') previous.value += value;
	else children.push({ type: 'text', value });
}

function appendNode(children: PhrasingContent[], node: PhrasingContent): void {
	if (node.type === 'text') appendText(children, node.value);
	else children.push(node);
}

function markerText(value: string): string {
	return value.replace(MARKER, '');
}

function atomHint(node: PhrasingContent): string | undefined {
	if (node.type !== 'inlineCode' && node.type !== 'inlineMath') return undefined;
	return `${node.type}: ${node.value.slice(0, MAX_ATOM_HINT_CHARACTERS)}`;
}

type Encoding = {
	ambiguous: boolean;
	atoms: Record<string, string>;
	inlines: Record<string, MarkedInline>;
	nextId: number;
};

// Formatting that holds translatable text becomes a numbered tag pair; everything else is an atom the model must
// keep exactly once. URLs, titles and other attributes never reach the model.
function encodePhrasing(children: readonly PhrasingContent[], ancestors: readonly Nodes[], encoding: Encoding): string {
	let text = '';
	for (const node of children) {
		if (node.type === 'text') {
			// A literal marker in the source could not be told apart from a structural one in the translation.
			if (HAS_MARKER.test(node.value)) encoding.ambiguous = true;
			text += node.value;
			continue;
		}
		const id = String(encoding.nextId++);
		if (isParent(node) && containsTranslatableText(node, ancestors)) {
			encoding.inlines[id] = { kind: 'tag', node: { ...node, children: [] } as PhrasingContent };
			text += `<${id}>${encodePhrasing(node.children, [...ancestors, node], encoding)}</${id}>`;
			continue;
		}
		encoding.inlines[id] = { kind: 'atom', node };
		const hint = atomHint(node);
		if (hint) encoding.atoms[`{{${id}}}`] = hint;
		text += `{{${id}}}`;
	}
	return text;
}

function blockShape(block: ProseBlock): BlockShape {
	return block.type === 'heading' ? { type: 'heading', depth: block.depth } : { type: block.type };
}

function referenceDefinitions(nodes: readonly Nodes[]): RootContent[] {
	const definitions = new Map<string, RootContent>();
	const visit = (node: Nodes): void => {
		if (node.type === 'footnoteReference') {
			definitions.set(`^${node.identifier}`, {
				type: 'footnoteDefinition',
				identifier: node.identifier,
				label: node.label ?? null,
				children: [{ type: 'paragraph', children: [{ type: 'text', value: 'note' }] }],
			});
		} else if (node.type === 'linkReference' || node.type === 'imageReference') {
			definitions.set(node.identifier, { type: 'definition', identifier: node.identifier, label: node.label ?? null, url: 'x' });
		}
		if (isParent(node)) for (const child of node.children) visit(child);
	};
	for (const node of nodes) visit(node);
	return [...definitions.values()];
}

// One block alone, plus stub definitions so its references still resolve when re-parsed.
function wrapBlock(shape: BlockShape, children: PhrasingContent[]): Root {
	const block: RootContent =
		shape.type === 'heading'
			? { type: 'heading', depth: shape.depth, children }
			: shape.type === 'paragraph'
				? { type: 'paragraph', children }
				: { type: 'table', align: [null], children: [{ type: 'tableRow', children: [{ type: 'tableCell', children }] }] };
	return { type: 'root', children: [block, ...referenceDefinitions(children)] };
}

// Compare structure, attributes and visible text. Whitespace is ignored: the serializer may trim or encode it at block
// and delimiter edges, and prose spacing is not structure.
function structure(node: Nodes): unknown {
	const shape: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		// Shorthand references can expand after translation; their identifier must still match.
		if (key === 'data' || key === 'position' || key === 'referenceType') continue;
		if (key === 'children' && isParent(node)) {
			const children: Nodes[] = [];
			for (const child of node.children) {
				const previous = children.at(-1);
				if (child.type === 'text' && previous?.type === 'text')
					children[children.length - 1] = { ...previous, value: previous.value + child.value };
				else children.push(child);
			}
			shape.children = children
				.filter((child) => child.type !== 'text' || child.value.replace(/\s+/gu, ''))
				.map((child) => structure(child));
			continue;
		}
		shape[key] = node.type === 'text' && key === 'value' && typeof value === 'string' ? value.replace(/\s+/gu, '') : value;
	}
	return shape;
}

function sameStructure(left: Nodes, right: Nodes): boolean {
	return JSON.stringify(structure(left)) === JSON.stringify(structure(right));
}

function isAttentionNode(node: PhrasingContent): boolean {
	return node.type === 'emphasis' || node.type === 'strong' || node.type === 'delete';
}

// CommonMark uses the same delimiter runs for adjacent attention nodes. Without a boundary, two sibling nodes such as
// `*one**two*` are parsed as one emphasis node; adjacent formulas or code spans can merge too. The serializer cannot round-trip every tree, so
// add a visible word boundary only when translated prose produced this otherwise unrepresentable sibling shape.
function separateAdjacentDelimitedNodes(children: PhrasingContent[]): void {
	for (const child of children) {
		if (isParent(child)) separateAdjacentDelimitedNodes(child.children as PhrasingContent[]);
	}
	for (let index = 1; index < children.length; index += 1) {
		const previous = children[index - 1];
		const current = children[index];
		if (
			!previous ||
			!current ||
			!(
				(isAttentionNode(previous) && isAttentionNode(current)) ||
				((previous.type === 'inlineMath' || previous.type === 'inlineCode') && current.type === previous.type)
			)
		)
			continue;
		children.splice(index, 0, { type: 'text', value: ' ' });
		index += 1;
	}
}

function invalidResult(segment: MarkdownTranslationSegment, message: string): MarkdownTranslationInvariantError {
	return new MarkdownTranslationInvariantError('invalid-result', `Translated segment ${segment.id} ${message}`);
}

/** Rebuild a segment's phrasing from its tag syntax, restoring every source inline exactly once. */
function decodeSegment(segment: MarkdownTranslationSegment, translated: string): PhrasingContent[] {
	if (translated.includes('\0') || BLANK_LINE.test(translated)) throw invalidResult(segment, 'contains unsafe text');
	if (isTranslatableProse(markerText(segment.text)) && !isTranslatableProse(markerText(translated))) {
		throw invalidResult(segment, 'erased its prose');
	}
	const stack: { children: PhrasingContent[]; id: string | null }[] = [{ children: [], id: null }];
	const seen = new Set<string>();
	let offset = 0;
	for (const match of translated.matchAll(MARKER)) {
		const current = stack.at(-1)!;
		appendText(current.children, translated.slice(offset, match.index));
		offset = match.index + match[0].length;
		const [, closing, tagId, atomId] = match;
		const id = tagId ?? atomId ?? '';
		const inline = segment.inlines[id];
		if (closing) {
			if (current.id !== id || !inline) throw invalidResult(segment, `closes <${id}> out of order`);
			stack.pop();
			if (!current.children.some((child) => child.type !== 'text' || child.value.trim())) {
				throw invalidResult(segment, `left <${id}> empty`);
			}
			stack.at(-1)!.children.push({ ...structuredClone(inline.node), children: current.children } as PhrasingContent);
			continue;
		}
		if (!inline || inline.kind !== (tagId === undefined ? 'atom' : 'tag')) throw invalidResult(segment, `invented ${match[0]}`);
		if (seen.has(id)) throw invalidResult(segment, `repeated ${match[0]}`);
		seen.add(id);
		if (inline.kind === 'tag') stack.push({ children: [], id });
		else current.children.push(structuredClone(inline.node));
	}
	const root = stack[0]!;
	if (stack.length !== 1) throw invalidResult(segment, `left <${stack.at(-1)!.id}> open`);
	appendText(root.children, translated.slice(offset));
	if (seen.size !== Object.keys(segment.inlines).length) throw invalidResult(segment, 'dropped a tag or placeholder');
	return root.children;
}

/**
 * Reject a translation unless it decodes and its block serializes and re-parses to the same structure. Runs inside the
 * batch step, so one malformed block is retried or kept in its source language without redoing the document.
 */
export function verifySegmentTranslation(segment: MarkdownTranslationSegment, translated: string): string {
	const children = decodeSegment(segment, translated);
	separateAdjacentDelimitedNodes(children);
	const tree = wrapBlock(segment.block, children);
	if (!sameStructure(tree, parseMarkdown(stringifyMarkdown(tree)))) {
		throw new MarkdownTranslationInvariantError(
			'markdown-structure-changed',
			`Translated segment ${segment.id} does not round-trip through Markdown`,
		);
	}
	return translated;
}

function createBatch(segments: readonly MarkdownTranslationSegment[], index: number) {
	return {
		id: `b${String(index + 1).padStart(4, '0')}`,
		segments,
	};
}

export type MarkdownTranslationBatch = Readonly<ReturnType<typeof createBatch>>;

export function segmentCharacters(segment: MarkdownTranslationSegment): number {
	return segment.text.length + (segment.context?.length ?? 0);
}

function batchSegments(segments: readonly MarkdownTranslationSegment[]): MarkdownTranslationBatch[] {
	const batches: MarkdownTranslationBatch[] = [];
	let current: MarkdownTranslationSegment[] = [];
	let currentCharacters = 0;
	for (const segment of segments) {
		const characters = segmentCharacters(segment);
		if (current.length > 0 && (currentCharacters + characters > MAX_BATCH_CHARACTERS || current.length >= MAX_BATCH_SEGMENTS)) {
			batches.push(createBatch(current, batches.length));
			current = [];
			currentCharacters = 0;
		}
		current.push(segment);
		currentCharacters += characters;
	}
	if (current.length) batches.push(createBatch(current, batches.length));
	return batches;
}

/** Long blocks split between top-level inlines and at sentence ends inside top-level text. */
function chunkPhrasing(children: readonly PhrasingContent[]): PhrasingContent[][] {
	const pieces = children.flatMap((node): PhrasingContent[] =>
		node.type === 'text' ? sentences(node.value).map((value) => ({ type: 'text', value })) : [node],
	);
	const chunks: PhrasingContent[][] = [];
	let chunk: PhrasingContent[] = [];
	let characters = 0;
	for (const piece of pieces) {
		const pieceCharacters = piece.type === 'text' ? piece.value.length : translatablePlainText(piece).length + 8;
		if (chunk.length && characters + pieceCharacters > MAX_SEGMENT_CHARACTERS) {
			chunks.push(chunk);
			chunk = [];
			characters = 0;
		}
		appendNode(chunk, piece);
		characters += pieceCharacters;
	}
	if (chunk.length) chunks.push(chunk);
	return chunks;
}

function splitWhitespace(value: string): Readonly<{ leading: string; prose: string; trailing: string }> {
	const withoutLeading = value.trimStart();
	const leading = value.slice(0, value.length - withoutLeading.length);
	const prose = withoutLeading.trimEnd();
	return {
		leading,
		prose,
		trailing: withoutLeading.slice(prose.length),
	};
}

function planProseBlock(block: ProseBlock, context: VisitContext, accumulator: PlanAccumulator): void {
	if (!containsTranslatableText(block)) return;
	const translationContext =
		context.heading && block.type !== 'heading' ? `Heading: ${context.heading}`.slice(0, MAX_CONTEXT_CHARACTERS) : null;
	const parts: MarkdownBlockTranslationPart[] = [];
	const keepSource = (nodes: PhrasingContent[]): void => {
		const previous = parts.at(-1);
		if (previous && 'source' in previous) for (const node of nodes) appendNode(previous.source, node);
		else if (nodes.length) parts.push({ source: nodes });
	};
	const encodedLength = encodePhrasing(block.children, [block], { ambiguous: false, atoms: {}, inlines: {}, nextId: 1 }).length;
	const chunks = encodedLength <= MAX_SEGMENT_CHARACTERS ? [block.children] : chunkPhrasing(block.children);
	for (const chunk of chunks) {
		// Edge whitespace and line breaks stay with the source: chunks rejoin exactly, and a break cannot end a block.
		const body = structuredClone(chunk);
		const leading: PhrasingContent[] = [];
		const trailing: PhrasingContent[] = [];
		while (body[0]?.type === 'break' || (body[0]?.type === 'text' && !body[0].value.trim())) leading.push(body.shift()!);
		while (body.at(-1)?.type === 'break' || (body.at(-1)?.type === 'text' && !(body.at(-1) as Text).value.trim()))
			trailing.unshift(body.pop()!);
		const first = body[0];
		if (first?.type === 'text') {
			const { leading: space } = splitWhitespace(first.value);
			if (space) leading.push({ type: 'text', value: space });
			first.value = first.value.slice(space.length);
		}
		const last = body.at(-1);
		if (last?.type === 'text') {
			const { trailing: space } = splitWhitespace(last.value);
			if (space) trailing.unshift({ type: 'text', value: space });
			last.value = last.value.slice(0, last.value.length - space.length);
		}
		const encoding: Encoding = { ambiguous: false, atoms: {}, inlines: {}, nextId: 1 };
		const text = encodePhrasing(body, [block], encoding);
		keepSource(leading);
		if (encoding.ambiguous || !body.some((node) => containsTranslatableText(node, [block]))) {
			keepSource(body);
		} else {
			const segment: MarkdownTranslationSegment = {
				atoms: encoding.atoms,
				block: blockShape(block),
				context: translationContext,
				id: `s${String(accumulator.segments.length + 1).padStart(6, '0')}`,
				inlines: encoding.inlines,
				text,
			};
			accumulator.segments.push(segment);
			parts.push({ segmentId: segment.id });
		}
		keepSource(trailing);
	}
	if (parts.some((part) => 'segmentId' in part)) accumulator.targets.push({ parts, path: context.path });
}

function visitNode(node: Nodes, context: VisitContext, accumulator: PlanAccumulator): void {
	if (isProseBlock(node)) {
		planProseBlock(node, context, accumulator);
		return;
	}
	if (!isParent(node)) return;
	let heading = context.heading;
	for (const [index, child] of node.children.entries()) {
		const childHeading = child.type === 'heading' ? translatablePlainText(child).trim() || heading : heading;
		visitNode(child, { heading: childHeading, path: [...context.path, index] }, accumulator);
		if (child.type === 'heading') heading = childHeading;
	}
}

function nodeAtPath(tree: Root, path: readonly number[]): Nodes | undefined {
	let current: Nodes = tree;
	for (const index of path) {
		const child: Nodes | undefined = isParent(current) ? current.children[index] : undefined;
		if (!child) return undefined;
		current = child;
	}
	return current;
}

function proseBlockAtPath(tree: Root, path: readonly number[]): ProseBlock {
	const block = nodeAtPath(tree, path);
	if (!block || !isProseBlock(block))
		throw new MarkdownTranslationInvariantError('invalid-plan', 'Translation target is not a prose block');
	return block;
}

export function planMarkdownTranslation(sourceMarkdown: string) {
	const canonicalSourceMarkdown = stringifyMarkdown(parseMarkdown(sourceMarkdown));
	const tree = parseMarkdown(canonicalSourceMarkdown);
	if (!sameStructure(tree, parseMarkdown(stringifyMarkdown(tree)))) {
		throw new MarkdownTranslationInvariantError(
			'source-not-roundtrippable',
			'Source Markdown structure cannot be safely round-tripped by the translation serializer',
		);
	}
	const accumulator: PlanAccumulator = { segments: [], targets: [] };
	visitNode(tree, { heading: null, path: [] }, accumulator);
	return {
		batches: batchSegments(accumulator.segments),
		segments: accumulator.segments,
		sourceMarkdown: canonicalSourceMarkdown,
		originalMarkdown: sourceMarkdown,
		targets: accumulator.targets,
	};
}

// Store correspondence, not a second copy of every source/translated paragraph.
// Walk the persisted Markdown (before canonical serialization) so paths match
// the reader's native parser. Digests bind those paths to both exact bodies.
function createMarkdownTranslationAlignment(sourceMarkdown: string, translatedMarkdown: string) {
	const paths: number[][] = [];
	const walk = (source: Nodes, translated: Nodes, path: number[]): void => {
		if (source.type !== translated.type)
			throw new MarkdownTranslationInvariantError('markdown-structure-changed', 'Aligned block types differ');
		if (isProseBlock(source)) {
			if (containsTranslatableProse(source)) paths.push(path);
			return;
		}
		if (isParent(source)) {
			// GFM serializes short rows with empty cells up to the header width.
			const paddedRow =
				source.type === 'tableRow' &&
				translated.type === 'tableRow' &&
				translated.children.length >= source.children.length &&
				translated.children.slice(source.children.length).every((cell) => cell.children.length === 0);
			if (!isParent(translated) || (source.children.length !== translated.children.length && !paddedRow)) {
				throw new MarkdownTranslationInvariantError('markdown-structure-changed', 'Aligned block counts differ');
			}
			source.children.forEach((child, index) => walk(child, translated.children[index]!, [...path, index]));
		}
	};
	walk(parseDialect(sourceMarkdown), parseDialect(translatedMarkdown), []);
	return {
		version: 2 as const,
		sourceHash: hash('sha256', sourceMarkdown, 'hex'),
		translatedHash: hash('sha256', translatedMarkdown, 'hex'),
		paths,
	};
}

/**
 * Write every verified segment into its block. A block that still changes shape in its document position (verification
 * sees it alone) falls back to its source text instead of failing the document.
 */
export function compileMarkdownTranslationArtifact(
	plan: ReturnType<typeof planMarkdownTranslation>,
	translations: MarkdownSegmentTranslations,
) {
	const segments = new Map(plan.segments.map((segment) => [segment.id, segment]));
	const sourceTree = parseMarkdown(plan.sourceMarkdown);
	const tree = parseMarkdown(plan.sourceMarkdown);
	for (const target of plan.targets) {
		const children: PhrasingContent[] = [];
		for (const part of target.parts) {
			if ('source' in part) {
				for (const node of structuredClone(part.source)) appendNode(children, node);
				continue;
			}
			const segment = segments.get(part.segmentId);
			if (!segment) throw new MarkdownTranslationInvariantError('invalid-plan', `Unknown segment ${part.segmentId}`);
			for (const node of decodeSegment(segment, translations[segment.id] ?? segment.text)) appendNode(children, node);
		}
		separateAdjacentDelimitedNodes(children);
		proseBlockAtPath(tree, target.path).children = children;
	}
	let translatedMarkdown = stringifyMarkdown(tree);
	const reparsed = parseMarkdown(translatedMarkdown);
	const reverted = plan.targets.filter((target) => {
		const block = nodeAtPath(reparsed, target.path);
		return !block || !sameStructure(block, proseBlockAtPath(tree, target.path));
	});
	if (reverted.length) {
		console.warn({ tag: 'RESOURCE_TRANSLATION', event: 'blocks_kept_in_source_language', blocks: reverted.length });
		for (const target of reverted) {
			proseBlockAtPath(tree, target.path).children = structuredClone(proseBlockAtPath(sourceTree, target.path).children);
		}
		translatedMarkdown = stringifyMarkdown(tree);
	}
	return {
		alignment: createMarkdownTranslationAlignment(plan.originalMarkdown, translatedMarkdown),
		content: translatedMarkdown,
	};
}
