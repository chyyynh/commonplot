import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { fromHtml } from 'hast-util-from-html';
import { toText } from 'hast-util-to-text';
import { z } from 'zod';
import type { PlatformResource } from '../contracts/acquired-resource';
import { htmlToMdast, stringifyMarkdown } from '../contracts/markdown';
import { resolveResourceUrl, ResourceUrlSchema } from '../contracts/resource-url';
import { fetchOk } from '../services/response';
import { FETCH_STEP_RETRIES, stepJson } from '../services/workflow-step';

const HN_ITEM_API = 'https://hacker-news.firebaseio.com/v0/item';

const optionalStringSchema = z.string().nullish();

const HackerNewsItemSchema = z.object({
	by: optionalStringSchema,
	dead: z.boolean().optional(),
	deleted: z.boolean().optional(),
	id: z.int().positive(),
	text: optionalStringSchema,
	time: z.int().nonnegative().nullish(),
	title: optionalStringSchema,
	type: z.enum(['story', 'comment', 'job', 'poll', 'pollopt']).optional(),
	url: optionalStringSchema,
});

function hnMarkdown(html: string): string {
	return stringifyMarkdown(htmlToMdast(`<base href="https://news.ycombinator.com/">${html}`)).trim();
}

/**
 * A link submission is the page it links to, read in its place; a text thread is the submitter's own words. Comments are
 * never read.
 */
async function scrapeHackerNews(itemId: string): Promise<PlatformResource | { redirect: string }> {
	console.info({ tag: 'HN', msg: 'Fetching item', itemId });
	const response = await fetchOk(`${HN_ITEM_API}/${itemId}.json`, { label: 'Hacker News item', timeoutMs: 15_000, missing: [404, 410] });
	const item = response && HackerNewsItemSchema.nullable().parse(await response.json());
	if (!item) throw new NonRetryableError(`Hacker News item ${itemId} was not found`);
	if (String(item.id) !== itemId) throw new Error(`Hacker News API returned no matching item for ${itemId}`);
	if ([item.deleted, item.dead].includes(true)) throw new NonRetryableError(`Hacker News item ${itemId} is unavailable`);
	const linkedUrl = ResourceUrlSchema.safeParse(item.url).data;
	// A link back to Hacker News is read as the thread it is.
	if (linkedUrl && resolveResourceUrl(linkedUrl)?.resourcePlatform !== 'hackernews') return { redirect: linkedUrl };
	if (!item.title && !item.text) throw new NonRetryableError(`Hacker News item ${itemId} has no content`);

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

	const heading = stringifyMarkdown({ type: 'heading', depth: 1, children: [{ type: 'text', value: title }] });
	const submitter = item.by?.trim();
	return {
		kind: 'forum',
		title: title.trim(),
		content: [heading, hnText].filter(Boolean).join('\n\n'),
		source: 'Hacker News',
		publishedDate: item.time ? new Date(item.time * 1000).toISOString() : null,
		summary: null,
		// A submitter is a byline name, not an account: few submit twice, and nobody follows one.
		creators: submitter ? [{ role: 'submitter', literal: submitter }] : [],
		kindMetadata: {},
		fileType: null,
		previewImageUrl: null,
		subjectUrl: null,
	};
}

export function stageHackerNewsAcquisition(step: WorkflowStep, itemId: string) {
	return stepJson(step, 'acquire-hackernews-item-v8', { retries: FETCH_STEP_RETRIES, timeout: '30 seconds' }, () =>
		scrapeHackerNews(itemId),
	);
}
