import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'cloudflare:workflows')
			return { shortCircuit: true, url: 'data:text/javascript,export class NonRetryableError extends Error {}' };
		if (specifier.startsWith('.') && !specifier.endsWith('.ts') && context.parentURL?.includes('/core-worker/src/')) {
			return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href };
		}
		return nextResolve(specifier, context);
	},
});
const { stageUrlAcquisition, withoutDuplicateResourceTitle } = await import('../src/ingest/acquisition.ts');
const { stagePaperResolution } = await import('../src/ingest/platforms/paper.ts');
const { resolveResourceUrl } = await import('../src/ingest/platforms/resource-url.ts');
const { prepareResolvedResource } = await import('../src/ingest/resource-persistence.ts');
const { selectCrossrefPaperCandidate, selectCrossrefReference } = await import('../src/ingest/crossref.ts');
const { parseGrobidPdfHeaderTei } = await import('../src/ingest/grobid-tei.ts');
const { parseTwitterAdvancedSearchPage } = await import('../src/ingest/platforms/twitter.ts');
const { parseTwitterTweetsResponse } = await import('../src/ingest/platforms/twitter-acquisition.ts');

assert.equal(withoutDuplicateResourceTitle('# Only title', 'Only title'), '# Only title');
assert.equal(withoutDuplicateResourceTitle('## **Actual** title\n\nBody.', 'Actual title'), 'Body.');
assert.equal(withoutDuplicateResourceTitle('# Introduction\n\nBody.', 'Article title'), '# Introduction\n\nBody.');

const requests = [];
const responses = new Map();
const originalFetch = globalThis.fetch;
const step = { do: async (_name, ...args) => args.at(-1)({ attempt: 1 }) };
const env = { YOUTUBE_API_KEY: 'fixture', KAITO_API_KEY: 'fixture', OPENALEX_API_KEY: 'fixture' };
const input = { processingId: 'contract', paidPdfFallback: null };
globalThis.fetch = async (request) => {
	const url = new URL(request);
	requests.push(url);
	assert.ok(responses.has(url.pathname), `Unexpected provider request: ${url.origin}${url.pathname}`);
	const response = responses.get(url.pathname);
	return typeof response === 'function' ? response(url) : Response.json(response);
};

