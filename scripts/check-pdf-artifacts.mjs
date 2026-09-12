import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	ensureStructuredPdfSourceCrops,
	parsePdfArtifactStream,
	parseStructuredPdfFailure,
	publishPublicPdfCrops,
	parsePublicPdfResponse,
	parseStoredPdfRepresentation,
	PermanentPdfArtifactError,
	readStructuredPdfArtifact,
	structuredPdfCropManifestKey,
	structuredPdfStorageKey,
	writeStructuredPdfArtifact,
} from '../src/ingest/zotero-sdt-service.ts';
import { structuredPdfVisualPlan } from '../src/ingest/zotero-sdt.ts';

assert.equal(structuredPdfStorageKey('users/u/resources/r/source.pdf'), 'users/u/resources/r/source.pdf.structured-document.json');
assert.deepEqual(parseStructuredPdfFailure(422, '{"error":"model failed","totalPages":12}'), {
	message: 'Zotero SDT parse failed with 422: model failed',
	totalPages: 12,
});
assert.deepEqual(parseStructuredPdfFailure(500, 'not-json'), {
	message: 'Zotero SDT parse failed with 500',
	totalPages: null,
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const pdf = Buffer.from('%PDF-1.7\nfixture');
const inputHash = createHash('sha256').update(pdf).digest('hex');
const document = {
	schemaVersion: '1.2.0',
	metadata: { processor: { type: 'pdf', version: 14 }, source: { properties: {} } },
	catalog: { outline: [], pages: [{ contentRange: [[0], [3]], textSource: 'born-digital' }] },
	content: [
		{ type: 'paragraph', content: [{ text: 'A document with two graphics.' }, { text: '[1]', refs: [[3]] }] },
		{ type: 'image', content: [], anchor: { pageRects: [[0, 10, 30, 100, 130]] } },
		{ type: 'image', content: [], anchor: { pageRects: [[0, 110, 30, 200, 130]] } },
		{ type: 'paragraph', reference: true, content: [{ text: '[1] Example. Source evidence. 2024.' }] },
	],
};

class MemoryR2 {
	objects = new Map();
	reads = [];
	failPut = null;
	async put(key, input, options = {}) {
		if (this.failPut?.(key)) throw new Error('Temporary R2 write failure');
		const bytes = Buffer.from(await new Response(input).arrayBuffer());
		this.objects.set(key, { bytes, ...options });
	}
	async head(key) {
		const stored = this.objects.get(key);
		return stored ? { key, size: stored.bytes.length, customMetadata: stored.customMetadata } : null;
	}
	async delete(key) {
		for (const item of Array.isArray(key) ? key : [key]) this.objects.delete(item);
	}
	async get(key) {
		this.reads.push(key);
		const stored = this.objects.get(key);
		return stored
			? {
					key,
					size: stored.bytes.length,
					customMetadata: stored.customMetadata,
					body: new Response(stored.bytes).body,
					text: async () => stored.bytes.toString(),
					json: async () => JSON.parse(stored.bytes.toString()),
				}
			: null;
	}
	json(key) {
		return JSON.parse(this.objects.get(key).bytes.toString());
	}
}

function environment() {
	const R2 = new MemoryR2();
	const batches = [];
	let parseCalls = 0;
	const client = {
		async processPdf(stream) {
			assert.deepEqual(Buffer.from(await new Response(stream).arrayBuffer()), pdf);
			parseCalls++;
			return Response.json(document);
		},
		async renderPdfAreas(stream, byteLength, crops) {
			assert.equal(byteLength, pdf.length);
			assert.deepEqual(Buffer.from(await new Response(stream).arrayBuffer()), pdf);
			batches.push(crops.map(({ id }) => id));
			return new Response(crops.map(({ id }) => JSON.stringify({ id, pngBase64: png.toString('base64') })).join('\n'));
		},
	};
	return { R2, ZOTERO_SDT: { getByName: () => client }, client, batches, parseCalls: () => parseCalls };
}

const key = 'users/owner/source.pdf';
const env = environment();
await env.R2.put(key, pdf);
const input = { pdfStorageKey: key, inputContentHash: inputHash, sourceLabel: 'fixture' };
const crops = structuredPdfVisualPlan(document).crops;
const manifestKey = structuredPdfCropManifestKey(key, inputHash);

// A durable partial failure retries only the missing PNG, retaining both source
// parse and successful crop objects. It cannot complete as a text-only success.
env.R2.failPut = (objectKey) => objectKey.endsWith(`${crops[1].id}.png`);
await assert.rejects(parseStoredPdfRepresentation(env, input), /crops incomplete: 1\/2/);
assert.equal(env.R2.json(manifestKey).state, 'partial');
assert.equal(env.R2.json(manifestKey).quality, null);
assert.deepEqual(env.R2.json(manifestKey).ready, [crops[0].id]);
assert.match(env.R2.json(manifestKey).failed[0].reason, /Temporary R2/);
env.R2.failPut = null;
const recovered = await parseStoredPdfRepresentation(env, input);
assert.equal(env.parseCalls(), 1);
assert.deepEqual(env.batches, [crops.map(({ id }) => id), [crops[1].id]]);
assert.equal(recovered.parse.visual.ready, 2);
assert.equal(recovered.citations.references[0].key, 'sdt-1');
assert.deepEqual(recovered.citations.mentions[0].targetKeys, ['sdt-1']);
assert.equal(env.R2.json(manifestKey).state, 'complete');
assert.deepEqual(env.R2.json(manifestKey).quality, recovered.parse);
assert.match(recovered.markdown, /\/api\/media\/asset\/pdf-crops\//);
await parseStoredPdfRepresentation(env, input);
assert.equal(env.batches.length, 2, 'warm cache must not rerender');

// A geometry update gets an immutable new URL and rerenders only that region.
const changed = structuredClone(document);
changed.content[1].anchor.pageRects[0][3] += 5;
const changedCrops = structuredPdfVisualPlan(changed).crops;
assert.notEqual(changedCrops[0].id, crops[0].id);
await ensureStructuredPdfSourceCrops(env, { ...input, crops: changedCrops, resourceId: 'fixture' });
assert.deepEqual(env.batches.at(-1), [changedCrops[0].id]);
assert.ok(env.R2.objects.has(`${key}.structured-crops/${inputHash}/${crops[0].id}.png`), 'old URLs remain readable');

// The artifact recipe and source hash are both part of cache admission.
const storedArtifact = env.R2.objects.get(structuredPdfStorageKey(key));
storedArtifact.customMetadata.artifactVersion = 'old-parser';
assert.equal(await readStructuredPdfArtifact(env, key, inputHash), null);
await writeStructuredPdfArtifact(env, key, inputHash, document);
assert.equal(await readStructuredPdfArtifact(env, key, 'b'.repeat(64)), null);
env.R2.objects.get(structuredPdfStorageKey(key)).bytes = Buffer.from('{corrupt');
assert.equal(await readStructuredPdfArtifact(env, key, inputHash), null, 'corrupt cached SDT must be reparsed rather than retried forever');
await writeStructuredPdfArtifact(env, key, inputHash, document);

// Identical bytes obtained via a public fetch never reuse/private-publish owned
// crop keys. Both entry points still produce all the same planned graphics.
const sourceUrl = 'https://example.org/paper.pdf';
const sourceHash = createHash('sha256').update(sourceUrl).digest('hex');
const publicResult = await parsePublicPdfResponse(env, new Response(pdf), sourceUrl);
assert.equal(publicResult.parse.visual.ready, 2);
assert.match(publicResult.markdown, new RegExp(`/public-pdf-crops/${sourceHash}/${inputHash}/`));
assert.doesNotMatch(publicResult.markdown, /asset\/pdf-crops\//);
const publicKey = `public-pdf/${sourceHash}/${inputHash}/source.pdf`;
assert.equal(env.R2.objects.get(publicKey).customMetadata.scope, 'corpus');
assert.ok(
	!env.R2.objects.has(`public-pdf/${sourceHash}/${inputHash}/publication.json`),
	'acquisition cannot publish before canonical persistence',
);
assert.deepEqual(publicResult.citations, recovered.citations, 'both acquisition routes return the already-normalized citations');
const publicationKey = `public-pdf/${sourceHash}/${inputHash}/publication.json`;
const publicManifestKey = structuredPdfCropManifestKey(publicKey, inputHash);
const publicManifest = env.R2.json(publicManifestKey);
const publicSourceMetadata = env.R2.objects.get(publicKey).customMetadata;
publicSourceMetadata.scope = 'private';
await assert.rejects(publishPublicPdfCrops(env, 'paper', publicResult.markdown), /no independent public source/);
publicSourceMetadata.scope = 'corpus';
await env.R2.put(publicManifestKey, JSON.stringify({ ...publicManifest, state: 'partial' }));
await assert.rejects(publishPublicPdfCrops(env, 'paper', publicResult.markdown), /unready images/);
assert.ok(!env.R2.objects.has(publicationKey));
await env.R2.put(publicManifestKey, JSON.stringify(publicManifest));
await publishPublicPdfCrops(env, 'paper', publicResult.markdown);
assert.deepEqual(env.R2.json(publicationKey), { resourceId: 'paper', cropIds: crops.map(({ id }) => id) });

// Batches transfer one source body per eight crops, and malformed/omitted output
// cannot fabricate completeness or overwrite an unrelated R2 path.
const batchEnv = environment();
await batchEnv.R2.put(key, pdf);
const many = Array.from({ length: 17 }, (_, index) => ({ ...crops[0], id: `${index}-p0-0123456789abcdef` }));
await ensureStructuredPdfSourceCrops(batchEnv, { ...input, crops: many, resourceId: 'fixture' });
assert.deepEqual(
	batchEnv.batches.map((batch) => batch.length),
	[8, 8, 1],
);
assert.equal(batchEnv.R2.reads.filter((readKey) => readKey === key).length, 3);

for (const rows of [[], [{ id: '../../unrelated', pngBase64: png.toString('base64') }], [{ id: crops[0].id, pngBase64: 'not-png' }]]) {
	const broken = environment();
	await broken.R2.put(key, pdf);
	broken.client.renderPdfAreas = async () => new Response(rows.map((row) => JSON.stringify(row)).join('\n'));
	await assert.rejects(ensureStructuredPdfSourceCrops(broken, { ...input, crops, resourceId: 'fixture' }), /crops incomplete/);
	assert.equal(broken.R2.json(manifestKey).state, 'partial');
}

for (const status of [429, 500, 503]) {
	const failing = environment();
	failing.client.processPdf = async () => Response.json({ error: 'retry me' }, { status });
	await assert.rejects(parsePdfArtifactStream(failing, new Response(pdf).body, pdf.length, 'fixture'), /retry me/);
}
const invalid = environment();
invalid.client.processPdf = async () => Response.json({ error: 'invalid PDF', totalPages: 2 }, { status: 422 });
const invalidResult = await parsePdfArtifactStream(invalid, new Response(pdf).body, pdf.length, 'fixture');
assert.deepEqual(invalidResult.parse.fallbackReasons, ['parse-failed']);
assert.equal(invalidResult.parse.totalPages, 2);
assert.equal(invalidResult.citations, null);

const permanent = environment();
await permanent.R2.put(key, pdf);
permanent.client.renderPdfAreas = async (_stream, _size, requested) =>
	new Response(requested.map(({ id }) => JSON.stringify({ id, error: 'Invalid PDF structure.', retryable: false })).join('\n'));
await assert.rejects(ensureStructuredPdfSourceCrops(permanent, { ...input, crops, resourceId: 'fixture' }), PermanentPdfArtifactError);
assert.equal(permanent.R2.json(manifestKey).failed[0].retryable, false);
await assert.rejects(
	parsePublicPdfResponse(permanent, new Response(pdf, { headers: { 'content-length': String(26 * 1024 * 1024) } }), sourceUrl),
	PermanentPdfArtifactError,
);

// Deletion while a renderer still holds the PDF cannot recreate its crop family.
const deleted = environment();
await deleted.R2.put(key, pdf);
deleted.client.renderPdfAreas = async (_stream, _size, requested) => {
	await deleted.R2.delete([...deleted.R2.objects.keys()]);
	return new Response(requested.map(({ id }) => JSON.stringify({ id, pngBase64: png.toString('base64') })).join('\n'));
};
await assert.rejects(ensureStructuredPdfSourceCrops(deleted, { ...input, crops, resourceId: 'fixture' }), PermanentPdfArtifactError);
assert.equal(deleted.R2.objects.size, 0, 'late PNG and manifest writes must be removed after source deletion');

console.info('PDF artifact contracts passed: recovery, immutable cache, public/private isolation, bounded batches, retryable errors.');
