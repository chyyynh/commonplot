import assert from 'node:assert/strict';
import { normalizeLiteParseDocument, serializeParsedDocument } from '../src/ingest/platforms/parsed-document.ts';
import { sanitizePdfText } from '../src/ingest/platforms/pdf-text-quality.ts';

const strayControl = sanitizePdfText('Revenue\u0001 increased by 12%.');
assert.equal(strayControl.text, 'Revenue increased by 12%.');
assert.equal(strayControl.strippedControlCharacters, 1);
assert.equal(strayControl.isGarbled, false, 'one stray control character is stripped without rejecting good text');

const binaryGarbage = sanitizePdfText('\u0001\u0002g~|{u>Ty`5Pt;cQkZ;xJ#E$ntZ:U4/F62Z'.repeat(40));
assert.equal(binaryGarbage.isGarbled, true);
assert.deepEqual(binaryGarbage.reasons, ['unsafe-character-density']);

const printableGarbage = sanitizePdfText('!@#$%^&*()[]{}<>?/\\|=+-_ABCDEFG1234567890'.repeat(12));
assert.equal(printableGarbage.isGarbled, true);
assert.deepEqual(printableGarbage.reasons, ['symbol-density']);

const mathHeavyText = sanitizePdfText('The loss is $L = \\sum_i (y_i - \\hat{y}_i)^2$ and converges for 0 < alpha <= 1. '.repeat(20));
assert.equal(mathHeavyText.isGarbled, false, 'ordinary math-heavy prose must not trip the binary-output guard');

function quality(pageNumber, overrides = {}) {
	return {
		pageNumber,
		textLength: 120,
		textCoverage: 0.25,
		hasSubstantialImages: false,
		imageBlockCount: 0,
		imageCoverage: 0,
		largestImageCoverage: 0,
		fullPageImage: false,
		uncoveredVectorArea: 0,
		isGarbled: false,
		pageArea: 484704,
		needsOcr: false,
		reasons: [],
		...overrides,
	};
}

const liteParseResult = {
	totalPages: 4,
	pages: [
		{
			pageNum: 1,
			width: 612,
			height: 792,
			text: 'Study results  Model Accuracy A 95%',
			markdown: '# Study results\n\n| Model | Accuracy |\n| --- | --- |\n| A | 95% |',
			blocks: [
				{
					kind: 'heading',
					text: 'Study results',
					level: 1,
					bbox: { x: 72, y: 64, width: 180, height: 24 },
				},
				{
					kind: 'table',
					bold: false,
					italic: false,
					bbox: { x: 72, y: 120, width: 300, height: 72 },
					header: [
						{ text: 'Model', bbox: { x: 72, y: 120, width: 150, height: 24 } },
						{ text: 'Accuracy', bbox: { x: 222, y: 120, width: 150, height: 24 } },
					],
					rows: [
						[
							{ text: 'A', bbox: { x: 72, y: 144, width: 150, height: 24 } },
							{ text: '95%', bbox: { x: 222, y: 144, width: 150, height: 24 } },
						],
					],
				},
				{
					kind: 'equation',
					text: 'E = mc²',
					bbox: { x: 72, y: 220, width: 90, height: 18 },
				},
			],
			complexity: quality(1, {
				layout: {
					columnCount: 1,
					ruledTableCount: 1,
					ruledTableCoverage: 0.1,
					textTableRunCount: 0,
					figureCount: 0,
					figureCoverage: 0,
					isComplex: true,
					reasons: ['ruled-table'],
				},
			}),
		},
		{
			pageNum: 2,
			width: 612,
			height: 792,
			text: '����',
			markdown: '����',
			blocks: [{ kind: 'grid_fallback', lines: ['����'] }],
			complexity: quality(2, {
				textLength: 4,
				textCoverage: 0,
				fullPageImage: true,
				isGarbled: true,
				needsOcr: true,
				reasons: ['scanned', 'no-text', 'scanned'],
			}),
		},
	],
	pageErrors: [{ pageNum: 3, message: 'Malformed page content' }],
};

