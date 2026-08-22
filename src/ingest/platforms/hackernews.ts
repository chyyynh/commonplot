import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { ForumKindMetadata } from '@core-shared/resource';
import { generateText } from 'ai';
import { decode } from 'html-entities';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import {
	literalCreator,
	materializePlatformResource,
	type PlatformAcquiredMaterial,
	type ResolvedResource,
	type ResourceAcquisitionOrigin,
} from './materialize';

const HN_ALGOLIA_API = 'https://hn.algolia.com/api/v1/items';
interface HnComment {
	author?: string;
	text?: string;
	children?: HnComment[];
}

const optionalStringSchema = z
	.string()
	.nullable()
	.transform((value) => value ?? undefined)
	.optional();
const optionalNonnegativeIntegerSchema = z
	.number()
	.int()
	.nonnegative()
	.nullable()
	.transform((value) => value ?? undefined)
	.optional();

const HnCommentSchema: z.ZodType<HnComment> = z.lazy(() =>
	z.object({
		author: optionalStringSchema,
		text: optionalStringSchema,
		children: z
			.array(HnCommentSchema)
			.nullable()
			.transform((value) => value ?? undefined)
			.optional(),
	}),
);

// Shape of Algolia's /items/{id} response. It carries the whole comment tree in
// `children` but has no `descendants` — that is a Firebase field, so discussion
// size has to be counted from the tree.
const HackerNewsItemSchema = z.object({
	id: z.number().int().positive(),
	title: optionalStringSchema,
	url: optionalStringSchema,
	author: optionalStringSchema,
	points: optionalNonnegativeIntegerSchema,
	type: z
		.enum(['story', 'ask', 'show', 'job', 'comment', 'poll'])
		.nullable()
		.transform((value) => value ?? undefined)
		.optional(),
	created_at_i: optionalNonnegativeIntegerSchema,
	text: optionalStringSchema,
	children: z
		.array(HnCommentSchema)
		.nullable()
		.transform((value) => value ?? undefined)
		.optional(),
});

type HackerNewsItem = z.infer<typeof HackerNewsItemSchema>;

type HackerNewsDiscussionInput = {
	commentInput: string;
	commentCount: number;
	hnText: string | null;
	points: number | null;
	totalCommentCount: number;
};

type HackerNewsAcquisition = PlatformAcquiredMaterial<'hackernews'> & { discussion: HackerNewsDiscussionInput };

/** Every node in the tree, deleted ones included — the closest analogue to the count HN itself shows. */
function countHnComments(children: HnComment[] | undefined): number {
	let total = 0;
	for (const child of children ?? []) {
		total += 1 + countHnComments(child.children);
	}
	return total;
}

async function fetchHnItem(itemId: string): Promise<HackerNewsItem> {
	const response = await fetch(`${HN_ALGOLIA_API}/${itemId}`, { signal: AbortSignal.timeout(15_000) });
	if (!response.ok) {
		await response.body?.cancel();
		if (response.status === 404 || response.status === 410) {
			throw new NonRetryableError(`Hacker News item ${itemId} was not found`);
		}
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}
	const payload: unknown = await response.json();
	if (payload === null) throw new NonRetryableError(`Hacker News item ${itemId} was not found`);
	return HackerNewsItemSchema.parse(payload);
}

interface HnCollectedComment {
	author?: string;
	text: string;
}

