import { generateText } from 'ai';
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { fromHtml } from 'hast-util-from-html';
import { toText } from 'hast-util-to-text';
import pLimit from 'p-limit';
import { z } from 'zod';
import type { AcquiredResource } from '../contracts/acquired-resource';
import { htmlToMdast, stringifyMarkdown } from '../contracts/markdown';
import { ResourceUrlSchema } from '../contracts/resource-url';
import { AI_STEP, CORE_TEXT_REASONING, coreTextModel } from '../services/ai-model';
import { FETCH_STEP_RETRIES, stepJson } from '../services/workflow-step';

const HN_ITEM_API = 'https://hacker-news.firebaseio.com/v0/item';
const HN_TOP_LEVEL_THREAD_LIMIT = 10;
const HN_REPLIES_PER_THREAD_LIMIT = 3;
const HN_FETCH_CONCURRENCY = 6;
const HN_TOP_LEVEL_TEXT_MAX_CHARS = 1_000;
const HN_REPLY_TEXT_MAX_CHARS = 350;

const optionalStringSchema = z.string().nullish();
const optionalNonnegativeIntegerSchema = z.int().nonnegative().nullish();

const HackerNewsItemSchema = z.object({
	by: optionalStringSchema,
	dead: z.boolean().optional(),
	deleted: z.boolean().optional(),
	descendants: optionalNonnegativeIntegerSchema,
	id: z.int().positive(),
	kids: z.array(z.int().positive()).nullish(),
	score: optionalNonnegativeIntegerSchema,
	text: optionalStringSchema,
	time: optionalNonnegativeIntegerSchema,
	title: optionalStringSchema,
	type: z.enum(['story', 'comment', 'job', 'poll', 'pollopt']).optional(),
	url: optionalStringSchema,
});

type HackerNewsItem = z.infer<typeof HackerNewsItemSchema>;

async function fetchHnItem(itemId: number | string): Promise<HackerNewsItem | null> {
	const response = await fetch(`${HN_ITEM_API}/${itemId}.json`, { signal: AbortSignal.timeout(15_000) });
	if (!response.ok) {
		await response.body?.cancel();
		if (response.status === 404 || response.status === 410) return null;
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}
	const item = HackerNewsItemSchema.nullable().parse(await response.json());
	if (item && String(item.id) !== String(itemId)) throw new Error(`Hacker News API returned no matching item for ${itemId}`);
	return item;
}

export async function hackerNewsTitle(itemId: string): Promise<string | null> {
	const item = await fetchHnItem(itemId);
	if (!item || item.dead || item.deleted) return null;
	return item.title?.trim() || null;
}

async function fetchHnItems(itemIds: readonly number[]): Promise<Map<number, HackerNewsItem>> {
	const items = await pLimit(HN_FETCH_CONCURRENCY).map(itemIds, (itemId) => fetchHnItem(itemId));
	return new Map(items.filter((item) => item !== null).map((item) => [item.id, item]));
}

function isReadableComment(item: HackerNewsItem | undefined): item is HackerNewsItem & { text: string } {
	return Boolean(item?.text && !item.deleted && !item.dead && item.type === 'comment');
}

function hnMarkdown(html: string): string {
	return stringifyMarkdown(htmlToMdast(`<base href="https://news.ycombinator.com/">${html}`)).trim();
}

function discussionExcerpt(markdown: string, maxChars: number): string {
	return markdown.length <= maxChars
		? markdown
		: `${markdown
				.slice(0, maxChars)
				.replace(/\s+\S*$/, '')
				.trimEnd()}…`;
}

