import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { generateText, Output } from 'ai';
import { decode } from 'html-entities';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { type ForumKindMetadata, RESOURCE_TYPES } from '../../shared/resource';
import { CORE_TEXT_MODEL, CORE_TEXT_MODEL_SETTINGS } from '../ai-model';
import {
	literalCreator,
	materializePlatformResource,
	type PlatformAcquiredMaterial,
	type ResolvedResource,
	type ResolvedResourceSubject,
	type ResourceAcquisitionHints,
} from './materialize';

const HN_ITEM_API = 'https://hacker-news.firebaseio.com/v0/item';
const HN_TOP_LEVEL_THREAD_LIMIT = 10;
const HN_REPLIES_PER_THREAD_LIMIT = 3;
const HN_FETCH_CONCURRENCY = 6;
const HN_TOP_LEVEL_TEXT_MAX_CHARS = 1_000;
const HN_REPLY_TEXT_MAX_CHARS = 350;
const HackerNewsDigestSchema = z.object({ digest: z.string().min(1) });

export function parseHackerNewsResourceUrl(url: URL) {
	const itemId = RESOURCE_TYPES.forum.platforms[0].identifier.safeParse(url.searchParams.get('id'));
	return itemId.success
		? {
				resourcePlatform: 'hackernews' as const,
				platformId: itemId.data,
				canonicalUrl: `https://news.ycombinator.com/item?id=${itemId.data}`,
			}
		: null;
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

const HackerNewsItemSchema = z.object({
	by: optionalStringSchema,
	dead: z.boolean().optional(),
	deleted: z.boolean().optional(),
	descendants: optionalNonnegativeIntegerSchema,
	id: z.number().int().positive(),
	kids: z
		.array(z.number().int().positive())
		.nullable()
		.transform((value) => value ?? undefined)
		.optional(),
	score: optionalNonnegativeIntegerSchema,
	text: optionalStringSchema,
	time: optionalNonnegativeIntegerSchema,
	title: optionalStringSchema,
	type: z.enum(['story', 'comment', 'job', 'poll', 'pollopt']).optional(),
	url: optionalStringSchema,
});

type HackerNewsItem = z.infer<typeof HackerNewsItemSchema>;

type HackerNewsDiscussionInput = {
	commentInput: string;
	commentCount: number;
	hnText: string | null;
	points: number | null;
	threadCount: number;
	totalCommentCount: number;
};

type HackerNewsAcquisition = PlatformAcquiredMaterial<'hackernews'> & { discussion: HackerNewsDiscussionInput };

async function fetchHnItem(itemId: number | string): Promise<HackerNewsItem | null> {
	const response = await fetch(`${HN_ITEM_API}/${itemId}.json`, { signal: AbortSignal.timeout(15_000) });
	if (!response.ok) {
		await response.body?.cancel();
		if (response.status === 404 || response.status === 410) return null;
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}
	const payload: unknown = await response.json();
	return payload === null ? null : HackerNewsItemSchema.parse(payload);
}

async function fetchHnItems(itemIds: readonly number[]): Promise<Map<number, HackerNewsItem>> {
	const items = new Map<number, HackerNewsItem>();
	for (let offset = 0; offset < itemIds.length; offset += HN_FETCH_CONCURRENCY) {
		const batch = await Promise.all(itemIds.slice(offset, offset + HN_FETCH_CONCURRENCY).map(fetchHnItem));
		for (const item of batch) {
			if (item) items.set(item.id, item);
		}
	}
	return items;
}

function htmlToText(str: string): string {
	return decode(
		str
			.replace(/<p\s*\/?>/gi, '\n\n')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<[^>]*>/g, ' '),
	)
		.replace(/[ \t]+/g, ' ')
		.replace(/\n[ \t]+/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function boundedCommentText(item: HackerNewsItem | undefined, maxChars: number): string | null {
	if (!item?.text || item.deleted || item.dead || item.type !== 'comment') return null;
	const text = htmlToText(item.text);
	if (!text) return null;
	if (text.length <= maxChars) return text;
	const prefix = text.slice(0, maxChars);
	return `${prefix.replace(/\s+\S*$/, '').trimEnd()}…`;
}

async function collectRankedDiscussion(
	item: HackerNewsItem,
): Promise<Pick<HackerNewsDiscussionInput, 'commentCount' | 'commentInput' | 'threadCount'>> {
	const rankedThreadIds = (item.kids ?? []).slice(0, HN_TOP_LEVEL_THREAD_LIMIT);
	const topLevelItems = await fetchHnItems(rankedThreadIds);
	const rankedThreads = rankedThreadIds.flatMap((id) => {
		const thread = topLevelItems.get(id);
		return thread && boundedCommentText(thread, HN_TOP_LEVEL_TEXT_MAX_CHARS) ? [thread] : [];
	});
	const replyIds = rankedThreads.flatMap((thread) => (thread.kids ?? []).slice(0, HN_REPLIES_PER_THREAD_LIMIT));
	const replies = await fetchHnItems(replyIds);
	let commentCount = 0;
	const blocks = rankedThreads.flatMap((thread, index) => {
		const topLevel = boundedCommentText(thread, HN_TOP_LEVEL_TEXT_MAX_CHARS);
		if (!topLevel) return [];
		commentCount += 1;
		const lines = [`Thread ${index + 1}`, `Top-level: ${topLevel}`];
		for (const replyId of (thread.kids ?? []).slice(0, HN_REPLIES_PER_THREAD_LIMIT)) {
			const reply = boundedCommentText(replies.get(replyId), HN_REPLY_TEXT_MAX_CHARS);
			if (!reply) continue;
			commentCount += 1;
			lines.push(`Direct reply: ${reply}`);
		}
		return [lines.join('\n')];
	});
	return { commentCount, commentInput: blocks.join('\n\n'), threadCount: blocks.length };
}

function buildHnPostMarkdown(item: HackerNewsItem, title: string, commentCount: number): string {
	const parts: string[] = [`# ${title}\n`];
	const metaParts: string[] = [];
	if (item.score !== undefined) metaParts.push(`${item.score} points`);
	if (item.by) metaParts.push(`by ${item.by}`);
	if (commentCount > 0) metaParts.push(`${commentCount} comments`);
	if (metaParts.length) parts.push(`*${metaParts.join(' | ')}*\n`);
	if (item.text) parts.push(`---\n\n${htmlToText(item.text)}\n`);
	return parts.join('\n');
}

function hackerNewsItemTitle(item: HackerNewsItem, itemId: string): string {
	const title = item.title?.trim();
	if (title) return title;
	if (item.type === 'comment') return `Hacker News comment #${itemId}`;
	if (item.type === 'poll' || item.type === 'pollopt') return `Hacker News poll #${itemId}`;
	return `Hacker News item #${itemId}`;
}

function hackerNewsItemType(item: HackerNewsItem, title: string): ForumKindMetadata['itemType'] {
	if (item.type === 'job') return 'job';
	if (/^Ask HN:/i.test(title)) return 'ask';
	if (/^Show HN:/i.test(title)) return 'show';
	return item.type === 'story' ? 'story' : undefined;
}

async function scrapeHackerNews(itemId: string): Promise<HackerNewsAcquisition> {
	console.info({ tag: 'HN', msg: 'Fetching item and ranked discussion', itemId });
	const item = await fetchHnItem(itemId);
	if (!item) throw new NonRetryableError(`Hacker News item ${itemId} was not found`);
	const title = hackerNewsItemTitle(item, itemId);
	const hnText = item.text ? htmlToText(item.text) : '';
	if (item.type === 'comment' && !hnText) throw new Error(`Hacker News comment ${itemId} has no text`);
	const sampled = await collectRankedDiscussion(item);
	const totalCommentCount = item.descendants ?? item.kids?.length ?? sampled.commentCount;
	const markdown = buildHnPostMarkdown(item, title, totalCommentCount);
	const itemType = hackerNewsItemType(item, title);
	if (!markdown) throw new Error(`Hacker News item ${itemId} has no content`);
	console.info({
		tag: 'HN',
		msg: 'Item and ranked discussion fetched',
		title,
		sampledComments: sampled.commentCount,
		sampledThreads: sampled.threadCount,
		subjectUrl: item.url ?? null,
		totalComments: totalCommentCount,
	});
	return {
		resourcePlatform: 'hackernews',
		platformId: itemId,
		fileType: null,
		title,
		markdown,
		source: 'Hacker News',
		originalLang: null,
		publishedDate: item.time ? new Date(item.time * 1000).toISOString() : null,
		summary: hnText.slice(0, 280) || null,
		...(item.url ? { subjectUrl: item.url } : {}),
		creators: literalCreator('submitter', item.by),
		kindMetadata: { points: item.score, commentCount: totalCommentCount, itemType } satisfies ForumKindMetadata,
		discussion: {
			...sampled,
			hnText: hnText.slice(0, 1200) || null,
			points: item.score ?? null,
			totalCommentCount,
		},
	};
}

export async function stageHackerNewsAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		hints: ResourceAcquisitionHints;
		itemId: string;
		processingId: string;
		resolveSubject: (url: string | null | undefined) => ResolvedResourceSubject | null;
	},
): Promise<ResolvedResource> {
	const contentStream = await step.do(
		'acquire-hackernews-ranked-v2',
		{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		async () => Response.json(await scrapeHackerNews(input.itemId)).body!,
	);
	const acquired = await new Response(contentStream).json<HackerNewsAcquisition>();
	const annotation = await step
		.do(
			'build-hacker-news-annotation-ranked-v2',
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
		},
		input.hints,
		{ kind: 'forum', url: `https://news.ycombinator.com/item?id=${input.itemId}` },
		input.resolveSubject(resource.subjectUrl),
	);
}