const document = normalizeLiteParseDocument(liteParseResult, '2.13.1');
assert.deepEqual(document.parser, {
	name: 'liteparse',
	version: '2.13.1',
	policyRevision: 'liteparse-blocks-v2',
});
assert.deepEqual(document.coordinateSystem, { origin: 'top-left', unit: 'pdf-point', pointsPerInch: 72 });
assert.deepEqual(
	document.pages[0].blocks.map((block) => ({ id: block.id, sourceKind: block.sourceKind, type: block.type })),
	[
		{ id: 'p1-b1', sourceKind: 'heading', type: 'heading' },
		{ id: 'p1-b2', sourceKind: 'table', type: 'table' },
		{ id: 'p1-b3', sourceKind: 'equation', type: 'equation' },
	],
);
assert.deepEqual(document.pages[0].blocks[1].table.header[1], {
	text: 'Accuracy',
	bbox: { x: 222, y: 120, width: 150, height: 24 },
});
assert.equal(document.pages[0].blocks[2].text, 'E = mc²');
assert.equal(document.pages[0].blocks[2].style.bold, false, 'omitted false style flags normalize explicitly');
assert.deepEqual(document.pages[1].blocks[0].table.fallbackLines, ['']);
assert.equal(document.pages[1].text, '');
assert.equal(document.pages[1].markdown, '');
assert.deepEqual(document.pages[1].quality.sanitation, {
	checkedCharacters: 8,
	strippedControlCharacters: 0,
	strippedReplacementCharacters: 8,
	unsafeRatio: 1,
	symbolRatio: 0,
	longestNonWhitespaceRun: 0,
	isGarbled: true,
	reasons: ['unsafe-character-density'],
});
assert.deepEqual(document.pages[1].quality.reasons, ['binary-garbage', 'no-text', 'scanned']);
assert.deepEqual(document.quality, {
	complete: false,
	usablePages: 1,
	needsOcrPages: [2],
	garbledPages: [2],
	complexLayoutPages: [1],
	failedPages: [3],
	unparsedPages: 1,
	problemPages: [1, 2, 3, 4],
});
assert.equal(document.markdown, liteParseResult.pages[0].markdown);

const serialized = serializeParsedDocument(document);
assert.equal(serialized, serializeParsedDocument(document), 'serialization is deterministic');
assert.deepEqual(JSON.parse(serialized), document, 'artifact is plain JSON without runtime-only values');

function artifactHasUnsafeText(value) {
	if (typeof value === 'string') return sanitizePdfText(value).text !== value;
	if (Array.isArray(value)) return value.some(artifactHasUnsafeText);
	return value !== null && typeof value === 'object' && Object.values(value).some(artifactHasUnsafeText);
}

assert.equal(artifactHasUnsafeText(document), false, 'unsafe parser text never reaches the artifact');

const failedDocument = normalizeLiteParseDocument({ ...liteParseResult, totalPages: 3 }, '2.13.1');
assert.equal(failedDocument.quality.unparsedPages, 0);
assert.equal(failedDocument.quality.complete, false, 'a covered but failed page does not make the artifact complete');

assert.throws(
	() => normalizeLiteParseDocument({ ...liteParseResult, pages: [...liteParseResult.pages].reverse() }, '2.13.1'),
	/strictly increasing source-page order/,
);
assert.throws(
	() => normalizeLiteParseDocument({ ...liteParseResult, pages: [{ ...liteParseResult.pages[0], blocks: undefined }] }, '2.13.1'),
	/pages\[0\]\.blocks must be an array/,
);
assert.throws(() => normalizeLiteParseDocument(liteParseResult, '../latest'), /safe artifact revision/);

console.info({
	event: 'pdf_artifact_contract_passed',
	blocks: document.pages.reduce((count, page) => count + page.blocks.length, 0),
	pages: document.parsedPages,
	problemPages: document.quality.problemPages.length,
	serializedBytes: new TextEncoder().encode(serialized).byteLength,
});
