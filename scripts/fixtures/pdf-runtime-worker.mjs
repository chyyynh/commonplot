import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
	planMarkdownTranslation,
	createMarkdownTranslationTemplate,
	compileMarkdownTranslationArtifact,
} from '../../src/ingest/markdown-translation.ts';
import { parsePublicPdfResponse, parseStoredPdfRepresentation, structuredPdfCropManifestKey } from '../../src/ingest/zotero-sdt-service.ts';
import { structuredPdfSourceCrops } from '../../src/ingest/zotero-sdt.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const pdf = Buffer.from('%PDF-1.7\nruntime fixture');
const inputContentHash = createHash('sha256').update(pdf).digest('hex');
const privateKey = 'users/runtime-owner/source.pdf';
const sourceUrl = 'https://example.invalid/runtime-paper.pdf';
const sourceHash = createHash('sha256').update(sourceUrl).digest('hex');
const publicKey = `public-pdf/${sourceHash}/${inputContentHash}/source.pdf`;
const document = {
	schemaVersion: '1.2.0',
	metadata: { processor: { type: 'pdf', version: 14 }, source: { properties: {} } },
	catalog: { outline: [], pages: [{ contentRange: [[0], [4]], textSource: 'born-digital' }] },
	content: [
		{ type: 'paragraph', content: [{ text: 'A document with two graphics.' }] },
		{ type: 'image', content: [], anchor: { pageRects: [[0, 10, 30, 100, 130]] } },
		{ type: 'image', content: [], anchor: { pageRects: [[0, 110, 30, 200, 130]] } },
		{
			type: 'table',
			content: [
				{
					type: 'tablerow',
					content: [
						{
							type: 'tablecell',
							header: true,
							axis: 'column',
							colspan: 2,
							content: [{ type: 'paragraph', content: [{ text: 'Runtime result' }] }],
						},
					],
				},
				{
					type: 'tablerow',
					content: [
						{ type: 'tablecell', content: [{ type: 'paragraph', content: [{ text: 'Evidence' }, { text: '[1]', refs: [[4]] }] }] },
						{ type: 'tablecell', content: [{ type: 'paragraph', content: [{ text: '42' }] }] },
					],
				},
			],
		},
		{ type: 'note', content: [{ type: 'paragraph', content: [{ text: '1 Original evidence.' }] }] },
	],
};
const crops = structuredPdfSourceCrops(document);

export default {
	async fetch(request, bindings) {
		const phase = new URL(request.url).pathname.slice(1);
		if (!['partial', 'recover', 'warm', 'public'].includes(phase)) return new Response('Unknown fixture phase', { status: 404 });
		let parseCalls = 0;
		const batches = [];
		const client = {
			async processPdf(stream, size) {
				if (size !== pdf.length || !Buffer.from(await new Response(stream).arrayBuffer()).equals(pdf))
					throw new Error('Source stream changed');
				parseCalls++;
				return Response.json(document);
			},
			async renderPdfAreas(stream, size, requested) {
				if (size !== pdf.length || !Buffer.from(await new Response(stream).arrayBuffer()).equals(pdf))
					throw new Error('Crop source stream changed');
				batches.push(requested.map(({ id }) => id));
				return new Response(
					requested
						.map(({ id }) =>
							JSON.stringify(
								phase === 'partial' && id === crops[1].id
									? { id, error: 'Transient fixture renderer failure', retryable: true }
									: { id, pngBase64: png.toString('base64') },
							),
						)
						.join('\n'),
				);
			},
		};
		// R2 is the actual workerd binding; only the external parser is deterministic.
		const env = { R2: bindings.R2, ZOTERO_SDT: { getByName: () => client } };
		if (phase === 'partial') await env.R2.put(privateKey, pdf, { httpMetadata: { contentType: 'application/pdf' } });
		let result = null;
		let error = null;
		try {
			result =
				phase === 'public'
					? await parsePublicPdfResponse(env, new Response(pdf), sourceUrl)
					: await parseStoredPdfRepresentation(env, { pdfStorageKey: privateKey, inputContentHash, sourceLabel: 'Runtime fixture' });
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
		const pdfStorageKey = phase === 'public' ? publicKey : privateKey;
		let translated = null;
		if (result) {
			const plan = planMarkdownTranslation(result.markdown);
			const artifact = compileMarkdownTranslationArtifact(
				plan,
				plan.segments.map((segment) => ({
					texts: Object.fromEntries(
						Object.entries(createMarkdownTranslationTemplate(segment).texts).map(([id, text]) => [
							id,
							text.replace('Runtime result', '執行結果').replace('Evidence', '證據'),
						]),
					),
				})),
			);
			await env.R2.put(`${pdfStorageKey}.fixture-translation.md`, artifact.content);
			translated = await (await env.R2.get(`${pdfStorageKey}.fixture-translation.md`)).text();
		}
		const manifest = await env.R2.get(structuredPdfCropManifestKey(pdfStorageKey, inputContentHash));
		const source = await env.R2.head(pdfStorageKey);
		const storedCrops = [];
		for (const crop of crops) {
			const object = await env.R2.get(`${pdfStorageKey}.structured-crops/${inputContentHash}/${crop.id}.png`);
			storedCrops.push({
				id: crop.id,
				ready: !!object,
				validBytes: object ? Buffer.from(await object.arrayBuffer()).equals(png) : false,
				contentType: object?.httpMetadata?.contentType,
			});
		}
		return Response.json({
			phase,
			error,
			result,
			translated,
			parseCalls,
			batches,
			inputContentHash,
			sourceHash,
			pdfStorageKey,
			manifest: manifest ? await manifest.json() : null,
			storedCrops,
			sourceMetadata: source?.customMetadata,
			objectKeys: (await env.R2.list()).objects.map(({ key }) => key),
		});
	},
};
