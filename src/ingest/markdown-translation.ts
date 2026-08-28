import type { Literal, Nodes, Parents, Root } from 'mdast';
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
const TRANSLATED_FIELD_SENTINEL = '<translated-prose>';
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

type TranslationField = 'alt' | 'value';

type MarkdownTranslationTargetPart = Readonly<{ kind: 'literal'; value: string }> | Readonly<{ id: string; kind: 'segment' }>;

type MarkdownTranslationTarget = Readonly<{
	field: TranslationField;
	parts: readonly MarkdownTranslationTargetPart[];
	path: readonly number[];
}>;

export type MarkdownTranslationSegment = Readonly<{
	context: string | null;
	id: string;
	text: string;
}>;

export type MarkdownTranslationBatch = Readonly<{
	id: string;
	inputCharacters: number;
	segments: readonly MarkdownTranslationSegment[];
	sourceCharacters: number;
}>;

export type MarkdownSegmentTranslation = Readonly<{
	id: string;
	text: string;
}>;

export type MarkdownTranslationPlan = Readonly<{
	batches: readonly MarkdownTranslationBatch[];
	segments: readonly MarkdownTranslationSegment[];
	sourceMarkdown: string;
	sourceSkeleton: string;
	targets: readonly MarkdownTranslationTarget[];
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
	blockText: WeakMap<object, string>;
	segments: MarkdownTranslationSegment[];
	targets: MarkdownTranslationTarget[];
};

type VisitContext = Readonly<{
	ancestors: readonly Nodes[];
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

function parseMarkdown(markdown: string): Root {
	return fromMarkdown(markdown, {
		extensions: [frontmatter(FRONTMATTER_PRESETS), math(), gfm()],
		mdastExtensions: [frontmatterFromMarkdown(FRONTMATTER_PRESETS), mathFromMarkdown(), ...gfmFromMarkdown()],
	});
}

function serializeMarkdown(tree: Root): string {
	return toMarkdown(tree, {
		extensions: [frontmatterToMarkdown(FRONTMATTER_PRESETS), mathToMarkdown(), gfmToMarkdown()],
	}).trimEnd();
}

function isParent(node: Nodes): node is Parents {
	return 'children' in node && Array.isArray(node.children);
}

function plainText(node: Nodes): string {
	if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') return node.value;
	if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
	if (node.type === 'break') return '\n';
	if (!isParent(node)) return '';
	return node.children.map((child) => plainText(child)).join('');
}

function nearestProseBlock(ancestors: readonly Nodes[]): Nodes | null {
	for (let index = ancestors.length - 1; index >= 0; index--) {
		const node = ancestors[index];
		if (node && (node.type === 'heading' || node.type === 'paragraph' || node.type === 'tableCell')) return node;
	}
	return null;
}

function cachedPlainText(node: Nodes, accumulator: PlanAccumulator): string {
	const cached = accumulator.blockText.get(node);
	if (cached !== undefined) return cached;
	const value = plainText(node).trim();
	accumulator.blockText.set(node, value);
	return value;
}

function segmentContext(value: string, context: VisitContext, maxCharacters: number, accumulator: PlanAccumulator): string | null {
	const block = nearestProseBlock(context.ancestors);
	const blockText = block ? cachedPlainText(block, accumulator) : '';
	const parts: string[] = [];
	if (context.heading && context.heading !== blockText) parts.push(`Heading: ${context.heading}`);
	if (blockText && blockText !== value.trim()) parts.push(`Block: ${blockText}`);
	const combined = parts.join('\n').trim();
	return combined ? combined.slice(0, maxCharacters) : null;
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
		if (end <= start) throw new MarkdownTranslationInvariantError('invalid-plan', 'Markdown segment split made no progress');
		chunks.push(value.slice(start, end));
		start = end;
	}
	return chunks;
}

function appendLiteral(parts: MarkdownTranslationTargetPart[], value: string): void {
	if (!value) return;
	const previous = parts.at(-1);
	if (previous?.kind === 'literal') {
		parts[parts.length - 1] = { kind: 'literal', value: previous.value + value };
		return;
	}
	parts.push({ kind: 'literal', value });
}

function splitWhitespace(value: string): Readonly<{ leading: string; prose: string; trailing: string }> {
	const leadingLength = value.match(/^\s*/u)?.[0].length ?? 0;
	const withoutLeading = value.slice(leadingLength);
	const trailingLength = withoutLeading.match(/\s*$/u)?.[0].length ?? 0;
	return {
		leading: value.slice(0, leadingLength),
		prose: withoutLeading.slice(0, withoutLeading.length - trailingLength),
		trailing: trailingLength ? withoutLeading.slice(-trailingLength) : '',
	};
}

function planField(
	value: string,
	field: TranslationField,
	context: VisitContext,
	options: ResolvedPlanOptions,
	accumulator: PlanAccumulator,
): void {
	const parts: MarkdownTranslationTargetPart[] = [];
	for (const chunk of splitProse(value, options.maxSegmentCharacters)) {
		const { leading, prose, trailing } = splitWhitespace(chunk);
		appendLiteral(parts, leading);
		if (isTranslatableProse(prose)) {
			const id = `s${String(accumulator.segments.length + 1).padStart(6, '0')}`;
			accumulator.segments.push({
				context: segmentContext(prose, context, options.maxContextCharacters, accumulator),
				id,
				text: prose,
			});
			parts.push({ id, kind: 'segment' });
		} else {
			appendLiteral(parts, prose);
		}
		appendLiteral(parts, trailing);
	}
	if (parts.some((part) => part.kind === 'segment')) {
		accumulator.targets.push({ field, parts, path: context.path });
	}
}

