import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import LlamaCloud, { APIConnectionError, APIError, NotFoundError, toFile } from '@llamaindex/llama-cloud';
import { VERSION as LLAMA_CLOUD_SDK_VERSION } from '@llamaindex/llama-cloud/version';
import { isAllowedPublicPdfUrl, LLAMA_PARSE_MAX_PAGES } from './llama-parse-policy';
import { fetchOpenAlexPdf } from './openalex';
import { MAX_PDF_BYTES, PDF_MIME } from './pdf';

export const LLAMA_PARSE_TIER = 'cost_effective';
export const LLAMA_PARSE_VERSION = '2026-08-19';
export const LLAMA_PARSE_MAX_POLL_ATTEMPTS = 120;
export const LLAMA_PARSE_POLL_INTERVAL = '10 seconds';
export { LLAMA_CLOUD_SDK_VERSION };

const LLAMA_CLOUD_BASE_URL = 'https://api.cloud.llamaindex.ai';
const AMBIGUOUS_MUTATION = 'LLAMA_PARSE_AMBIGUOUS_MUTATION';
const READ_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
const CLEANUP_STEP = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '90 seconds' } as const;
const MUTATION_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '180 seconds' } as const;

export type PdfWorkflowIdentity = Readonly<{ instanceId: string; startedAt: string }>;
export type PublicPdfProviderSource = Readonly<{ kind: 'openalex' | 'web'; url: string }>;
export type ProviderCredentials = Readonly<{ apiKey: string; projectId: string }>;
export type ProviderFile = Readonly<{ fileId: string; startedAt: number }>;
export type ProviderJob = Readonly<{ billedCredits: number | null; jobId: string; observedAt: number; status: string }>;
export type ProviderResult = Readonly<{
	finishedAt: number;
	result: {
		job: { id: string; status: string; usage?: { credits?: number | null } | null };
		markdown?: { pages: Array<{ markdown?: string; page_number: number; success: boolean }> } | null;
	};
}>;

function client(apiKey: string): LlamaCloud {
	return new LlamaCloud({ apiKey, baseURL: LLAMA_CLOUD_BASE_URL, maxRetries: 0, timeout: 30_000, logLevel: 'off' });
}

export function providerError(error: unknown): { name: string; status: number | null } {
	return {
		name: error instanceof Error ? error.name : 'UnknownError',
		status: error instanceof APIError && typeof error.status === 'number' ? error.status : null,
	};
}

function mutationFailure(action: string, error: unknown, workflowInstanceId: string): NonRetryableError {
	const status = error instanceof APIError && typeof error.status === 'number' ? error.status : null;
	const ambiguous = error instanceof APIConnectionError || status === null || status === 409 || status >= 500;
	return new NonRetryableError(
		`${ambiguous ? AMBIGUOUS_MUTATION : 'LLAMA_PARSE_MUTATION_REJECTED'} action=${action} status=${status ?? 'none'} workflow_instance_id=${workflowInstanceId}`,
	);
}

export function isAmbiguousProviderMutation(error: unknown): boolean {
	return error instanceof Error && error.message.includes(AMBIGUOUS_MUTATION);
}

export function isTerminalProviderStatus(status: string): boolean {
	return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}

async function boundedPdfBytes(response: Response): Promise<Uint8Array> {
	const declaredSize = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredSize) && declaredSize > MAX_PDF_BYTES) {
		await response.body?.cancel();
		throw new NonRetryableError(`Public PDF exceeded ${MAX_PDF_BYTES} bytes`);
	}
	let size = 0;
	const body = response.body?.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				size += chunk.byteLength;
				if (size > MAX_PDF_BYTES) throw new NonRetryableError(`Public PDF exceeded ${MAX_PDF_BYTES} bytes`);
				controller.enqueue(chunk);
			},
		}),
	);
	return new Response(body).bytes();
}

async function fetchProviderPdf(env: CoreEnv, source: PublicPdfProviderSource): Promise<Response> {
	if (!isAllowedPublicPdfUrl(source.url)) throw new NonRetryableError('Public PDF URL is not eligible for provider egress');
	if (source.kind === 'openalex') return fetchOpenAlexPdf({ apiKey: env.OPENALEX_API_KEY, contentPdfUrl: source.url });
	const response = await fetch(source.url, { headers: { Accept: PDF_MIME }, signal: AbortSignal.timeout(90_000) });
	if (!response.ok) {
		const status = response.status;
		await response.body?.cancel();
		if (status === 404 || status === 410) throw new NonRetryableError(`Public PDF returned HTTP ${status}`);
		throw new Error(`Public PDF returned HTTP ${status}`);
	}
	if (!isAllowedPublicPdfUrl(response.url)) {
		await response.body?.cancel();
		throw new NonRetryableError('Public PDF redirected to an ineligible provider URL');
	}
	const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
	if (!contentType.includes(PDF_MIME) && !new URL(response.url).pathname.toLowerCase().endsWith('.pdf')) {
		await response.body?.cancel();
		throw new NonRetryableError('Public PDF source no longer returns a PDF');
	}
	return response;
}

