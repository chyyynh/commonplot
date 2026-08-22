import type { ResourceForProcessing } from '@core-shared/types';
import { initSync, LiteParse } from '@llamaindex/liteparse-wasm';
import wasmModule from '@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm';
import type { AcquiredWebContent } from '../web-acquisition';

export const PDF_MIME = 'application/pdf';

export type PdfTextArtifact = {
	chars: number;
	pages: number;
	status: 'ok' | 'needs_ocr';
	text: string;
};

const MIN_PDF_CHARS = 40;
const MIN_PDF_CHARS_PER_PAGE = 20;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

function extractedTextChars(markdown: string): number {
	const content = markdown.replace(/^```[^\n]*$/gm, '').replace(/^[-_*]{3,}$/gm, '');
	return content.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

export async function parsePdfBytes(bytes: Uint8Array): Promise<PdfTextArtifact> {
	initSync({ module: wasmModule });
	const parser = new LiteParse({ ocrEnabled: false, outputFormat: 'markdown', imageMode: 'off' });
	const raw = (await parser.parse(bytes)) as { text?: unknown; pages?: unknown };
	if (typeof raw.text !== 'string') throw new Error('LiteParse response is missing text');
	if (!Array.isArray(raw.pages) || raw.pages.length === 0) throw new Error('LiteParse response is missing pages');
	const text = raw.text.trim();
	const pages = raw.pages.length;
	const chars = extractedTextChars(text);
	const status = chars < MIN_PDF_CHARS || chars / pages < MIN_PDF_CHARS_PER_PAGE ? 'needs_ocr' : 'ok';
	return { text, pages, chars, status };
}

export async function acquireStoredPdf(
	env: CoreEnv,
	resource: Pick<
		ResourceForProcessing,
		| 'creators'
		| 'file_type'
		| 'kind_metadata'
		| 'original_lang'
		| 'processing_id'
		| 'published_date'
		| 'source'
		| 'storage_key'
		| 'summary'
		| 'title'
	>,
): Promise<AcquiredWebContent> {
	if (resource.file_type !== PDF_MIME || !resource.storage_key) {
		throw new Error(`Stored resource ${resource.processing_id} is not an R2 PDF`);
	}
	const source = resource.source?.trim();
	if (!source) throw new Error(`Stored PDF ${resource.processing_id} has no source`);
	const obj = await env.R2.get(resource.storage_key);
	if (!obj) throw new Error(`PDF source object missing: ${resource.storage_key}`);
	if (obj.size > MAX_PDF_BYTES) throw new Error(`PDF source object exceeded ${MAX_PDF_BYTES} bytes`);
	const parsed = await parsePdfBytes(new Uint8Array(await obj.arrayBuffer()));
	return {
		provider: null,
		fileType: PDF_MIME,
		title: resource.title,
		markdown: parsed.text,
		source,
		originalLang: resource.original_lang,
		publishedDate: resource.published_date,
		summary: resource.summary,
		creators: resource.creators,
		kindMetadata: resource.kind_metadata,
		extraction: { status: parsed.status, pages: parsed.pages },
	};
}
