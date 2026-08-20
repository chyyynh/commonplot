import { fetchWithTimeout, readBytesWithLimit, readTextWithLimit, WEB_FETCH_USER_AGENT } from '@core-shared/http';
import { normalizedResourceImageUrl } from '@core-shared/resource-image-mapping';
import type { AcquiredMaterial, PdfExtractionMetadata } from '@core-shared/types';
import { extractFromHtml } from '@extractus/article-extractor';
import { type PdfTextArtifact, parsePdfBytes } from './platforms/pdf';

export const PDF_MIME = 'application/pdf';

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
	if (!title) throw new Error(`Extracted article has no title: ${url}`);
	const siteName = article.source?.trim();
	if (!siteName) throw new Error(`Extracted article has no source: ${url}`);

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
	ownedStorageKey?: string;
};

function urlHost(url: string): string {
	return new URL(url).hostname.replace(/^www\./, '');
}

function fileNameFromUrl(url: string): string {
	const encodedName = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
	if (!encodedName) return 'document.pdf';
	try {
		return decodeURIComponent(encodedName) || 'document.pdf';
	} catch {
		return encodedName;
	}
}

function titleFromFileName(fileName: string): string {
	const title = fileName.replace(/\.[a-z0-9]+$/i, '').trim();
	if (!title) throw new Error(`File name has no title: ${fileName}`);
	return title;
}

export function pdfExtractionMetadata(pdf: PdfTextArtifact): PdfExtractionMetadata {
	return { status: pdf.status, pages: pdf.pages };
}

function stripLeadingFrontmatter(markdown: string): string {
	return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
}

async function markdownFromDocument(
	env: CoreEnv,
	document: MarkdownDocument,
	context: { feature: string; resourceId?: string },
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
				...(context.resourceId ? { resource_id: context.resourceId } : {}),
			},
		},
		extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
		...(conversionOptions ? { conversionOptions } : {}),
	});
	// Conversion failures are returned in-band rather than thrown.
	if (result.format === 'error') throw new Error(`Workers AI toMarkdown failed: ${result.error}`);
	return stripLeadingFrontmatter(result.data);
}

export function markdownFromHtml(env: CoreEnv, html: string, url: string, resourceId?: string): Promise<string> {
	return markdownFromDocument(
		env,
		{
			name: `${urlHost(url)}.html`,
			blob: new Blob([html], { type: 'text/html' }),
		},
		{ feature: 'html-to-markdown', resourceId },
		{ html: { hostname: new URL(url).hostname } },
	);
}

export function markdownFromXml(env: CoreEnv, xml: string, resourceId?: string): Promise<string> {
	return markdownFromDocument(
		env,
		{ name: 'openalex.grobid.xml', blob: new Blob([xml], { type: 'application/xml' }) },
		{ feature: 'xml-to-markdown', resourceId },
	);
}

async function acquirePdfBytes(bytes: Uint8Array, url: string, fileName: string, ownedStorageKey?: string): Promise<AcquiredWebContent> {
	const parsed = await parsePdfBytes(bytes);
	const title = titleFromFileName(fileName);
	return {
		provider: null,
		fileType: PDF_MIME,
		title,
		markdown: parsed.text,
		metadata: {
			author: null,
			language: null,
			publishedDate: null,
			siteName: urlHost(url),
			description: parsed.text.slice(0, 500) || null,
		},
		acquisition: {
			data: null,
			representation: { fileName, fileSize: bytes.byteLength },
		},
		extraction: pdfExtractionMetadata(parsed),
		...(ownedStorageKey ? { ownedStorageKey } : {}),
	};
}

export async function acquireFetchedPdfResponse(
	env: CoreEnv,
	resourceId: string | undefined,
	response: Response,
	finalUrl: string,
): Promise<AcquiredWebContent> {
	const bytes = await readBytesWithLimit(response, GENERIC_PDF_MAX_BYTES);
	const persisted = resourceId
		? await env.DOMAIN.persistResourcePdf({
				body: new Blob([new Uint8Array(bytes).buffer], {
					type: PDF_MIME,
				}).stream(),
				contentLength: bytes.byteLength,
				resourceId,
				sourceUrl: finalUrl,
			})
		: null;
	return acquirePdfBytes(bytes, finalUrl, fileNameFromUrl(finalUrl), persisted?.storageKey);
}

async function acquireHtmlArticle(env: CoreEnv, html: string, url: string, resourceId?: string): Promise<AcquiredWebContent> {
	const article = await extractHtmlArticle(html, url);
	if (!article) throw new Error(`No readable article content found: ${url}`);

	const content = await markdownFromHtml(env, article.html, url, resourceId);
	if (content.length < MIN_ARTICLE_CONTENT_CHARS) {
		throw new Error(`Extracted HTML content is too short (${content.length} chars): ${url}`);
	}
	return {
		provider: null,
		fileType: null,
		title: article.title,
		markdown: content,
		metadata: {
			author: article.author,
			language: article.language,
			publishedDate: article.publishedDate,
			siteName: article.siteName,
			description: article.description,
		},
		acquisition: { data: null },
		previewImageUrl: article.previewImageUrl,
	};
}

export async function acquireWebResource(url: string, env: CoreEnv, resourceId?: string): Promise<AcquiredWebContent> {
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
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}
	const finalUrl = response.url.trim();
	if (!finalUrl) {
		await response.body?.cancel();
		throw new Error(`Fetch response has no final URL: ${url}`);
	}

	const contentType = response.headers.get('content-type')?.toLowerCase() || '';
	if (contentType.includes(PDF_MIME) || new URL(finalUrl).pathname.toLowerCase().endsWith('.pdf')) {
		return acquireFetchedPdfResponse(env, resourceId, response, finalUrl);
	}
	if (
		contentType &&
		!contentType.includes('text/html') &&
		!contentType.includes('text/xml') &&
		!contentType.includes('application/xhtml') &&
		!contentType.includes('application/xml')
	) {
		await response.body?.cancel();
		throw new Error(`Unsupported response content type: ${contentType}`);
	}

	const html = await readTextWithLimit(response, GENERIC_HTML_MAX_BYTES);
	return acquireHtmlArticle(env, html, finalUrl, resourceId);
}
