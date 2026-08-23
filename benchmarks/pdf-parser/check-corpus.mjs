import { readFile } from 'node:fs/promises';

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const corpus = JSON.parse(await readFile(new URL('./corpus.json', import.meta.url), 'utf8'));

if (corpus.schemaVersion !== 1 || !Array.isArray(corpus.cases) || corpus.cases.length === 0) {
	throw new Error('PDF benchmark corpus must be a non-empty schema v1 manifest');
}

const ids = new Set();
const profiles = new Set();
for (const entry of corpus.cases) {
	if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) throw new Error(`Invalid or duplicate corpus id: ${entry.id}`);
	ids.add(entry.id);
	if (new URL(entry.sourceUrl).protocol !== 'https:') throw new Error(`${entry.id} must use an HTTPS source URL`);
	if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`${entry.id} must have a lowercase SHA-256 hash`);
	if (!Number.isSafeInteger(entry.inputBytes) || entry.inputBytes < 1 || entry.inputBytes > MAX_PDF_BYTES) {
		throw new Error(`${entry.id} bytes must be within the production PDF cap`);
	}
	if (!Number.isSafeInteger(entry.pages) || entry.pages < 1) throw new Error(`${entry.id} must have a positive page count`);
	if (!Array.isArray(entry.profile) || entry.profile.length === 0 || new Set(entry.profile).size !== entry.profile.length) {
		throw new Error(`${entry.id} must have unique profile labels`);
	}
	for (const profile of entry.profile) profiles.add(profile);
}

for (const required of ['digital', 'multi-column', 'table-heavy', 'scanned', 'near-cap']) {
	if (!profiles.has(required)) throw new Error(`PDF benchmark corpus is missing the ${required} profile`);
}
if (!corpus.cases.some((entry) => entry.inputBytes <= 5 * 1024 * 1024))
	throw new Error('PDF benchmark corpus needs a small input baseline');

const rejection = corpus.syntheticRejections?.find((entry) => entry.id === 'over-cap');
if (
	!rejection ||
	rejection.inputBytes <= MAX_PDF_BYTES ||
	rejection.expectedStatus !== 413 ||
	rejection.expectedError !== `PDF exceeds ${MAX_PDF_BYTES} bytes`
) {
	throw new Error('PDF benchmark corpus must pin the over-cap rejection contract');
}

console.info({ event: 'pdf_benchmark_corpus_contract_passed', cases: corpus.cases.length, profiles: profiles.size });
