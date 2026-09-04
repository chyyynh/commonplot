import type { Heading, Link, Literal, Nodes, Paragraph, Parents, PhrasingContent, Root, TableCell } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown, frontmatterToMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown, mathToMarkdown } from 'mdast-util-math';
import { toMarkdown } from 'mdast-util-to-markdown';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';

const DEFAULT_BATCH_MAX_CHARACTERS = 8_000;
const DEFAULT_CONTEXT_MAX_CHARACTERS = 800;
const DEFAULT_SEGMENT_MAX_CHARACTERS = 6_000;
const DEFAULT_BATCH_MAX_SEGMENTS = 16;
const MINIMUM_SPLIT_BOUNDARY_RATIO = 0.65;
const TRANSLATABLE_CHARACTER = /[\p{L}\p{N}]/u;
const URL_OR_EMAIL = /^(?:https?:\/\/|mailto:|www\.)\S+$|^[^\s@]+@[^\s@]+\.[^\s@]+$/iu;
const TRANSLATED_PROSE_SENTINEL = '<translated-prose>';
const INLINE_TOKEN_PATTERN = /<\/?n[0-9]+>|<n[0-9]+\/>/gu;
const MAX_INLINE_REFERENCE_CHARACTERS = 256;
const MIN_CROSS_SEQUENCE_DUPLICATE_CHARACTERS = 12;
const ROOT_TRANSLATION_SEQUENCE = 'root';
const TEXT_TRANSLATION_ID_PREFIX = 't';
const FRONTMATTER_PRESETS: Array<'toml' | 'yaml'> = ['yaml', 'toml'];

interface TomlFrontmatter extends Literal {
	type: 'toml';
}

interface YamlFrontmatter extends Literal {
	type: 'yaml';
}

declare module 'mdast' {
	interface RootContentMap {
		toml: TomlFrontmatter;
		yaml: YamlFrontmatter;
	}
}

type ProseBlock = Heading | Paragraph | TableCell;

type MarkdownBlockTranslationTarget = Readonly<{
	boundaries: readonly string[] | null;
	path: readonly number[];
	segmentIds: readonly string[];
}>;

type ProtectedInline =
	| Readonly<{ kind: 'atom'; node: PhrasingContent; token: string }>
	| Readonly<{
			close: string;
			kind: 'container';
			mode: 'alt' | 'children';
			node: PhrasingContent;
			open: string;
	  }>;

export type MarkdownTranslationSegment = Readonly<{
	context: string | null;
	id: string;
	protectedInlines: readonly ProtectedInline[];
	text: string;
}>;

export type MarkdownTranslationBatch = Readonly<{
	id: string;
	inputCharacters: number;
	segments: readonly MarkdownTranslationSegment[];
	sourceCharacters: number;
}>;

export type MarkdownTranslationInline = PhrasingContent['type'] | Readonly<{ kind: PhrasingContent['type']; reference: string }>;

export type MarkdownTranslationPart = Readonly<{ type: 'inline'; value: string }> | Readonly<{ type: 'text'; value: string }>;

type MarkdownTranslationSourcePart = string | Readonly<{ id: string }>;

export type MarkdownTranslationTemplate = Readonly<{
	inlines: Readonly<Record<string, MarkdownTranslationInline>>;
	sequences: Readonly<Record<string, readonly string[]>>;
	texts: Readonly<Record<string, string>>;
}>;

export type MarkdownTranslationTarget = Readonly<{
	sequences: Readonly<Record<string, readonly MarkdownTranslationPart[]>>;
}>;

export type MarkdownSegmentTranslation = MarkdownTranslationTarget &
	Readonly<{
		id: string;
	}>;

export type MarkdownTranslationPlan = Readonly<{
	batches: readonly MarkdownTranslationBatch[];
	segments: readonly MarkdownTranslationSegment[];
	sourceMarkdown: string;
	sourceSkeleton: string;
	targets: readonly MarkdownBlockTranslationTarget[];
}>;

export type MarkdownTranslationAlignment = Readonly<{
	blocks: readonly Readonly<{
		sourceMarkdown: string;
		translatedMarkdown: string;
		type: ProseBlock['type'];
	}>[];
	version: 1;
}>;

export type CompiledMarkdownTranslation = Readonly<{
	alignment: MarkdownTranslationAlignment;
	content: string;
}>;

export type MarkdownTranslationPlanOptions = Readonly<{
	maxBatchCharacters?: number;
	maxBatchSegments?: number;
	maxContextCharacters?: number;
	maxSegmentCharacters?: number;
}>;

type MarkdownTranslationReconstructionPart =
	| Readonly<{ id: string; type: 'fixed-inline' }>
	| Readonly<{ id: string; type: 'sequence' }>
	| Readonly<{ type: 'literal'; value: string }>;

