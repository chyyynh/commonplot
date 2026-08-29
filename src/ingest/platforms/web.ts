import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { addTransformations, extractFromHtml } from '@extractus/article-extractor';
import { normalizedResourceImageUrl } from '../../shared/image-mapping';
import { type GenericAcquiredMaterial, literalCreator, type PlatformResourceUrl } from './materialize';
import {
	acquireFetchedPdfResponse,
	completeFetchedPdfAcquisition,
	isPdfAcquisitionDraft,
	type PaidPdfFallbackGrant,
	PDF_MIME,
	type PdfAcquisitionDraft,
} from './pdf';
import { resolveArticlePublishedDate } from './web-published-date';

const GENERIC_FETCH_TIMEOUT_MS = 8_000;
const GENERIC_HTML_MAX_BYTES = 5 * 1024 * 1024;
const GENERIC_WEB_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const MIN_ARTICLE_CONTENT_CHARS = 180;
const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'mc_eid', 'mc_cid'];

// Static extractor configuration: TechCrunch places author cards and affiliate
// chrome beside the real post body inside the same Readability candidate. Its
// figcaptions are omitted because CommonMark would flatten them into body text;
// publisher-provided image alt text remains intact, but is not invented.
addTransformations({
	patterns: [/^https?:\/\/(?:www\.)?techcrunch\.com\//i],
	pre(document) {
		const article = document.querySelector('.entry-content.wp-block-post-content');
		if (article) document.body.replaceChildren(article.cloneNode(true));
		return document;
	},
	post(document) {
		for (const caption of document.querySelectorAll('figcaption')) caption.remove();
		return document;
	},
});

type ExtractedHtmlArticle = {
	html: string;
	title: string;
	author: string | null;
	publishedDate: string | null;
	siteName: string;
	description: string | null;
	previewImageUrl: string | null;
};

function optionalText(value: string | undefined): string | null {
	return value?.trim() || null;
}

async function extractHtmlArticle(html: string, url: string): Promise<ExtractedHtmlArticle | null> {
	const article = await extractFromHtml(html, url, {
		contentLengthThreshold: MIN_ARTICLE_CONTENT_CHARS,
		descriptionLengthThreshold: 0,
	});
	if (!article?.content?.trim()) return null;
	const title = article.title?.trim();
	if (!title) throw new NonRetryableError('Extracted article has no title');
	const siteName = article.source?.trim();
	if (!siteName) throw new NonRetryableError('Extracted article has no source');

	const articleHtml = article.content.trim();
	return {
		html: articleHtml,
		title,
		author: optionalText(article.author),
		publishedDate: resolveArticlePublishedDate({
			articleHtml,
			extracted: optionalText(article.published),
			pageHtml: html,
		}),
		siteName,
		description: optionalText(article.description),
		previewImageUrl: normalizedResourceImageUrl(article.image, url),
	};
}

type PlatformResolution = { platform: PlatformResourceUrl };
type WebAcquisition = GenericAcquiredMaterial | PdfAcquisitionDraft | PlatformResolution;

async function acquireHtmlArticle(env: CoreEnv, html: string, url: string, processingId: string): Promise<GenericAcquiredMaterial> {
	const article = await extractHtmlArticle(html, url);
	if (!article) throw new NonRetryableError('No readable article content found');

	const hostname = new URL(url).hostname;
	const converted = await env.AI.toMarkdown(
		{
			name: `${hostname.replace(/^www\./, '')}.html`,
			blob: new Blob([article.html], { type: 'text/html' }),
		},
		{
			gateway: {
				id: 'core-ingest',
				collectLog: true,
				retries: { maxAttempts: 1 },
				metadata: {
					feature: 'html-to-markdown',
					environment: env.AI_GATEWAY_ENVIRONMENT,
					processing_id: processingId,
				},
			},
			extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
			conversionOptions: { html: { hostname } },
		},
	);
	if (converted.format === 'error') throw new Error(`Workers AI toMarkdown failed: ${converted.error}`);
	const content = converted.data.trim();
	if (content.length < MIN_ARTICLE_CONTENT_CHARS) {
		throw new NonRetryableError(`Extracted HTML content is too short (${content.length} chars)`);
	}
	return {
		resourcePlatform: null,
		fileType: null,
		title: article.title,
		markdown: content,
		source: article.siteName,
		originalLang: null,
		publishedDate: article.publishedDate,
		summary: article.description,
		creators: literalCreator('author', article.author),
		kindMetadata: { siteName: article.siteName },
		previewImageUrl: article.previewImageUrl,
	};
}

async function acquireWebResource(
	url: string,
	env: CoreEnv,
	platformUrl: (url: URL) => PlatformResourceUrl | null,
	processingId: string,
): Promise<WebAcquisition> {
	const response = await fetch(url, {
		headers: {
			'User-Agent': GENERIC_WEB_USER_AGENT,
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.5',
			'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
		},
		signal: AbortSignal.timeout(GENERIC_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		await response.body?.cancel();
		if (response.status === 404 || response.status === 410) {
			throw new NonRetryableError(`Fetched resource returned HTTP ${response.status}`);
		}
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}
	const parsedFinalUrl = URL.parse(response.url);
	if (
		!parsedFinalUrl ||
		(parsedFinalUrl.protocol !== 'http:' && parsedFinalUrl.protocol !== 'https:') ||
		parsedFinalUrl.username ||
		parsedFinalUrl.password
	) {
		await response.body?.cancel();
		throw new Error('Fetch response has no valid final URL');
	}
	const platform = platformUrl(parsedFinalUrl);
	if (platform) {
		await response.body?.cancel();
		return { platform };
	}
	parsedFinalUrl.hostname = parsedFinalUrl.hostname.toLowerCase().replace(/^www\./, '');
	for (const parameter of TRACKING_PARAMS) parsedFinalUrl.searchParams.delete(parameter);
	parsedFinalUrl.searchParams.sort();
	const finalUrl = parsedFinalUrl.toString();

	const contentType = response.headers.get('content-type')?.toLowerCase() || '';
	if (contentType.includes(PDF_MIME) || new URL(finalUrl).pathname.toLowerCase().endsWith('.pdf')) {
		const acquired = await acquireFetchedPdfResponse(response, finalUrl);
		return { ...acquired, material: { ...acquired.material, canonicalUrl: finalUrl } };
	}
	if (
		contentType &&
		!contentType.includes('text/html') &&
		!contentType.includes('text/xml') &&
		!contentType.includes('application/xhtml') &&
		!contentType.includes('application/xml')
	) {
		await response.body?.cancel();
		throw new NonRetryableError(`Unsupported response content type: ${contentType}`);
	}

	let htmlBytes = 0;
	const body = response.body?.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				htmlBytes += chunk.byteLength;
				if (htmlBytes > GENERIC_HTML_MAX_BYTES) {
					throw new NonRetryableError(`HTML response exceeded ${GENERIC_HTML_MAX_BYTES} bytes`);
				}
				controller.enqueue(chunk);
			},
		}),
	);
	const html = await new Response(body).text();
	return { ...(await acquireHtmlArticle(env, html, finalUrl, processingId)), canonicalUrl: finalUrl };
}

export async function stageWebAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: { paidPdfFallback: PaidPdfFallbackGrant | null; processingId: string; url: string },
	platformUrl: (url: URL) => PlatformResourceUrl | null,
) {
	const result = await step.do(
		'acquire-web-v3',
		{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		async () => {
			const acquired = await acquireWebResource(input.url, env, platformUrl, input.processingId);
			return 'platform' in acquired ? acquired : Response.json(acquired).body!;
		},
	);
	if ('platform' in result) return result;
	const acquired = await new Response(result).json<GenericAcquiredMaterial | PdfAcquisitionDraft>();
	return isPdfAcquisitionDraft(acquired)
		? completeFetchedPdfAcquisition(env, step, {
				acquisition: acquired,
				grant: input.paidPdfFallback,
				processingId: input.processingId,
				sourceUrl: acquired.material.canonicalUrl ?? input.url,
			})
		: acquired;
}
