import type { Heading, Literal, Nodes, Paragraph, Parents, PhrasingContent, Root, TableCell } from 'mdast';
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
const INLINE_TOKEN_PATTERN = /<\/?n-[0-9]{6}>|<n-[0-9]{6}\/>/gu;
const MAX_INLINE_REFERENCE_CHARACTERS = 256;
const ROOT_TRANSLATION_SEQUENCE = 'root';
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

export type MarkdownTranslationPart = Readonly<{ type: 'inline'; value: string }> | Readonly<{ type: 'text'; value: string }>;

export type MarkdownTranslationInline = Readonly<{
	canReorder?: false;
	kind: PhrasingContent['type'];
	reference?: string;
}>;

export type MarkdownTranslationSourcePart = string | Readonly<{ id: string }>;

export type MarkdownTranslationTemplate = Readonly<{
	inlines: Readonly<Record<string, MarkdownTranslationInline>>;
	sequences: Readonly<Record<string, readonly MarkdownTranslationSourcePart[]>>;
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

export type MarkdownTranslationPlanOptions = Readonly<{
	maxBatchCharacters?: number;
	maxBatchSegments?: number;
	maxContextCharacters?: number;
	maxSegmentCharacters?: number;
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
	const offsets = ambiguousCurrencyDelimiterOffsets(tree, markdown);
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

function ambiguousCurrencyDelimiterOffsets(tree: Root, source: string): number[] {
	const offsets: number[] = [];
	const visit = (node: Nodes): void => {
		if (node.type === 'inlineMath' && (node.value.includes('](') || node.value.length > 160)) {
			const start = node.position?.start.offset;
			const end = node.position?.end.offset;
			if (
				start !== undefined &&
				end !== undefined &&
				source[start] === '$' &&
				source[end - 1] === '$' &&
				source.slice(start, start + 2) !== '$$'
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
	if (inline.kind !== 'atom' || (inline.node.type !== 'inlineCode' && inline.node.type !== 'inlineMath')) return undefined;
	const value = inline.node.value.slice(0, MAX_INLINE_REFERENCE_CHARACTERS);
	return value || undefined;
}

function protectedInlineId(inline: ProtectedInline): string {
	const id = (inline.kind === 'atom' ? inline.token : inline.open).match(/n-[0-9]{6}/u)?.[0];
	if (!id) throw new MarkdownTranslationInvariantError('invalid-plan', 'Protected inline has no stable identifier');
	return id;
}

function canReorderProtectedInline(inline: ProtectedInline): boolean {
	return inline.kind === 'container' || inline.node.type === 'inlineCode' || inline.node.type === 'inlineMath';
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

// Like XLIFF inline codes, these references protect syntax and destinations. Named parent sequences normalize the inline tree without
// a recursive model schema: siblings can move for target-language word order, but prose cannot cross a formatting scope.
export function createMarkdownTranslationTemplate(segment: MarkdownTranslationSegment): MarkdownTranslationTemplate {
	return {
		inlines: Object.fromEntries(
			segment.protectedInlines.map((inline) => {
				const reference = protectedAtomReference(inline);
				return [
					protectedInlineId(inline),
					{
						...(!canReorderProtectedInline(inline) ? { canReorder: false as const } : {}),
						kind: inline.node.type,
						...(reference ? { reference } : {}),
					},
				];
			}),
		),
		sequences: parseTranslationSequences(segment.text, segment.protectedInlines),
	};
}

function nextInlineToken(kind: 'atom' | 'close' | 'open', index: number): string {
	const name = `n-${String(index).padStart(6, '0')}`;
	if (kind === 'atom') return `<${name}/>`;
	return kind === 'open' ? `<${name}>` : `</${name}>`;
}

function isAutolink(node: PhrasingContent): boolean {
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
		if (isAutolink(node) || (!isParent(node) && node.type !== 'image' && node.type !== 'imageReference')) {
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

function sameStringMembers(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const sortedLeft = [...left].sort();
	const sortedRight = [...right].sort();
	return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function sourceTranslationTextSlots(parts: readonly MarkdownTranslationSourcePart[]): string[] {
	const slots = [''];
	for (const part of parts) {
		if (typeof part === 'string') slots[slots.length - 1] += part;
		else slots.push('');
	}
	return slots;
}

function targetTranslationTextSlots(parts: readonly MarkdownTranslationPart[]): string[] {
	const slots = [''];
	for (const part of parts) {
		if (part.type === 'text') slots[slots.length - 1] += part.value;
		else slots.push('');
	}
	return slots;
}

function compileMarkdownTranslationTarget(segment: MarkdownTranslationSegment, target: MarkdownTranslationTarget): string {
	const template = createMarkdownTranslationTemplate(segment);
	const targetSequences = target?.sequences;
	if (!targetSequences || typeof targetSequences !== 'object' || Array.isArray(targetSequences)) {
		throw new MarkdownTranslationInvariantError('invalid-result', `Translated segment ${segment.id} has no inline sequences`);
	}
	const expectedSequenceIds = Object.keys(template.sequences);
	const receivedSequenceIds = Object.keys(targetSequences);
	if (!sameStringMembers(expectedSequenceIds, receivedSequenceIds)) {
		throw new MarkdownTranslationInvariantError(
			'markdown-structure-changed',
			`Translated segment ${segment.id} changed its inline sequence keys`,
		);
	}
	const protectedById = new Map(segment.protectedInlines.map((inline) => [protectedInlineId(inline), inline]));
	let translatedText = '';

	const compileSequence = (sequenceId: string): string => {
		const sourceParts = template.sequences[sequenceId];
		const targetParts = targetSequences[sequenceId];
		if (!sourceParts || !Array.isArray(targetParts)) {
			throw new MarkdownTranslationInvariantError(
				'markdown-structure-changed',
				`Translated segment ${segment.id} is missing inline sequence ${sequenceId}`,
			);
		}
		const expectedInlineIds = sourceParts.flatMap((part) => (typeof part === 'string' ? [] : [part.id]));
		const expectedInlineSet = new Set(expectedInlineIds);
		const seenInlineIds = new Set<string>();
		const receivedInlineIds: string[] = [];
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
			receivedInlineIds.push(inlineId);
			const inline = protectedById.get(inlineId);
			if (!inline) {
				throw new MarkdownTranslationInvariantError(
					'markdown-structure-changed',
					`Translated segment ${segment.id} references unknown inline ${inlineId}`,
				);
			}
			compiled += inline.kind === 'atom' ? inline.token : `${inline.open}${compileSequence(inlineId)}${inline.close}`;
		}
		if (seenInlineIds.size !== expectedInlineSet.size) {
			throw new MarkdownTranslationInvariantError(
				'markdown-structure-changed',
				`Translated segment ${segment.id} omitted an inline from sequence ${sequenceId}`,
			);
		}
		const hasFixedInline = expectedInlineIds.some((inlineId) => {
			const inline = protectedById.get(inlineId);
			return inline ? !canReorderProtectedInline(inline) : true;
		});
		if (hasFixedInline && !expectedInlineIds.every((inlineId, index) => receivedInlineIds[index] === inlineId)) {
			throw new MarkdownTranslationInvariantError(
				'markdown-structure-changed',
				`Translated segment ${segment.id} reordered a fixed inline in sequence ${sequenceId}`,
			);
		}
		if (hasFixedInline) {
			const sourceSlots = sourceTranslationTextSlots(sourceParts);
			const targetSlots = targetTranslationTextSlots(targetParts);
			for (const [index, sourceSlot] of sourceSlots.entries()) {
				const targetSlot = targetSlots[index] ?? '';
				if (isTranslatableProse(sourceSlot) && !isTranslatableProse(targetSlot)) {
					throw new MarkdownTranslationInvariantError(
						'invalid-result',
						`Translated segment ${segment.id} erased prose beside a fixed inline in sequence ${sequenceId}`,
					);
				}
				if (!sourceSlot.trim() && isTranslatableProse(targetSlot)) {
					throw new MarkdownTranslationInvariantError(
						'markdown-structure-changed',
						`Translated segment ${segment.id} moved prose across a fixed inline in sequence ${sequenceId}`,
					);
				}
			}
		}
		const sourceHasProse = sourceParts.some((part) => typeof part === 'string' && isTranslatableProse(part));
		if (sourceHasProse && !isTranslatableProse(sequenceText)) {
			throw new MarkdownTranslationInvariantError(
				'invalid-result',
				`Translated segment ${segment.id} erased the prose in inline sequence ${sequenceId}`,
			);
		}
		return compiled;
	};

	const compiled = compileSequence(ROOT_TRANSLATION_SEQUENCE);
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

export function compileMarkdownTranslation(plan: MarkdownTranslationPlan, translations: readonly MarkdownSegmentTranslation[]): string {
	const values = orderedTranslationMap(plan.segments, translations);
	const segmentsById = new Map(plan.segments.map((segment) => [segment.id, segment]));
	const tree = parseMarkdown(plan.sourceMarkdown);
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
	const translatedMarkdown = serializeMarkdown(tree);
	const translatedSkeleton = markdownSkeleton(
		parseMarkdown(translatedMarkdown),
		plan.targets.map((target) => target.path),
	);
	if (translatedSkeleton !== plan.sourceSkeleton) {
		throw new MarkdownTranslationInvariantError(
			'markdown-structure-changed',
			'Translated Markdown did not preserve the source document structure',
		);
	}
	return translatedMarkdown;
}