async function findFile(api: LlamaCloud, projectId: string, externalId: string): Promise<string | null> {
	const page = await api.files.list({ external_file_id: externalId, page_size: 3, project_id: projectId }, { maxRetries: 0 });
	const matches = page.items.filter((file) => file.external_file_id === externalId);
	if (matches.length > 1 || page.hasNextPage()) throw new NonRetryableError(`${AMBIGUOUS_MUTATION} action=file-reconcile`);
	return matches[0]?.id ?? null;
}

async function deleteFile(credentials: ProviderCredentials, fileId: string): Promise<void> {
	try {
		await client(credentials.apiKey).files.delete(fileId, { project_id: credentials.projectId }, { maxRetries: 0, timeout: 30_000 });
	} catch (error) {
		if (!(error instanceof NotFoundError)) throw error;
	}
}

export async function stageProviderFile(
	env: CoreEnv,
	step: WorkflowStep,
	input: { credentials: ProviderCredentials; source: PublicPdfProviderSource; workflow: PdfWorkflowIdentity },
): Promise<ProviderFile> {
	const externalId = `newsence:${input.workflow.instanceId}`;
	return step.do(
		'llamaparse-upload-public-pdf-v1',
		MUTATION_STEP,
		async (ctx) => {
			const api = client(input.credentials.apiKey);
			let existing: string | null;
			try {
				existing = await findFile(api, input.credentials.projectId, externalId);
			} catch (error) {
				if (isAmbiguousProviderMutation(error)) throw error;
				throw new NonRetryableError('LLAMA_PARSE_PREPARATION_FAILED action=file-reconcile');
			}
			if (existing) return { fileId: existing, startedAt: Date.now() };
			if (ctx.attempt > 1) throw new NonRetryableError(`${AMBIGUOUS_MUTATION} action=file-retry-reconcile-miss`);
			const startedAt = Date.now();
			let bytes: Uint8Array;
			try {
				bytes = await boundedPdfBytes(await fetchProviderPdf(env, input.source));
			} catch {
				throw new NonRetryableError('LLAMA_PARSE_PREPARATION_FAILED action=source-fetch');
			}
			try {
				const file = await toFile(bytes, `newsence-${input.workflow.instanceId.slice(0, 96)}.pdf`, { type: PDF_MIME });
				const uploaded = await api.files.create(
					{ external_file_id: externalId, file, project_id: input.credentials.projectId, purpose: 'parse' },
					{ maxRetries: 0, timeout: 60_000 },
				);
				return { fileId: uploaded.id, startedAt };
			} catch (error) {
				throw mutationFailure('file-upload', error, input.workflow.instanceId);
			}
		},
		{
			rollback: async ({ output }) => {
				if (output?.fileId) await deleteFile(input.credentials, output.fileId);
			},
			rollbackConfig: { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
		},
	);
}

function jobState(job: { id: string; status: string; usage?: { credits?: number | null } | null }): ProviderJob {
	return { billedCredits: job.usage?.credits ?? null, jobId: job.id, observedAt: Date.now(), status: job.status };
}

async function readJob(credentials: ProviderCredentials, jobId: string): Promise<ProviderJob> {
	const response = await client(credentials.apiKey).parsing.get(
		jobId,
		{ expand: ['usage'], project_id: credentials.projectId },
		{ maxRetries: 0 },
	);
	return jobState(response.job);
}

async function findJob(credentials: ProviderCredentials, workflow: PdfWorkflowIdentity): Promise<ProviderJob | null> {
	const reconciliationStart = new Date(new Date(workflow.startedAt).getTime() - 5 * 60_000).toISOString();
	let page = await client(credentials.apiKey).parsing.list(
		{ created_at_on_or_after: reconciliationStart, page_size: 100, project_id: credentials.projectId },
		{ maxRetries: 0 },
	);
	const matches = [] as typeof page.items;
	for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
		matches.push(...page.items.filter((job) => job.user_metadata?.workflow_instance_id === workflow.instanceId));
		if (!page.hasNextPage()) break;
		if (pageNumber === 4) throw new NonRetryableError(`${AMBIGUOUS_MUTATION} action=job-reconcile-window`);
		page = await page.getNextPage();
	}
	if (matches.length > 1) throw new NonRetryableError(`${AMBIGUOUS_MUTATION} action=job-reconcile`);
	return matches[0] ? jobState(matches[0]) : null;
}

