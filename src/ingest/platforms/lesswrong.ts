import { fetchWithTimeout, readTextWithLimit, WEB_FETCH_USER_AGENT } from '@core-shared/http';
import { normalizedResourceImageUrl } from '@core-shared/resource-image-mapping';
import type { AcquiredMaterial } from '@core-shared/types';

const LESSWRONG_GRAPHQL_URL = 'https://www.lesswrong.com/graphql';
const LESSWRONG_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
const LESSWRONG_POST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

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

export async function scrapeLessWrong(postId: string): Promise<AcquiredMaterial<'lesswrong'>> {
	if (!LESSWRONG_POST_ID_RE.test(postId)) throw new Error(`Invalid LessWrong post id: ${postId}`);
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
	if (!post || post._id !== postId) throw new Error(`LessWrong post was not found: ${postId}`);
	const title = post.title?.trim();
	const markdown = post.contents?.markdown?.trim();
	if (!title) throw new Error(`LessWrong post ${postId} has no title`);
	if (!markdown) throw new Error(`LessWrong post ${postId} has no Markdown content`);
	const author = post.user?.displayName?.trim() || post.user?.username?.trim() || null;
	return {
		provider: 'lesswrong',
		fileType: null,
		title,
		markdown,
		previewImageUrl: normalizedResourceImageUrl(
			post.socialPreviewImageUrl?.trim() || post.socialPreviewImageAutoUrl?.trim(),
			LESSWRONG_GRAPHQL_URL,
		),
		metadata: {
			author,
			language: null,
			publishedDate: post.postedAt?.trim() || null,
			siteName: 'LessWrong',
			description: null,
		},
		acquisition: { data: null },
	};
}
