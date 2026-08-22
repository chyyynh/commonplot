import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { readTextWithLimit, WEB_FETCH_USER_AGENT } from '@core-shared/http';
import { normalizedResourceImageUrl } from '@core-shared/image-mapping';
import type { AcquiredMaterial } from '@core-shared/resource';
import { literalCreator } from '@core-shared/resource';
import { detectResourceUrl, normalizeUrl, parseExternalHttpUrl } from '@core-shared/url';
import { extractFromHtml } from '@extractus/article-extractor';
import { markdownFromHtml } from '../document-conversion';
import { acquireFetchedPdfResponse, PDF_MIME } from './pdf';

const GENERIC_FETCH_TIMEOUT_MS = 8_000;
const GENERIC_HTML_MAX_BYTES = 5 * 1024 * 1024;
const MIN_ARTICLE_CONTENT_CHARS = 180;

type ExtractedHtmlArticle = {
	html: string;
	title: string;
	author: string | null;
	language: string | null;
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

	return {
		html: article.content.trim(),
		title,
		author: optionalText(article.author),
		language: null,
		publishedDate: optionalText(article.published),
		siteName,
		description: optionalText(article.description),
		previewImageUrl: normalizedResourceImageUrl(article.image, url),
	};
}

type AcquiredWebContent = AcquiredMaterial<null>;

type PlatformRedirect = { redirectUrl: string };

async function acquireHtmlArticle(env: CoreEnv, html: string, url: string, processingId?: string): Promise<AcquiredWebContent> {
	const article = await extractHtmlArticle(html, url);
	if (!article) throw new NonRetryableError('No readable article content found');

	const content = await markdownFromHtml(env, article.html, url, processingId);
	if (content.length < MIN_ARTICLE_CONTENT_CHARS) {
		throw new NonRetryableError(`Extracted HTML content is too short (${content.length} chars)`);
	}
	return {
		resourcePlatform: null,
		fileType: null,
		title: article.title,
		markdown: content,
		source: article.siteName,
		originalLang: article.language,
		publishedDate: article.publishedDate,
		summary: article.description,
		creators: literalCreator('author', article.author),
		kindMetadata: { siteName: article.siteName },
		previewImageUrl: article.previewImageUrl,
	};
}

async function acquireWebResource(url: string, env: CoreEnv, processingId?: string): Promise<AcquiredWebContent | PlatformRedirect> {
	const response = await fetch(url, {
		headers: {
			'User-Agent': WEB_FETCH_USER_AGENT,
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
	const parsedFinalUrl = parseExternalHttpUrl(response.url);
	if (!parsedFinalUrl) {
		await response.body?.cancel();
		throw new Error('Fetch response has no valid final URL');
	}
	const finalUrl = normalizeUrl(parsedFinalUrl.toString());
	if (detectResourceUrl(finalUrl)) {
		await response.body?.cancel();
		return { redirectUrl: finalUrl };
	}

	const contentType = response.headers.get('content-type')?.toLowerCase() || '';
	if (contentType.includes(PDF_MIME) || new URL(finalUrl).pathname.toLowerCase().endsWith('.pdf')) {
		return { ...(await acquireFetchedPdfResponse(response, finalUrl)), canonicalUrl: finalUrl };
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

	const html = await readTextWithLimit(response, GENERIC_HTML_MAX_BYTES);
	return { ...(await acquireHtmlArticle(env, html, finalUrl, processingId)), canonicalUrl: finalUrl };
}

export async function stageWebAcquisition(env: CoreEnv, step: WorkflowStep, input: { processingId: string; url: string }) {
	const result = await step.do(
		'acquire-web-v1',
		{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		async () => {
			const acquired = await acquireWebResource(input.url, env, input.processingId);
			return 'redirectUrl' in acquired ? acquired : Response.json(acquired).body!;
		},
	);
	return 'redirectUrl' in result ? result : new Response(result).json<AcquiredWebContent>();
}
