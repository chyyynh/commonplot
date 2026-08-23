const baseUrl = process.argv[2];
if (!baseUrl) throw new Error('Usage: node benchmarks/pdf-parser/reject.mjs BASE_URL');

const MEBIBYTE = 1024 * 1024;
const overCapBytes = new Uint8Array(50 * MEBIBYTE + 1);
overCapBytes.set([0x25, 0x50, 0x44, 0x46, 0x2d]);

async function expectRejection(name, bytes, expectedStatus, expectedError) {
	const startedAt = performance.now();
	const response = await fetch(new URL('/benchmark?mode=whole', baseUrl), {
		method: 'POST',
		headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.byteLength) },
		body: bytes,
	});
	const body = await response.json();
	if (response.status !== expectedStatus || body.error !== expectedError) {
		throw new Error(`${name} returned ${response.status} ${JSON.stringify(body)}`);
	}
	return {
		name,
		inputBytes: bytes.byteLength,
		status: response.status,
		error: body.error,
		clientWallMs: Math.round(performance.now() - startedAt),
	};
}

const results = [];
results.push(await expectRejection('over-cap', overCapBytes, 413, `PDF exceeds ${25 * MEBIBYTE} bytes`));
results.push(
	await expectRejection(
		'invalid-signature',
		new TextEncoder().encode('not a PDF'),
		400,
		'Request body does not begin with a PDF signature',
	),
);

console.info(JSON.stringify({ event: 'pdf_worker_rejection_contract_passed', results }, null, 2));
