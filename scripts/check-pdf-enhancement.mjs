import assert from 'node:assert/strict';
import { normalizeLiteParseDocument } from '../src/ingest/platforms/parsed-document.ts';
import {
	buildSelectiveLlamaParseV2Configuration,
	detectPdfEnhancementPages,
	formatLlamaParseTargetPages,
	planSelectivePdfEnhancement,
} from '../src/ingest/platforms/pdf-enhancement.ts';

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

function page(pageNumber, complexity = quality(pageNumber)) {
	return {
		pageNum: pageNumber,
		width: 612,
		height: 792,
		text: `Page ${pageNumber}`,
		markdown: `Page ${pageNumber}`,
		blocks: [{ kind: 'paragraph', text: `Page ${pageNumber}` }],
		complexity,
	};
}

const document = normalizeLiteParseDocument(
	{
		totalPages: 7,
		pages: [
			page(1),
			page(2, quality(2, { needsOcr: true })),
			page(3, quality(3, { isGarbled: true })),
			page(4, quality(4, { needsOcr: true, isGarbled: true })),
			page(
				5,
				quality(5, {
					layout: {
						isComplex: true,
						reasons: [],
						columnCount: 2,
						ruledTableCount: 0,
						ruledTableCoverage: 0,
						textTableRunCount: 0,
						figureCount: 0,
						figureCoverage: 0,
					},
				}),
			),
		],
		pageErrors: [{ pageNum: 6, message: 'Malformed page content' }],
	},
	'2.13.1',
);

assert.deepEqual(detectPdfEnhancementPages(document), [
	{ pageNumber: 2, reasons: ['needs-ocr'] },
	{ pageNumber: 3, reasons: ['garbled-text'] },
	{ pageNumber: 4, reasons: ['garbled-text', 'needs-ocr'] },
	{ pageNumber: 5, reasons: ['complex-layout'] },
	{ pageNumber: 6, reasons: ['parse-failed'] },
	{ pageNumber: 7, reasons: ['unparsed'] },
]);

assert.equal(formatLlamaParseTargetPages([7, 3, 4, 5, 5, 2], 7), '2-5,7');
assert.throws(() => formatLlamaParseTargetPages([], 7), /must not be empty/);
assert.throws(() => formatLlamaParseTargetPages([0], 7), /outside the 1-7 source page range/);
assert.throws(() => formatLlamaParseTargetPages([8], 7), /outside the 1-7 source page range/);
assert.throws(() => formatLlamaParseTargetPages([1.5], 7), /outside the 1-7 source page range/);

const parseConfiguration = buildSelectiveLlamaParseV2Configuration([2, 3, 4, 5, 6, 7], 7);
assert.deepEqual(parseConfiguration, {
	tier: 'agentic',
	version: '2026-08-19',
	client_name: 'newsence-core',
	page_ranges: { target_pages: '2-7' },
	output_options: {
		additional_outputs: [],
		granular_bboxes: [],
		images_to_save: [],
		save_output_pdf: false,
	},
});

const plan = planSelectivePdfEnhancement(document);
assert(plan);
assert.equal(plan.parseConfiguration.page_ranges.target_pages, '2-7');
assert.deepEqual(plan.providerFile, { purpose: 'parse', cleanup: 'delete-after-terminal-job' });
assert.deepEqual(plan.usageAccounting, {
	settlement: 'provider-reported-credits',
	targetPageBilling: 'unverified',
});

const cleanDocument = normalizeLiteParseDocument({ totalPages: 1, pages: [page(1)], pageErrors: [] }, '2.13.1');
assert.equal(planSelectivePdfEnhancement(cleanDocument), null, 'clean PDFs never create paid-provider work');

console.info({
	event: 'pdf_enhancement_contract_passed',
	problemPages: plan.targetPages.length,
	targetPages: plan.parseConfiguration.page_ranges.target_pages,
});
