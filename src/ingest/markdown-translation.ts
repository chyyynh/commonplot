import { hash } from 'node:crypto';
import type { Emphasis, Heading, Link, Nodes, Paragraph, Parents, PhrasingContent, Root, Strong, TableCell } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown, frontmatterToMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown, mathToMarkdown } from 'mdast-util-math';
import { type Info, type State, toMarkdown } from 'mdast-util-to-markdown';
import { cjkFriendlyToMarkdown } from 'mdast-util-to-markdown-cjk-friendly';
import { cjkFriendlyGfmStrikethroughToMarkdown } from 'mdast-util-to-markdown-cjk-friendly-gfm-strikethrough';
import { cjkFriendlyExtension } from 'micromark-extension-cjk-friendly';
import { gfmStrikethroughCjkFriendly } from 'micromark-extension-cjk-friendly-gfm-strikethrough';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';

const MAX_BATCH_CHARACTERS = 24_000;
const MAX_BATCH_SEGMENTS = 16;
const MAX_CONTEXT_CHARACTERS = 800;
const MAX_SEGMENT_CHARACTERS = 20_000;
const TRANSLATABLE_CHARACTER = /[\p{L}\p{N}]/u;
const URL_OR_EMAIL = /^(?:https?:\/\/|mailto:|www\.)\S+$|^[^\s@]+@[^\s@]+\.[^\s@]+$/iu;
const TRANSLATED_PROSE_SENTINEL = '<translated-prose>';
const MAX_INLINE_REFERENCE_CHARACTERS = 256;
const ROOT_TRANSLATION_SEQUENCE = 'root';
const TEXT_TRANSLATION_ID_PREFIX = 't';
const CJK_MARKDOWN = cjkFriendlyToMarkdown();
const FRONTMATTER_PRESETS: Array<'toml' | 'yaml'> = ['yaml', 'toml'];

declare module 'mdast' {
	interface RootContentMap {
		toml: Literal & { type: 'toml' };
	}
}

type ProseBlock = Heading | Paragraph | TableCell;

type MarkdownBlockTranslationTarget = Readonly<{
	boundaries: readonly string[] | null;
	path: readonly number[];
	segmentIds: readonly string[];
}>;

type ProtectedInline =
	| Readonly<{ kind: 'atom'; node: PhrasingContent }>
	| Readonly<{ kind: 'container'; mode: 'alt' | 'children'; node: PhrasingContent }>;

export type MarkdownTranslationSegment = Readonly<
	ReturnType<typeof planPhrasing> & {
		context: string | null;
		id: string;
	}
>;

type MarkdownTranslationSourcePart = string | Readonly<{ id: string }>;

export type MarkdownSegmentTranslation = Readonly<{
	texts: Readonly<Record<string, string>>;
}>;

type MarkdownTranslationReconstructionPart =
	| Readonly<{ id: string; type: 'fixed-inline' }>
	| Readonly<{ id: string; type: 'sequence' }>
	| Readonly<{ type: 'literal'; value: string }>;

type PlanAccumulator = {
	nextInlineIndex: number;
	segments: MarkdownTranslationSegment[];
	targets: MarkdownBlockTranslationTarget[];
};

type VisitContext = Readonly<{
	heading: string | null;
	path: readonly number[];
}>;

type MarkdownTranslationInvariantCode =
	| 'invalid-plan'
	| 'invalid-result'
	| 'markdown-structure-changed'
	| 'missing-segment'
	| 'source-not-roundtrippable';

export class MarkdownTranslationInvariantError extends Error {
	readonly code: MarkdownTranslationInvariantCode;

	constructor(code: MarkdownTranslationInvariantCode, message: string) {
		super(message);
		this.code = code;
		this.name = 'MarkdownTranslationInvariantError';
	}
}

