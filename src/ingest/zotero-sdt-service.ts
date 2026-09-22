import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { NonRetryableError } from 'cloudflare:workflows';
import { limitByteStream, readBoundedResponseText } from '../shared/response.ts';
import { MAX_PDF_BYTES } from './platforms/pdf-policy.ts';
import {
	normalizeStructuredPdf,
	parseStructuredPdfDocumentJson,
	type StructuredPdfDocument,
	type StructuredPdfSourceCrop,
	structuredPdfVisualPlan,
	ZOTERO_SDT_ARTIFACT_VERSION,
} from './zotero-sdt.ts';

const MAX_ERROR_BODY_BYTES = 4_096;
const SOURCE_CROP_ARTIFACT_VERSION = 'newsence-zotero-source-crop-v2';
const ZOTERO_SDT_CONTAINER_NAME = 'structured-pdf-v1';
const ZOTERO_SDT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const CROP_BATCH_SIZE = 8;
const MAX_CROP_PNG_BYTES = 8 * 1024 * 1024;
const MAX_CROP_ROW_BYTES = Math.ceil(MAX_CROP_PNG_BYTES / 3) * 4 + 4_096;

function parseStructuredPdfFailure(status: number, body: string): { message: string; totalPages: number | null } {
	let message = `Zotero SDT parse failed with ${status}`;
	let totalPages: number | null = null;
	try {
		const parsed = JSON.parse(body) as { error?: unknown; totalPages?: unknown };
		if (typeof parsed.error === 'string' && parsed.error.trim()) message = `${message}: ${parsed.error.trim()}`;
		if (Number.isInteger(parsed.totalPages) && Number(parsed.totalPages) > 0) totalPages = Number(parsed.totalPages);
	} catch {
		// A malformed internal error response still fails safely without page-count admission.
	}
	return { message, totalPages };
}

function structuredPdfStorageKey(pdfStorageKey: string): string {
	return `${pdfStorageKey}.structured-document.json`;
}

function cropFailure(error: unknown) {
	return {
		reason: (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_BODY_BYTES),
		retryable: !(error instanceof NonRetryableError),
	};
}

/** A source deleted during rendering must not leave newly written orphan derivatives. */
async function putPdfDerivative(
	env: CoreEnv,
	pdfStorageKey: string,
	key: string,
	value: string | Buffer,
	options: R2PutOptions,
): Promise<void> {
	await env.R2.put(key, value, options);
	// Check after the write: if deletion races before it, remove our late object;
	// if deletion starts after this check, its family scan sees our existing object.
	if (!(await env.R2.head(pdfStorageKey))) {
		await env.R2.delete(key);
		throw new NonRetryableError('PDF source was removed during processing');
	}
}

function structuredPdfCropManifestKey(pdfStorageKey: string, inputContentHash: string): string {
	return `${pdfStorageKey}.structured-crops/${inputContentHash}/manifest.json`;
}

/** Keep only one bounded PNG row in memory while the container streams a batch. */
async function* cropResponseRows(response: Response): AsyncGenerator<unknown> {
	if (!response.body) throw new Error('Zotero crop batch response is empty');
	const stream = limitByteStream(response.body, CROP_BATCH_SIZE * MAX_CROP_ROW_BYTES, () => new Error('Zotero crop batch is too large'));
	const reader = stream.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
	let pending = '';
	let finished = false;
	try {
		while (!finished) {
			const { done, value } = await reader.read();
			finished = done;
			pending += decoder.decode(value, { stream: !done });
			for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
				if (newline > MAX_CROP_ROW_BYTES) throw new Error('Zotero crop row is too large');
				const row = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				if (row.trim()) yield JSON.parse(row);
			}
			if (pending.length > MAX_CROP_ROW_BYTES) throw new Error('Zotero crop row is too large');
		}
		if (pending.trim()) yield JSON.parse(pending);
	} finally {
		if (!finished) await reader.cancel('Crop batch consumer stopped').catch(() => undefined);
		reader.releaseLock();
	}
}

function cropPng(row: Record<string, unknown>): Buffer {
	if (typeof row.pngBase64 !== 'string' || !row.pngBase64.length || row.pngBase64.length > MAX_CROP_ROW_BYTES) {
		throw new Error('Zotero crop PNG is missing or too large');
	}
	const png = Buffer.from(row.pngBase64, 'base64');
	if (png.length > MAX_CROP_PNG_BYTES || png.length < 8 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		throw new Error('Zotero crop response is not a bounded PNG');
	}
	return png;
}

