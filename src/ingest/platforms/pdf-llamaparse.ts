import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import LlamaCloud, { APIConnectionError, APIError } from '@llamaindex/llama-cloud';
import { VERSION as LLAMA_CLOUD_SDK_VERSION } from '@llamaindex/llama-cloud/version';
import { llamaParseFallbackReason, type PaidPdfFallbackGrant, wholeDocumentMarkdown } from './pdf-fallback-policy.ts';

const LLAMA_CLOUD_BASE_URL = 'https://api.cloud.llamaindex.ai';
const LLAMA_PARSE_TIER = 'cost_effective';
const LLAMA_PARSE_VERSION = '2026-08-19';
const LLAMA_PARSE_POLL_ATTEMPTS = 120;
const LLAMA_PARSE_POLL_INTERVAL = '10 seconds';
const AMBIGUOUS_CREATE = 'LLAMA_PARSE_AMBIGUOUS_CREATE';
const DEFINITIVE_CREATE_REJECTION = 'LLAMA_PARSE_CREATE_REJECTED';
const READ_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
const CLEANUP_STEP = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '90 seconds' } as const;
const CREATE_STEP = { retries: { limit: 2, delay: '5 seconds' }, timeout: '60 seconds' } as const;
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

type LocalPdfFallbackSummary = Readonly<{
	hardDefects: readonly string[];
	parserVersion: string;
	totalPages: number | null;
}>;

type ProviderCredentials = Readonly<{ apiKey: string; projectId: string }>;
type ProviderJob = Readonly<{
	billedCredits: number | null;
	jobId: string;
	observedAt: number;
	startedAt: number;
	status: string;
}>;

type ProviderResult = Readonly<{
	finishedAt: number;
	result: {
		job: { id: string; status: string; usage?: { credits?: number | null } | null };
		markdown?: { pages: Array<{ markdown?: string; page_number: number; success: boolean }> } | null;
	};
}>;

function client(apiKey: string): LlamaCloud {
	return new LlamaCloud({ apiKey, baseURL: LLAMA_CLOUD_BASE_URL, maxRetries: 0, timeout: 30_000, logLevel: 'off' });
}

function providerError(error: unknown): { name: string; status: number | null } {
	return {
		name: error instanceof Error ? error.name : 'UnknownError',
		status: error instanceof APIError && typeof error.status === 'number' ? error.status : null,
	};
}

function createFailure(error: unknown): NonRetryableError {
	const status = error instanceof APIError && typeof error.status === 'number' ? error.status : null;
	const ambiguous = error instanceof APIConnectionError || status === null || status === 408 || status === 409 || status >= 500;
	return new NonRetryableError(`${ambiguous ? AMBIGUOUS_CREATE : DEFINITIVE_CREATE_REJECTION} status=${status ?? 'none'}`);
}

function isAmbiguousCreate(error: unknown): boolean {
	return error instanceof Error && error.message.includes(AMBIGUOUS_CREATE);
}

function isDefinitiveCreateRejection(error: unknown): boolean {
	return error instanceof Error && error.message.includes(DEFINITIVE_CREATE_REJECTION);
}

function jobState(job: { id: string; status: string; usage?: { credits?: number | null } | null }, startedAt: number): ProviderJob {
	return {
		billedCredits: job.usage?.credits ?? null,
		jobId: job.id,
		observedAt: Date.now(),
		startedAt,
		status: job.status,
	};
}

async function readJob(credentials: ProviderCredentials, job: Pick<ProviderJob, 'jobId' | 'startedAt'>): Promise<ProviderJob> {
	const response = await client(credentials.apiKey).parsing.get(
		job.jobId,
		{ expand: ['usage'], project_id: credentials.projectId },
		{ maxRetries: 0 },
	);
	return jobState(response.job, job.startedAt);
}

async function cancelKnownJob(credentials: ProviderCredentials, job: Pick<ProviderJob, 'jobId' | 'startedAt'>): Promise<void> {
	const current = await readJob(credentials, job);
	if (TERMINAL_STATUSES.has(current.status)) return;
	await client(credentials.apiKey).parsing.cancel(job.jobId, { project_id: credentials.projectId }, { maxRetries: 0, timeout: 30_000 });
}

function stageCreateJob(
	step: WorkflowStep,
	input: {
		credentials: ProviderCredentials;
		local: LocalPdfFallbackSummary;
		pageCount: number;
		processingId: string;
		sourceUrl: string;
	},
): Promise<ProviderJob> {
	return step.do(
		'llamaparse-create-source-job-v2',
		CREATE_STEP,
		async (ctx) => {
			if (ctx.attempt > 1) throw new NonRetryableError(`${AMBIGUOUS_CREATE} action=workflow-retry`);
			const startedAt = Date.now();
			try {
				const job = await client(input.credentials.apiKey).parsing.create(
					{
						client_name: 'newsence-core',
						disable_cache: false,
						output_options: { images_to_save: [] },
						page_ranges: { max_pages: input.pageCount },
						processing_control: { timeouts: { base_in_seconds: 120, extra_time_per_page_in_seconds: 8 } },
						project_id: input.credentials.projectId,
						source_url: input.sourceUrl,
						tier: LLAMA_PARSE_TIER,
						user_metadata: {
							local_parser_version: input.local.parserVersion,
							processing_id: input.processingId.slice(0, 128),
						},
						version: LLAMA_PARSE_VERSION,
					},
					{ maxRetries: 0, timeout: 30_000 },
				);
				return jobState(job, startedAt);
			} catch (error) {
				throw createFailure(error);
			}
		},
		{
			rollback: async ({ output }) => {
				if (output?.jobId) await cancelKnownJob(input.credentials, output);
			},
			rollbackConfig: CLEANUP_STEP,
		},
	);
}