function parseMarkdownOnce(markdown: string): Root {
	return fromMarkdown(markdown, {
		extensions: [frontmatter(FRONTMATTER_PRESETS), math(), gfm(), cjkFriendlyExtension(), gfmStrikethroughCjkFriendly()],
		mdastExtensions: [frontmatterFromMarkdown(FRONTMATTER_PRESETS), mathFromMarkdown(), ...gfmFromMarkdown()],
	});
}

function parseMarkdown(markdown: string): Root {
	const tree = parseMarkdownOnce(markdown);
	const offsets = currencyDelimiterOffsets(tree, markdown);
	if (!offsets.length) return tree;
	let escaped = markdown;
	for (const offset of offsets.sort((left, right) => right - left)) {
		escaped = `${escaped.slice(0, offset)}\\${escaped.slice(offset)}`;
	}
	return parseMarkdownOnce(escaped);
}

function isCurrencyMath(source: string, start: number, end: number): boolean {
	return source.slice(start, start + 2) !== '$$' && /\p{Nd}/u.test(source[start + 1] ?? '') && /\p{Nd}/u.test(source[end] ?? '');
}

function attentionMarker(state: State, kind: 'strong' | 'emphasis'): '*' | '_' {
	return state.stack.filter((construct) => construct === kind).length % 2 === 0 ? '*' : '_';
}

// Alternate nested attention markers so translated text cannot change delimiter pairing.
function serializeAttention(node: Strong | Emphasis, parent: Parents | undefined, state: State, info: Info): string {
	const previousMarker = state.options[node.type];
	state.options[node.type] = attentionMarker(state, node.type);
	try {
		return node.type === 'strong'
			? CJK_MARKDOWN.handlers!.strong!(node, parent, state, info)
			: CJK_MARKDOWN.handlers!.emphasis!(node, parent, state, info);
	} finally {
		state.options[node.type] = previousMarker;
	}
}
serializeAttention.peek = (node: Strong | Emphasis, _parent: Parents | undefined, state: State): string =>
	attentionMarker(state, node.type);

function serializeMarkdown(tree: Root): string {
	return toMarkdown(tree, {
		extensions: [
			frontmatterToMarkdown(FRONTMATTER_PRESETS),
			mathToMarkdown(),
			gfmToMarkdown(),
			CJK_MARKDOWN,
			cjkFriendlyGfmStrikethroughToMarkdown(),
		],
		handlers: { strong: serializeAttention, emphasis: serializeAttention },
	}).trimEnd();
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

function splitProse(value: string, maxCharacters: number): string[] {
	const chunks: string[] = [];
	let chunk = '';
	const flush = (): void => {
		if (chunk) chunks.push(chunk);
		chunk = '';
	};
	const append = (part: string): void => {
		if (chunk && chunk.length + part.length > maxCharacters) flush();
		if (part.length <= maxCharacters) {
			chunk += part;
			return;
		}
		for (const character of part) {
			if (chunk.length + character.length > maxCharacters) flush();
			chunk += character;
		}
	};
	for (const sentence of new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(value)) {
		append(sentence.segment);
	}
	flush();
	return chunks;
}

function structuralNode(
	node: Nodes,
	path: readonly number[],
	translatedBlocks: ReadonlySet<string>,
	ancestors: readonly Nodes[] = [],
	insideTranslatedBlock = false,
): unknown | null {
	const translated = insideTranslatedBlock || translatedBlocks.has(path.join('.'));
	if (translated && node.type === 'text' && !isProtectedLinkText(node.value, ancestors)) return null;
	const structure: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		// Shorthand references can expand after translation; their identifier must still match.
		if (key === 'data' || key === 'position' || key === 'referenceType') continue;
		if (key === 'children' && isParent(node)) {
			const children = node.children
				.map((child, index) => structuralNode(child, [...path, index], translatedBlocks, [...ancestors, node], translated))
				.filter((child) => child !== null);
			structure.children = translated
				? children.sort((left, right) => {
						const leftKey = JSON.stringify(left);
						const rightKey = JSON.stringify(right);
						return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
					})
				: children;
			continue;
		}
		if (translated && key === 'alt' && (node.type === 'image' || node.type === 'imageReference')) {
			structure.alt = TRANSLATED_PROSE_SENTINEL;
			continue;
		}
		structure[key] = value;
	}
	return structure;
}

