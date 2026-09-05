import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'cloudflare:workflows') {
			return { shortCircuit: true, url: 'data:text/javascript,export class NonRetryableError extends Error {}' };
		}
		if (specifier.startsWith('.') && !specifier.endsWith('.ts') && context.parentURL?.includes('/workers/core-worker/src/')) {
			return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href };
		}
		return nextResolve(specifier, context);
	},
});

const [resource, paper, hackerNews, lessWrong, twitter, youtube, { analyzeResource }] = await Promise.all([
	import('../src/shared/resource.ts'),
	import('../src/shared/paper-identity.ts'),
	import('../src/ingest/platforms/hackernews.ts'),
	import('../src/ingest/platforms/lesswrong.ts'),
	import('../src/ingest/platforms/twitter-acquisition.ts'),
	import('../src/ingest/platforms/youtube.ts'),
	import('../src/ingest/analysis.ts'),
]);

function detectResourceUrl(value) {
	const url = URL.parse(value);
	if (!url) return null;
	const hostname = url.hostname.toLowerCase();
	if (hostname === 'ycombinator.com' || hostname.endsWith('.ycombinator.com')) return hackerNews.parseHackerNewsResourceUrl(url);
	if (hostname === 'lesswrong.com' || hostname.endsWith('.lesswrong.com')) return lessWrong.parseLessWrongResourceUrl(url);
	if (hostname === 'twitter.com' || hostname.endsWith('.twitter.com') || hostname === 'x.com' || hostname.endsWith('.x.com')) {
		return twitter.parseTwitterResourceUrl(url);
	}
	if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be' || hostname.endsWith('.youtu.be')) {
		return youtube.parseYouTubeResourceUrl(url);
	}
	return null;
}

const platformUrlCases = [
	['https://twitter.com/openai/status/1234567890?s=20', ['twitter', '1234567890', 'https://x.com/i/status/1234567890']],
	[
		'https://news.ycombinator.com/item?id=12345678&utm_source=feed',
		['hackernews', '12345678', 'https://news.ycombinator.com/item?id=12345678'],
	],
	['https://youtu.be/dQw4w9WgXcQ?t=43', ['youtube', 'dQw4w9WgXcQ', 'https://youtube.com/watch?v=dQw4w9WgXcQ']],
	[
		'https://www.lesswrong.com/posts/A2kJKqnHhh5Hq4p2S/example-slug',
		['lesswrong', 'A2kJKqnHhh5Hq4p2S', 'https://lesswrong.com/posts/A2kJKqnHhh5Hq4p2S'],
	],
	['https://example.com/article', null],
	['https://example.com/openai/status/1234567890', null],
	['https://news.ycombinator.com/item?id=0', null],
	['https://x.com/openai/status/not-a-tweet', null],
	['https://x.com/openai/status/123abc', null],
	['https://youtu.be/too-short', null],
	['https://lesswrong.com/posts/short', null],
];
for (const [input, expected] of platformUrlCases) {
	const actual = detectResourceUrl(input);
	assert.deepEqual(actual ? [actual.resourcePlatform, actual.platformId, actual.canonicalUrl] : null, expected, input);
}

const canonicalIdentifiers = [
	{ preferred: true, scheme: 'doi', value: '10.1000/example' },
	{ preferred: true, scheme: 'youtube', value: 'dQw4w9WgXcQ' },
];
assert.deepEqual(resource.ResourceIdentifiersSchema.parse(canonicalIdentifiers), canonicalIdentifiers);
assert.equal(resource.ResourceIdentifiersSchema.safeParse([{ preferred: true, scheme: 'doi', value: ' 10.1000/EXAMPLE ' }]).success, false);
assert.equal(resource.ResourceIdentifiersSchema.safeParse([{ preferred: false, scheme: 'twitter', value: '123' }]).success, false);
assert.equal(
	resource.ResourceIdentifiersSchema.safeParse([
		{ preferred: true, scheme: 'arxiv', value: '2401.12345' },
		{ preferred: true, scheme: 'arxiv', value: '2402.12345' },
	]).success,
	false,
);

