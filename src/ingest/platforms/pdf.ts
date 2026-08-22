import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { readBytesWithLimit } from '@core-shared/http';
import type { ResourceCreator, ResourceKindMetadata } from '@core-shared/resource-metadata';
import type { AcquiredMaterial, AcquiredResource } from '@core-shared/types';
import { initSync, LiteParse } from '@llamaindex/liteparse-wasm';
import wasmModule from '@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm';

export const PDF_MIME = 'application/pdf';

const MIN_PDF_CHARS = 40;
const MIN_PDF_CHARS_PER_PAGE = 20;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

export type StoredPdfAcquisitionInput = {
	creators: ResourceCreator[];
	fileType: string;
	kindMetadata: ResourceKindMetadata | null;
	originalLang: string;
	publishedDate: string | null;
	resourceId: string;
	source: string;
	storageKey: string;
	summary: string | null;
	title: string;
};

function extractedTextChars(markdown: string): number {
	const content = markdown.replace(/^```[^\n]*$/gm, '').replace(/^[-_*]{3,}$/gm, '');
	return content.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

async function parsePdfBytes(bytes: Uint8Array, source: string): Promise<string> {
	initSync({ module: wasmModule });
	const parser = new LiteParse({ ocrEnabled: false, outputFormat: 'markdown', imageMode: 'off' });
	const raw = (await parser.parse(bytes)) as { text?: unknown; pages?: unknown };
	if (typeof raw.text !== 'string') throw new Error('LiteParse response is missing text');
	if (!Array.isArray(raw.pages) || raw.pages.length === 0) throw new Error('LiteParse response is missing pages');
	const text = raw.text.trim();
	const pages = raw.pages.length;
	const chars = extractedTextChars(text);
	if (chars < MIN_PDF_CHARS || chars / pages < MIN_PDF_CHARS_PER_PAGE) throw new NonRetryableError(`${source} requires OCR`);
	return text;
}

async function acquireStoredPdf(env: CoreEnv, resource: StoredPdfAcquisitionInput): Promise<AcquiredMaterial<null>> {
	if (resource.fileType !== PDF_MIME) {
		throw new Error(`Stored resource ${resource.resourceId} is not an R2 PDF`);
	}
	const obj = await env.R2.get(resource.storageKey);
	if (!obj) throw new Error(`PDF source object missing: ${resource.storageKey}`);
	if (obj.size > MAX_PDF_BYTES) throw new Error(`PDF source object exceeded ${MAX_PDF_BYTES} bytes`);
	const markdown = await parsePdfBytes(new Uint8Array(await obj.arrayBuffer()), `Stored PDF ${resource.resourceId}`);
	return {
		resourcePlatform: null,
		fileType: PDF_MIME,
		title: resource.title,
		markdown,
		source: resource.source,
		originalLang: resource.originalLang,
		publishedDate: resource.publishedDate,
		summary: resource.summary,
		creators: resource.creators,
		kindMetadata: resource.kindMetadata,
	};
}

export async function acquireFetchedPdfResponse(response: Response, finalUrl: string): Promise<AcquiredMaterial<null>> {
	const markdown = await parsePdfBytes(await readBytesWithLimit(response, MAX_PDF_BYTES), `PDF ${finalUrl}`);
	const encodedName = new URL(finalUrl).pathname.split('/').filter(Boolean).at(-1) ?? '';
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
	const source = new URL(finalUrl).hostname.replace(/^www\./, '');
	return {
		resourcePlatform: null,
		fileType: PDF_MIME,
		title,
		markdown,
		source,
		originalLang: null,
		publishedDate: null,
		summary: markdown.slice(0, 500) || null,
		creators: [],
		kindMetadata: { siteName: source },
	};
}

export async function stageStoredPdfAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	resource: StoredPdfAcquisitionInput,
): Promise<Extract<AcquiredResource, { resourcePlatform: null }>> {
	const contentStream = await step.do(
		'acquire-stored-pdf-v2',
		{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		async () => Response.json(await acquireStoredPdf(env, resource)).body!,
	);
	return { ...(await new Response(contentStream).json<AcquiredMaterial<null>>()), specialization: null };
}