function markdownSkeleton(tree: Root, translatedBlockPaths: readonly (readonly number[])[]): string {
	const translatedBlocks = new Set(translatedBlockPaths.map((path) => path.join('.')));
	return JSON.stringify(structuralNode(tree, [], translatedBlocks));
}

function protectedAtomReference(inline: ProtectedInline): string | undefined {
	if (inline.kind !== 'atom') return undefined;
	const node = inline.node;
	const value =
		node.type === 'inlineCode' || node.type === 'inlineMath' || node.type === 'html'
			? node.value
			: isAutolink(node)
				? node.children[0]?.type === 'text'
					? node.children[0].value
					: undefined
				: undefined;
	if (!value) return undefined;
	const reference = value.slice(0, MAX_INLINE_REFERENCE_CHARACTERS);
	return reference || undefined;
}

function canShareTranslationSequence(inline: ProtectedInline): boolean {
	return (
		inline.kind === 'container' ||
		inline.node.type === 'inlineCode' ||
		inline.node.type === 'inlineMath' ||
		inline.node.type === 'html' ||
		isAutolink(inline.node)
	);
}

function appendTranslationText(parts: MarkdownTranslationSourcePart[], value: string): void {
	if (!value) return;
	const previous = parts.at(-1);
	if (typeof previous === 'string') parts[parts.length - 1] = previous + value;
	else parts.push(value);
}