type MarkdownTranslationTemplatePlan = Readonly<{
	reconstruction: Readonly<Record<string, readonly MarkdownTranslationReconstructionPart[]>>;
	template: MarkdownTranslationTemplate;
}>;

type ResolvedPlanOptions = Readonly<{
	maxBatchCharacters: number;
	maxBatchSegments: number;
	maxContextCharacters: number;
	maxSegmentCharacters: number;
}>;

type PlanAccumulator = {
	nextInlineIndex: number;
	segments: MarkdownTranslationSegment[];
	targets: MarkdownBlockTranslationTarget[];
};

type VisitContext = Readonly<{
	heading: string | null;
	path: readonly number[];
}>;

export class MarkdownTranslationInvariantError extends Error {
	readonly code:
		| 'duplicate-segment'
		| 'invalid-plan'
		| 'invalid-result'
		| 'markdown-structure-changed'
		| 'missing-segment'
		| 'source-not-roundtrippable'
		| 'unknown-segment';

	constructor(
		code:
			| 'duplicate-segment'
			| 'invalid-plan'
			| 'invalid-result'
			| 'markdown-structure-changed'
			| 'missing-segment'
			| 'source-not-roundtrippable'
			| 'unknown-segment',
		message: string,
	) {
		super(message);
		this.code = code;
		this.name = 'MarkdownTranslationInvariantError';
	}
}