const HN_DISCUSSION_HEADING = '## Hacker News community perspectives';
const HN_DISCUSSION_SYSTEM =
	'You are a professional tech news editor. Synthesize Hacker News comments into concise community perspectives. Use only the provided material. Return only the finished digest, never your analysis process.';

function buildDiscussionPrompt(
	title: string,
	hnText: string | null,
	commentInput: string,
	commentCount: number,
	threadCount: number,
): string {
	const hnPostText = hnText ? htmlToText(hnText).slice(0, 1200) : '';
	const hnPostSection = hnPostText ? `HN post text:\n${hnPostText}\n\n` : '';
	return `Title: ${title}
${hnPostSection}Ranked HN discussion sample (${commentCount} comments from ${threadCount} top-level threads):
${commentInput}

The Thread blocks follow Hacker News' ranked top-level order. Each Direct reply belongs to the Top-level comment immediately above it.

Write a 220-360 word community digest in English using 3-5 short paragraphs. Each paragraph should synthesize one distinct perspective found across the sampled threads. Prioritize viewpoints that recur across multiple top-level threads, meaningful disagreements, useful context, and genuine areas of agreement. Include supporting, skeptical, and supplementary perspectives only when the comments contain them.

Rules:
- Write in English
- Do not add a heading, bullets, numbering, usernames, or emoji
- Do not let one long thread dominate the digest
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
	if (discussion.commentCount < 4 || discussion.threadCount < 2) return null;

	const { finishReason, output } = await generateText({
		model: createWorkersAI({ binding: env.AI })(CORE_TEXT_MODEL, {
			...CORE_TEXT_MODEL_SETTINGS,
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
		prompt: buildDiscussionPrompt(title, discussion.hnText, discussion.commentInput, discussion.commentCount, discussion.threadCount),
		system: HN_DISCUSSION_SYSTEM,
		output: Output.object({
			name: 'hacker_news_discussion_digest',
			description: 'The finished community digest without analysis narration, headings, lists, or usernames.',
			schema: HackerNewsDigestSchema,
		}),
		maxOutputTokens: 900,
		temperature: 0.3,
		reasoning: 'none',
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error('Hacker News discussion digest hit its output token cap');
	const digest = output.digest.trim();
	if (!digest) throw new Error('Hacker News discussion digest returned no text');
	return digest;
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
	const carrierContent = content.split(`\n\n---\n\n${HN_DISCUSSION_HEADING}`, 1)[0].trim();
	if (!carrierContent) throw new Error('Hacker News resource has no content to annotate');
	return [carrierContent, '---', annotation].join('\n\n');
}
