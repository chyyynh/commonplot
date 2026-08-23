import assert from 'node:assert/strict';
import { LLAMAPARSE_V2_RESULT_EXPAND, normalizeSelectiveLlamaParseV2Result } from '../src/ingest/platforms/llamaparse-result.ts';
import { normalizeLiteParseDocument } from '../src/ingest/platforms/parsed-document.ts';
import {
	buildSelectiveLlamaParseV2Configuration,
	detectPdfEnhancementPages,
	formatLlamaParseTargetPages,
	planSelectivePdfEnhancement,
} from '../src/ingest/platforms/pdf-enhancement.ts';
import { mergeSelectivePdfEnhancement } from '../src/ingest/platforms/pdf-enhancement-merge.ts';

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
assert.deepEqual(LLAMAPARSE_V2_RESULT_EXPAND, ['text', 'markdown', 'items', 'usage']);

function providerTextItem(pageNumber, value = `Enhanced page ${pageNumber}`) {
	return { type: 'text', md: value, value, bbox: [{ x: 72, y: 72, w: 200, h: 20 }] };
}

const binaryProviderText = '\u0001\u0002g~|{u>Ty`5Pt;cQkZ;xJ#E$ntZ:U4/F62Z'.repeat(40);
const providerResult = {
	job: {
		id: 'pjb-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
		project_id: 'prj-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
		status: 'COMPLETED',
		tier: 'agentic',
		usage: { credits: 40 },
	},
	text: {
		pages: [2, 3, 4, 5, 6].map((pageNumber) => ({
			page_number: pageNumber,
			text: pageNumber === 4 ? binaryProviderText : `Enhanced page ${pageNumber}`,
		})),
	},
	markdown: {
		pages: [
			...[2, 3, 4, 5, 6].map((pageNumber) => ({
				page_number: pageNumber,
				markdown: pageNumber === 4 ? binaryProviderText : `# Enhanced page ${pageNumber}`,
				success: true,
			})),
			{ page_number: 7, error: 'OCR timed out', success: false },
		],
	},
	items: {
		pages: [
			{
				page_number: 2,
				page_width: 612,
				page_height: 792,
				success: true,
				items: [
					providerTextItem(2),
					{ type: 'heading', md: '## Findings', level: 2, value: 'Findings' },
					{ type: 'list', md: '- Alpha\n- Beta', items: [], ordered: false },
					{ type: 'code', md: '```ts\nconst answer = 42;\n```', value: 'const answer = 42;', language: 'ts' },
					{
						type: 'table',
						md: '| Model | Accuracy |\n| --- | --- |\n| A | 95 |',
						rows: [
							['Model', 'Accuracy'],
							['A\u0001', 95],
						],
						html: '<table></table>',
						csv: 'Model,Accuracy\nA,95',
					},
					{ type: 'image', md: '![Chart](provider-url)', caption: 'Accuracy chart', url: 'https://provider.example/chart.png' },
					{ type: 'link', md: '[Source](https://example.com)', url: 'https://example.com', text: 'Source' },
					{ type: 'header', md: 'Quarterly report', items: [] },
					{ type: 'footer', md: 'Confidential', items: [] },
				],
			},
			...[3, 4, 5, 6].map((pageNumber) => ({
				page_number: pageNumber,
				page_width: 612,
				page_height: 792,
				success: true,
				items: [providerTextItem(pageNumber, pageNumber === 4 ? binaryProviderText : `Enhanced page ${pageNumber}`)],
			})),
			{ page_number: 7, error: 'Structured OCR timed out', success: false },
		],
	},
};

const normalizedProviderResult = normalizeSelectiveLlamaParseV2Result(providerResult, plan);
assert.deepEqual(
	normalizedProviderResult.pages.map((page) => page.pageNumber),
	[2, 3, 5, 6],
);
assert.deepEqual(
	normalizedProviderResult.failedPages.map((page) => page.pageNumber),
	[4, 7],
);
assert.equal(normalizedProviderResult.usageCredits, 40);
assert.deepEqual(
	normalizedProviderResult.pages[0].blocks.map((block) => block.type),
	['paragraph', 'heading', 'list', 'code', 'table', 'figure', 'paragraph', 'paragraph', 'paragraph'],
);
assert.equal(normalizedProviderResult.pages[0].blocks[0].bbox, null, 'provider bbox origin is not assumed');
assert.deepEqual(normalizedProviderResult.pages[0].blocks[4].table.rows[1][0], { text: 'A', bbox: null });
assert.equal(JSON.stringify(normalizedProviderResult).includes('provider.example'), false, 'provider asset URLs are not persisted');

const merged = mergeSelectivePdfEnhancement(document, plan, normalizedProviderResult);
assert.deepEqual(
	merged.pages.map((page) => [page.pageNumber, page.source]),
	[
		[1, 'liteparse'],
		[2, 'llamaparse'],
		[3, 'llamaparse'],
		[4, 'liteparse'],
		[5, 'llamaparse'],
		[6, 'llamaparse'],
	],
);
assert.deepEqual(merged.pageErrors, [], 'a successful provider page replaces the matching LiteParse page error');
assert.deepEqual(merged.quality.problemPages, [4, 7], 'failed provider pages retain their local fallback or unparsed gap');
assert.deepEqual(merged.enhancement, {
	provider: 'llamaparse',
	apiVersion: 'v2',
	version: '2026-08-19',
	policyRevision: 'selective-llamaparse-v1',
	requestedPages: [2, 3, 4, 5, 6, 7],
	appliedPages: [2, 3, 5, 6],
	failedPages: normalizedProviderResult.failedPages,
	usageCredits: 40,
});
assert.equal(merged.markdown.includes('# Enhanced page 2'), true);
assert.equal(merged.markdown.includes(binaryProviderText), false);

const nonTargetResult = structuredClone(providerResult);
nonTargetResult.markdown.pages[0].page_number = 1;
assert.throws(() => normalizeSelectiveLlamaParseV2Result(nonTargetResult, plan), /one of the requested target pages/);

const duplicateResult = structuredClone(providerResult);
duplicateResult.markdown.pages[1].page_number = 2;
assert.throws(() => normalizeSelectiveLlamaParseV2Result(duplicateResult, plan), /unique within its result channel/);

const runningResult = structuredClone(providerResult);
runningResult.job.status = 'RUNNING';
assert.throws(() => normalizeSelectiveLlamaParseV2Result(runningResult, plan), /COMPLETED before result normalization/);

assert.throws(
	() => mergeSelectivePdfEnhancement(document, plan, { ...normalizedProviderResult, failedPages: [] }),
	/exactly one outcome for every requested page/,
);

const cleanDocument = normalizeLiteParseDocument({ totalPages: 1, pages: [page(1)], pageErrors: [] }, '2.13.1');
assert.equal(planSelectivePdfEnhancement(cleanDocument), null, 'clean PDFs never create paid-provider work');

console.info({
	event: 'pdf_enhancement_contract_passed',
	appliedPages: merged.enhancement.appliedPages.length,
	problemPages: plan.targetPages.length,
	targetPages: plan.parseConfiguration.page_ranges.target_pages,
});