for (const input of [
	'https://arxiv.org/abs/2507.12652',
	'https://arxiv.org/html/2507.12652v2',
	'https://arxiv.org/pdf/2507.12652v3.pdf',
	'arXiv:2507.12652v4',
	'2507.12652',
]) {
	assert.deepEqual(paper.resolveExactPaperInput(input), {
		canonicalUrl: 'https://arxiv.org/abs/2507.12652',
		identity: { arxivId: '2507.12652' },
	});
}
assert.deepEqual(paper.resolveExactPaperInput('https://openalex.org/w2741809807'), {
	canonicalUrl: 'https://openalex.org/W2741809807',
	identity: { openAlexId: 'W2741809807' },
});
assert.deepEqual(paper.paperIdentityFromText('DOI: 10.1000/EXAMPLE\narXiv:2401.00001v2'), {
	doi: '10.1000/example',
	arxivId: '2401.00001',
});
assert.deepEqual(paper.paperIdentityFromText('arXiv preprint arXiv 2401.00001v2'), {
	arxivId: '2401.00001',
});
assert.deepEqual(
	paper.paperIdentifiersFromIdentity({
		doi: 'DOI: 10.1000/EXAMPLE',
		arxivId: 'arXiv:2401.00001v2',
		openAlexId: 'https://openalex.org/w2741809807',
	}),
	[
		{ preferred: true, scheme: 'doi', value: '10.1000/example' },
		{ preferred: true, scheme: 'arxiv', value: '2401.00001' },
		{ preferred: true, scheme: 'openalex', value: 'W2741809807' },
	],
);
assert.deepEqual(
	paper.normalizePaperIdentifiers([
		{ scheme: 'arxiv', value: 'arXiv:2405.06478', preferred: true },
		{ scheme: 'openalex', value: 'W4411722349', preferred: true },
		{ scheme: 'openalex', value: 'w4396882289', preferred: true },
		{ scheme: 'doi', value: 'https://doi.org/10.1007/S00146-025-02400-Z' },
	]),
	[
		{ scheme: 'arxiv', value: '2405.06478', preferred: true },
		{ scheme: 'openalex', value: 'W4411722349', preferred: true },
		{ scheme: 'openalex', value: 'W4396882289', preferred: false },
		{ scheme: 'doi', value: '10.1007/s00146-025-02400-z', preferred: true },
	],
);
assert.equal(resource.ResourceIdentifiersSchema.safeParse([{ preferred: true, scheme: 'youtube', value: 'too-short' }]).success, false);

const generatedSummary = 'A preliminary evaluation found improved accuracy on two datasets.';
for (const [summary, originalLang, detectedLang, expectedLang] of [
	['Existing source abstract, including its limitations.', 'en', 'ja', 'en'],
	[null, 'und', 'en', 'en'],
	['', 'zh-Hant', 'zh-Hant', 'zh-Hant'],
	['   ', 'und', 'ja', 'ja'],
]) {
	const input = { title: 'Evaluation', source: 'Example', kind: 'blog', content: generatedSummary, summary, originalLang };
	const output = {
		tags: ['Research'],
		keywords: ['evaluation'],
		originalLang: detectedLang,
		summary: summary?.trim() ? null : generatedSummary,
	};
	const env = {
		AI: { run: async () => ({ response: JSON.stringify(output), finish_reason: 'stop' }) },
		AI_GATEWAY_ENVIRONMENT: 'development',
	};
	const analysis = await analyzeResource(input, ['source-keyword'], env, 'analysis-contract');
	assert.equal(analysis.summary, summary?.trim() || generatedSummary);
	assert.equal(analysis.originalLang, expectedLang);
	assert.deepEqual(analysis.keywords, ['source-keyword']);
	if (!summary?.trim()) {
		output.summary = '   ';
		await assert.rejects(analyzeResource(input, [], env, 'analysis-contract'));
	}
}

console.info({
	event: 'resource_contract_smoke_passed',
	identifierContractCases: 5,
	urlCases: platformUrlCases.length,
});
