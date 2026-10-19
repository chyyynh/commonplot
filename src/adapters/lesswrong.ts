import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';
import type { PlatformResource } from '../contracts/acquired-resource';
import { normalizedResourceImageUrl } from '../contracts/image-mapping';
import { ResourceUrlSchema } from '../contracts/resource-url';
import { fetchOk, readBoundedResponseText } from '../services/response';
import { FETCH_STEP_RETRIES, stepJson } from '../services/workflow-step';

const LESSWRONG_GRAPHQL_URL = 'https://www.lesswrong.com/graphql';
const MAX_LESSWRONG_RESPONSE_BYTES = 8 * 1024 * 1024;
/** The line LessWrong opens a linkpost with when the post itself does not carry the link. */
const LINKPOST_LEAD = /^This is a linkpost for \[?(https?:\/\/[^\]\s)]+)/;

const POST_QUERY = `query PostForIngest($id: String!) {
  post(selector: { documentId: $id }, allowNull: true) {
    result {
      _id
      title
      postedAt
      url
      contents { markdown }
      user { _id displayName username }
      socialPreviewImageUrl
      socialPreviewImageAutoUrl
    }
  }
}`;

const LessWrongDataSchema = z.object({
	post: z.object({
		result: z
			.object({
				_id: z.string(),
				title: z.string(),
				postedAt: z.string(),
				url: z.string().nullable(),
				contents: z.object({ markdown: z.string().nullable() }).nullable(),
				user: z.object({ _id: z.string(), displayName: z.string(), username: z.string().nullable() }).nullable(),
				socialPreviewImageUrl: z.string().nullable(),
				socialPreviewImageAutoUrl: z.string().nullable(),
			})
			.nullable(),
	}),
});

async function scrapeLessWrong(postId: string) {
	const response = await fetchOk(LESSWRONG_GRAPHQL_URL, {
		label: 'LessWrong GraphQL',
		timeoutMs: 15_000,
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ query: POST_QUERY, variables: { id: postId } }),
	});
	const payload = z
		.object({
			data: z.unknown().optional(),
			errors: z
				.array(z.object({ message: z.string() }))
				.nonempty()
				.optional(),
		})
		.parse(JSON.parse(await readBoundedResponseText(response, MAX_LESSWRONG_RESPONSE_BYTES, 'LessWrong response')));
	if (payload.errors) throw new Error(`LessWrong GraphQL failed: ${payload.errors.map(({ message }) => message).join('; ')}`);
	const post = LessWrongDataSchema.parse(payload.data).post.result;
	if (!post) throw new NonRetryableError(`LessWrong post was not found: ${postId}`);
	if (post._id !== postId) throw new Error(`LessWrong GraphQL returned no matching post for ${postId}`);
	const title = post.title.trim();
	const body = post.contents?.markdown?.trim();
	// A linkpost shares another page, which is its subject; it may have no words of its own.
	const linked = ResourceUrlSchema.safeParse(post.url?.trim() || LINKPOST_LEAD.exec(body ?? '')?.[1]).data ?? null;
	const markdown = body || (linked && `This is a linkpost for ${linked}`);
	if (!title) throw new NonRetryableError(`LessWrong post ${postId} has no title`);
	if (!markdown) throw new NonRetryableError(`LessWrong post ${postId} has no Markdown content`);
	const author = post.user?.displayName.trim() || post.user?.username?.trim() || null;
	return {
		kind: 'blog',
		fileType: null,
		title,
		content: markdown,
		previewImageUrl: normalizedResourceImageUrl(
			post.socialPreviewImageUrl?.trim() || post.socialPreviewImageAutoUrl?.trim(),
			LESSWRONG_GRAPHQL_URL,
		),
		source: 'LessWrong',
		originalLang: 'und',
		publishedDate: post.postedAt.trim() || null,
		summary: null,
		creators: post.user && author ? [{ role: 'author', literal: author, account: { platform: 'lesswrong', id: post.user._id } }] : [],
		kindMetadata: null,
		subjectUrl: linked,
	} satisfies PlatformResource;
}

export async function stageLessWrongAcquisition(step: WorkflowStep, postId: string) {
	return stepJson(step, 'acquire-lesswrong-v3', { retries: FETCH_STEP_RETRIES, timeout: '120 seconds' }, () => scrapeLessWrong(postId));
}
