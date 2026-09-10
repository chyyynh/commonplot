import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { DocumentWorkerClient, createDocumentServer } = require('../containers/zotero-sdt/server.cjs');
const pdf = Buffer.from('%PDF-fixture');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');

class ControlledWorker extends EventEmitter {
	requests = [];
	postMessage(message) {
		this.requests.push(message);
	}
	finish(index, data) {
		this.emit('message', { responseID: this.requests[index].id, data });
	}
}

// A waiting request may expire, but the active PDF must still finish normally.
{
	const worker = new ControlledWorker();
	let fatalCount = 0;
	const client = new DocumentWorkerClient({
		worker,
		maxPendingRequests: 1,
		queueTimeoutMs: 20,
		requestTimeoutMs: 1000,
		onFatal: () => fatalCount++,
	});
	worker.emit('message', { ready: true });
	const active = client.request('parse', pdf, {});
	const expired = client.request('render', pdf, {});
	await assert.rejects(client.request('overflow', pdf, {}), { statusCode: 503 });
	await assert.rejects(expired, { statusCode: 503 });
	worker.finish(0, { value: 'active completed' });
	assert.deepEqual(await active, { value: 'active completed' });
	const next = client.request('later', pdf, {});
	worker.finish(1, { value: 'still usable' });
	assert.deepEqual(await next, { value: 'still usable' });
	assert.equal(fatalCount, 0);
	assert.deepEqual(
		worker.requests.map(({ action }) => action),
		['parse', 'later'],
	);
}

// The execution watchdog starts after admission, not when joining the queue.
{
	const worker = new ControlledWorker();
	const client = new DocumentWorkerClient({
		worker,
		queueTimeoutMs: 1000,
		requestTimeoutMs: 160,
		onFatal: () => assert.fail('Unexpected worker crash'),
	});
	worker.emit('message', { ready: true });
	const first = client.request('first', pdf, {});
	const second = client.request('second', pdf, {});
	await delay(95);
	worker.finish(0, 'one');
	assert.equal(await first, 'one');
	await delay(95);
	worker.finish(1, 'two');
	assert.equal(await second, 'two');
}

const seen = [];
const client = {
	async request(action, buffer, data) {
		seen.push({ action, buffer, data });
		if (action === 'getStructuredDocumentText') throw Object.assign(new Error('Worker busy.'), { statusCode: 503 });
		if (data.pageIndex === 1) throw Object.assign(new Error('Invalid PDF page.'), { statusCode: 422 });
		if (data.pageIndex === 2) throw new Error('Transient renderer failure.');
		if (data.pageIndex === 3) return { buf: Buffer.alloc(8 * 1024 * 1024 + 1) };
		return { buf: png };
	},
};
const server = createDocumentServer(client, () => assert.fail('Batch must not reparse the PDF'));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const crop = (id, pageIndex = 0) => ({ id, pageIndex, rect: [0, 0, 100, 100] });
async function batch(crops) {
	return fetch(`${origin}/render-areas`, {
		method: 'POST',
		headers: { 'content-type': 'application/pdf', 'x-pdf-crops': JSON.stringify(crops) },
		body: pdf,
	});
}
try {
	const response = await batch([crop('first.a-0123'), crop('invalid', 1), crop('retry', 2), crop('oversize', 3), crop('last')]);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
	const rows = (await response.text()).trim().split('\n').map(JSON.parse);
	assert.deepEqual(
		rows.map(({ id }) => id),
		['first.a-0123', 'invalid', 'retry', 'oversize', 'last'],
	);
	assert.deepEqual(Buffer.from(rows[0].pngBase64, 'base64'), png);
	assert.equal(rows[1].retryable, false);
	assert.equal(rows[2].retryable, true);
	assert.equal(rows[3].retryable, false);
	assert.deepEqual(Buffer.from(rows[4].pngBase64, 'base64'), png);
	assert.ok(seen.every(({ buffer }) => buffer === seen[0].buffer));
	assert.deepEqual(seen[0].buffer, pdf);
	assert.equal(seen[0].data.scale, 3);
	const large = await batch([{ ...crop('large'), rect: [0, 0, 100_000, 100_000] }]);
	assert.equal(large.status, 200);
	await large.text();
	assert.ok(seen.at(-1).data.scale * 100_000 <= 8192);
	assert.ok((seen.at(-1).data.scale * 100_000) ** 2 <= 16 * 1024 * 1024);
	for (const invalid of [
		[],
		[crop('duplicate'), crop('duplicate')],
		Array.from({ length: 9 }, (_, index) => crop(`crop-${index}`)),
		[crop('../path')],
	]) {
		const rejected = await batch(invalid);
		assert.equal(rejected.status, 400);
		await rejected.text();
	}
	const busy = await fetch(`${origin}/parse`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: pdf });
	assert.equal(busy.status, 503);
	assert.equal(busy.headers.get('retry-after'), '10');
	await busy.text();
	assert.equal(seen.filter(({ action }) => action === 'pdf.getFulltext').length, 0);
	const legacy = await fetch(`${origin}/render-area?pageIndex=0&rect=0,0,100,100`, {
		method: 'POST',
		headers: { 'content-type': 'application/pdf' },
		body: pdf,
	});
	assert.equal(legacy.status, 200);
	assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), png);
} finally {
	await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

console.info('Zotero container queue isolation and batch rendering checks passed.');