async function scrapeHackerNews(itemId: string) {
	console.info({ tag: 'HN', msg: 'Fetching item and ranked discussion', itemId });
	const item = await fetchHnItem(itemId);
	if (!item) throw new NonRetryableError(`Hacker News item ${itemId} was not found`);
	if ([item.deleted, item.dead].includes(true)) throw new NonRetryableError(`Hacker News item ${itemId} is unavailable`);

	const rankedThreadIds = (item.kids ?? []).slice(0, HN_TOP_LEVEL_THREAD_LIMIT);
	const fetchedThreads = await fetchHnItems(rankedThreadIds);
	const rankedThreads = rankedThreadIds.map((id) => fetchedThreads.get(id)).filter(isReadableComment);
	const replyIds = rankedThreads.flatMap((thread) => (thread.kids ?? []).slice(0, HN_REPLIES_PER_THREAD_LIMIT));
	const fetchedReplies = await fetchHnItems(replyIds);
	if (!item.title && !item.text && !rankedThreads.length) throw new NonRetryableError(`Hacker News item ${itemId} has no content`);

	// HN titles are HTML, but the Resource title is plain text, not Markdown.
	const convertedTitle = item.title ? toText(fromHtml(item.title, { fragment: true })).trim() : null;
	if (item.title && !convertedTitle) throw new Error(`Hacker News item ${itemId} has no readable title`);
	const title =
		convertedTitle ||
		(item.type === 'comment'
			? `Hacker News comment #${itemId}`
			: ['poll', 'pollopt'].includes(item.type ?? '')
				? `Hacker News poll #${itemId}`
				: `Hacker News item #${itemId}`);
	const hnText = item.text ? hnMarkdown(item.text) : null;
	if (item.text && !hnText) throw new Error(`Hacker News item ${itemId} has no readable body`);
	if (item.type === 'comment' && !hnText) throw new Error(`Hacker News comment ${itemId} has no text`);

	const threadBlocks = rankedThreads.flatMap((thread, index) => {
		const fullTopLevel = hnMarkdown(thread.text);
		if (!fullTopLevel) return [];
		const topLevel = discussionExcerpt(fullTopLevel, HN_TOP_LEVEL_TEXT_MAX_CHARS);
		const directReplies = (thread.kids ?? []).slice(0, HN_REPLIES_PER_THREAD_LIMIT).flatMap((replyId) => {
			const reply = fetchedReplies.get(replyId);
			if (!isReadableComment(reply)) return [];
			const fullReply = hnMarkdown(reply.text);
			if (!fullReply) return [];
			return [`Direct reply: ${discussionExcerpt(fullReply, HN_REPLY_TEXT_MAX_CHARS)}`];
		});
		return [
			{ commentCount: 1 + directReplies.length, text: [`Thread ${index + 1}`, `Top-level: ${topLevel}`, ...directReplies].join('\n') },
		];
	});
	const sampledCommentCount = threadBlocks.reduce((total, block) => total + block.commentCount, 0);
	const totalCommentCount = item.descendants ?? item.kids?.length ?? sampledCommentCount;
	let itemType: 'story' | 'ask' | 'show' | 'job' | undefined;
	if (item.type === 'job') itemType = 'job';
	else if (/^Ask HN:/i.test(title)) itemType = 'ask';
	else if (/^Show HN:/i.test(title)) itemType = 'show';
	else if (item.type === 'story') itemType = 'story';
	const heading = stringifyMarkdown({ type: 'heading', depth: 1, children: [{ type: 'text', value: title }] });
	const markdown = [heading, hnText].filter(Boolean).join('\n\n');
	console.info({
		tag: 'HN',
		msg: 'Item and ranked discussion fetched',
		title,
		sampledComments: sampledCommentCount,
		sampledThreads: threadBlocks.length,
		subjectUrl: item.url ?? null,
		totalComments: totalCommentCount,
	});
	const publishedDate = item.time ? new Date(item.time * 1000).toISOString() : null;
	const submitter = item.by?.trim();
	return {
		resource: {
			kind: 'forum',
			resourcePlatform: 'hackernews',
			resourceIdentifiers: [{ preferred: true, scheme: 'hackernews', value: itemId }],
			url: `https://news.ycombinator.com/item?id=${itemId}`,
			title: title.trim(),
			content: markdown,
			source: 'Hacker News',
			originalLang: 'und',
			publishedDate,
			summary: null,
			creators: submitter ? [{ role: 'submitter', literal: submitter }] : [],
			kindMetadata: { points: item.score ?? undefined, commentCount: totalCommentCount },
			fileType: null,
			previewImageUrl: null,
			subjectUrl: ResourceUrlSchema.safeParse(item.url).data ?? null,
		} satisfies AcquiredResource,
		discussion: {
			commentCount: sampledCommentCount,
			commentInput: threadBlocks.map((block) => block.text).join('\n\n'),
			hnText: hnText?.slice(0, 1200) || null,
			...(itemType ? { itemType } : {}),
			threadCount: threadBlocks.length,
		},
	};
}

