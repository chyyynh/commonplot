// Core's one Markdown dialect. It is the dialect Web renders (frontmatter, math, GFM,
// CJK-friendly emphasis), so every writer emits what Web reads and translation can
// round-trip any stored body through the same parser and serializer.
import { fromHtml } from 'hast-util-from-html';
import { type Options as ToMdastOptions, toMdast } from 'hast-util-to-mdast';
import type { Emphasis, Nodes, Parents, Root, Strong } from 'mdast';
import { fromMarkdown, type Options as FromMarkdownOptions } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown, frontmatterToMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown, mathToMarkdown } from 'mdast-util-math';
import type { Raw } from 'mdast-util-to-hast';
import { type Info, type State, toMarkdown } from 'mdast-util-to-markdown';
import { cjkFriendlyToMarkdown } from 'mdast-util-to-markdown-cjk-friendly';
import { cjkFriendlyGfmStrikethroughToMarkdown } from 'mdast-util-to-markdown-cjk-friendly-gfm-strikethrough';
import { cjkFriendlyExtension } from 'micromark-extension-cjk-friendly';
import { gfmStrikethroughCjkFriendly } from 'micromark-extension-cjk-friendly-gfm-strikethrough';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';

declare module 'mdast' {
	interface RootContentMap {
		toml: Literal & { type: 'toml' };
	}
}

const FRONTMATTER_PRESETS: Array<'toml' | 'yaml'> = ['yaml', 'toml'];
const CJK_MARKDOWN = cjkFriendlyToMarkdown();

/** Parse Markdown; `extensions` may only narrow the dialect (e.g. disable raw HTML). */
export function parseMarkdown(markdown: string, extensions: NonNullable<FromMarkdownOptions['extensions']> = []): Root {
	return fromMarkdown(markdown, {
		extensions: [frontmatter(FRONTMATTER_PRESETS), math(), gfm(), cjkFriendlyExtension(), gfmStrikethroughCjkFriendly(), ...extensions],
		mdastExtensions: [frontmatterFromMarkdown(FRONTMATTER_PRESETS), mathFromMarkdown(), ...gfmFromMarkdown()],
	});
}

function attentionMarker(state: State, kind: 'strong' | 'emphasis'): '*' | '_' {
	return state.stack.filter((construct) => construct === kind).length % 2 === 0 ? '*' : '_';
}

// Alternate nested attention markers so edited or translated text cannot change delimiter pairing.
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

export function stringifyMarkdown(tree: Nodes): string {
	return toMarkdown(tree, {
		bullet: '-',
		extensions: [
			frontmatterToMarkdown(FRONTMATTER_PRESETS),
			mathToMarkdown(),
			gfmToMarkdown({ tablePipeAlign: false }),
			CJK_MARKDOWN,
			cjkFriendlyGfmStrikethroughToMarkdown(),
		],
		handlers: { strong: serializeAttention, emphasis: serializeAttention },
	}).trimEnd();
}

/** Plain text as one paragraph each, escaped by the shared serializer. */
export function paragraphsMarkdown(texts: readonly string[]): string {
	return stringifyMarkdown({
		type: 'root',
		children: texts.map((value) => ({ type: 'paragraph', children: [{ type: 'text', value }] })),
	});
}

/** An HTML fragment as mdast. HTML comments are invisible implementation metadata, never content. */
export function htmlToMdast(html: string, options: ToMdastOptions = {}): Root {
	return toMdast(fromHtml(html, { fragment: true }), { ...options, nodeHandlers: { comment() {}, ...options.nodeHandlers } }) as Root;
}

/** Markdown blocks inside an HTML element (e.g. a merged table cell); blank lines let Markdown resume. */
export function markdownHtmlContent(tree: Root): Raw {
	return { type: 'raw', value: `\n\n${stringifyMarkdown(tree)}\n\n` };
}