// Build the model's text slots directly from Markdown nodes. Inline IDs and
// planning weights stay stable so persisted batch results remain replayable.
function planPhrasing(children: readonly PhrasingContent[], firstInlineIndex: number) {
	const inlines: Record<string, ProtectedInline> = {};
	const sourceSequences: Record<string, MarkdownTranslationSourcePart[]> = {};
	let nextInlineIndex = firstInlineIndex;
	let characterCount = 0;
	function visitSequence(children: readonly PhrasingContent[], sequenceId: string): void {
		const parts: MarkdownTranslationSourcePart[] = [];
		sourceSequences[sequenceId] = parts;
		for (const node of children) {
			if (node.type === 'text') {
				appendTranslationText(parts, node.value);
				characterCount += node.value.length;
				continue;
			}
			const id = `n${nextInlineIndex++}`;
			const image = node.type === 'image' || node.type === 'imageReference';
			const empty = image ? !node.alt : isParent(node) && node.children.length === 0;
			parts.push({ id });
			if (empty || isAutolink(node) || (!isParent(node) && !image)) {
				inlines[id] = { kind: 'atom', node: structuredClone(node) };
				characterCount += id.length + 3;
			} else {
				inlines[id] = { kind: 'container', mode: image ? 'alt' : 'children', node: structuredClone(node) };
				characterCount += id.length * 2 + 5;
				visitSequence(image ? [{ type: 'text', value: node.alt ?? '' }] : isParent(node) ? node.children : [], id);
			}
		}
	}
	visitSequence(children, ROOT_TRANSLATION_SEQUENCE);

	const plannedSequences: Record<string, readonly MarkdownTranslationSourcePart[]> = {};
	const reconstruction: Record<string, readonly MarkdownTranslationReconstructionPart[]> = {};

	for (const [sourceSequenceId, sourceParts] of Object.entries(sourceSequences)) {
		// Whitespace-only containers still carry formatting. An empty model result
		// would turn them into invalid Markdown delimiters (for example, ****).
		if (sourceParts.every((part) => typeof part === 'string' && !part.trim())) {
			reconstruction[sourceSequenceId] = [{ type: 'literal', value: sourceParts.join('') }];
			continue;
		}
		const hasFixedInline = sourceParts.some((part) => {
			if (typeof part === 'string') return false;
			const inline = inlines[part.id];
			return !inline || !canShareTranslationSequence(inline);
		});
		if (!hasFixedInline) {
			plannedSequences[sourceSequenceId] = sourceParts;
			reconstruction[sourceSequenceId] = [{ id: sourceSequenceId, type: 'sequence' }];
			continue;
		}

		const parts: MarkdownTranslationReconstructionPart[] = [];
		let slot: MarkdownTranslationSourcePart[] = [];
		let slotIndex = 0;
		const flushSlot = (): void => {
			if (!slot.length) return;
			const literal = slot.every((part) => typeof part === 'string') ? slot.join('') : null;
			if (literal !== null && !isTranslatableProse(literal)) {
				parts.push({ type: 'literal', value: literal });
				slot = [];
				return;
			}
			slotIndex += 1;
			const outputSequenceId = `${sourceSequenceId}:slot:${String(slotIndex).padStart(2, '0')}`;
			plannedSequences[outputSequenceId] = slot;
			parts.push({ id: outputSequenceId, type: 'sequence' });
			slot = [];
		};

		for (const sourcePart of sourceParts) {
			if (typeof sourcePart === 'string') {
				appendTranslationText(slot, sourcePart);
				continue;
			}
			const inline = inlines[sourcePart.id];
			if (!inline) {
				throw new MarkdownTranslationInvariantError('invalid-plan', `Inline ${sourcePart.id} has no protected source node`);
			}
			if (canShareTranslationSequence(inline)) {
				slot.push(sourcePart);
				continue;
			}
			flushSlot();
			parts.push({ id: sourcePart.id, type: 'fixed-inline' });
		}
		flushSlot();
		const sequenceParts = parts.filter(
			(part): part is Extract<MarkdownTranslationReconstructionPart, { type: 'sequence' }> => part.type === 'sequence',
		);
		if (sequenceParts.length === 1) {
			const onlySequence = sequenceParts[0];
			const onlySourceParts = onlySequence ? plannedSequences[onlySequence.id] : undefined;
			if (onlySequence && onlySourceParts) {
				delete plannedSequences[onlySequence.id];
				plannedSequences[sourceSequenceId] = onlySourceParts;
				const partIndex = parts.indexOf(onlySequence);
				parts[partIndex] = { id: sourceSequenceId, type: 'sequence' };
			}
		}
		reconstruction[sourceSequenceId] = parts;
	}
	const texts: Record<string, string> = {};
	let nextTextIndex = 1;
	const sequences = Object.fromEntries(
		Object.entries(plannedSequences).map(([sequenceId, parts]) => [
			sequenceId,
			parts.map((part) => {
				if (typeof part !== 'string') return part.id;
				const textId = `${TEXT_TRANSLATION_ID_PREFIX}${nextTextIndex}`;
				nextTextIndex += 1;
				texts[textId] = part;
				return textId;
			}),
		]),
	);

	return {
		characterCount,
		inlines,
		reconstruction,
		template: {
			inlines: Object.fromEntries(
				Object.entries(inlines).flatMap(([id, inline]) => {
					if (!canShareTranslationSequence(inline)) return [];
					const reference = protectedAtomReference(inline);
					return [[id, reference ? { kind: inline.node.type, reference } : inline.node.type]];
				}),
			),
			sequences,
			texts,
		},
	};
}

function isAutolink(node: PhrasingContent): node is Link {
	return (
		node.type === 'link' &&
		node.children.length === 1 &&
		node.children[0]?.type === 'text' &&
		normalizedAutolinkDestination(node.children[0].value) === normalizedAutolinkDestination(node.url)
	);
}

function appendText(children: PhrasingContent[], value: string): void {
	if (!value) return;
	const previous = children.at(-1);
	if (previous?.type === 'text') previous.value += value;
	else children.push({ type: 'text', value });
}

type ProtectedContainer = Extract<ProtectedInline, { kind: 'container' }>;