/** Materialize Zotero Reading Mode source crops beside the private PDF. */
async function ensureStructuredPdfSourceCrops(
	env: CoreEnv,
	input: Readonly<{
		crops: readonly StructuredPdfSourceCrop[];
		inputContentHash: string;
		pdfStorageKey: string;
		quality: ReturnType<typeof normalizeStructuredPdf>['parse'];
		resourceId: string;
	}>,
): Promise<void> {
	const prefix = `${input.pdfStorageKey}.structured-crops/${input.inputContentHash}/`;
	const plannedIds = new Set(input.crops.map(({ id }) => id));
	if (plannedIds.size !== input.crops.length) throw new Error('Structured PDF crop IDs must be unique');
	const readyCropIds = new Set<string>();
	const failed = new Map<string, ReturnType<typeof cropFailure>>();
	// HEAD only this recipe's keys: old parser revisions cannot exhaust a LIST page.
	for (let offset = 0; offset < input.crops.length; offset += CROP_BATCH_SIZE) {
		await Promise.all(
			input.crops.slice(offset, offset + CROP_BATCH_SIZE).map(async (crop) => {
				const object = await env.R2.head(`${prefix}${crop.id}.png`);
				if (object?.customMetadata?.artifactVersion === SOURCE_CROP_ARTIFACT_VERSION) readyCropIds.add(crop.id);
			}),
		);
	}
	const missing = input.crops.filter(({ id }) => !readyCropIds.has(id));
	for (let offset = 0; offset < missing.length; offset += CROP_BATCH_SIZE) {
		const batch = missing.slice(offset, offset + CROP_BATCH_SIZE);
		try {
			const pdf = await env.R2.get(input.pdfStorageKey);
			if (!pdf) throw new NonRetryableError('PDF source object is missing');
			const response = await env.ZOTERO_SDT.getByName(ZOTERO_SDT_CONTAINER_NAME).renderPdfAreas(pdf.body, pdf.size, batch);
			if (!response.ok) {
				const body = await readBoundedResponseText(response, MAX_ERROR_BODY_BYTES, 'Zotero source crop error');
				const ErrorType = [400, 413, 415, 422].includes(response.status) ? NonRetryableError : Error;
				throw new ErrorType(`Zotero source crop failed with ${response.status}: ${body}`);
			}
			const expected = new Set(batch.map(({ id }) => id));
			for await (const value of cropResponseRows(response)) {
				if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !expected.delete(value.id)) {
					throw new Error('Zotero crop batch returned an unexpected or duplicate ID');
				}
				const row = value as Record<string, unknown>;
				const id = value.id;
				try {
					if (typeof row.error === 'string') {
						const ErrorType = row.retryable === false ? NonRetryableError : Error;
						throw new ErrorType(row.error.slice(0, MAX_ERROR_BODY_BYTES));
					}
					await putPdfDerivative(env, input.pdfStorageKey, `${prefix}${id}.png`, cropPng(row), {
						customMetadata: { artifactVersion: SOURCE_CROP_ARTIFACT_VERSION },
						httpMetadata: { contentType: 'image/png' },
					});
					readyCropIds.add(id);
				} catch (error) {
					failed.set(id, cropFailure(error));
				}
			}
			for (const id of expected) failed.set(id, { reason: 'Zotero crop batch ended before this crop was returned', retryable: true });
		} catch (error) {
			for (const { id } of batch) if (!readyCropIds.has(id)) failed.set(id, cropFailure(error));
		}
	}
	// PNGs are the retry checkpoints; publish one manifest after the complete attempt.
	await putPdfDerivative(
		env,
		input.pdfStorageKey,
		structuredPdfCropManifestKey(input.pdfStorageKey, input.inputContentHash),
		JSON.stringify({
			artifactVersion: SOURCE_CROP_ARTIFACT_VERSION,
			inputSha256: input.inputContentHash,
			pdfStorageKey: input.pdfStorageKey,
			planned: [...plannedIds],
			ready: [...readyCropIds],
			failed: [...failed].map(([id, failure]) => ({ id, ...failure })),
			state: readyCropIds.size === plannedIds.size ? 'complete' : 'partial',
			quality: readyCropIds.size === plannedIds.size ? input.quality : null,
		}),
		{ httpMetadata: { contentType: 'application/json' } },
	);
	console.info({
		tag: 'PDF_PARSE',
		event: 'zotero_source_crops_completed',
		crop_count: input.crops.length,
		ready_count: readyCropIds.size,
		resource_id: input.resourceId,
	});
	if (readyCropIds.size !== plannedIds.size) {
		// Workflow retries reuse the parsed document and all successful immutable
		// crops. A partial batch must never become a successful acquisition checkpoint.
		const retryable = [...failed.values()].some(({ retryable }) => retryable);
		const ErrorType = retryable ? Error : NonRetryableError;
		throw new ErrorType(`Structured PDF crops incomplete: ${readyCropIds.size}/${plannedIds.size}; inspect missing crops in the manifest`);
	}
}

