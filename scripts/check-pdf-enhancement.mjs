import assert from 'node:assert/strict';
import { createLlamaParseClient, LlamaParseClientError } from '../src/ingest/platforms/llamaparse.ts';
import {
	buildSelectiveLlamaParseV2Configuration,
	detectPdfEnhancementPages,
	formatLlamaParseTargetPages,
	LLAMAPARSE_V2_RESULT_EXPAND,
	mergeSelectivePdfEnhancement,
	normalizeSelectiveLlamaParseV2Result,
	planSelectivePdfEnhancement,
} from '../src/ingest/platforms/pdf-enhancement.ts';
import { normalizeLiteParseWorkingDocument } from '../src/ingest/platforms/pdf-working-document.ts';

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
		complexity,
	};
}

const document = normalizeLiteParseWorkingDocument(
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

const parseConfiguration = buildSelectiveLlamaParseV2Configuration([2, 3, 4, 5, 6, 7], 7, 'agentic');
assert.deepEqual(parseConfiguration, {
	tier: 'agentic',
	version: '2026-07-15',
	client_name: 'newsence-core',
	page_ranges: { target_pages: '2-7' },
	output_options: {
		additional_outputs: [],
		granular_bboxes: [],
		images_to_save: [],
		save_output_pdf: false,
	},
});
assert.equal(buildSelectiveLlamaParseV2Configuration([3, 7], 10, 'cost_effective').version, '2026-06-26');
assert.throws(() => buildSelectiveLlamaParseV2Configuration([3, 7], 10, 'fast'), /Unsupported LlamaParse v2 tier/);

const plan = planSelectivePdfEnhancement(document, 'agentic');
assert(plan);
assert.equal(plan.parseConfiguration.page_ranges.target_pages, '2-7');
assert.deepEqual(plan.providerFile, { purpose: 'parse', cleanup: 'delete-after-terminal-job' });
assert.deepEqual(plan.usageAccounting, {
	activationGate: 'real-document-contract-probe-required',
	settlement: 'provider-reported-credits',
	targetPageBilling: 'documented-selected-pages',
});
assert.deepEqual(LLAMAPARSE_V2_RESULT_EXPAND, ['text', 'markdown', 'usage']);

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
assert.equal(normalizedProviderResult.pages[0].markdown, '# Enhanced page 2');
assert.equal(normalizedProviderResult.pages[0].text, 'Enhanced page 2');
assert.equal(Object.hasOwn(normalizedProviderResult.pages[0], 'blocks'), false, 'provider geometry is not retained');

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
	version: '2026-07-15',
	policyRevision: 'selective-llamaparse-v2',
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

const clientRequests = [];
const jobResponse = {
	id: 'pjb-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
	project_id: 'prj-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
	status: 'PENDING',
	tier: 'agentic',
};
const client = createLlamaParseClient({
	apiKey: 'llx-contract-secret',
	projectId: 'project-contract',
	organizationId: 'organization-contract',
	async fetcher(input, init) {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const record = {
			method: request.method,
			path: url.pathname,
			query: url.searchParams,
			authorization: request.headers.get('authorization'),
			contentType: request.headers.get('content-type'),
			body: null,
		};
		clientRequests.push(record);
		if (request.method === 'POST' && url.pathname === '/api/v1/beta/files') {
			const form = await request.formData();
			const file = form.get('file');
			record.body = { purpose: form.get('purpose'), fileName: file.name, fileType: file.type, fileSize: file.size };
			return Response.json(
				{
					id: 'dfl-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
					name: 'document.pdf',
					project_id: 'prj-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
					purpose: 'parse',
				},
				{ status: 201 },
			);
		}
		if (request.method === 'POST' && url.pathname === '/api/v2/parse') {
			record.body = await request.json();
			return Response.json(jobResponse);
		}
		if (request.method === 'GET' && url.pathname.endsWith('/pjb-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')) {
			return Response.json(url.searchParams.has('expand') ? providerResult : jobResponse);
		}
		if (request.method === 'POST' && url.pathname.endsWith('/cancel')) {
			return Response.json({ ...jobResponse, status: 'CANCELLED' });
		}
		if (request.method === 'DELETE' && url.pathname.endsWith('/dfl-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')) {
			return new Response(null, { status: 204 });
		}
		throw new Error(`Unexpected fake LlamaParse request: ${request.method} ${url.pathname}`);
	},
});

const uploaded = await client.uploadPdf(new Blob(['%PDF-1.7\nfixture'], { type: 'application/pdf' }));
assert.deepEqual(uploaded, {
	id: 'dfl-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
	name: 'document.pdf',
	projectId: 'prj-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
	purpose: 'parse',
});
const createdJob = await client.createParse(uploaded.id, plan.parseConfiguration);
assert.equal(createdJob.status, 'PENDING');
assert.equal((await client.getParseJob(createdJob.id)).status, 'PENDING');
assert.deepEqual(await client.getParseResult(createdJob.id), providerResult);
assert.equal((await client.cancelParse(createdJob.id)).status, 'CANCELLED');
await client.deleteFile(uploaded.id);

assert.equal(clientRequests.length, 6);
assert.equal(
	clientRequests.every((request) => request.authorization === 'Bearer llx-contract-secret'),
	true,
);
assert.equal(
	clientRequests.every((request) => request.query.get('project_id') === 'project-contract'),
	true,
);
assert.equal(
	clientRequests.every((request) => request.query.get('organization_id') === 'organization-contract'),
	true,
);
assert.match(clientRequests[0].contentType, /^multipart\/form-data; boundary=/);
assert.deepEqual(clientRequests[0].body, {
	purpose: 'parse',
	fileName: 'document.pdf',
	fileType: 'application/pdf',
	fileSize: 16,
});
assert.deepEqual(clientRequests[1].body, {
	file_id: uploaded.id,
	tier: 'agentic',
	version: '2026-07-15',
	client_name: 'newsence-core',
	page_ranges: { target_pages: '2-7' },
	output_options: {
		additional_outputs: [],
		granular_bboxes: [],
		images_to_save: [],
		save_output_pdf: false,
	},
});
assert.equal(Object.hasOwn(clientRequests[1].body, 'product_type'), false);
assert.equal(clientRequests[3].query.get('expand'), 'text,markdown,usage');

const retryClient = createLlamaParseClient({
	apiKey: 'llx-contract-secret',
	fetcher: async () =>
		new Response('provider detail must stay private', {
			status: 429,
			headers: { 'content-type': 'text/plain', 'retry-after': '2', 'x-request-id': 'request-contract' },
		}),
});
await assert.rejects(retryClient.getParseJob(createdJob.id), (error) => {
	assert(error instanceof LlamaParseClientError);
	assert.equal(error.retryable, true);
	assert.equal(error.status, 429);
	assert.equal(error.requestId, 'request-contract');
	assert.equal(error.retryAfterSeconds, 2);
	assert.equal(error.message.includes('provider detail'), false);
	assert.equal(error.message.includes('llx-contract-secret'), false);
	return true;
});
await assert.rejects(retryClient.createParse(uploaded.id, plan.parseConfiguration), (error) => {
	assert(error instanceof LlamaParseClientError);
	assert.equal(error.retryable, false, 'create requires reconciliation instead of a blind retry');
	return true;
});

const oversizedClient = createLlamaParseClient({
	apiKey: 'llx-contract-secret',
	fetcher: async () =>
		Response.json(providerResult, {
			headers: { 'content-length': `${16 * 1024 * 1024 + 1}` },
		}),
});
await assert.rejects(oversizedClient.getParseResult(createdJob.id), /response exceeded 16777216 bytes/);

const absentDeleteClient = createLlamaParseClient({
	apiKey: 'llx-contract-secret',
	fetcher: async () => new Response(null, { status: 404 }),
});
await absentDeleteClient.deleteFile(uploaded.id);
await assert.rejects(() => client.uploadPdf(new Blob([])), /must contain between 1 and 26214400 bytes/);
assert.throws(() => createLlamaParseClient({ apiKey: 'secret\nheader' }), /API key is invalid/);

const cleanDocument = normalizeLiteParseWorkingDocument({ totalPages: 1, pages: [page(1)], pageErrors: [] }, '2.13.1');
assert.equal(planSelectivePdfEnhancement(cleanDocument, 'agentic'), null, 'clean PDFs never create paid-provider work');

console.info({
	event: 'pdf_enhancement_contract_passed',
	appliedPages: merged.enhancement.appliedPages.length,
	httpRequests: clientRequests.length,
	problemPages: plan.targetPages.length,
	targetPages: plan.parseConfiguration.page_ranges.target_pages,
});