function protectedPlainText(node: Nodes): string {
	if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') return node.value;
	if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
	if (node.type === 'break') return '\n';
	if (!isParent(node)) return '';
	return node.children.map((child) => protectedPlainText(child)).join('');
}

function restoreContainer(inline: ProtectedContainer, children: PhrasingContent[]): PhrasingContent {
	const node = structuredClone(inline.node);
	if (inline.mode === 'alt' && (node.type === 'image' || node.type === 'imageReference')) {
		node.alt = children.map((child) => protectedPlainText(child)).join('');
		return node;
	}
	if (inline.mode === 'children' && isParent(node)) {
		node.children = children;
		return node;
	}
	throw new MarkdownTranslationInvariantError('invalid-plan', 'Protected inline node cannot contain translated prose');
}

function isAttentionNode(node: PhrasingContent): boolean {
	return node.type === 'emphasis' || node.type === 'strong' || node.type === 'delete';
}

// CommonMark uses the same delimiter runs for adjacent attention nodes. Without a boundary, two sibling nodes such as
// `*one**two*` are parsed as one emphasis node; `$x$$y$` similarly merges adjacent formulas. The serializer cannot round-trip every tree, so
// add a visible word boundary only when translated prose produced this otherwise unrepresentable sibling shape.
function separateAdjacentDelimitedNodes(children: PhrasingContent[]): boolean {
	let changed = false;
	for (const child of children) {
		if (isParent(child)) changed = separateAdjacentDelimitedNodes(child.children as PhrasingContent[]) || changed;
	}
	for (let index = 1; index < children.length; index += 1) {
		const previous = children[index - 1];
		const current = children[index];
		if (
			!previous ||
			!current ||
			!((isAttentionNode(previous) && isAttentionNode(current)) || (previous.type === 'inlineMath' && current.type === 'inlineMath'))
		)
			continue;
		children.splice(index, 0, { type: 'text', value: ' ' });
		changed = true;
		index += 1;
	}
	return changed;
}

function compileMarkdownTranslationTarget(segment: MarkdownTranslationSegment, target: MarkdownSegmentTranslation): PhrasingContent[] {
	const { inlines, reconstruction, template } = segment;
	for (const textId of Object.keys(template.texts)) {
		const targetText = target.texts[textId];
		if (typeof targetText !== 'string' || targetText.includes('\0') || /\r?\n[\t ]*\r?\n/u.test(targetText)) {
			throw new MarkdownTranslationInvariantError('invalid-result', `Translated segment ${segment.id} has unsafe text ${textId}`);
		}
	}

	const compileSequence = (sequenceId: string): PhrasingContent[] => {
		const partIds = template.sequences[sequenceId];
		if (!partIds) {
			throw new MarkdownTranslationInvariantError(
				'invalid-plan',
				`Translated segment ${segment.id} has no source inline sequence ${sequenceId}`,
			);
		}
		const compiled: PhrasingContent[] = [];
		for (const partId of partIds) {
			const text = target.texts[partId];
			if (text !== undefined) {
				appendText(compiled, text);
				continue;
			}
			const inline = inlines[partId];
			if (!inline) {
				throw new MarkdownTranslationInvariantError(
					'invalid-plan',
					`Source inline sequence ${sequenceId} references unknown inline ${partId}`,
				);
			}
			if (inline.kind === 'atom' && isAutolink(inline.node)) {
				const reference = protectedPlainText(inline.node);
				const sourceText = partIds.map((id) => template.texts[id] ?? '').join('\0');
				const targetText = partIds.map((id) => target.texts[id] ?? '').join('\0');
				// Core restores this link itself. A copied model-facing reference would add another visible address and
				// may become an extra GFM autolink on serialization. Reject inside the batch step so its retries can recover.
				if (reference && targetText.split(reference).length > sourceText.split(reference).length) {
					throw new MarkdownTranslationInvariantError(
						'invalid-result',
						`Translated segment ${segment.id} copied protected link ${partId} into prose`,
					);
				}
			}
			compiled.push(inline.kind === 'atom' ? structuredClone(inline.node) : restoreContainer(inline, compileSourceSequence(partId)));
		}
		const sourceHasProse = partIds.some((partId) => isTranslatableProse(template.texts[partId] ?? ''));
		const translatedHasProse = partIds.some((partId) => isTranslatableProse(target.texts[partId] ?? ''));
		if (sourceHasProse && !translatedHasProse) {
			throw new MarkdownTranslationInvariantError(
				'invalid-result',
				`Translated segment ${segment.id} erased the prose in inline sequence ${sequenceId}`,
			);
		}
		return compiled;
	};
	const compileSourceSequence = (sourceSequenceId: string): PhrasingContent[] => {
		const parts = reconstruction[sourceSequenceId];
		if (!parts) {
			throw new MarkdownTranslationInvariantError(
				'invalid-plan',
				`Translated segment ${segment.id} has no reconstruction sequence ${sourceSequenceId}`,
			);
		}
		const children: PhrasingContent[] = [];
		for (const part of parts) {
			if (part.type === 'literal') appendText(children, part.value);
			else if (part.type === 'sequence') {
				for (const node of compileSequence(part.id)) {
					if (node.type === 'text') appendText(children, node.value);
					else children.push(node);
				}
			} else {
				const inline = inlines[part.id];
				if (inline?.kind !== 'atom' || canShareTranslationSequence(inline)) {
					throw new MarkdownTranslationInvariantError('invalid-plan', `Fixed inline ${part.id} is not an opaque atom`);
				}
				children.push(structuredClone(inline.node));
			}
		}
		return children;
	};

	const compiled = compileSourceSequence(ROOT_TRANSLATION_SEQUENCE);
	const sourceProse = Object.values(template.texts).join('');
	const translatedProse = Object.values(target.texts).join('');
	if (isTranslatableProse(sourceProse) && !isTranslatableProse(translatedProse)) {
		throw new MarkdownTranslationInvariantError('invalid-result', `Translated segment ${segment.id} erased all prose`);
	}
	return compiled;
}

