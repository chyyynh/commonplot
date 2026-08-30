import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { generateText } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { type ForumKindMetadata, RESOURCE_TYPES } from '../../shared/resource';
import { CORE_TEXT_MODEL } from '../ai-model';
import {
	literalCreator,
	materializePlatformResource,
	type PlatformAcquiredMaterial,
	type ResolvedPlatformResource,
	type ResolvedResourceSubjectIdentity,
	type ResourceAcquisitionHints,
} from './materialize';

const HN_ITEM_API = 'https://hacker-news.firebaseio.com/v0/item';
const HN_TOP_LEVEL_THREAD_LIMIT = 10;
const HN_REPLIES_PER_THREAD_LIMIT = 3;
const HN_FETCH_CONCURRENCY = 6;
const HN_TOP_LEVEL_TEXT_MAX_CHARS = 1_000;
const HN_REPLY_TEXT_MAX_CHARS = 350;

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
	.nullish()
	.transform((value) => value ?? undefined);
const optionalNonnegativeIntegerSchema = z
	.int()
	.nonnegative()
	.nullish()
	.transform((value) => value ?? undefined);

const HackerNewsItemSchema = z.object({
	by: optionalStringSchema,
	dead: z.boolean().optional(),
	deleted: z.boolean().optional(),
	descendants: optionalNonnegativeIntegerSchema,
	id: z.int().positive(),
	kids: z
		.array(z.int().positive())
		.nullish()
		.transform((value) => value ?? undefined),
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
	itemType?: 'story' | 'ask' | 'show' | 'job';
	threadCount: number;
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

async function scrapeHackerNews(env: CoreEnv, itemId: string, processingId: string): Promise<HackerNewsAcquisition> {
	console.info({ tag: 'HN', msg: 'Fetching item and ranked discussion', itemId });
	const item = await fetchHnItem(itemId);
	if (!item) throw new NonRetryableError(`Hacker News item ${itemId} was not found`);
	if ([item.deleted, item.dead].includes(true)) throw new NonRetryableError(`Hacker News item ${itemId} is unavailable`);

	const rankedThreadIds = (item.kids ?? []).slice(0, HN_TOP_LEVEL_THREAD_LIMIT);
	const fetchedThreads = await fetchHnItems(rankedThreadIds);
	const rankedThreads = rankedThreadIds
		.map((id) => fetchedThreads.get(id))
		.filter((thread): thread is HackerNewsItem & { text: string } =>
			Boolean(thread?.text && !thread.deleted && !thread.dead && thread.type === 'comment'),
		);
	const replyIds = rankedThreads.flatMap((thread) => (thread.kids ?? []).slice(0, HN_REPLIES_PER_THREAD_LIMIT));
	const fetchedReplies = await fetchHnItems(replyIds);
	const replies = [...fetchedReplies.values()].filter((reply): reply is HackerNewsItem & { text: string } =>
		Boolean(reply.text && !reply.deleted && !reply.dead && reply.type === 'comment'),
	);

	const titleDocumentName = `title-${item.id}.html`;
	const postDocumentName = `item-${item.id}.html`;
	const fragments = [
		...(item.title ? [{ name: titleDocumentName, html: item.title }] : []),
		...(item.text ? [{ name: postDocumentName, html: item.text }] : []),
		...[...rankedThreads, ...replies].map((comment) => ({ name: `comment-${comment.id}.html`, html: comment.text })),
	];
	if (!fragments.length) throw new NonRetryableError(`Hacker News item ${itemId} has no content`);
	const convertedResults = await env.AI.toMarkdown(
		fragments.map(({ html, name }) => ({ name, blob: new Blob([html], { type: 'text/html' }) })),
		{
			gateway: {
				id: 'core-ingest',
				collectLog: true,
				retries: { maxAttempts: 1 },
				metadata: {
					feature: 'hn-html-to-markdown',
					environment: env.AI_GATEWAY_ENVIRONMENT,
					processing_id: processingId,
				},
			},
			extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
			conversionOptions: { html: { hostname: 'news.ycombinator.com' } },
		},
	);
	const conversionError = convertedResults.find((result) => result.format === 'error');
	if (conversionError?.format === 'error') {
		throw new Error(`Workers AI toMarkdown failed for ${conversionError.name}: ${conversionError.error}`);
	}
	const converted = new Map(
		convertedResults.flatMap((result) => (result.format === 'error' ? [] : [[result.name, result.data.trim()] as const])),
	);

	const convertedTitle = item.title ? converted.get(titleDocumentName) : null;
	if (item.title && !convertedTitle) throw new Error(`Workers AI toMarkdown returned no title for Hacker News item ${itemId}`);
	const title =
		convertedTitle ||
		(item.type === 'comment'
			? `Hacker News comment #${itemId}`
			: ['poll', 'pollopt'].includes(item.type ?? '')
				? `Hacker News poll #${itemId}`
				: `Hacker News item #${itemId}`);
	const hnText = item.text ? converted.get(postDocumentName) : null;
	if (item.text && !hnText) throw new Error(`Workers AI toMarkdown returned no body for Hacker News item ${itemId}`);
	if (item.type === 'comment' && !hnText) throw new Error(`Hacker News comment ${itemId} has no text`);

	const threadBlocks = rankedThreads.flatMap((thread, index) => {
		const fullTopLevel = converted.get(`comment-${thread.id}.html`);
		if (!fullTopLevel) return [];
		const topLevel =
			fullTopLevel.length <= HN_TOP_LEVEL_TEXT_MAX_CHARS
				? fullTopLevel
				: `${fullTopLevel
						.slice(0, HN_TOP_LEVEL_TEXT_MAX_CHARS)
						.replace(/\s+\S*$/, '')
						.trimEnd()}…`;
		const directReplies = (thread.kids ?? []).slice(0, HN_REPLIES_PER_THREAD_LIMIT).flatMap((replyId) => {
			const fullReply = converted.get(`comment-${replyId}.html`);
			if (!fullReply) return [];
			const reply =
				fullReply.length <= HN_REPLY_TEXT_MAX_CHARS
					? fullReply
					: `${fullReply
							.slice(0, HN_REPLY_TEXT_MAX_CHARS)
							.replace(/\s+\S*$/, '')
							.trimEnd()}…`;
			return [`Direct reply: ${reply}`];
		});
		return [
			{ commentCount: 1 + directReplies.length, text: [`Thread ${index + 1}`, `Top-level: ${topLevel}`, ...directReplies].join('\n') },
		];
	});
	const sampledCommentCount = threadBlocks.reduce((total, block) => total + block.commentCount, 0);
	const totalCommentCount = item.descendants ?? item.kids?.length ?? sampledCommentCount;
	let itemType: HackerNewsDiscussionInput['itemType'];
	if (item.type === 'job') itemType = 'job';
	else if (/^Ask HN:/i.test(title)) itemType = 'ask';
	else if (/^Show HN:/i.test(title)) itemType = 'show';
	else if (item.type === 'story') itemType = 'story';
	const markdown = [`# ${title}`, hnText].filter(Boolean).join('\n\n');
	if (!markdown) throw new Error(`Hacker News item ${itemId} has no content`);
	console.info({
		tag: 'HN',
		msg: 'Item and ranked discussion fetched',
		title,
		sampledComments: sampledCommentCount,
		sampledThreads: threadBlocks.length,
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
		summary: hnText?.slice(0, 280) || null,
		...(item.url ? { subjectUrl: item.url } : {}),
		creators: literalCreator('submitter', item.by),
		kindMetadata: { points: item.score, commentCount: totalCommentCount } satisfies ForumKindMetadata,
		discussion: {
			commentCount: sampledCommentCount,
			commentInput: threadBlocks.map((block) => block.text).join('\n\n'),
			hnText: hnText?.slice(0, 1200) || null,
			...(itemType ? { itemType } : {}),
			threadCount: threadBlocks.length,
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
		resolveSubject: (url: string | null | undefined) => ResolvedResourceSubjectIdentity | null;
	},
): Promise<ResolvedPlatformResource<'hackernews'>> {
	const contentStream = await step.do(
		'acquire-hackernews-ranked-v3',
		{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		async () => Response.json(await scrapeHackerNews(env, input.itemId, input.processingId)).body!,
	);
	const acquired = await new Response(contentStream).json<HackerNewsAcquisition>();
	const digest = await step.do(
		'build-hacker-news-annotation-ranked-v3',
		{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
		async () => {
			const discussion = acquired.discussion;
			if (discussion.commentCount < 4 || discussion.threadCount < 2) return null;
			const hnPostSection = discussion.hnText ? `HN post text:\n${discussion.hnText}\n\n` : '';
			const digestFocus =
				discussion.itemType === 'ask'
					? 'Synthesize the answers, experiences, and advice offered in response to the question.'
					: discussion.itemType === 'show'
						? 'Synthesize the community feedback, questions, use cases, and technical observations about the project.'
						: 'Synthesize the arguments, context, reactions, and disagreements in the discussion.';
			const { finishReason, text } = await generateText({
				model: createWorkersAI({ binding: env.AI })(CORE_TEXT_MODEL, {
					gateway: {
						id: 'core-ingest',
						collectLog: true,
						retries: { maxAttempts: 1 },
						metadata: {
							feature: 'hn-discussion-digest-en',
							environment: env.AI_GATEWAY_ENVIRONMENT,
							resource_id: input.processingId,
						},
					},
					extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
				}),
				prompt: `Title: ${acquired.title}
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
				reasoning: 'none',
				maxRetries: 0,
			});
			if (finishReason === 'length') throw new Error('Hacker News discussion digest hit its output token cap');
			const generatedDigest = text.trim();
			if (!generatedDigest) throw new Error('Hacker News discussion digest returned no text');
			return generatedDigest;
		},
	);
	const { discussion: _discussion, ...resource } = acquired;
	const markdown = digest ? [resource.markdown, '---', digest].join('\n\n') : resource.markdown;
	return materializePlatformResource(
		{ ...resource, markdown },
		input.hints,
		{ kind: 'forum', url: `https://news.ycombinator.com/item?id=${input.itemId}` },
		input.resolveSubject(resource.subjectUrl),
	);
}

const HN_DISCUSSION_SYSTEM =
	'You are a professional tech news editor. Synthesize Hacker News comments into community perspectives. Use only the provided material. Return only the finished digest, never your analysis process.';
