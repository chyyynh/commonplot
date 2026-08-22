import { initSync, LiteParse } from '@llamaindex/liteparse-wasm';
import wasmModule from '@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm';
import type { StoredPdfInput } from '../stored-resource';
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

export async function acquireStoredPdf(env: CoreEnv, resource: StoredPdfInput): Promise<AcquiredWebContent> {
	if (resource.fileType !== PDF_MIME) {
		throw new Error(`Stored resource ${resource.resourceId} is not an R2 PDF`);
	}
	const obj = await env.R2.get(resource.storageKey);
	if (!obj) throw new Error(`PDF source object missing: ${resource.storageKey}`);
	if (obj.size > MAX_PDF_BYTES) throw new Error(`PDF source object exceeded ${MAX_PDF_BYTES} bytes`);
	const parsed = await parsePdfBytes(new Uint8Array(await obj.arrayBuffer()));
	return {
		provider: null,
		fileType: PDF_MIME,
		title: resource.title,
		markdown: parsed.text,
		source: resource.source,
		originalLang: resource.originalLang,
		publishedDate: resource.publishedDate,
		summary: resource.summary,
		creators: resource.creators,
		kindMetadata: resource.kindMetadata,
		extraction: { status: parsed.status, pages: parsed.pages },
	};
}