const tweet = {
	id: '125',
	url: 'https://x.com/example/status/125',
	createdAt: '2026-09-01T00:00:00Z',
	author: { userName: 'example', name: 'Example' },
	text: 'Comment https://t.co/link',
	urls: [{ url: 'https://t.co/link', expanded_url: 'https://doi.org/10.1000/example' }],
};
responses.set('/v0/item/124.json', {
	id: 124,
	type: 'story',
	title: 'Ask HN: A &amp; B',
	text: '<p>First <i>point</i></p><p><a href="item?id=123">Discussion</a></p><pre><code>const n = 1;</code></pre>',
	url: 'https://doi.org/10.1000/example',
});
responses.set('/graphql', {
	data: { post: { result: { _id: 'A2kJKqnHhh5Hq4p2S', title: 'Example', contents: { markdown: '**Original** body.' } } } },
});
responses.set('/twitter/tweets', { tweets: [tweet] });
responses.set('/youtube/v3/videos', {
	items: [
		{
			id: 'abcdefghijk',
			snippet: {
				title: 'Video',
				description: '00:00 Introduction\n01:00 Results',
				channelId: 'example',
				channelTitle: 'Example Channel',
				publishedAt: '2026-09-01T00:00:00Z',
				thumbnails: {},
			},
			contentDetails: { duration: 'PT2M' },
			statistics: {},
		},
	],
});
responses.set('/youtube/v3/channels', { items: [{ snippet: { thumbnails: { high: { url: 'https://example.com/avatar.jpg' } } } }] });
responses.set('/youtubei/v1/player', {
	captions: {
		playerCaptionsTracklistRenderer: {
			captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?lang=ja&fmt=srv3&signature=fixture', languageCode: 'ja' }],
		},
	},
});
responses.set('/api/timedtext', (url) => {
	assert.equal(url.searchParams.get('fmt'), 'srv1', 'Request one explicit format instead of guessing timestamp units');
	assert.equal(url.searchParams.get('signature'), 'fixture');
	assert.equal(url.searchParams.get('lang'), 'ja');
	return new Response('<transcript><text start="60" dur="1.5">Transcript content</text></transcript>');
});
const summaryFields = { originalLang: 'en', summary: 'Summary' };
try {
	const cases = [
		['https://news.ycombinator.com/item?id=124', 'hackernews', 'forum', '124'],
		['https://www.lesswrong.com/posts/A2kJKqnHhh5Hq4p2S/example', 'lesswrong', 'blog', 'A2kJKqnHhh5Hq4p2S'],
		['https://x.com/example/status/125', 'twitter', 'post', '125'],
		['https://youtu.be/abcdefghijk', 'youtube', 'video', 'abcdefghijk'],
	];
	const acquired = new Map();
	for (const [url, platform, kind, value] of cases) {
		const resource = await stageUrlAcquisition(env, step, { ...input, url });
		acquired.set(platform, resource);
		assert.equal(resource.kind, kind);
		assert.equal(resource.resourcePlatform, platform);
		assert.deepEqual(resource.resourceIdentifiers, [{ scheme: platform, value, preferred: true }]);
		assert.ok(resource.content.trim());
		assert.equal(resolveResourceUrl(url).identifiers[0].value, value);
	}
	for (const [url, normalizedUrl, scheme] of [
		['https://www.example.com/article?b=2&utm_source=feed&a=1', 'https://example.com/article?a=1&b=2', null],
		['https://youtu.be/abcdefghijk?si=share', 'https://youtube.com/watch?v=abcdefghijk', 'youtube'],
		['https://doi.org/10.1000/example?utm_source=feed#part', 'https://doi.org/10.1000/example', 'doi'],
		['https://arxiv.org/pdf/2507.12652v2?download=1', 'https://arxiv.org/abs/2507.12652', 'arxiv'],
		['https://doi.org/10.48550/arXiv.2507.12652', 'https://arxiv.org/abs/2507.12652', 'arxiv'],
	]) {
		const resolved = resolveResourceUrl(url);
		assert.equal(resolved.url, url, 'Identity normalization must not rewrite the fetch URL');
		assert.equal(resolved.normalizedUrl, normalizedUrl);
		assert.equal(resolved.identifiers[0]?.scheme ?? null, scheme);
		const repeated = resolveResourceUrl(normalizedUrl);
		assert.equal(repeated.normalizedUrl, normalizedUrl);
		assert.deepEqual(repeated.identifiers, resolved.identifiers, 'Identity is idempotent');
	}
	for (const url of ['not a url', 'ftp://example.com/file', 'https://user:password@example.com']) {
		assert.equal(resolveResourceUrl(url), null);
	}
	const hn = acquired.get('hackernews');
	assert.equal(hn.title, 'Ask HN: A & B');
	assert.match(hn.content, /First \*point\*/u);
	assert.match(hn.content, /\[Discussion\]\(https:\/\/news.ycombinator.com\/item\?id=123\)/u);
	assert.match(hn.content, /```\nconst n = 1;/u);
	assert.equal(hn.subject.normalizedUrl, 'https://doi.org/10.1000/example');
	assert.equal(acquired.get('lesswrong').content, '**Original** body.');
	assert.equal(acquired.get('twitter').content, 'Comment https://doi.org/10.1000/example');
	assert.equal(acquired.get('twitter').subject.normalizedUrl, 'https://doi.org/10.1000/example');
	const subjectUrl = 'https://arxiv.org/pdf/2507.12652v2?download=1';
	responses.set('/twitter/tweets', {
		tweets: [{ ...tweet, text: 'https://t.co/link', urls: [{ url: 'https://t.co/link', expanded_url: subjectUrl }] }],
	});
	const linkOnly = await stageUrlAcquisition(env, step, { ...input, url: tweet.url });
	assert.equal(linkOnly.content, subjectUrl);
	const linked = prepareResolvedResource({ ...linkOnly, ...summaryFields }, []);
	assert.equal(linked.subject.url, subjectUrl);
	assert.equal(linked.subject.normalizedUrl, 'https://arxiv.org/abs/2507.12652');
	responses.set('/twitter/tweets', { tweets: [tweet] });
	const video = acquired.get('youtube');
	assert.equal(video.content, 'Transcript content');
	assert.equal(video.originalLang, 'ja');
	assert.equal(video.summary, '00:00 Introduction\n01:00 Results');
	assert.equal(video.creators[0].avatarUrl, 'https://example.com/avatar.jpg');
	assert.deepEqual(video.youtube.segments, [{ startTime: 60, endTime: 61.5, text: 'Transcript content' }]);
	responses.get('/youtubei/v1/player').captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl =
		'https://www.youtube.com/api/timedtext?lang=ja&signature=fixture';
	responses.get('/youtube/v3/videos').items[0].snippet.description = 'Video without chapters';
	const unchaptered = await stageUrlAcquisition(env, step, { ...input, url: 'https://youtu.be/abcdefghijk' });
	assert.equal(unchaptered.youtube.chapters.length, 0);
	assert.deepEqual(
		unchaptered.youtube.segments,
		video.youtube.segments,
		'Default and srv3 caption URLs both request classic XML in seconds',
	);
	assert.equal(unchaptered.content, video.content, 'Acquisition must return the transcript without calling AI');

	responses.set('/twitter/tweets', { tweets: [{ ...tweet, url: 'https://x.com/i/article/125' }] });
	responses.set('/twitter/article', {
		status: 'success',
		article: {
			title: 'Longform',
			contents: [
				{ type: 'header-one', text: 'Heading' },
				{ type: 'unstyled', text: 'Bold text', inlineStyleRanges: [{ offset: 0, length: 4, style: 'Bold' }] },
				{ type: 'unordered-list-item', text: 'One' },
				{ type: 'unordered-list-item', text: 'Two' },
			],
		},
	});
	const article = await stageUrlAcquisition(env, step, { ...input, url: 'https://x.com/i/article/125' });
	assert.equal(article.title, 'Longform');
	assert.equal(article.content, '# Heading\n\n**Bold** text\n\n- One\n- Two');
	for (const url of [
		'https://example.com/status/125',
		'https://youtu.be/short',
		'https://x.com/example/status/abc',
		'https://ycombinator.com/companies?id=124',
		'https://news.ycombinator.com/news?id=124',
		'https://youtube.com/channel/example?v=abcdefghijk',
	]) {
		assert.equal(resolveResourceUrl(url).resourcePlatform, null, 'Unrelated or malformed URLs cannot claim platform identity');
	}
	assert.throws(() => parseTwitterTweetsResponse({ tweets: [], status: 'error', message: 'Provider failed' }), /Provider failed/);
	const page = parseTwitterAdvancedSearchPage({ tweets: [tweet, { ...tweet, createdAt: 123 }], has_next_page: true, next_cursor: 'next' });
	assert.equal(page.rawTweetCount, 2);
	assert.equal(page.tweets.length, 1);
	assert.equal(page.nextCursor, 'next');
	assert.equal(parseTwitterTweetsResponse({ tweets: [{ ...tweet, quoted_tweet: { ...tweet, createdAt: 123 } }] })[0].quoted_tweet, null);
	const discovery = parseTwitterAdvancedSearchPage({
		tweets: [
			{ ...tweet, author: { userName: 'example', name: '' }, extendedEntities: 'unused malformed media', text: null },
			{ ...tweet, retweeted_tweet: { id: '126', createdAt: tweet.createdAt } },
			{ ...tweet, id: 'invalid' },
		],
		has_next_page: false,
	});
	assert.equal(discovery.tweets.length, 2, 'Discovery depends on identity and attribution, not display or content metadata');
	assert.equal(discovery.invalidItems.length, 1);
	assert.equal(discovery.tweets[1].retweeted_tweet.id, '126');
	assert.ok(!('text' in discovery.tweets[0]));

	let blog;
	for (const [metadata, summary] of [
		['<meta name="description" content="Source summary">', 'Source summary'],
		[
			'<script type="application/ld+json">{"@graph":[{"@type":"Organization","description":"Marketing"},{"@type":"NewsArticle","description":"Article abstract"}]}</script>',
			'Article abstract',
		],
		['<script type="application/ld+json">{"@type":"Organization","description":"Marketing"}</script>', null],
		['', null],
	]) {
		responses.set('/article', (url) => {
			const response = new Response(
				`<html><head><title>Example</title><meta property="og:site_name" content="Example">${metadata}</head><body><article><h1>Example</h1><p>${'A useful research article. '.repeat(30)}</p></article></body></html>`,
				{ headers: { 'content-type': 'text/html' } },
			);
			Object.defineProperty(response, 'url', { value: url.href });
			return response;
		});
		blog = await stageUrlAcquisition(env, step, { ...input, url: 'https://example.com/article' });
		assert.equal(blog.kind, 'blog');
		assert.equal(blog.summary, summary);
		assert.match(blog.content, /A useful research article/u);
		assert.equal(prepareResolvedResource({ ...blog, ...summaryFields }, []).kind, 'blog');
	}
	const today = new Date().toISOString().slice(0, 10);
	for (const [publishedDate, expected] of [
		['2099-06-24T00:00:00.000Z', `${today}T00:00:00.000Z`],
		[`${today}T23:59:59.000Z`, `${today}T23:59:59.000Z`],
		['2024-06-30T00:00:00.000Z', '2024-06-30T00:00:00.000Z'],
		[null, null],
	]) {
		assert.equal(prepareResolvedResource({ ...blog, ...summaryFields, publishedDate }, []).publishedDate?.toISOString() ?? null, expected);
	}
	responses.set('/10.1000/example', () => responses.get('/article')(new URL('https://publisher.example/article')));
	const redirected = await stageUrlAcquisition(env, step, { ...input, url: 'https://doi.org/10.1000/example?utm_source=feed' });
	assert.equal(redirected.url, 'https://publisher.example/article');
	assert.deepEqual(redirected.resourceIdentifiers, [{ scheme: 'doi', value: '10.1000/example', preferred: true }]);
	const tracked = await stageUrlAcquisition(env, step, { ...input, url: 'https://www.example.com/article?utm_source=feed' });
	const persisted = prepareResolvedResource({ ...tracked, ...summaryFields }, []);
	assert.equal(persisted.url, tracked.url);
	assert.equal(persisted.normalizedUrl, 'https://example.com/article');
	for (const [url, fileType, identifiers, kind, provider] of [
		[blog.url, null, [], 'blog', null],
		['https://doi.org/10.1000/example', null, [], 'paper', 'api.openalex.org'],
		['https://arxiv.org/abs/2507.12652', null, [], 'paper', 'api.openalex.org'],
		['https://example.com/file.pdf', 'application/pdf', [], 'file', null],
		[
			'https://example.com/paper.pdf',
			'application/pdf',
			[{ scheme: 'doi', value: '10.1000/example', preferred: true }],
			'paper',
			'api.crossref.org',
		],
	]) {
		requests.length = 0;
		const savedFetch = globalThis.fetch;
		globalThis.fetch = async (request) => {
			requests.push(new URL(request));
			return Response.json(null, { status: 404 });
		};
		try {
			const result = await stagePaperResolution(env, step, {
				processingId: 'contract',
				resource: {
					...blog,
					url,
					resourceIdentifiers: [...resolveResourceUrl(url).identifiers, ...identifiers],
					fileType,
					kind: fileType ? 'file' : 'blog',
					kindMetadata: fileType ? null : blog.kindMetadata,
				},
			});
			assert.equal(result.kind, kind, 'Provider outages must preserve explicit identity and readable content');
			assert.equal(result.content, blog.content);
			assert.deepEqual(
				requests.map((url) => url.hostname),
				provider ? [provider] : [],
			);
			assert.equal(prepareResolvedResource({ ...result, ...summaryFields }, []).kind, kind);
		} finally {
			globalThis.fetch = savedFetch;
		}
	}
	responses.set('/works/W2', { id: 'https://openalex.org/W2', title: 'Resolved paper', cited_by_count: 17, referenced_works_count: 4 });
	requests.length = 0;
	const paper = await stagePaperResolution(env, step, {
		processingId: 'contract',
		resource: { ...blog, url: 'https://openalex.org/W2', resourceIdentifiers: resolveResourceUrl('https://openalex.org/W2').identifiers },
	});
	assert.equal(paper.title, 'Resolved paper');
	assert.equal(paper.kindMetadata.citedByCount, 17);
	assert.equal(paper.kindMetadata.referenceCount, 4);
	assert.deepEqual(
		requests.map((url) => url.pathname),
		['/works/W2'],
		'Paper resolution needs no sampled citation-list requests',
	);
	assert.throws(
		() => prepareResolvedResource({ ...blog, ...summaryFields, resourcePlatform: 'twitter' }, []),
		/Resource identifiers do not match/,
	);

	for (const pdfUrl of ['https://example.com/works/W2.pdf', 'https://content.openalex.org/works/W2.pdf?api_key=fixture']) {
		responses.set('/works/W2', { id: 'https://openalex.org/W2', has_content: { pdf: true }, content_urls: { pdf: pdfUrl } });
		requests.length = 0;
		const result = await stagePaperResolution(env, step, {
			processingId: 'contract',
			resource: { ...blog, url: 'https://openalex.org/W2', resourceIdentifiers: resolveResourceUrl('https://openalex.org/W2').identifiers },
		});
		assert.equal(result.content, blog.content);
		assert.deepEqual(
			requests.map((url) => url.hostname),
			['api.openalex.org'],
			'Untrusted provider content URLs must never receive an authenticated fetch',
		);
	}
	responses.set('/works/https://doi.org/10.48550%2Farxiv.2507.12652', {
		id: 'https://openalex.org/W2',
		doi: 'https://doi.org/10.48550/arXiv.2507.12652',
	});
	const arxiv = await stagePaperResolution(env, step, {
		processingId: 'contract',
		resource: {
			...blog,
			url: 'https://arxiv.org/abs/2507.12652v2',
			resourceIdentifiers: resolveResourceUrl('https://arxiv.org/abs/2507.12652v2').identifiers,
		},
	});
	assert.ok(arxiv.resourceIdentifiers.some(({ scheme, value }) => scheme === 'arxiv' && value === '2507.12652'));
	assert.ok(
		!arxiv.resourceIdentifiers.some(({ scheme }) => scheme === 'doi'),
		'An arXiv proxy DOI must not become a separate paper identity',
	);
} finally {
	globalThis.fetch = originalFetch;
}

const title = 'Social coding in GitHub';
const crossref = {
	status: 'ok',
	message: {
		items: [
			{
				DOI: '10.1145/2145204.2145396',
				title: [title],
				author: [{ family: 'Dabbish', given: 'Laura' }],
				published: { 'date-parts': [[2012]] },
				'container-title': ['CSCW'],
				type: 'proceedings-article',
			},
		],
	},
};
assert.equal(selectCrossrefPaperCandidate(title, ['Laura Dabbish'], crossref).doi, '10.1145/2145204.2145396');
assert.equal(selectCrossrefPaperCandidate(title, ['Someone Else'], crossref), null);
assert.equal(selectCrossrefReference(`Laura Dabbish. 2012. ${title}.`, crossref).doi, '10.1145/2145204.2145396');
assert.equal(selectCrossrefReference(`Laura Dabbish. 2023. ${title}.`, crossref), null);
const header = parseGrobidPdfHeaderTei(
	'<TEI><teiHeader><fileDesc><titleStmt><title type="main">Report</title></titleStmt></fileDesc></teiHeader></TEI>',
);
assert.deepEqual(header.resourceIdentifiers, [], 'A title alone cannot turn a private PDF into a public paper');
console.info('Platform contracts passed: native adapters, URL identity, paper resolution, summaries and bibliography matching.');