export async function parsePdfArtifactStream(
	env: CoreEnv,
	input: ReadableStream<Uint8Array>,
	byteLength: number | null,
	sourceLabel: string,
) {
	try {
		const response = await env.ZOTERO_SDT.getByName(ZOTERO_SDT_CONTAINER_NAME).processPdf(input, byteLength);
		const maxBytes = response.ok ? ZOTERO_SDT_MAX_RESPONSE_BYTES : MAX_ERROR_BODY_BYTES;
		const body = await readBoundedResponseText(response, maxBytes, 'Zotero SDT response');
		if (!response.ok) {
			const failure = parseStructuredPdfFailure(response.status, body);
			// Only a documented invalid/unreadable PDF is a permanent local parse
			// outcome. Busy, startup, transport and malformed responses remain retryable.
			if (response.status !== 400 && response.status !== 422) throw new Error(failure.message);
			return {
				citations: null,
				markdown: '',
				paperIdentifierText: null,
				parse: {
					fallbackReasons: ['parse-failed'],
					fullPageImagePages: 0,
					parserVersion: ZOTERO_SDT_ARTIFACT_VERSION,
					totalPages: failure.totalPages,
				},
			};
		}
		return parseStructuredPdfDocumentJson(body);
	} catch (error) {
		console.error({
			tag: 'PDF_PARSE',
			event: 'zotero_sdt_failed',
			parser_version: ZOTERO_SDT_ARTIFACT_VERSION,
			source: sourceLabel,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

async function readStructuredPdfArtifact(
	env: CoreEnv,
	pdfStorageKey: string,
	inputContentHash: string,
): Promise<StructuredPdfDocument | null> {
	const object = await env.R2.get(structuredPdfStorageKey(pdfStorageKey));
	if (!object) return null;
	if (object.customMetadata?.artifactVersion !== ZOTERO_SDT_ARTIFACT_VERSION || object.customMetadata?.inputSha256 !== inputContentHash) {
		await object.body.cancel('Structured PDF artifact revision is stale');
		return null;
	}
	if (object.size < 1 || object.size > ZOTERO_SDT_MAX_RESPONSE_BYTES) {
		await object.body.cancel('Structured PDF artifact size is invalid');
		return null;
	}
	const json = await object.text();
	try {
		return parseStructuredPdfDocumentJson(json);
	} catch (error) {
		console.warn({ tag: 'PDF_PARSE', event: 'zotero_sdt_artifact_invalid', error: error instanceof Error ? error.message : String(error) });
		return null;
	}
}

/** One acquisition path for owned uploads and independently fetched public PDFs. */
export async function parseStoredPdfRepresentation(
	env: CoreEnv,
	input: Readonly<{ pdfStorageKey: string; inputContentHash: string; sourceLabel: string; cropUrlPrefix?: string }>,
) {
	let document = await readStructuredPdfArtifact(env, input.pdfStorageKey, input.inputContentHash);
	if (!document) {
		const object = await env.R2.get(input.pdfStorageKey);
		if (!object) throw new NonRetryableError('PDF source object is missing');
		if (object.size < 1 || object.size > MAX_PDF_BYTES) {
			await object.body.cancel('PDF source size is invalid');
			throw new NonRetryableError(`PDF source object must contain 1-${MAX_PDF_BYTES} bytes`);
		}
		const attempt = await parsePdfArtifactStream(env, object.body, object.size, input.sourceLabel);
		if (!('schemaVersion' in attempt)) return attempt;
		document = attempt;
		await putPdfDerivative(env, input.pdfStorageKey, structuredPdfStorageKey(input.pdfStorageKey), JSON.stringify(document), {
			customMetadata: { artifactVersion: ZOTERO_SDT_ARTIFACT_VERSION, inputSha256: input.inputContentHash },
		});
	}
	const visualPlan = structuredPdfVisualPlan(document);
	const crops = visualPlan.crops;
	const cropUrlPrefix = input.cropUrlPrefix ?? '/api/media/asset/pdf-crops';
	const normalized = normalizeStructuredPdf(document, {
		visualPlan,
		cropUrlPrefix: `${cropUrlPrefix}/${input.inputContentHash}`,
	});
	// Stage the complete body once. It becomes readable only after every planned
	// crop is stored and its quality is committed in the same completion manifest.
	await ensureStructuredPdfSourceCrops(env, {
		...input,
		crops,
		quality: normalized.parse,
		resourceId: input.sourceLabel,
	});
	console.info({ tag: 'PDF_PARSE', event: 'zotero_sdt_completed', source: input.sourceLabel, ...normalized.parse });
	return {
		citations: { references: normalized.references },
		markdown: normalized.markdown,
		paperIdentifierText: normalized.paperIdentifierText,
		parse: normalized.parse,
	};
}

/** Public source provenance is kept separate even if its bytes match a private upload. */
export async function parsePublicPdfResponse(env: CoreEnv, response: Response, sourceUrl: string) {
	const source = URL.parse(sourceUrl);
	if (!source || !['https:', 'http:'].includes(source.protocol) || source.username || source.password) {
		await response.body?.cancel('Invalid public PDF source');
		throw new NonRetryableError('Invalid public PDF source URL');
	}
	if (!response.ok || !response.body) {
		await response.body?.cancel('Public PDF response is not usable');
		throw new Error(`Public PDF response is not usable (${response.status})`);
	}
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES) {
		await response.body.cancel('Public PDF is too large');
		throw new NonRetryableError(`PDF exceeded ${MAX_PDF_BYTES} bytes`);
	}
	// Bounded at 25 MiB; release this buffer before parsing the larger SDT response.
	const sourceHash = createHash('sha256').update(source.toString()).digest('hex');
	const stored = await (async () => {
		const bytes = await new Response(
			limitByteStream(response.body!, MAX_PDF_BYTES, () => new NonRetryableError(`PDF exceeded ${MAX_PDF_BYTES} bytes`)),
		).arrayBuffer();
		if (!bytes.byteLength) throw new NonRetryableError('Fetched PDF response body is empty');
		const inputContentHash = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
		const pdfStorageKey = `public-pdf/${sourceHash}/${inputContentHash}/source.pdf`;
		await env.R2.put(pdfStorageKey, bytes, {
			customMetadata: { scope: 'corpus', sourceSha256: sourceHash, inputSha256: inputContentHash },
			httpMetadata: { contentType: 'application/pdf' },
		});
		return { inputContentHash, pdfStorageKey };
	})();
	return parseStoredPdfRepresentation(env, {
		...stored,
		sourceLabel: `Public PDF ${sourceHash}`,
		cropUrlPrefix: `/api/media/asset/public-pdf-crops/${sourceHash}`,
	});
}

const PUBLIC_CROP_PATTERN = /\/api\/media\/asset\/public-pdf-crops\/([a-f\d]{64})\/([a-f\d]{64})\/(\d+(?:\.\d+)*-p\d+-[a-f\d]{16})\.png/gu;
const MAX_MANIFEST_BYTES = 64 * 1024;

/** Publish only persisted references to crops produced from an independent public fetch. */
export async function publishPublicPdfCrops(env: CoreEnv, resourceId: string, content: string): Promise<void> {
	const groups = new Map<string, { sourceHash: string; inputHash: string; cropIds: Set<string> }>();
	for (const [, sourceHash, inputHash, cropId] of content.matchAll(PUBLIC_CROP_PATTERN)) {
		const groupKey = `${sourceHash}/${inputHash}`;
		const group = groups.get(groupKey) ?? { sourceHash: sourceHash!, inputHash: inputHash!, cropIds: new Set<string>() };
		group.cropIds.add(cropId!);
		groups.set(groupKey, group);
	}
	for (const { sourceHash, inputHash, cropIds } of groups.values()) {
		const prefix = `public-pdf/${sourceHash}/${inputHash}`;
		const pdfStorageKey = `${prefix}/source.pdf`;
		const source = await env.R2.head(pdfStorageKey);
		if (
			source?.customMetadata?.scope !== 'corpus' ||
			source.customMetadata.sourceSha256 !== sourceHash ||
			source.customMetadata.inputSha256 !== inputHash
		) {
			throw new Error('Public PDF crop publication has no independent public source');
		}
		const object = await env.R2.get(structuredPdfCropManifestKey(pdfStorageKey, inputHash));
		if (!object) throw new Error('Public PDF crop publication manifest is missing');
		if (object.size > MAX_MANIFEST_BYTES) {
			await object.body.cancel('Invalid public PDF manifest size');
			throw new Error('Public PDF crop publication manifest is too large');
		}
		const manifest: { inputSha256?: unknown; pdfStorageKey?: unknown; ready?: unknown; state?: unknown } = await object.json();
		const ready = manifest.ready;
		if (
			manifest.inputSha256 !== inputHash ||
			manifest.pdfStorageKey !== pdfStorageKey ||
			manifest.state !== 'complete' ||
			!Array.isArray(ready) ||
			[...cropIds].some((id) => !ready.includes(id))
		) {
			throw new Error('Public PDF crop publication includes unready images');
		}
		await env.R2.put(`${prefix}/publication.json`, JSON.stringify({ resourceId, cropIds: [...cropIds] }), {
			httpMetadata: { contentType: 'application/json' },
		});
	}
}