export async function stageHackerNewsAcquisition(env: CoreEnv, step: WorkflowStep, input: { itemId: string; processingId: string }) {
	const { resource, discussion } = await stepJson(
		step,
		'acquire-hackernews-ranked-v5',
		{ retries: FETCH_STEP_RETRIES, timeout: '120 seconds' },
		() => scrapeHackerNews(input.itemId),
	);
	if (discussion.commentCount < 4 || discussion.threadCount < 2) return resource;
	const digest = await step.do('build-hacker-news-annotation-ranked-v3', AI_STEP, async () => {
		const hnPostSection = discussion.hnText ? `HN post text:\n${discussion.hnText}\n\n` : '';
		const digestFocus =
			discussion.itemType === 'ask'
				? 'Synthesize the answers, experiences, and advice offered in response to the question.'
				: discussion.itemType === 'show'
					? 'Synthesize the community feedback, questions, use cases, and technical observations about the project.'
					: 'Synthesize the arguments, context, reactions, and disagreements in the discussion.';
		const { finishReason, text } = await generateText({
			model: coreTextModel(env, { feature: 'hn-discussion-digest-en', resource_id: input.processingId }),
			prompt: `Title: ${resource.title}
${hnPostSection}Ranked HN discussion sample (${discussion.commentCount} comments from ${discussion.threadCount} top-level threads):
${discussion.commentInput}

The Thread blocks follow Hacker News' ranked top-level order. Each Direct reply belongs to the Top-level comment immediately above it.

${digestFocus} Write the digest in English and choose the structure and level of detail that best represent the sampled discussion. Prioritize viewpoints that recur across multiple top-level threads, meaningful disagreements, useful context, and genuine areas of agreement. Include supporting, skeptical, and supplementary perspectives only when the comments contain them.

Rules:
- Write in English
- Do not add a heading, bullets, numbering, usernames, or emoji
- Do not let one long thread dominate the digest
- Focus on the arguments, context, and disagreements present in the discussion
- Synthesize and paraphrase; do not quote comments verbatim
- Do not invent consensus or force opposing sides when the discussion does not support them
- Present commenter claims as community perspectives, not established facts
- Maintain a neutral, objective tone
- Output only the paragraphs, without a code block`,
			system: HN_DISCUSSION_SYSTEM,
			temperature: 0.3,
			reasoning: CORE_TEXT_REASONING,
			maxRetries: 0,
		});
		if (finishReason === 'length') throw new Error('Hacker News discussion digest hit its output token cap');
		const generatedDigest = text.trim();
		if (!generatedDigest) throw new Error('Hacker News discussion digest returned no text');
		return generatedDigest;
	});
	// The title heading is dropped as a duplicate, so the rule only separates HN post text from the digest.
	return { ...resource, content: [resource.content, discussion.hnText ? '---' : null, digest].filter(Boolean).join('\n\n') };
}

const HN_DISCUSSION_SYSTEM =
	'You are a professional tech news editor. Synthesize Hacker News comments into community perspectives. Use only the provided material. Return only the finished digest, never your analysis process.';