function stageReadJob(step: WorkflowStep, credentials: ProviderCredentials, job: ProviderJob, attempt: number): Promise<ProviderJob> {
	return step.do(`llamaparse-poll-${attempt}-v2`, READ_STEP, () => readJob(credentials, job));
}

async function stageReadResult(step: WorkflowStep, credentials: ProviderCredentials, jobId: string): Promise<ProviderResult> {
	const stream = await step.do('llamaparse-read-result-v2', { ...READ_STEP, sensitive: 'output', timeout: '90 seconds' }, async () => {
		const result = await client(credentials.apiKey).parsing.get(
			jobId,
			{ expand: ['markdown', 'usage'], project_id: credentials.projectId },
			{ maxRetries: 0, timeout: 60_000 },
		);
		return Response.json({ finishedAt: Date.now(), result }).body!;
	});
	return new Response(stream).json<ProviderResult>();
}

async function stageCancelJob(step: WorkflowStep, credentials: ProviderCredentials, job: ProviderJob): Promise<void> {
	await step.do('llamaparse-cancel-job-v2', CLEANUP_STEP, async () => {
		await cancelKnownJob(credentials, job);
		return true;
	});
}

function logFallback(input: {
	billedCredits?: number | null;
	error?: unknown;
	job?: ProviderJob;
	local: LocalPdfFallbackSummary;
	outcome: string;
}): void {
	const error = input.error ? providerError(input.error) : null;
	console.info({
		tag: 'PDF_PARSE',
		event: 'llamaparse_fallback',
		provider: 'llamaparse',
		provider_base_region: 'us',
		provider_job_id: input.job?.jobId ?? null,
		provider_sdk_version: LLAMA_CLOUD_SDK_VERSION,
		provider_status: error?.status ?? null,
		provider_error: error?.name ?? null,
		tier: LLAMA_PARSE_TIER,
		parser_version: LLAMA_PARSE_VERSION,
		page_count: input.local.totalPages,
		local_hard_defects: input.local.hardDefects,
		outcome: input.outcome,
		latency_ms: input.job ? Math.max(0, (input.job.observedAt || Date.now()) - input.job.startedAt) : null,
		billed_credits: input.billedCredits ?? input.job?.billedCredits ?? null,
	});
}

/** Execute one paid whole-document fallback after Web has granted a per-document page allowance. */
export async function stageLlamaParseFallback(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		grant: PaidPdfFallbackGrant | null;
		local: LocalPdfFallbackSummary;
		processingId: string;
		sourceUrl: string;
	},
): Promise<string | null> {
	const credentials = {
		apiKey: env.LLAMA_CLOUD_API_KEY?.trim() ?? '',
		projectId: env.LLAMA_CLOUD_PROJECT_ID?.trim() ?? '',
	};
	const admission = llamaParseFallbackReason({
		grant: input.grant,
		hasCredentials: !!credentials.apiKey && !!credentials.projectId,
		local: input.local,
		sourceUrl: input.sourceUrl,
	});
	if (admission !== 'admitted') {
		if (admission !== 'local-usable') logFallback({ local: input.local, outcome: admission });
		return null;
	}

	let job: ProviderJob;
	try {
		job = await stageCreateJob(step, {
			credentials,
			local: input.local,
			pageCount: input.local.totalPages!,
			processingId: input.processingId,
			sourceUrl: input.sourceUrl,
		});
	} catch (error) {
		const createError =
			isAmbiguousCreate(error) || isDefinitiveCreateRejection(error)
				? error
				: new NonRetryableError(`${AMBIGUOUS_CREATE} action=create-step-failed`);
		logFallback({
			error: createError,
			local: input.local,
			outcome: isAmbiguousCreate(createError) ? 'operator-reconciliation-required' : 'job-create-failed',
		});
		if (isAmbiguousCreate(createError)) throw createError;
		return null;
	}

	let state = job;
	try {
		for (let attempt = 1; !TERMINAL_STATUSES.has(state.status) && attempt <= LLAMA_PARSE_POLL_ATTEMPTS; attempt++) {
			await step.sleep(`llamaparse-poll-wait-${attempt}-v2`, LLAMA_PARSE_POLL_INTERVAL);
			state = await stageReadJob(step, credentials, job, attempt);
		}
		if (!TERMINAL_STATUSES.has(state.status)) {
			await stageCancelJob(step, credentials, job);
			logFallback({ job: state, local: input.local, outcome: 'timed-out' });
			return null;
		}
		if (state.status !== 'COMPLETED') {
			logFallback({ job: state, local: input.local, outcome: `job-${state.status.toLowerCase()}` });
			return null;
		}
		const result = await stageReadResult(step, credentials, job.jobId);
		const markdown = wholeDocumentMarkdown(result.result.markdown?.pages, input.local.totalPages!);
		logFallback({
			billedCredits: result.result.job.usage?.credits,
			job: { ...state, observedAt: result.finishedAt },
			local: input.local,
			outcome: markdown ? 'cloud-replaced-local' : 'incomplete-cloud-result',
		});
		return markdown;
	} catch (error) {
		try {
			await stageCancelJob(step, credentials, job);
		} catch (cancelError) {
			logFallback({ error: cancelError, job, local: input.local, outcome: 'operator-reconciliation-required' });
			throw cancelError;
		}
		logFallback({ error, job, local: input.local, outcome: 'provider-failed' });
		return null;
	}
}
