import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { fetchWithTimeout, readTextWithLimit, WEB_FETCH_USER_AGENT } from '@core-shared/http';
import { normalizedResourceImageUrl } from '@core-shared/resource-image-mapping';
import { literalCreator } from '@core-shared/resource-metadata';
import type { AcquiredMaterial } from '@core-shared/types';
import { z } from 'zod';
import {
	acquiredContentSchema,
	DEFAULT_ACQUISITION_STEP_CONFIG,
	type NormalizedAcquiredContent,
	normalizeAcquiredContent,
} from '../acquired-content';

const LESSWRONG_GRAPHQL_URL = 'https://www.lesswrong.com/graphql';
const LESSWRONG_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
const LESSWRONG_POST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const LessWrongAcquiredContentSchema: z.ZodType<NormalizedAcquiredContent<'lesswrong'>> = acquiredContentSchema('lesswrong', {
	platformId: z.string().trim().min(1),
});

const POST_QUERY = `query PostForIngest($id: String!) {
  post(selector: { documentId: $id }) {
    result {
      _id
      title
      postedAt
      contents { markdown }
      user { displayName username }
      socialPreviewImageUrl
      socialPreviewImageAutoUrl
    }
  }
}`;

type LessWrongGraphqlResponse = {
	data?: {
		post?: {
			result?: {
				_id?: string;
				title?: string;
				postedAt?: string;
				contents?: { markdown?: string | null } | null;
				user?: { displayName?: string | null; username?: string | null } | null;
				socialPreviewImageUrl?: string | null;
				socialPreviewImageAutoUrl?: string | null;
			} | null;
		} | null;
	};
	errors?: Array<{ message?: string }>;
};

async function scrapeLessWrong(postId: string): Promise<AcquiredMaterial<'lesswrong'>> {
	if (!LESSWRONG_POST_ID_RE.test(postId)) throw new NonRetryableError(`Invalid LessWrong post id: ${postId}`);
	const response = await fetchWithTimeout(LESSWRONG_GRAPHQL_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'User-Agent': WEB_FETCH_USER_AGENT,
		},
		body: JSON.stringify({ query: POST_QUERY, variables: { id: postId } }),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`LessWrong GraphQL failed with HTTP ${response.status}`);
	}
	const payload = JSON.parse(await readTextWithLimit(response, LESSWRONG_RESPONSE_MAX_BYTES)) as LessWrongGraphqlResponse;
	const graphqlError = payload.errors?.map((error) => error.message?.trim()).find(Boolean);
	if (graphqlError) throw new Error(`LessWrong GraphQL failed: ${graphqlError}`);
	const post = payload.data?.post?.result;
	if (!post || post._id !== postId) throw new NonRetryableError(`LessWrong post was not found: ${postId}`);
	const title = post.title?.trim();
	const markdown = post.contents?.markdown?.trim();
	if (!title) throw new NonRetryableError(`LessWrong post ${postId} has no title`);
	if (!markdown) throw new NonRetryableError(`LessWrong post ${postId} has no Markdown content`);
	const author = post.user?.displayName?.trim() || post.user?.username?.trim() || null;
	return {
		resourcePlatform: 'lesswrong',
		platformId: postId,
		fileType: null,
		title,
		markdown,
		previewImageUrl: normalizedResourceImageUrl(
			post.socialPreviewImageUrl?.trim() || post.socialPreviewImageAutoUrl?.trim(),
			LESSWRONG_GRAPHQL_URL,
		),
		source: 'LessWrong',
		originalLang: null,
		publishedDate: post.postedAt?.trim() || null,
		summary: null,
		creators: literalCreator('author', author),
		kindMetadata: { siteName: 'LessWrong' },
	};
}

export async function stageLessWrongAcquisition(step: WorkflowStep, input: { postId: string; route: number; url: string }) {
	const contentStream = await step.do(
		`acquire-lesswrong-v1-${input.route}`,
		DEFAULT_ACQUISITION_STEP_CONFIG,
		async () => Response.json(await normalizeAcquiredContent({ ...(await scrapeLessWrong(input.postId)), canonicalUrl: input.url })).body!,
	);
	return LessWrongAcquiredContentSchema.parse(await new Response(contentStream).json());
}
