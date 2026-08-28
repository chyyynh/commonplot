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

type MarkdownTranslationTarget = Readonly<{
	boundaries: readonly string[] | null;
	path: readonly number[];
	segmentIds: readonly string[];
}>;

type ProtectedDestination = Readonly<{
	displayUrl: string | null;
	placeholder: string;
	title: string | null;
	url: string;
}>;

type ProtectedLiteral = Readonly<{
	placeholder: string;
	value: string;
}>;

export type MarkdownTranslationSegment = Readonly<{
	context: string | null;
	id: string;
	protectedDestinations: readonly ProtectedDestination[];
	protectedLiterals: readonly ProtectedLiteral[];
	referenceContext: string;
	sourceSkeleton: string;
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
	referenceContext: string;
	segments: MarkdownTranslationSegment[];
	targets: MarkdownTranslationTarget[];
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

function plainText(node: Nodes): string {
	if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') return node.value;
	if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
	if (node.type === 'break') return '\n';
	if (!isParent(node)) return '';
	return node.children.map((child) => plainText(child)).join('');
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
): unknown {
	const translated = insideTranslatedBlock || translatedBlocks.has(translatedPathKey(path));
	const structure: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === 'data' || key === 'position') continue;
		if (key === 'children' && isParent(node)) {
			structure.children = node.children.map((child, index) =>
				structuralNode(child, [...path, index], translatedBlocks, [...ancestors, node], translated),
			);
			continue;
		}
		if (translated && key === 'value' && node.type === 'text' && !isProtectedLinkText(node.value, ancestors)) {
			structure.value = TRANSLATED_PROSE_SENTINEL;
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

function phrasingRoot(children: readonly PhrasingContent[]): Root {
	return { type: 'root', children: [{ type: 'paragraph', children: [...children] }] };
}

function referenceContext(tree: Root): string {
	const definitions = tree.children.filter((node) => node.type === 'definition' || node.type === 'footnoteDefinition');
	return definitions.length ? serializeMarkdown({ type: 'root', children: definitions }) : '';
}

function serializePhrasing(children: readonly PhrasingContent[]): string {
	return serializeMarkdown(phrasingRoot(children));
}

function protectDestinations(children: readonly PhrasingContent[]): Readonly<{
	destinations: readonly ProtectedDestination[];
	literals: readonly ProtectedLiteral[];
	text: string;
}> {
	const protectedChildren = structuredClone(children);
	const destinations: ProtectedDestination[] = [];
	const literals: ProtectedLiteral[] = [];
	const protectNode = (node: Nodes): void => {
		if (node.type === 'link' || node.type === 'image') {
			const placeholder = `https://newsence.invalid/protected/${String(destinations.length + 1).padStart(4, '0')}`;
			const displayUrl =
				node.type === 'link' &&
				node.children.length === 1 &&
				node.children[0]?.type === 'text' &&
				normalizedAutolinkDestination(node.children[0].value) === normalizedAutolinkDestination(node.url)
					? node.children[0].value
					: null;
			destinations.push({ displayUrl, placeholder, title: node.title ?? null, url: node.url });
			node.url = placeholder;
			node.title = null;
			if (displayUrl && node.type === 'link' && node.children[0]?.type === 'text') node.children[0].value = placeholder;
		}
		if (node.type === 'text') {
			node.value = node.value.replaceAll('$', () => {
				const placeholder = `NEWSENCEPROTECTED${String(literals.length + 1).padStart(4, '0')}TOKEN`;
				literals.push({ placeholder, value: '$' });
				return placeholder;
			});
		}
		if (isParent(node)) {
			for (const child of node.children) protectNode(child);
		}
	};
	for (const child of protectedChildren) protectNode(child);
	return { destinations, literals, text: serializePhrasing(protectedChildren) };
}

function parsePhrasing(markdown: string, references: string): PhrasingContent[] {
	const tree = parseMarkdown(references ? `${markdown}\n\n${references}` : markdown);
	const block = tree.children[0];
	if (
		block?.type !== 'paragraph' ||
		tree.children.slice(1).some((node) => node.type !== 'definition' && node.type !== 'footnoteDefinition')
	) {
		throw new MarkdownTranslationInvariantError('invalid-result', 'Translated Markdown segment must remain one prose block');
	}
	return block.children;
}

function phrasingSkeleton(markdown: string, references: string): string {
	let tree: Root;
	try {
		tree = parseMarkdown(references ? `${markdown}\n\n${references}` : markdown);
	} catch (error) {
		throw new MarkdownTranslationInvariantError(
			'invalid-result',
			`Translated Markdown segment could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		tree.children[0]?.type !== 'paragraph' ||
		tree.children.slice(1).some((node) => node.type !== 'definition' && node.type !== 'footnoteDefinition')
	) {
		throw new MarkdownTranslationInvariantError('invalid-result', 'Translated Markdown segment must remain one prose block');
	}
	return JSON.stringify(structuralNode(tree.children[0], [0], new Set(['0'])));
}

function segmentInputCharacters(segment: MarkdownTranslationSegment): number {
	return JSON.stringify({ context: segment.context, id: segment.id, text: segment.text }).length + 1;
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
	input: string | readonly PhrasingContent[],
	context: string | null,
	accumulator: PlanAccumulator,
): MarkdownTranslationSegment {
	const protectedInput = typeof input === 'string' ? { destinations: [], literals: [], text: input } : protectDestinations(input);
	const text = protectedInput.text;
	const sourceSkeleton = phrasingSkeleton(text, accumulator.referenceContext);
	const segment = {
		context,
		id: `s${String(accumulator.segments.length + 1).padStart(6, '0')}`,
		protectedDestinations: protectedInput.destinations,
		protectedLiterals: protectedInput.literals,
		referenceContext: accumulator.referenceContext,
		sourceSkeleton,
		text,
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
	const heading = context.heading && block.type !== 'heading' ? `Heading: ${context.heading}`.slice(0, options.maxContextCharacters) : null;
	const serialized = serializePhrasing(block.children);
	if (serialized.length <= options.maxSegmentCharacters) {
		const segment = addSegment(block.children, heading, accumulator);
		accumulator.targets.push({ boundaries: null, path: context.path, segmentIds: [segment.id] });
	} else if (block.children.length === 1 && block.children[0]?.type === 'text') {
		const boundaries = [''];
		const segmentIds: string[] = [];
		for (const chunk of splitProse(block.children[0].value, options.maxSegmentCharacters)) {
			const { leading, prose, trailing } = splitWhitespace(chunk);
			boundaries[boundaries.length - 1] += leading;
			if (!prose) {
				boundaries[boundaries.length - 1] += trailing;
				continue;
			}
			segmentIds.push(addSegment(prose, heading, accumulator).id);
			boundaries.push(trailing);
		}
		accumulator.targets.push({ boundaries, path: context.path, segmentIds });
	} else {
		throw new MarkdownTranslationInvariantError(
			'invalid-plan',
			'Markdown prose block with inline structure exceeds the safe translation segment size',
		);
	}
}

function visitNode(node: Nodes, context: VisitContext, options: ResolvedPlanOptions, accumulator: PlanAccumulator): void {
	if (isProseBlock(node)) {
		planProseBlock(node, context, options, accumulator);
		return;
	}
	if (!isParent(node)) return;
	let heading = context.heading;
	for (const [index, child] of node.children.entries()) {
		const childHeading = child.type === 'heading' ? plainText(child).trim() || heading : heading;
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

function restoreDestinations(children: PhrasingContent[], segment: MarkdownTranslationSegment): void {
	const destinations = new Map(segment.protectedDestinations.map((destination) => [destination.placeholder, destination]));
	const restored = new Set<string>();
	const restoreNode = (node: Nodes): void => {
		if (node.type === 'link' || node.type === 'image') {
			const destination = destinations.get(node.url);
			if (destination) {
				node.url = destination.url;
				node.title = destination.title;
				if (destination.displayUrl && node.type === 'link' && node.children[0]?.type === 'text') {
					node.children[0].value = destination.displayUrl;
				}
				restored.add(destination.placeholder);
			}
		}
		if (isParent(node)) {
			for (const child of node.children) restoreNode(child);
		}
	};
	for (const child of children) restoreNode(child);
	if (restored.size !== destinations.size) {
		throw new MarkdownTranslationInvariantError(
			'markdown-structure-changed',
			`Translated segment ${segment.id} lost a protected destination`,
		);
	}
}

function restoreLiterals(markdown: string, segment: MarkdownTranslationSegment): string {
	let restored = markdown;
	for (const literal of segment.protectedLiterals) {
		restored = restored.replaceAll(literal.placeholder, `\\${literal.value}`);
	}
	return restored;
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
		if (!result.text.trim() || result.text !== result.text.trim() || result.text.includes('\0')) {
			throw new MarkdownTranslationInvariantError('invalid-result', `Translated segment ${result.id} must contain safe, trimmed Markdown`);
		}
		for (const literal of expected.protectedLiterals) {
			if (result.text.split(literal.placeholder).length !== 2) {
				throw new MarkdownTranslationInvariantError(
					'markdown-structure-changed',
					`Translated segment ${result.id} changed a protected literal`,
				);
			}
		}
		if (phrasingSkeleton(result.text, expected.referenceContext) !== expected.sourceSkeleton) {
			throw new MarkdownTranslationInvariantError(
				'markdown-structure-changed',
				`Translated segment ${result.id} changed protected Markdown structure`,
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
	const accumulator: PlanAccumulator = { referenceContext: referenceContext(tree), segments: [], targets: [] };
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
		const block = nodeAtPath(tree, target.path);
		if (!isProseBlock(block)) throw new MarkdownTranslationInvariantError('invalid-plan', 'Translation target is not a prose block');
		const translatedParts = target.segmentIds.map((id) => {
			const translated = values.get(id);
			if (translated === undefined) throw new MarkdownTranslationInvariantError('missing-segment', `Missing segment ${id}`);
			const segment = segmentsById.get(id);
			if (!segment) throw new MarkdownTranslationInvariantError('invalid-plan', `Missing planned segment ${id}`);
			const children = parsePhrasing(restoreLiterals(translated, segment), segment.referenceContext);
			restoreDestinations(children, segment);
			return children;
		});
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