function planNodeFields(node: Nodes, context: VisitContext, options: ResolvedPlanOptions, accumulator: PlanAccumulator): void {
	if (node.type === 'text' && !isProtectedLinkText(node.value, context.ancestors)) {
		planField(node.value, 'value', context, options, accumulator);
		return;
	}
	if ((node.type === 'image' || node.type === 'imageReference') && node.alt) {
		planField(node.alt, 'alt', context, options, accumulator);
	}
}

function visitNode(node: Nodes, context: VisitContext, options: ResolvedPlanOptions, accumulator: PlanAccumulator): void {
	planNodeFields(node, context, options, accumulator);
	if (!isParent(node)) return;
	let heading = context.heading;
	for (const [index, child] of node.children.entries()) {
		const childHeading = child.type === 'heading' ? plainText(child).trim() || heading : heading;
		visitNode(
			child,
			{
				ancestors: [...context.ancestors, node],
				heading: childHeading,
				path: [...context.path, index],
			},
			options,
			accumulator,
		);
		if (child.type === 'heading') heading = childHeading;
	}
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

function segmentInputCharacters(segment: MarkdownTranslationSegment): number {
	return JSON.stringify(segment).length + 1;
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
		const exceedsLimit = current.length > 0 && currentCharacters + characters > options.maxBatchCharacters;
		if (exceedsLimit || current.length >= options.maxBatchSegments) {
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

function targetKey(path: readonly number[], field: TranslationField): string {
	return `${path.join('.')}:${field}`;
}

function structuralNode(node: Nodes, path: readonly number[], translatedFields: ReadonlySet<string>): unknown {
	const structure: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === 'data' || key === 'position') continue;
		if (key === 'children' && isParent(node)) {
			structure.children = node.children.map((child, index) => structuralNode(child, [...path, index], translatedFields));
			continue;
		}
		if ((key === 'alt' || key === 'value') && translatedFields.has(targetKey(path, key))) {
			structure[key] = TRANSLATED_FIELD_SENTINEL;
			continue;
		}
		structure[key] = value;
	}
	return structure;
}

function markdownSkeleton(tree: Root, targets: readonly MarkdownTranslationTarget[]): string {
	const translatedFields = new Set(targets.map((target) => targetKey(target.path, target.field)));
	return JSON.stringify(structuralNode(tree, [], translatedFields));
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

function setTargetValue(node: Nodes, field: TranslationField, value: string): void {
	if (field === 'value' && node.type === 'text') {
		node.value = value;
		return;
	}
	if (field === 'alt' && (node.type === 'image' || node.type === 'imageReference')) {
		node.alt = value;
		return;
	}
	throw new MarkdownTranslationInvariantError('invalid-plan', `Translation target field ${field} does not match its Markdown node`);
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
		if (!result.text.trim() || result.text !== result.text.trim() || /\r?\n[\t ]*\r?\n/u.test(result.text) || result.text.includes('\0')) {
			throw new MarkdownTranslationInvariantError(
				'invalid-result',
				`Translated segment ${result.id} must contain safe, trimmed prose without blank lines`,
			);
		}
		values.set(result.id, result.text);
	}
	return values;
}

export function validateMarkdownBatchTranslations(
	batch: Pick<MarkdownTranslationBatch, 'segments'>,
	translations: readonly MarkdownSegmentTranslation[],
): readonly MarkdownSegmentTranslation[] {
	const values = orderedTranslationMap(batch.segments, translations);
	return batch.segments.map((segment) => ({ id: segment.id, text: values.get(segment.id)! }));
}

export function planMarkdownTranslation(sourceMarkdown: string, options: MarkdownTranslationPlanOptions = {}): MarkdownTranslationPlan {
	const resolvedOptions = resolvePlanOptions(options);
	const tree = parseMarkdown(sourceMarkdown);
	const accumulator: PlanAccumulator = { blockText: new WeakMap(), segments: [], targets: [] };
	visitNode(tree, { ancestors: [], heading: null, path: [] }, resolvedOptions, accumulator);
	const sourceSkeleton = markdownSkeleton(tree, accumulator.targets);
	const normalizedTree = parseMarkdown(serializeMarkdown(tree));
	if (markdownSkeleton(normalizedTree, accumulator.targets) !== sourceSkeleton) {
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
	const tree = parseMarkdown(plan.sourceMarkdown);
	for (const target of plan.targets) {
		const value = target.parts
			.map((part) => {
				if (part.kind === 'literal') return part.value;
				const translated = values.get(part.id);
				if (translated === undefined) throw new MarkdownTranslationInvariantError('missing-segment', `Missing segment ${part.id}`);
				return translated;
			})
			.join('');
		setTargetValue(nodeAtPath(tree, target.path), target.field, value);
	}
	const translatedMarkdown = serializeMarkdown(tree);
	const translatedSkeleton = markdownSkeleton(parseMarkdown(translatedMarkdown), plan.targets);
	if (translatedSkeleton !== plan.sourceSkeleton) {
		throw new MarkdownTranslationInvariantError(
			'markdown-structure-changed',
			'Translated Markdown did not preserve the source document structure',
		);
	}
	return translatedMarkdown;
}
