import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { normalizedResourceImageUrl } from '../../shared/image-mapping';
import { RESOURCE_TYPES } from '../../shared/resource';
import {
	literalCreator,
	materializePlatformResource,
	type PlatformAcquiredMaterial,
	type ResolvedResource,
	type ResourceAcquisitionHints,
} from './materialize';

const LESSWRONG_GRAPHQL_URL = 'https://www.lesswrong.com/graphql';

export function parseLessWrongResourceUrl(url: URL) {
	const postId = RESOURCE_TYPES.blog.platforms[0].identifier.safeParse(url.pathname.match(/^\/posts\/([^/]+)(?:\/|$)/)?.[1]);
	return postId.success
		? {
				resourcePlatform: 'lesswrong' as const,
				platformId: postId.data,
				canonicalUrl: `https://lesswrong.com/posts/${postId.data}`,
			}
		: null;
}

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

async function scrapeLessWrong(postId: string): Promise<PlatformAcquiredMaterial<'lesswrong'>> {
	const response = await fetch(LESSWRONG_GRAPHQL_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ query: POST_QUERY, variables: { id: postId } }),
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`LessWrong GraphQL failed with HTTP ${response.status}`);
	}
	const payload = await response.json<LessWrongGraphqlResponse>();
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

export async function stageLessWrongAcquisition(
	step: WorkflowStep,
	postId: string,
	hints: ResourceAcquisitionHints,
): Promise<ResolvedResource> {
	const contentStream = await step.do(
		'acquire-lesswrong-v1',
		{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		async () => Response.json(await scrapeLessWrong(postId)).body!,
	);
	return materializePlatformResource(await new Response(contentStream).json<PlatformAcquiredMaterial<'lesswrong'>>(), hints, {
		kind: 'blog',
		url: `https://lesswrong.com/posts/${postId}`,
	});
}