function parseMarkdownOnce(markdown: string): Root {
	return fromMarkdown(markdown, {
		extensions: [frontmatter(FRONTMATTER_PRESETS), math(), gfm()],
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

function serializeMarkdown(tree: Root): string {
	return toMarkdown(tree, {
		extensions: [frontmatterToMarkdown(FRONTMATTER_PRESETS), mathToMarkdown(), gfmToMarkdown()],
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
				source.slice(start, start + 2) !== '$$' &&
				/\p{Nd}/u.test(source[start + 1] ?? '') &&
				/\p{Nd}/u.test(source[end] ?? '')
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

function safeSplitIndex(value: string, proposed: number): number {
	if (proposed <= 0 || proposed >= value.length) return proposed;
	const previous = value.charCodeAt(proposed - 1);
	const next = value.charCodeAt(proposed);
	return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? proposed - 1 : proposed;
}

function preferredSplitIndex(value: string, start: number, maxCharacters: number): number {
	const hardEnd = Math.min(value.length, start + maxCharacters);
	if (hardEnd === value.length) return hardEnd;
	const minimumEnd = start + Math.floor(maxCharacters * MINIMUM_SPLIT_BOUNDARY_RATIO);
	const separators = ['\n\n', '\n', '. ', '! ', '? ', '。', '！', '？', '; ', '；', ', ', '，', ' '] as const;
	for (const separator of separators) {
		const boundary = value.lastIndexOf(separator, hardEnd - separator.length);
		if (boundary < minimumEnd) continue;
		return safeSplitIndex(value, boundary + separator.length);
	}
	return safeSplitIndex(value, hardEnd);
}

function splitProse(value: string, maxCharacters: number): string[] {
	const chunks: string[] = [];
	let start = 0;
	while (start < value.length) {
		const end = preferredSplitIndex(value, start, maxCharacters);
		if (end <= start) throw new MarkdownTranslationInvariantError('invalid-plan', 'Markdown prose split made no progress');
		chunks.push(value.slice(start, end));
		start = end;
	}
	return chunks;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1) {
		throw new MarkdownTranslationInvariantError('invalid-plan', `${name} must be a positive integer`);
	}
	return resolved;
}

function resolvePlanOptions(options: MarkdownTranslationPlanOptions): ResolvedPlanOptions {
	const maxBatchCharacters = positiveInteger(options.maxBatchCharacters, DEFAULT_BATCH_MAX_CHARACTERS, 'maxBatchCharacters');
	const maxBatchSegments = positiveInteger(options.maxBatchSegments, DEFAULT_BATCH_MAX_SEGMENTS, 'maxBatchSegments');
	const requestedContext = positiveInteger(options.maxContextCharacters, DEFAULT_CONTEXT_MAX_CHARACTERS, 'maxContextCharacters');
	const maxContextCharacters = Math.min(requestedContext, Math.max(1, Math.floor(maxBatchCharacters * 0.2)));
	const availableSegmentCharacters = Math.max(1, maxBatchCharacters - maxContextCharacters - 64);
	const requestedSegment = positiveInteger(options.maxSegmentCharacters, DEFAULT_SEGMENT_MAX_CHARACTERS, 'maxSegmentCharacters');
	return {
		maxBatchCharacters,
		maxBatchSegments,
		maxContextCharacters,
		maxSegmentCharacters: Math.min(requestedSegment, availableSegmentCharacters),
	};
}

function translatedPathKey(path: readonly number[]): string {
	return path.join('.');
}

function structuralNode(
	node: Nodes,
	path: readonly number[],
	translatedBlocks: ReadonlySet<string>,
	ancestors: readonly Nodes[] = [],
	insideTranslatedBlock = false,
): unknown | null {
	const translated = insideTranslatedBlock || translatedBlocks.has(translatedPathKey(path));
	if (translated && node.type === 'text' && !isProtectedLinkText(node.value, ancestors)) return null;
	const structure: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === 'data' || key === 'position') continue;
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
	const translatedBlocks = new Set(translatedBlockPaths.map(translatedPathKey));
	return JSON.stringify(structuralNode(tree, [], translatedBlocks));
}

function inlineTokens(value: string): string[] {
	return value.match(INLINE_TOKEN_PATTERN) ?? [];
}

function protectedAtomReference(inline: ProtectedInline): string | undefined {
	if (inline.kind !== 'atom') return undefined;
	const node = inline.node;
	const value =
		node.type === 'inlineCode' || node.type === 'inlineMath'
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

function protectedInlineId(inline: ProtectedInline): string {
	const id = (inline.kind === 'atom' ? inline.token : inline.open).match(/n[0-9]+/u)?.[0];
	if (!id) throw new MarkdownTranslationInvariantError('invalid-plan', 'Protected inline has no stable identifier');
	return id;
}

function canReorderProtectedInline(inline: ProtectedInline): boolean {
	return inline.kind === 'container' || inline.node.type === 'inlineCode' || inline.node.type === 'inlineMath' || isAutolink(inline.node);
}

function appendTranslationText(parts: MarkdownTranslationSourcePart[], value: string): void {
	if (!value) return;
	const previous = parts.at(-1);
	if (typeof previous === 'string') parts[parts.length - 1] = previous + value;
	else parts.push(value);
}

function parseTranslationSequences(
	text: string,
	protectedInlines: readonly ProtectedInline[],
): Readonly<Record<string, readonly MarkdownTranslationSourcePart[]>> {
	const registry = inlineRegistry(protectedInlines);
	const matches = [...text.matchAll(INLINE_TOKEN_PATTERN)];
	const sequences: Record<string, MarkdownTranslationSourcePart[]> = {};
	let cursor = 0;
	let matchIndex = 0;

	const fail = (message: string): never => {
		throw new MarkdownTranslationInvariantError('invalid-plan', message);
	};
	const parseSequence = (sequenceId: string, container: ProtectedContainer | null): void => {
		if (Object.hasOwn(sequences, sequenceId)) fail(`Inline sequence ${sequenceId} appears more than once`);
		const parts: MarkdownTranslationSourcePart[] = [];
		sequences[sequenceId] = parts;
		while (matchIndex < matches.length) {
			const match = matches[matchIndex];
			if (!match || match.index === undefined) fail('Inline token has no source offset');
			appendTranslationText(parts, text.slice(cursor, match.index));
			const token = match[0];
			cursor = match.index + token.length;
			matchIndex += 1;
			if (container && token === container.close) return;
			if (registry.closings.has(token)) fail(`Inline sequence ${sequenceId} has an unexpected closing token`);
			const atom = registry.atoms.get(token);
			if (atom) {
				parts.push({ id: protectedInlineId(atom) });
				continue;
			}
			const opening = registry.openings.get(token);
			if (opening) {
				const inlineId = protectedInlineId(opening);
				parts.push({ id: inlineId });
				parseSequence(inlineId, opening);
				continue;
			}
			fail(`Inline sequence ${sequenceId} contains an unknown token`);
		}
		appendTranslationText(parts, text.slice(cursor));
		cursor = text.length;
		if (container) fail(`Inline sequence ${sequenceId} has no closing token`);
	};

	parseSequence(ROOT_TRANSLATION_SEQUENCE, null);
	return sequences;
}

function createMarkdownTranslationTemplatePlan(segment: MarkdownTranslationSegment): MarkdownTranslationTemplatePlan {
	const protectedById = new Map(segment.protectedInlines.map((inline) => [protectedInlineId(inline), inline]));
	const sourceSequences = parseTranslationSequences(segment.text, segment.protectedInlines);
	const plannedSequences: Record<string, readonly MarkdownTranslationSourcePart[]> = {};
	const reconstruction: Record<string, readonly MarkdownTranslationReconstructionPart[]> = {};

	for (const [sourceSequenceId, sourceParts] of Object.entries(sourceSequences)) {
		const hasFixedInline = sourceParts.some((part) => {
			if (typeof part === 'string') return false;
			const inline = protectedById.get(part.id);
			return !inline || !canReorderProtectedInline(inline);
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
			const hasMovableInline = slot.some((part) => typeof part !== 'string');
			const literal = slot.every((part) => typeof part === 'string') ? slot.join('') : null;
			if (!hasMovableInline && literal !== null && !isTranslatableProse(literal)) {
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
			const inline = protectedById.get(sourcePart.id);
			if (!inline) {
				throw new MarkdownTranslationInvariantError('invalid-plan', `Inline ${sourcePart.id} has no protected source node`);
			}
			if (canReorderProtectedInline(inline)) {
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
		reconstruction,
		template: {
			inlines: Object.fromEntries(
				segment.protectedInlines.flatMap((inline) => {
					if (!canReorderProtectedInline(inline)) return [];
					const reference = protectedAtomReference(inline);
					return [[protectedInlineId(inline), reference ? { kind: inline.node.type, reference } : inline.node.type]];
				}),
			),
			sequences,
			texts,
		},
	};
}

// Like XLIFF inline codes, stable source text and inline IDs keep translation separate from Markdown syntax. Output text remains
// fluid within each sequence because natural target-language prose cannot preserve every source-side gap around an inline.
export function createMarkdownTranslationTemplate(segment: MarkdownTranslationSegment): MarkdownTranslationTemplate {
	return createMarkdownTranslationTemplatePlan(segment).template;
}

function nextInlineToken(kind: 'atom' | 'close' | 'open', index: number): string {
	const name = `n${index}`;
	if (kind === 'atom') return `<${name}/>`;
	return kind === 'open' ? `<${name}>` : `</${name}>`;
}

function isAutolink(node: PhrasingContent): node is Link {
	return (
		node.type === 'link' &&
		node.children.length === 1 &&
		node.children[0]?.type === 'text' &&
		normalizedAutolinkDestination(node.children[0].value) === normalizedAutolinkDestination(node.url)
	);
}

// A prose block is the smallest unit that still carries sentence-level meaning. Inline nodes use an internal encoded form that is
// converted to the model-facing sequence IR, so the model never sees or edits destinations, code, formulas, or Markdown syntax.
function encodePhrasing(
	children: readonly PhrasingContent[],
	firstInlineIndex: number,
): Readonly<{
	protectedInlines: readonly ProtectedInline[];
	text: string;
}> {
	const protectedInlines: ProtectedInline[] = [];
	const encodeText = (value: string): string => {
		if (inlineTokens(value).length) {
			throw new MarkdownTranslationInvariantError('invalid-plan', 'Source prose contains a reserved translation token');
		}
		return value;
	};
	const encodeNode = (node: PhrasingContent): string => {
		if (node.type === 'text') return encodeText(node.value);
		const index = firstInlineIndex + protectedInlines.length;
		const emptyContainer =
			node.type === 'image' || node.type === 'imageReference' ? !node.alt : isParent(node) && node.children.length === 0;
		if (emptyContainer || isAutolink(node) || (!isParent(node) && node.type !== 'image' && node.type !== 'imageReference')) {
			const token = nextInlineToken('atom', index);
			protectedInlines.push({ kind: 'atom', node: structuredClone(node), token });
			return token;
		}
		const open = nextInlineToken('open', index);
		const close = nextInlineToken('close', index);
		const image = node.type === 'image' || node.type === 'imageReference';
		const mode = image ? 'alt' : 'children';
		protectedInlines.push({ close, kind: 'container', mode, node: structuredClone(node), open });
		const content = image ? encodeText(node.alt ?? '') : isParent(node) ? node.children.map(encodeNode).join('') : '';
		return `${open}${content}${close}`;
	};
	return { protectedInlines, text: children.map(encodeNode).join('') };
}

function appendText(children: PhrasingContent[], value: string): void {
	if (!value) return;
	const previous = children.at(-1);
	if (previous?.type === 'text') previous.value += value;
	else children.push({ type: 'text', value });
}

type ProtectedAtom = Extract<ProtectedInline, { kind: 'atom' }>;
type ProtectedContainer = Extract<ProtectedInline, { kind: 'container' }>;
type DecodeFrame = { children: PhrasingContent[]; inline: ProtectedContainer | null };
type InlineRegistry = Readonly<{
	atoms: ReadonlyMap<string, ProtectedAtom>;
	closings: ReadonlyMap<string, ProtectedContainer>;
	openings: ReadonlyMap<string, ProtectedContainer>;
}>;

function inlineRegistry(protectedInlines: readonly ProtectedInline[]): InlineRegistry {
	const atoms = new Map<string, ProtectedAtom>();
	const openings = new Map<string, ProtectedContainer>();
	const closings = new Map<string, ProtectedContainer>();
	for (const inline of protectedInlines) {
		if (inline.kind === 'atom') atoms.set(inline.token, inline);
		else {
			openings.set(inline.open, inline);
			closings.set(inline.close, inline);
		}
	}
	return { atoms, closings, openings };
}

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

function appendDecodedToken(token: string, frames: DecodeFrame[], registry: InlineRegistry): void {
	const atom = registry.atoms.get(token);
	if (atom) {
		frames.at(-1)!.children.push(structuredClone(atom.node));
		return;
	}
	const opening = registry.openings.get(token);
	if (opening) {
		frames.push({ children: [], inline: opening });
		return;
	}
	const closing = registry.closings.get(token);
	const completed = frames.pop();
	if (!closing || !completed?.inline || completed.inline !== closing || !frames.length) {
		throw new MarkdownTranslationInvariantError('markdown-structure-changed', 'Translated prose has invalid inline tokens');
	}
	frames.at(-1)!.children.push(restoreContainer(closing, completed.children));
}

function decodePhrasing(text: string, protectedInlines: readonly ProtectedInline[]): PhrasingContent[] {
	const registry = inlineRegistry(protectedInlines);
	const frames: DecodeFrame[] = [{ children: [], inline: null }];
	let cursor = 0;
	for (const match of text.matchAll(INLINE_TOKEN_PATTERN)) {
		appendText(frames.at(-1)!.children, text.slice(cursor, match.index));
		appendDecodedToken(match[0], frames, registry);
		cursor = match.index + match[0].length;
	}
	appendText(frames.at(-1)!.children, text.slice(cursor));
	if (frames.length !== 1) {
		throw new MarkdownTranslationInvariantError('markdown-structure-changed', 'Translated prose has unclosed inline tokens');
	}
	return frames[0]!.children;
}

function isAttentionNode(node: PhrasingContent): boolean {
	return node.type === 'emphasis' || node.type === 'strong' || node.type === 'delete';
}

// CommonMark uses the same delimiter runs for adjacent attention nodes. Without a boundary, two sibling nodes such as
// `*one**two*` are parsed as one emphasis node. The upstream serializer cannot round-trip every arbitrary mdast tree, so
// add a visible word boundary only when translated prose produced this otherwise unrepresentable sibling shape.
function separateAdjacentAttentionNodes(children: PhrasingContent[]): boolean {
	let changed = false;
	for (const child of children) {
		if (isParent(child)) changed = separateAdjacentAttentionNodes(child.children as PhrasingContent[]) || changed;
	}
	for (let index = 1; index < children.length; index += 1) {
		const previous = children[index - 1];
		const current = children[index];
		if (!previous || !current || !isAttentionNode(previous) || !isAttentionNode(current)) continue;
		children.splice(index, 0, { type: 'text', value: ' ' });
		changed = true;
		index += 1;
	}
	return changed;
}

function sameStringMembers(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const sortedLeft = [...left].sort();
	const sortedRight = [...right].sort();
	return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function normalizedComparableProse(value: string): string {
	return value
		.normalize('NFKC')
		.toLocaleLowerCase()
		.replace(/[\s\p{P}\p{S}]+/gu, '');
}

function hasSubstantialContainedProse(left: string, right: string): boolean {
	const normalizedLeft = normalizedComparableProse(left);
	const normalizedRight = normalizedComparableProse(right);
	const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
	const longer = shorter === normalizedLeft ? normalizedRight : normalizedLeft;
	return [...shorter].length >= MIN_CROSS_SEQUENCE_DUPLICATE_CHARACTERS && longer.includes(shorter);
}

function sequenceSourceText(template: MarkdownTranslationTemplate, sequenceId: string): string {
	return (template.sequences[sequenceId] ?? [])
		.flatMap((partId) => {
			const sourceText = template.texts[partId];
			return sourceText === undefined ? [] : [sourceText];
		})
		.join('');
}

function assertNoNewCrossSequenceDuplication(
	segment: MarkdownTranslationSegment,
	template: MarkdownTranslationTemplate,
	translatedSequenceText: ReadonlyMap<string, string>,
): void {
	const translatedEntries = [...translatedSequenceText.entries()];
	for (const [index, [leftId, leftText]] of translatedEntries.entries()) {
		for (const [rightId, rightText] of translatedEntries.slice(index + 1)) {
			if (!hasSubstantialContainedProse(leftText, rightText)) continue;
			const sourceLeft = sequenceSourceText(template, leftId);
			const sourceRight = sequenceSourceText(template, rightId);
			if (hasSubstantialContainedProse(sourceLeft, sourceRight)) continue;
			throw new MarkdownTranslationInvariantError(
				'invalid-result',
				`Translated segment ${segment.id} duplicated prose across inline sequences ${leftId} and ${rightId}`,
			);
		}
	}
}

function compileMarkdownTranslationTarget(segment: MarkdownTranslationSegment, target: MarkdownTranslationTarget): string {
	const { reconstruction, template } = createMarkdownTranslationTemplatePlan(segment);
	const rawTargetSequences = target?.sequences;
	if (!rawTargetSequences || typeof rawTargetSequences !== 'object' || Array.isArray(rawTargetSequences)) {
		throw new MarkdownTranslationInvariantError('invalid-result', `Translated segment ${segment.id} has no inline sequences`);
	}
	const expectedSequenceIds = Object.keys(template.sequences);
	const receivedSequenceIds = Object.keys(rawTargetSequences);
	if (!sameStringMembers(expectedSequenceIds, receivedSequenceIds)) {
		throw new MarkdownTranslationInvariantError(
			'markdown-structure-changed',
			`Translated segment ${segment.id} changed its inline sequence keys`,
		);
	}
	const protectedById = new Map(segment.protectedInlines.map((inline) => [protectedInlineId(inline), inline]));
	const translatedSequenceText = new Map<string, string>();
	let translatedText = '';

	const compileSequence = (sequenceId: string): string => {
		const sourcePartIds = template.sequences[sequenceId];
		const targetParts = rawTargetSequences[sequenceId];
		if (!sourcePartIds || !Array.isArray(targetParts)) {
			throw new MarkdownTranslationInvariantError(
				'markdown-structure-changed',
				`Translated segment ${segment.id} is missing inline sequence ${sequenceId}`,
			);
		}
		const expectedInlineSet = new Set(sourcePartIds.filter((partId) => !Object.hasOwn(template.texts, partId)));
		const seenInlineIds = new Set<string>();
		let compiled = '';
		let sequenceText = '';
		for (const part of targetParts) {
			const candidate = part as { type?: unknown; value?: unknown };
			if (
				!candidate ||
				typeof candidate !== 'object' ||
				!sameStringMembers(Object.keys(candidate), ['type', 'value']) ||
				typeof candidate.value !== 'string'
			) {
				throw new MarkdownTranslationInvariantError('invalid-result', `Translated segment ${segment.id} has an invalid inline part`);
			}
			if (candidate.type === 'text') {
				if (
					!candidate.value ||
					candidate.value.includes('\0') ||
					/\r?\n[\t ]*\r?\n/u.test(candidate.value) ||
					inlineTokens(candidate.value).length
				) {
					throw new MarkdownTranslationInvariantError(
						'invalid-result',
						`Translated segment ${segment.id} has unsafe text in inline sequence ${sequenceId}`,
					);
				}
				compiled += candidate.value;
				sequenceText += candidate.value;
				translatedText += candidate.value;
				continue;
			}
			if (candidate.type !== 'inline') {
				throw new MarkdownTranslationInvariantError('invalid-result', `Translated segment ${segment.id} has an unknown part type`);
			}
			const inlineId = candidate.value;
			if (!expectedInlineSet.has(inlineId)) {
				const reason = protectedById.has(inlineId) ? 'moved' : 'invented';
				throw new MarkdownTranslationInvariantError(
					'markdown-structure-changed',
					`Translated segment ${segment.id} ${reason} inline ${inlineId} into sequence ${sequenceId}`,
				);
			}
			if (seenInlineIds.has(inlineId)) {
				throw new MarkdownTranslationInvariantError(
					'markdown-structure-changed',
					`Translated segment ${segment.id} duplicated inline ${inlineId} in sequence ${sequenceId}`,
				);
			}
			seenInlineIds.add(inlineId);
			const inline = protectedById.get(inlineId);
			if (!inline) {
				throw new MarkdownTranslationInvariantError(
					'markdown-structure-changed',
					`Translated segment ${segment.id} references unknown inline ${inlineId}`,
				);
			}
			compiled += inline.kind === 'atom' ? inline.token : `${inline.open}${compileSourceSequence(inlineId)}${inline.close}`;
		}
		if (seenInlineIds.size !== expectedInlineSet.size) {
			throw new MarkdownTranslationInvariantError(
				'markdown-structure-changed',
				`Translated segment ${segment.id} omitted an inline from sequence ${sequenceId}`,
			);
		}
		const sourceHasProse = sourcePartIds.some((partId) => {
			const sourceText = template.texts[partId];
			return sourceText !== undefined && isTranslatableProse(sourceText);
		});
		if (sourceHasProse && !isTranslatableProse(sequenceText)) {
			throw new MarkdownTranslationInvariantError(
				'invalid-result',
				`Translated segment ${segment.id} erased the prose in inline sequence ${sequenceId}`,
			);
		}
		translatedSequenceText.set(sequenceId, sequenceText);
		return compiled;
	};
	const compileSourceSequence = (sourceSequenceId: string): string => {
		const parts = reconstruction[sourceSequenceId];
		if (!parts) {
			throw new MarkdownTranslationInvariantError(
				'invalid-plan',
				`Translated segment ${segment.id} has no reconstruction sequence ${sourceSequenceId}`,
			);
		}
		return parts
			.map((part) => {
				if (part.type === 'sequence') return compileSequence(part.id);
				if (part.type === 'literal') return part.value;
				const inline = protectedById.get(part.id);
				if (inline?.kind !== 'atom' || canReorderProtectedInline(inline)) {
					throw new MarkdownTranslationInvariantError('invalid-plan', `Fixed inline ${part.id} is not an opaque atom`);
				}
				return inline.token;
			})
			.join('');
	};

	const compiled = compileSourceSequence(ROOT_TRANSLATION_SEQUENCE);
	assertNoNewCrossSequenceDuplication(segment, template, translatedSequenceText);
	if (!translatedText.trim() || compiled !== compiled.trim()) {
		throw new MarkdownTranslationInvariantError('invalid-result', `Translated segment ${segment.id} must contain safe, trimmed prose`);
	}
	return compiled;
}

function segmentInputCharacters(segment: MarkdownTranslationSegment): number {
	return JSON.stringify({ context: segment.context, id: segment.id, ...createMarkdownTranslationTemplate(segment) }).length + 1;
}

function createBatch(segments: readonly MarkdownTranslationSegment[], index: number): MarkdownTranslationBatch {
	return {
		id: `b${String(index + 1).padStart(4, '0')}`,
		inputCharacters: segments.reduce((total, segment) => total + segmentInputCharacters(segment), 0),
		segments,
		sourceCharacters: segments.reduce((total, segment) => total + segment.text.length, 0),
	};
}

function batchSegments(segments: readonly MarkdownTranslationSegment[], options: ResolvedPlanOptions): MarkdownTranslationBatch[] {
	const batches: MarkdownTranslationBatch[] = [];
	let current: MarkdownTranslationSegment[] = [];
	let currentCharacters = 0;
	for (const segment of segments) {
		const characters = segmentInputCharacters(segment);
		if (characters > options.maxBatchCharacters) {
			throw new MarkdownTranslationInvariantError('invalid-plan', `Markdown segment ${segment.id} exceeds the batch character budget`);
		}
		if (current.length > 0 && (currentCharacters + characters > options.maxBatchCharacters || current.length >= options.maxBatchSegments)) {
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
	input: Readonly<{ protectedInlines: readonly ProtectedInline[]; text: string }>,
	context: string | null,
	accumulator: PlanAccumulator,
): MarkdownTranslationSegment {
	const segment = {
		context,
		id: `s${String(accumulator.segments.length + 1).padStart(6, '0')}`,
		protectedInlines: input.protectedInlines,
		text: input.text,
	};
	accumulator.segments.push(segment);
	return segment;
}

function splitWhitespace(value: string): Readonly<{ leading: string; prose: string; trailing: string }> {
	const leading = value.match(/^\s*/u)?.[0] ?? '';
	const withoutLeading = value.slice(leading.length);
	const trailing = withoutLeading.match(/\s*$/u)?.[0] ?? '';
	return {
		leading,
		prose: withoutLeading.slice(0, withoutLeading.length - trailing.length),
		trailing,
	};
}

function planProseBlock(block: ProseBlock, context: VisitContext, options: ResolvedPlanOptions, accumulator: PlanAccumulator): void {
	if (!containsTranslatableProse(block)) return;
	const translationContext =
		context.heading && block.type !== 'heading' ? `Heading: ${context.heading}`.slice(0, options.maxContextCharacters) : null;
	const encoded = encodePhrasing(block.children, accumulator.nextInlineIndex + 1);
	accumulator.nextInlineIndex += encoded.protectedInlines.length;
	if (encoded.text.length <= options.maxSegmentCharacters) {
		const segment = addSegment(encoded, translationContext, accumulator);
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
	for (const chunk of splitProse(block.children[0].value, options.maxSegmentCharacters)) {
		const { leading, prose, trailing } = splitWhitespace(chunk);
		boundaries[boundaries.length - 1] += leading;
		if (prose) {
			segmentIds.push(addSegment({ protectedInlines: [], text: prose }, translationContext, accumulator).id);
			boundaries.push(trailing);
		} else {
			boundaries[boundaries.length - 1] += trailing;
		}
	}
	accumulator.targets.push({ boundaries, path: context.path, segmentIds });
}

function visitNode(node: Nodes, context: VisitContext, options: ResolvedPlanOptions, accumulator: PlanAccumulator): void {
	if (isProseBlock(node)) {
		planProseBlock(node, context, options, accumulator);
		return;
	}
	if (!isParent(node)) return;
	let heading = context.heading;
	for (const [index, child] of node.children.entries()) {
		const childHeading = child.type === 'heading' ? translatablePlainText(child).trim() || heading : heading;
		visitNode(child, { heading: childHeading, path: [...context.path, index] }, options, accumulator);
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
): ReadonlyMap<string, string> {
	if (translations.length !== segments.length) {
		throw new MarkdownTranslationInvariantError(
			'missing-segment',
			`Expected ${segments.length} translated segments but received ${translations.length}`,
		);
	}
	const values = new Map<string, string>();
	for (const [index, expected] of segments.entries()) {
		const result = translations[index];
		if (!result) throw new MarkdownTranslationInvariantError('missing-segment', `Missing translated segment ${expected.id}`);
		if (values.has(result.id))
			throw new MarkdownTranslationInvariantError('duplicate-segment', `Duplicate translated segment ${result.id}`);
		if (result.id !== expected.id) {
			const expectedIds = new Set(segments.map((segment) => segment.id));
			throw new MarkdownTranslationInvariantError(
				expectedIds.has(result.id) ? 'invalid-result' : 'unknown-segment',
				`Expected translated segment ${expected.id} at index ${index}, received ${result.id}`,
			);
		}
		values.set(result.id, compileMarkdownTranslationTarget(expected, result));
	}
	return values;
}

export function validateMarkdownBatchTranslations(
	batch: Pick<MarkdownTranslationBatch, 'segments'>,
	translations: readonly MarkdownSegmentTranslation[],
): readonly MarkdownSegmentTranslation[] {
	orderedTranslationMap(batch.segments, translations);
	return batch.segments.map((segment, index) => {
		const translation = translations[index];
		if (!translation) throw new MarkdownTranslationInvariantError('missing-segment', `Missing translated segment ${segment.id}`);
		return translation;
	});
}

export function planMarkdownTranslation(sourceMarkdown: string, options: MarkdownTranslationPlanOptions = {}): MarkdownTranslationPlan {
	const resolvedOptions = resolvePlanOptions(options);
	const tree = parseMarkdown(sourceMarkdown);
	const accumulator: PlanAccumulator = { nextInlineIndex: 0, segments: [], targets: [] };
	visitNode(tree, { heading: null, path: [] }, resolvedOptions, accumulator);
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
		batches: batchSegments(accumulator.segments, resolvedOptions),
		segments: accumulator.segments,
		sourceMarkdown,
		sourceSkeleton,
		targets: accumulator.targets,
	};
}

function serializeProseBlock(block: ProseBlock): string {
	const child: Heading | Paragraph =
		block.type === 'tableCell' ? { children: structuredClone(block.children), type: 'paragraph' } : structuredClone(block);
	return serializeMarkdown({ children: [child], type: 'root' }).trim();
}

export function compileMarkdownTranslationArtifact(
	plan: MarkdownTranslationPlan,
	translations: readonly MarkdownSegmentTranslation[],
): CompiledMarkdownTranslation {
	const values = orderedTranslationMap(plan.segments, translations);
	const segmentsById = new Map(plan.segments.map((segment) => [segment.id, segment]));
	const sourceTree = parseMarkdown(plan.sourceMarkdown);
	const tree = structuredClone(sourceTree);
	for (const target of plan.targets) {
		const translatedParts = target.segmentIds.map((id) => {
			const translated = values.get(id);
			if (translated === undefined) throw new MarkdownTranslationInvariantError('missing-segment', `Missing segment ${id}`);
			const segment = segmentsById.get(id);
			if (!segment) throw new MarkdownTranslationInvariantError('invalid-plan', `Missing planned segment ${id}`);
			return decodePhrasing(translated, segment.protectedInlines);
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
		let separatedAttention = false;
		for (const target of plan.targets) {
			const block = nodeAtPath(tree, target.path);
			if (isProseBlock(block)) separatedAttention = separateAdjacentAttentionNodes(block.children) || separatedAttention;
		}
		if (separatedAttention) {
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
		alignment: {
			blocks: plan.targets.flatMap((target) => {
				const source = nodeAtPath(sourceTree, target.path);
				const translated = nodeAtPath(tree, target.path);
				if (!isProseBlock(source) || !isProseBlock(translated) || source.type !== translated.type) {
					throw new MarkdownTranslationInvariantError('invalid-plan', 'Aligned translation target changed block type');
				}
				// Resource readers render the canonical title separately and remove a
				// leading H1 from the body. Keep the alignment payload on that same body boundary.
				if (source.type === 'heading' && target.path.length === 1 && target.path[0] === 0) return [];
				return [
					{
						sourceMarkdown: serializeProseBlock(source),
						translatedMarkdown: serializeProseBlock(translated),
						type: source.type,
					},
				];
			}),
			version: 1,
		},
		content: translatedMarkdown,
	};
}

export function compileMarkdownTranslation(plan: MarkdownTranslationPlan, translations: readonly MarkdownSegmentTranslation[]): string {
	return compileMarkdownTranslationArtifact(plan, translations).content;
}
