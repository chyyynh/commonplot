import assert from 'node:assert/strict';
import { sanitizePdfText } from '../src/ingest/platforms/pdf-text-quality.ts';
import {
	normalizeLiteParseWorkingDocument,
	serializePdfWorkingDocument,
	splitPdfMarkdownForTranslation,
} from '../src/ingest/platforms/pdf-working-document.ts';
import { PDF_PARSE_CONTRACT, parsePdfParseAdmission } from '../src/shared/pdf-parse-contract.ts';

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

const document = normalizeLiteParseWorkingDocument(liteParseResult, '2.13.1');
assert.deepEqual(document.parser, {
	name: 'liteparse',
	version: '2.13.1',
	policyRevision: 'liteparse-pages-v3',
});
assert.equal(document.pages[0].source, 'liteparse');
assert.equal(document.pages[0].width, 612);
assert.equal(document.pages[0].height, 792);
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
assert.equal(Object.hasOwn(document.pages[0], 'blocks'), false, 'working pages do not retain block geometry');

const serialized = serializePdfWorkingDocument(document);
assert.equal(serialized, serializePdfWorkingDocument(document), 'serialization is deterministic');
assert.deepEqual(JSON.parse(serialized), document, 'Workflow streamed working state is plain JSON without runtime-only values');

function workingDocumentHasUnsafeText(value) {
	if (typeof value === 'string') return sanitizePdfText(value).text !== value;
	if (Array.isArray(value)) return value.some(workingDocumentHasUnsafeText);
	return value !== null && typeof value === 'object' && Object.values(value).some(workingDocumentHasUnsafeText);
}

assert.equal(workingDocumentHasUnsafeText(document), false, 'unsafe parser text never reaches Workflow working state');

const failedDocument = normalizeLiteParseWorkingDocument({ ...liteParseResult, totalPages: 3 }, '2.13.1');
assert.equal(failedDocument.quality.unparsedPages, 0);
assert.equal(failedDocument.quality.complete, false, 'a covered but failed page does not make the working document complete');

assert.throws(
	() => normalizeLiteParseWorkingDocument({ ...liteParseResult, pages: [...liteParseResult.pages].reverse() }, '2.13.1'),
	/strictly increasing source-page order/,
);
assert.throws(
	() =>
		normalizeLiteParseWorkingDocument({ ...liteParseResult, pages: [{ ...liteParseResult.pages[0], complexity: undefined }] }, '2.13.1'),
	/pages\[0\]\.complexity must be an object/,
);
assert.throws(() => normalizeLiteParseWorkingDocument(liteParseResult, '../latest'), /safe working revision/);

const longMarkdown = ['A'.repeat(60), 'B'.repeat(60), 'C'.repeat(60), 'D'.repeat(60)].join('\n\n');
const translationChunks = splitPdfMarkdownForTranslation(longMarkdown, 64);
assert.deepEqual(translationChunks, ['A'.repeat(60), 'B'.repeat(60), 'C'.repeat(60), 'D'.repeat(60)]);
assert.equal(translationChunks.join('\n\n'), longMarkdown, 'stable Markdown paragraph boundaries preserve the source projection');
assert.deepEqual(translationChunks, splitPdfMarkdownForTranslation(longMarkdown, 64), 'PDF translation chunk boundaries are deterministic');
assert.equal(
	translationChunks.every((chunk) => chunk.length <= 64),
	true,
	'PDF translation chunks respect the per-step character limit when stable boundaries exist',
);
assert.deepEqual(
	splitPdfMarkdownForTranslation('X'.repeat(130), 64).map((chunk) => chunk.length),
	[64, 64, 2],
	'an unbroken PDF Markdown block makes bounded forward progress',
);
assert.throws(() => splitPdfMarkdownForTranslation('content', 15), /at least 16 characters/);

const fileResourceId = '8d2e4a53-23e1-4dab-a26b-6c762f427114';
const liteAdmission = {
	parseRunId: '532dc42f-8920-4022-b467-c64682c60923',
	fileResourceId,
	revision: 1,
	inputContentHash: 'a'.repeat(64),
	workingSchemaVersion: PDF_PARSE_CONTRACT.workingSchemaVersion,
	parserVersion: PDF_PARSE_CONTRACT.parserVersion,
	policyRevision: PDF_PARSE_CONTRACT.litePolicyRevision,
	processingPolicy: 'lite',
	entitlementFeature: null,
	maxEnhancedPages: null,
	maxProviderCredits: null,
	providerTier: null,
	providerVersion: null,
};
assert.deepEqual(parsePdfParseAdmission(liteAdmission), liteAdmission);
assert.throws(
	() => parsePdfParseAdmission({ ...liteAdmission, processingPolicy: 'selective-enhancement' }),
	/Enhanced PDF admission is incomplete/,
);
const closedEnhancedAdmission = {
	...liteAdmission,
	policyRevision: PDF_PARSE_CONTRACT.enhancementPolicyRevision,
	processingPolicy: 'selective-enhancement',
	entitlementFeature: 'enhanced_pdf_parsing',
	maxEnhancedPages: PDF_PARSE_CONTRACT.maxEnhancedPages,
};
assert.deepEqual(parsePdfParseAdmission(closedEnhancedAdmission), closedEnhancedAdmission);
assert.throws(
	() => parsePdfParseAdmission({ ...closedEnhancedAdmission, maxProviderCredits: '6' }),
	/Enhanced PDF provider policy is incomplete/,
);
assert.throws(
	() =>
		parsePdfParseAdmission({
			...closedEnhancedAdmission,
			maxProviderCredits: '0',
			providerTier: 'cost_effective',
			providerVersion: PDF_PARSE_CONTRACT.llamaParseVersions.cost_effective,
		}),
	/Enhanced PDF provider policy is incomplete/,
);
const admittedEnhancedPolicy = {
	...closedEnhancedAdmission,
	maxProviderCredits: '6',
	providerTier: 'cost_effective',
	providerVersion: PDF_PARSE_CONTRACT.llamaParseVersions.cost_effective,
};
assert.deepEqual(parsePdfParseAdmission(admittedEnhancedPolicy), admittedEnhancedPolicy);
assert.throws(
	() => parsePdfParseAdmission({ ...admittedEnhancedPolicy, providerVersion: PDF_PARSE_CONTRACT.llamaParseVersions.agentic }),
	/Enhanced PDF provider policy is incomplete/,
);
console.info({
	event: 'pdf_working_document_contract_passed',
	pages: document.parsedPages,
	problemPages: document.quality.problemPages.length,
	serializedBytes: new TextEncoder().encode(serialized).byteLength,
	translationChunks: translationChunks.length,
});