function htmlToText(str: string): string {
	return decode(str.replace(/<[^>]*>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim();
}

function buildHnPostMarkdown(item: HackerNewsItem, title: string, commentCount: number): string {
	const parts: string[] = [`# ${title}\n`];
	const metaParts: string[] = [];
	if (item.points !== undefined) metaParts.push(`${item.points} points`);
	if (item.author) metaParts.push(`by ${item.author}`);
	if (commentCount > 0) metaParts.push(`${commentCount} comments`);
	if (metaParts.length) parts.push(`*${metaParts.join(' | ')}*\n`);
	if (item.text) parts.push(`---\n\n${htmlToText(item.text)}\n`);
	return parts.join('\n');
}

function hackerNewsItemTitle(item: HackerNewsItem, itemId: string): string {
	const title = item.title?.trim();
	if (title) return title;
	if (item.type === 'comment') return `Hacker News comment #${itemId}`;
	if (item.type === 'poll') return `Hacker News poll #${itemId}`;
	return `Hacker News item #${itemId}`;
}

async function scrapeHackerNews(itemId: string): Promise<HackerNewsAcquisition> {
	console.info({ tag: 'HN', msg: 'Fetching item', itemId });
	const item = await fetchHnItem(itemId);
	const title = hackerNewsItemTitle(item, itemId);
	const hnText = item.text ? htmlToText(item.text) : '';
	if (item.type === 'comment' && !hnText) throw new Error(`Hacker News comment ${itemId} has no text`);
	const commentCount = countHnComments(item.children);
	const comments = item.children?.length ? collectAllComments(item.children) : [];
	const markdown = buildHnPostMarkdown(item, title, commentCount);
	const description = hnText.slice(0, 280) || null;
	const itemType = item.type === 'story' || item.type === 'ask' || item.type === 'show' || item.type === 'job' ? item.type : undefined;
	if (!markdown) throw new Error(`Hacker News item ${itemId} has no content`);
	console.info({
		tag: 'HN',
		msg: 'Item fetched',
		title,
		subjectUrl: item.url ?? null,
	});
	return {
		resourcePlatform: 'hackernews',
		platformId: itemId,
		fileType: null,
		title,
		markdown,
		source: 'Hacker News',
		originalLang: null,
		publishedDate: item.created_at_i ? new Date(item.created_at_i * 1000).toISOString() : null,
		summary: description,
		...(item.url ? { subjectUrl: item.url } : {}),
		creators: literalCreator('submitter', item.author),
		kindMetadata: { points: item.points, commentCount, itemType } satisfies ForumKindMetadata,
		discussion: {
			commentInput: comments
				.map((comment) => `${comment.author ? `${comment.author}: ` : ''}${comment.text}`)
				.join('\n')
				.slice(0, 30000),
			commentCount: comments.length,
			hnText: hnText.slice(0, 1200) || null,
			points: item.points ?? null,
			totalCommentCount: commentCount,
		},
	};
}

export async function stageHackerNewsAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: { itemId: string; origin: ResourceAcquisitionOrigin; processingId: string },
): Promise<ResolvedResource> {
	const contentStream = await step.do(
		'acquire-hackernews-v1',
		{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		async () => Response.json(await scrapeHackerNews(input.itemId)).body!,
	);
	const acquired = await new Response(contentStream).json<HackerNewsAcquisition>();
	const annotation = await step
		.do(
			'build-hacker-news-annotation-v1',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
			() => buildHackerNewsAnnotation(acquired.title, env, acquired.discussion, input.processingId),
		)
		.catch((error) => {
			console.error({
				tag: 'HN',
				msg: 'Optional Hacker News discussion annotation failed after retries',
				processing_id: input.processingId,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		});
	const { discussion: _discussion, ...resource } = acquired;
	return materializePlatformResource(
		{
			...resource,
			...(annotation ? { markdown: applyHackerNewsAnnotation(resource.markdown, annotation) } : {}),
			specialization: null,
		},
		input.origin,
	);
}

function collectAllComments(children: HnComment[]): HnCollectedComment[] {
	const comments: HnCollectedComment[] = [];
	for (const child of children) {
		if (child.text) {
			const cleanText = htmlToText(child.text);
			if (cleanText) comments.push({ author: child.author, text: cleanText });
		}
		if (child.children?.length) comments.push(...collectAllComments(child.children));
	}
	return comments;
}

const HN_DISCUSSION_HEADING = '## Hacker News community perspectives';
const HN_DISCUSSION_SYSTEM =
	'You are a professional tech news editor. Synthesize Hacker News comments into concise community perspectives. Use only the provided material. Output Markdown directly.';

function buildDiscussionPrompt(title: string, hnText: string | null, commentInput: string, commentCount: number): string {
	const hnPostText = hnText ? htmlToText(hnText).slice(0, 1200) : '';
	const hnPostSection = hnPostText ? `HN post text:\n${hnPostText}\n\n` : '';
	return `Title: ${title}
${hnPostSection}HN comments (${commentCount} total):
${commentInput}

Write a 220-360 word community digest in English using 3-5 short paragraphs. Each paragraph should synthesize one distinct perspective found in the comments. Prioritize the strongest recurring viewpoints, meaningful disagreements, useful context, and genuine areas of agreement. Include supporting, skeptical, and supplementary perspectives only when the comments contain them.

Rules:
- Write in English
- Do not add a heading, bullets, numbering, usernames, or emoji
- Focus on the arguments, context, and disagreements present in the discussion
- Synthesize and paraphrase; do not quote comments verbatim
- Do not invent consensus or force opposing sides when the discussion does not support them
- Present commenter claims as community perspectives, not established facts
- Maintain a neutral, objective tone
- Output only the paragraphs, without a code block`;
}

async function generateHnDiscussionDigest(
	env: CoreEnv,
	resourceId: string,
	title: string,
	discussion: HackerNewsDiscussionInput,
): Promise<string | null> {
	if (discussion.commentCount < 4) return null;

	const { finishReason, text } = await generateText({
		model: createWorkersAI({ binding: env.AI })('@cf/qwen/qwen3-30b-a3b-fp8', {
			gateway: {
				id: 'core-ingest',
				collectLog: true,
				retries: { maxAttempts: 1 },
				metadata: {
					feature: 'hn-discussion-digest-en',
					environment: env.AI_GATEWAY_ENVIRONMENT,
					resource_id: resourceId,
				},
			},
			extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
		}),
		prompt: buildDiscussionPrompt(title, discussion.hnText, discussion.commentInput, discussion.commentCount),
		system: HN_DISCUSSION_SYSTEM,
		temperature: 0.3,
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error('Hacker News discussion digest hit its output token cap');
	const digest = text.trim();
	if (!digest) throw new Error('Hacker News discussion digest returned no text');
	return digest;
}

function withoutPreviousDiscussion(content: string): string {
	return content.split(`\n\n---\n\n${HN_DISCUSSION_HEADING}`, 1)[0].trim();
}

async function buildHackerNewsAnnotation(
	title: string,
	env: CoreEnv,
	discussion: HackerNewsDiscussionInput,
	processingId: string,
): Promise<string> {
	const digest = await generateHnDiscussionDigest(env, processingId, title, discussion);
	const stats = [
		discussion.points !== null ? `${discussion.points} points` : null,
		discussion.totalCommentCount > 0 ? `${discussion.totalCommentCount} comments` : null,
	]
		.filter(Boolean)
		.join(' | ');
	return [HN_DISCUSSION_HEADING, stats ? `*${stats}*` : null, digest].filter(Boolean).join('\n\n');
}

function applyHackerNewsAnnotation(content: string, annotation: string): string {
	const carrierContent = withoutPreviousDiscussion(content);
	if (!carrierContent) throw new Error('Hacker News resource has no content to annotate');
	return [carrierContent, '---', annotation].join('\n\n');
}
