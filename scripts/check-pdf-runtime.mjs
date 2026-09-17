import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// An isolated config prevents loading project secrets or contacting real bindings.
process.env.WRANGLER_SEND_METRICS = 'false';
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'opennews-pdf-runtime-'));
// Wrangler can flush teardown logs after stop(); keep them outside the config directory we remove.
process.env.WRANGLER_LOG_PATH = join(tmpdir(), `opennews-pdf-runtime-${process.pid}.log`);
const { unstable_dev } = await import('wrangler');
const config = join(temporaryDirectory, 'wrangler.json');
let worker;
try {
	await writeFile(
		config,
		JSON.stringify({
			name: 'opennews-pdf-runtime-fixture',
			compatibility_date: '2026-09-01',
			compatibility_flags: ['nodejs_compat'],
			r2_buckets: [{ binding: 'R2', bucket_name: 'pdf-runtime-fixture', remote: false }],
		}),
	);
	worker = await unstable_dev(fileURLToPath(new URL('./fixtures/pdf-runtime-worker.mjs', import.meta.url)), {
		config,
		local: true,
		port: 0,
		persist: false,
		logLevel: 'error',
		experimental: { disableDevRegistry: true, disableExperimentalWarning: true, watch: false, enableContainers: false },
	});
	async function phase(name) {
		const response = await worker.fetch(`/${name}`, { method: 'POST' });
		assert.equal(response.status, 200, await response.clone().text());
		return response.json();
	}
	const partial = await phase('partial');
	assert.match(partial.error, /crops incomplete: 1\/2/);
	assert.equal(partial.manifest.state, 'partial');
	assert.equal(partial.manifest.ready.length, 1);
	assert.equal(partial.manifest.failed[0].retryable, true);
	assert.equal(partial.storedCrops.filter(({ validBytes }) => validBytes).length, 1);
	assert.equal(partial.manifest.quality, null, 'partial acquisition cannot publish complete quality');

	const recovered = await phase('recover');
	assert.equal(recovered.error, null);
	assert.equal(recovered.parseCalls, 0, 'R2 parser artifact survives between requests');
	assert.deepEqual(recovered.batches, [[partial.manifest.failed[0].id]], 'only missing crop is rerendered');
	assert.equal(recovered.manifest.state, 'complete');
	assert.equal(recovered.result.parse.visual.ready, 2);
	assert.deepEqual(recovered.manifest.quality, recovered.result.parse, 'crop readiness and quality are committed together');
	assert.ok(!recovered.objectKeys.some((key) => key.endsWith('/quality.json')), 'quality needs no separate artifact');
	assert.ok(recovered.storedCrops.every(({ validBytes, contentType }) => validBytes && contentType === 'image/png'));
	assert.match(recovered.result.markdown, /\/api\/media\/asset\/pdf-crops\//);
	assert.match(recovered.result.markdown, /colspan="2"/u);
	assert.match(recovered.translated, /colspan="2"[^>]*>\s+執行結果/u);
	assert.match(recovered.translated, /證據\[\^sdt-note-4\]/u);
	assert.match(recovered.translated, /\[\^sdt-note-4\]: 1 Original evidence\./u);
	assert.equal((await phase('warm')).batches.length, 0);

	const publicResult = await phase('public');
	assert.equal(publicResult.error, null);
	assert.equal(publicResult.parseCalls, 1, 'public acquisition cannot reuse private parser artifacts');
	assert.equal(publicResult.result.parse.visual.ready, 2);
	assert.equal(publicResult.sourceMetadata.scope, 'corpus');
	assert.ok(publicResult.storedCrops.every(({ validBytes }) => validBytes));
	assert.ok(publicResult.result.markdown.includes(`/public-pdf-crops/${publicResult.sourceHash}/${publicResult.inputContentHash}/`));
	assert.doesNotMatch(publicResult.result.markdown, /asset\/pdf-crops\//);
	assert.ok(publicResult.objectKeys.some((key) => key.startsWith('users/runtime-owner/')));
	assert.ok(publicResult.objectKeys.some((key) => key.startsWith('public-pdf/')));
	assert.ok(!publicResult.objectKeys.some((key) => key.endsWith('/publication.json')), 'acquisition does not publish canonical media');

	const guards = await phase('guards');
	assert.match(guards.errors.privatePublication, /no independent public source/);
	assert.match(guards.errors.partialPublication, /unready images/);
	assert.equal(guards.unpublished, true);
	assert.equal(guards.publication.resourceId, 'paper');
	assert.equal(guards.publication.cropIds.length, 2);
	assert.equal(guards.mismatchedCache, null);
	assert.equal(guards.corruptCache, null);
	assert.match(guards.errors.malformed, /crops incomplete/);
	assert.ok(guards.errors.deleted);
	assert.match(guards.errors.permanent, /crops incomplete/);
	assert.equal(guards.retryable.malformed, true);
	assert.equal(guards.retryable.deleted, false);
	assert.equal(guards.retryable.permanent, false);
	assert.equal(guards.deletedObjects, 0, 'Late renderer output cannot recreate a deleted owned source');
	assert.equal(guards.unrelated, false);
	console.info(
		'PDF workerd/R2 runtime passed: partial manifest, cross-request resume, PNG metadata/bytes, warm cache, private/public isolation.',
	);
} finally {
	await worker?.stop();
	await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
