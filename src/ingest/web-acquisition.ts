import { NonRetryableError } from 'cloudflare:workflows';
import { fetchWithTimeout, readBytesWithLimit, readTextWithLimit, WEB_FETCH_USER_AGENT } from '@core-shared/http';
import { normalizedResourceImageUrl } from '@core-shared/resource-image-mapping';
import { literalCreator } from '@core-shared/resource-metadata';
import type { AcquiredMaterial, PdfExtractionMetadata } from '@core-shared/types';
import { detectResourceUrl, normalizeUrl, parseExternalHttpUrl } from '@core-shared/url';
import { extractFromHtml } from '@extractus/article-extractor';
import { PDF_MIME, type PdfTextArtifact, parsePdfBytes } from './platforms/pdf';

const GENERIC_FETCH_TIMEOUT_MS = 8_000;
const GENERIC_HTML_MAX_BYTES = 5 * 1024 * 1024;
const GENERIC_PDF_MAX_BYTES = 25 * 1024 * 1024;
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

export type AcquiredWebContent = AcquiredMaterial<null> & {
	extraction?: PdfExtractionMetadata;
};

type PlatformRedirect = { redirectUrl: string };

function urlHost(url: string): string {
	return new URL(url).hostname.replace(/^www\./, '');
}

function pdfExtractionMetadata(pdf: PdfTextArtifact): PdfExtractionMetadata {
	return { status: pdf.status, pages: pdf.pages };
}

function stripLeadingFrontmatter(markdown: string): string {
	return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
}

async function markdownFromDocument(
	env: CoreEnv,
	document: MarkdownDocument,
	context: { feature: string; processingId?: string },
	conversionOptions?: ConversionOptions,
): Promise<string> {
	const result = await env.AI.toMarkdown(document, {
		gateway: {
			id: 'core-ingest',
			collectLog: true,
			retries: { maxAttempts: 1 },
			metadata: {
				feature: context.feature,
				environment: env.AI_GATEWAY_ENVIRONMENT,
				...(context.processingId ? { processing_id: context.processingId } : {}),
			},
		},
		extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
		...(conversionOptions ? { conversionOptions } : {}),
	});
	// Conversion failures are returned in-band rather than thrown.
	if (result.format === 'error') throw new Error(`Workers AI toMarkdown failed: ${result.error}`);
	return stripLeadingFrontmatter(result.data);
}

export function markdownFromHtml(env: CoreEnv, html: string, url: string, processingId?: string): Promise<string> {
	return markdownFromDocument(
		env,
		{
			name: `${urlHost(url)}.html`,
			blob: new Blob([html], { type: 'text/html' }),
		},
		{ feature: 'html-to-markdown', processingId },
		{ html: { hostname: new URL(url).hostname } },
	);
}

export function markdownFromXml(env: CoreEnv, xml: string, processingId?: string): Promise<string> {
	return markdownFromDocument(
		env,
		{ name: 'openalex.grobid.xml', blob: new Blob([xml], { type: 'application/xml' }) },
		{ feature: 'xml-to-markdown', processingId },
	);
}

async function acquirePdfBytes(bytes: Uint8Array, url: string): Promise<AcquiredWebContent> {
	const parsed = await parsePdfBytes(bytes);
	const encodedName = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
	let fileName = encodedName || 'document.pdf';
	if (encodedName) {
		try {
			fileName = decodeURIComponent(encodedName) || 'document.pdf';
		} catch {
			fileName = encodedName;
		}
	}
	const title = fileName.replace(/\.[a-z0-9]+$/i, '').trim();
	if (!title) throw new Error(`File name has no title: ${fileName}`);
	const source = urlHost(url);
	return {
		provider: null,
		fileType: PDF_MIME,
		title,
		markdown: parsed.text,
		source,
		originalLang: null,
		publishedDate: null,
		summary: parsed.text.slice(0, 500) || null,
		creators: [],
		kindMetadata: { siteName: source },
		extraction: pdfExtractionMetadata(parsed),
	};
}

export async function acquireFetchedPdfResponse(response: Response, finalUrl: string): Promise<AcquiredWebContent> {
	const bytes = await readBytesWithLimit(response, GENERIC_PDF_MAX_BYTES);
	return acquirePdfBytes(bytes, finalUrl);
}

async function acquireHtmlArticle(env: CoreEnv, html: string, url: string, processingId?: string): Promise<AcquiredWebContent> {
	const article = await extractHtmlArticle(html, url);
	if (!article) throw new NonRetryableError('No readable article content found');

	const content = await markdownFromHtml(env, article.html, url, processingId);
	if (content.length < MIN_ARTICLE_CONTENT_CHARS) {
		throw new NonRetryableError(`Extracted HTML content is too short (${content.length} chars)`);
	}
	return {
		provider: null,
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

export async function acquireWebResource(url: string, env: CoreEnv, processingId?: string): Promise<AcquiredWebContent | PlatformRedirect> {
	const response = await fetchWithTimeout(
		url,
		{
			headers: {
				'User-Agent': WEB_FETCH_USER_AGENT,
				Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.5',
				'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
			},
		},
		GENERIC_FETCH_TIMEOUT_MS,
	);
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