async function cancelJob(credentials: ProviderCredentials, jobId: string, workflowInstanceId: string): Promise<void> {
	let current = await readJob(credentials, jobId);
	if (isTerminalProviderStatus(current.status)) return;
	try {
		await client(credentials.apiKey).parsing.cancel(jobId, { project_id: credentials.projectId }, { maxRetries: 0, timeout: 30_000 });
	} catch (error) {
		try {
			current = await readJob(credentials, jobId);
			if (isTerminalProviderStatus(current.status)) return;
		} catch {
			// The mutation result and confirming read are both unknown.
		}
		throw mutationFailure('job-cancel', error, workflowInstanceId);
	}
}

export async function stageProviderJob(
	step: WorkflowStep,
	input: {
		credentials: ProviderCredentials;
		file: ProviderFile;
		parserVersion: string;
		processingId: string;
		workflow: PdfWorkflowIdentity;
	},
): Promise<ProviderJob> {
	return step.do(
		'llamaparse-create-job-v1',
		MUTATION_STEP,
		async (ctx) => {
			let existing: ProviderJob | null;
			try {
				existing = await findJob(input.credentials, input.workflow);
			} catch (error) {
				if (isAmbiguousProviderMutation(error)) throw error;
				throw new NonRetryableError('LLAMA_PARSE_PREPARATION_FAILED action=job-reconcile');
			}
			if (existing) return existing;
			if (ctx.attempt > 1) throw new NonRetryableError(`${AMBIGUOUS_MUTATION} action=job-retry-reconcile-miss`);
			try {
				const job = await client(input.credentials.apiKey).parsing.create(
					{
						client_name: 'newsence-core',
						disable_cache: false,
						file_id: input.file.fileId,
						output_options: { images_to_save: [] },
						page_ranges: { max_pages: LLAMA_PARSE_MAX_PAGES },
						processing_control: { timeouts: { base_in_seconds: 120, extra_time_per_page_in_seconds: 8 } },
						project_id: input.credentials.projectId,
						tier: LLAMA_PARSE_TIER,
						user_metadata: {
							local_parser_version: input.parserVersion,
							processing_id: input.processingId.slice(0, 128),
							provider_file_id: input.file.fileId,
							workflow_instance_id: input.workflow.instanceId,
						},
						version: LLAMA_PARSE_VERSION,
					},
					{ maxRetries: 0, timeout: 30_000 },
				);
				return jobState(job);
			} catch (error) {
				throw mutationFailure('job-create', error, input.workflow.instanceId);
			}
		},
		{
			rollback: async ({ output }) => {
				if (output?.jobId) await cancelJob(input.credentials, output.jobId, input.workflow.instanceId);
			},
			rollbackConfig: { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
		},
	);
}

export function stageReadProviderJob(
	step: WorkflowStep,
	input: { attempt: number; credentials: ProviderCredentials; jobId: string },
): Promise<ProviderJob> {
	return step.do(`llamaparse-poll-${input.attempt}-v1`, READ_STEP, () => readJob(input.credentials, input.jobId));
}

export async function stageReadProviderResult(
	step: WorkflowStep,
	input: { credentials: ProviderCredentials; jobId: string },
): Promise<ProviderResult> {
	const stream = await step.do('llamaparse-read-result-v1', { ...READ_STEP, sensitive: 'output', timeout: '90 seconds' }, async () => {
		const result = await client(input.credentials.apiKey).parsing.get(
			input.jobId,
			{ expand: ['markdown', 'usage'], project_id: input.credentials.projectId },
			{ maxRetries: 0, timeout: 60_000 },
		);
		return Response.json({ finishedAt: Date.now(), result }).body!;
	});
	return new Response(stream).json<ProviderResult>();
}

export async function stageCancelProviderJob(
	step: WorkflowStep,
	input: { credentials: ProviderCredentials; jobId: string; workflowInstanceId: string },
): Promise<void> {
	await step.do('llamaparse-cancel-job-v1', CLEANUP_STEP, async () => {
		await cancelJob(input.credentials, input.jobId, input.workflowInstanceId);
		return true;
	});
}

export async function stageDeleteProviderFile(
	step: WorkflowStep,
	input: { credentials: ProviderCredentials; fileId: string },
): Promise<void> {
	await step.do('llamaparse-delete-file-v1', CLEANUP_STEP, async () => {
		await deleteFile(input.credentials, input.fileId);
		return true;
	});
}
