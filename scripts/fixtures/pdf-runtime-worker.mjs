import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { NonRetryableError } from 'cloudflare:workflows';
import { planMarkdownTranslation, compileMarkdownTranslationArtifact } from '../../src/ingest/markdown-translation.ts';
import {
	parsePublicPdfResponse,
	parseStoredPdfRepresentation,
	structuredPdfCropManifestKey,
	publishPublicPdfCrops,
	readStructuredPdfArtifact,
	structuredPdfStorageKey,
	ensureStructuredPdfSourceCrops,
} from '../../src/ingest/zotero-sdt-service.ts';
import { normalizeStructuredPdf, structuredPdfVisualPlan } from '../../src/ingest/zotero-sdt.ts';

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
const crops = structuredPdfVisualPlan(document).crops;

export default {
	async fetch(request, bindings) {
		const phase = new URL(request.url).pathname.slice(1);
		if (!['partial', 'recover', 'warm', 'public', 'guards'].includes(phase)) return new Response('Unknown fixture phase', { status: 404 });
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

		if (phase === 'guards') {
			const errors = {};
			const retryable = {};
			const rejected = async (name, run) => {
				try {
					await run();
				} catch (error) {
					errors[name] = error.message;
					retryable[name] = !(error instanceof NonRetryableError);
				}
			};
			const publicSource = await env.R2.head(publicKey);
			const publicManifestKey = structuredPdfCropManifestKey(publicKey, inputContentHash);
			const publicManifest = await (await env.R2.get(publicManifestKey)).json();
			const publicMarkdown = normalizeStructuredPdf(document, {
				cropUrlPrefix: `/api/media/asset/public-pdf-crops/${sourceHash}/${inputContentHash}`,
			}).markdown;
			await env.R2.put(publicKey, pdf, { customMetadata: { ...publicSource.customMetadata, scope: 'private' } });
			await rejected('privatePublication', () => publishPublicPdfCrops(env, 'paper', publicMarkdown));
			await env.R2.put(publicKey, pdf, { customMetadata: publicSource.customMetadata });
			await env.R2.put(publicManifestKey, JSON.stringify({ ...publicManifest, state: 'partial' }));
			await rejected('partialPublication', () => publishPublicPdfCrops(env, 'paper', publicMarkdown));
			const unpublished = !(await env.R2.head(`public-pdf/${sourceHash}/${inputContentHash}/publication.json`));
			await env.R2.put(publicManifestKey, JSON.stringify(publicManifest));
			await publishPublicPdfCrops(env, 'paper', publicMarkdown);
			const publication = await (await env.R2.get(`public-pdf/${sourceHash}/${inputContentHash}/publication.json`)).json();
			const mismatchedCache = await readStructuredPdfArtifact(env, privateKey, 'b'.repeat(64));
			const artifact = await env.R2.head(structuredPdfStorageKey(privateKey));
			await env.R2.put(structuredPdfStorageKey(privateKey), '{broken', { customMetadata: artifact.customMetadata });
			const corruptCache = await readStructuredPdfArtifact(env, privateKey, inputContentHash);
			for (const variant of ['malformed', 'deleted', 'permanent']) {
				const key = `users/${variant}/source.pdf`;
				await env.R2.put(key, pdf);
				const guarded = {
					...env,
					ZOTERO_SDT: {
						getByName: () => ({
							renderPdfAreas: async (stream, _size, requested) => {
								await new Response(stream).arrayBuffer();
								if (variant === 'deleted') await env.R2.delete((await env.R2.list({ prefix: key })).objects.map(({ key }) => key));
								return new Response(
									(variant === 'malformed'
										? [{ id: '../../unrelated', pngBase64: png.toString('base64') }]
										: requested.map(({ id }) =>
												variant === 'permanent'
													? { id, error: 'Invalid PDF page', retryable: false }
													: { id, pngBase64: png.toString('base64') },
											)
									)
										.map((row) => JSON.stringify(row))
										.join('\n'),
								);
							},
						}),
					},
				};
				await rejected(variant, () =>
					ensureStructuredPdfSourceCrops(guarded, {
						pdfStorageKey: key,
						inputContentHash,
						sourceLabel: 'Guard fixture',
						crops,
						resourceId: 'fixture',
					}),
				);
			}
			return Response.json({
				errors,
				retryable,
				unpublished,
				publication,
				mismatchedCache,
				corruptCache,
				deletedObjects: (await env.R2.list({ prefix: 'users/deleted/' })).objects.length,
				unrelated: !!(await env.R2.head('../../unrelated')),
			});
		}
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
						Object.entries(segment.template.texts).map(([id, text]) => [
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