function segmentInputCharacters(segment: MarkdownTranslationSegment): number {
	return JSON.stringify({ context: segment.context, id: segment.id, ...segment.template }).length + 1;
}

function createBatch(segments: readonly MarkdownTranslationSegment[], index: number) {
	return {
		id: `b${String(index + 1).padStart(4, '0')}`,
		segments,
	};
}

export type MarkdownTranslationBatch = Readonly<ReturnType<typeof createBatch>>;

function batchSegments(segments: readonly MarkdownTranslationSegment[]): MarkdownTranslationBatch[] {
	const batches: MarkdownTranslationBatch[] = [];
	let current: MarkdownTranslationSegment[] = [];
	let currentCharacters = 0;
	for (const segment of segments) {
		const characters = segmentInputCharacters(segment);
		if (characters > MAX_BATCH_CHARACTERS) {
			throw new MarkdownTranslationInvariantError('invalid-plan', `Markdown segment ${segment.id} exceeds the batch character budget`);
		}
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

function addSegment(
	input: ReturnType<typeof planPhrasing>,
	context: string | null,
	accumulator: PlanAccumulator,
): MarkdownTranslationSegment {
	const segment = {
		context,
		id: `s${String(accumulator.segments.length + 1).padStart(6, '0')}`,
		...input,
	};
	accumulator.segments.push(segment);
	return segment;
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
	if (!containsTranslatableProse(block)) return;
	const translationContext =
		context.heading && block.type !== 'heading' ? `Heading: ${context.heading}`.slice(0, MAX_CONTEXT_CHARACTERS) : null;
	const phrasing = planPhrasing(block.children, accumulator.nextInlineIndex + 1);
	accumulator.nextInlineIndex += Object.keys(phrasing.inlines).length;
	if (phrasing.characterCount <= MAX_SEGMENT_CHARACTERS) {
		const segment = addSegment(phrasing, translationContext, accumulator);
		accumulator.targets.push({ boundaries: null, path: context.path, segmentIds: [segment.id] });
		return;
	}
	if (block.children.length !== 1 || block.children[0]?.type !== 'text') {
		throw new MarkdownTranslationInvariantError(
			'invalid-plan',
			'Markdown prose block with inline structure exceeds the safe translation segment size',
		);
	}
	const boundaries = [''];
	const segmentIds: string[] = [];
	for (const chunk of splitProse(block.children[0].value, MAX_SEGMENT_CHARACTERS)) {
		const { leading, prose, trailing } = splitWhitespace(chunk);
		boundaries[boundaries.length - 1] += leading;
		if (prose) {
			segmentIds.push(
				addSegment(planPhrasing([{ type: 'text', value: prose }], accumulator.nextInlineIndex + 1), translationContext, accumulator).id,
			);
			boundaries.push(trailing);
		} else {
			boundaries[boundaries.length - 1] += trailing;
		}
	}
	accumulator.targets.push({ boundaries, path: context.path, segmentIds });
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

function nodeAtPath(tree: Root, path: readonly number[]): Nodes {
	let current: Nodes = tree;
	for (const index of path) {
		if (!isParent(current)) throw new MarkdownTranslationInvariantError('invalid-plan', 'Translation target is not a Markdown parent');
		const child: Nodes | undefined = current.children[index];
		if (!child) throw new MarkdownTranslationInvariantError('invalid-plan', 'Translation target path does not exist');
		current = child;
	}
	return current;
}

function orderedTranslationMap(
	segments: readonly MarkdownTranslationSegment[],
	translations: readonly MarkdownSegmentTranslation[],
): ReadonlyMap<string, PhrasingContent[]> {
	if (translations.length !== segments.length) {
		throw new MarkdownTranslationInvariantError(
			'missing-segment',
			`Expected ${segments.length} translated segments but received ${translations.length}`,
		);
	}
	const values = new Map<string, PhrasingContent[]>();
	for (const [index, expected] of segments.entries()) {
		const result = translations[index];
		if (!result) throw new MarkdownTranslationInvariantError('missing-segment', `Missing translated segment ${expected.id}`);
		values.set(expected.id, compileMarkdownTranslationTarget(expected, result));
	}
	return values;
}

export function validateMarkdownBatchTranslations(
	batch: Pick<MarkdownTranslationBatch, 'segments'>,
	translations: readonly MarkdownSegmentTranslation[],
): readonly MarkdownSegmentTranslation[] {
	const values = orderedTranslationMap(batch.segments, translations);
	const tree: Root = {
		type: 'root',
		children: [...values.values()].map((children) => ({ type: 'paragraph', children })),
	};
	const sourceTree: Root = {
		type: 'root',
		children: batch.segments.map((segment) => ({
			type: 'paragraph',
			children: compileMarkdownTranslationTarget(segment, { texts: segment.template.texts }),
		})),
	};
	const links = (node: Nodes): string[] => [
		...(node.type === 'link' ? [node.url] : []),
		...(isParent(node) ? node.children.flatMap(links) : []),
	];
	// GFM's AST transform can turn even escaped prose URLs into links. Reject
	// added links inside the retryable batch, before the whole-document compile.
	if (
		JSON.stringify(links(parseMarkdown(serializeMarkdown(sourceTree))).sort()) !==
		JSON.stringify(links(parseMarkdown(serializeMarkdown(tree))).sort())
	) {
		throw new MarkdownTranslationInvariantError('invalid-result', 'Translated prose changed the protected Markdown links');
	}
	return translations;
}

export function planMarkdownTranslation(sourceMarkdown: string) {
	const canonicalSourceMarkdown = serializeMarkdown(parseMarkdown(sourceMarkdown));
	const tree = parseMarkdown(canonicalSourceMarkdown);
	const accumulator: PlanAccumulator = { nextInlineIndex: 0, segments: [], targets: [] };
	visitNode(tree, { heading: null, path: [] }, accumulator);
	const targetPaths = accumulator.targets.map((target) => target.path);
	const sourceSkeleton = markdownSkeleton(tree, targetPaths);
	const normalizedTree = parseMarkdown(serializeMarkdown(tree));
	if (markdownSkeleton(normalizedTree, targetPaths) !== sourceSkeleton) {
		throw new MarkdownTranslationInvariantError(
			'source-not-roundtrippable',
			'Source Markdown structure cannot be safely round-tripped by the translation serializer',
		);
	}
	return {
		batches: batchSegments(accumulator.segments),
		segments: accumulator.segments,
		sourceMarkdown: canonicalSourceMarkdown,
		originalMarkdown: sourceMarkdown,
		sourceSkeleton,
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
	walk(parseMarkdownOnce(sourceMarkdown), parseMarkdownOnce(translatedMarkdown), []);
	return {
		version: 2 as const,
		sourceHash: hash('sha256', sourceMarkdown, 'hex'),
		translatedHash: hash('sha256', translatedMarkdown, 'hex'),
		paths,
	};
}

export function compileMarkdownTranslationArtifact(
	plan: ReturnType<typeof planMarkdownTranslation>,
	translations: readonly MarkdownSegmentTranslation[],
) {
	const values = orderedTranslationMap(plan.segments, translations);
	const sourceTree = parseMarkdown(plan.sourceMarkdown);
	const tree = structuredClone(sourceTree);
	for (const target of plan.targets) {
		const translatedParts = target.segmentIds.map((id) => {
			const translated = values.get(id);
			if (translated === undefined) throw new MarkdownTranslationInvariantError('missing-segment', `Missing segment ${id}`);
			return translated;
		});
		const block = nodeAtPath(tree, target.path);
		if (!isProseBlock(block)) throw new MarkdownTranslationInvariantError('invalid-plan', 'Translation target is not a prose block');
		if (!target.boundaries) {
			if (translatedParts.length !== 1) {
				throw new MarkdownTranslationInvariantError('invalid-plan', 'Complete Markdown block must have exactly one segment');
			}
			block.children = translatedParts[0] ?? [];
			continue;
		}
		if (target.boundaries.length !== translatedParts.length + 1) {
			throw new MarkdownTranslationInvariantError('invalid-plan', 'Split prose boundaries do not match its segments');
		}
		let text = target.boundaries[0] ?? '';
		for (const [index, children] of translatedParts.entries()) {
			if (children.length !== 1 || children[0]?.type !== 'text') {
				throw new MarkdownTranslationInvariantError(
					'markdown-structure-changed',
					`Split prose segment ${target.segmentIds[index]} changed structure`,
				);
			}
			text += children[0].value + (target.boundaries[index + 1] ?? '');
		}
		block.children = [{ type: 'text', value: text }];
	}
	const targetPaths = plan.targets.map((target) => target.path);
	let translatedMarkdown = serializeMarkdown(tree);
	let translatedSkeleton = markdownSkeleton(parseMarkdown(translatedMarkdown), targetPaths);
	if (translatedSkeleton !== plan.sourceSkeleton) {
		let separatedDelimiters = false;
		for (const target of plan.targets) {
			const block = nodeAtPath(tree, target.path);
			if (isProseBlock(block)) separatedDelimiters = separateAdjacentDelimitedNodes(block.children) || separatedDelimiters;
		}
		if (separatedDelimiters) {
			translatedMarkdown = serializeMarkdown(tree);
			translatedSkeleton = markdownSkeleton(parseMarkdown(translatedMarkdown), targetPaths);
		}
	}
	if (translatedSkeleton !== plan.sourceSkeleton) {
		throw new MarkdownTranslationInvariantError(
			'markdown-structure-changed',
			'Translated Markdown did not preserve the source document structure',
		);
	}
	return {
		alignment: createMarkdownTranslationAlignment(plan.originalMarkdown, translatedMarkdown),
		content: translatedMarkdown,
	};
}
