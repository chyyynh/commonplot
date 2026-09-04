import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import LlamaCloud, { APIError, NotFoundError } from '@llamaindex/llama-cloud';
import { VERSION as LLAMA_CLOUD_SDK_VERSION } from '@llamaindex/llama-cloud/version';
import { MAX_PDF_BYTES, PDF_MIME } from './pdf-constants';
import {
	type LocalPdfSummary,
	llamaParseAdmissionReason,
	type PaidPdfFallbackGrant,
	wholeDocumentMarkdown,
} from './pdf-fallback-policy.ts';

const LLAMA_CLOUD_BASE_URL = 'https://api.cloud.llamaindex.ai';
const LLAMA_PARSE_TIER = 'cost_effective';
const LLAMA_PARSE_VERSION = '2026-08-19';
const LLAMA_PARSE_POLL_ATTEMPTS = 120;
const LLAMA_PARSE_POLL_INTERVAL = '10 seconds';
const AMBIGUOUS_MUTATION = 'LLAMA_PARSE_AMBIGUOUS_MUTATION';
const PREPARATION_FAILED = 'LLAMA_PARSE_PREPARATION_FAILED';
const REJECTED_MUTATION = 'LLAMA_PARSE_MUTATION_REJECTED';
const READ_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '60 seconds' } as const;
const CLEANUP_STEP = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '90 seconds' } as const;
const CREATE_ONCE_STEP = { retries: { limit: 1, delay: '1 second' }, timeout: '60 seconds' } as const;
const UPLOAD_STEP = { retries: { limit: 2, delay: '5 seconds' }, timeout: '180 seconds' } as const;
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

type ProviderCredentials = Readonly<{ apiKey: string; projectId: string }>;
type ProviderSource = Readonly<{ kind: 'private-upload'; storageKey: string }> | Readonly<{ kind: 'public-url'; url: string }>;

function client(apiKey: string): LlamaCloud {
	return new LlamaCloud({ apiKey, baseURL: LLAMA_CLOUD_BASE_URL, maxRetries: 0, timeout: 30_000, logLevel: 'off' });
}

function mutationFailure(action: string, error: unknown, retryAmbiguous: boolean): Error {
	const status = error instanceof APIError && typeof error.status === 'number' ? error.status : null;
	const ambiguous = status === null || status === 408 || status === 409 || status >= 500;
	const message = `${ambiguous ? AMBIGUOUS_MUTATION : REJECTED_MUTATION} action=${action} status=${status ?? 'none'}`;
	return ambiguous && retryAmbiguous ? new Error(message) : new NonRetryableError(message);
}

function isDefinitiveFailure(error: unknown): boolean {
	return error instanceof Error && (error.message.includes(PREPARATION_FAILED) || error.message.includes(REJECTED_MUTATION));
}

function jobState(job: { id: string; status: string; usage?: { credits?: number | null } | null }, startedAt: number) {
	return {
		billedCredits: job.usage?.credits ?? null,
		jobId: job.id,
		observedAt: Date.now(),
		startedAt,
		status: job.status,
	};
}

type ProviderJob = ReturnType<typeof jobState>;

async function privatePdfBytes(env: CoreEnv, storageKey: string): Promise<Uint8Array> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const object = await env.R2.get(storageKey);
			if (!object) throw new NonRetryableError(`${PREPARATION_FAILED} action=r2-read reason=missing`);
			if (object.size > MAX_PDF_BYTES) throw new NonRetryableError(`${PREPARATION_FAILED} action=r2-read reason=too-large`);
			return await object.bytes();
		} catch (error) {
			if (error instanceof NonRetryableError) throw error;
			lastError = error;
		}
	}
	throw new NonRetryableError(`${PREPARATION_FAILED} action=r2-read reason=${lastError instanceof Error ? lastError.name : 'unknown'}`);
}

function providerFileExternalId(processingId: string): string {
	return `newsence:${processingId.slice(0, 128)}`;
}

async function findProviderFile(credentials: ProviderCredentials, externalId: string): Promise<string | null> {
	const page = await client(credentials.apiKey).files.list(
		{ external_file_id: externalId, page_size: 2, project_id: credentials.projectId },
		{ maxRetries: 2 },
	);
	const matches = page.items.filter((file) => file.external_file_id === externalId);
	if (matches.length > 1 || page.hasNextPage()) {
		throw new NonRetryableError(`${AMBIGUOUS_MUTATION} action=file-upload-reconcile-multiple`);
	}
	return matches[0]?.id ?? null;
}

function stageProviderFile(
	env: CoreEnv,
	step: WorkflowStep,
	input: { credentials: ProviderCredentials; processingId: string; storageKey: string },
): Promise<string> {
	const externalId = providerFileExternalId(input.processingId);
	return step.do(
		'llamaparse-upload-private-pdf-v1',
		UPLOAD_STEP,
		async ({ attempt }) => {
			if (attempt > 1) {
				try {
					const existing = await findProviderFile(input.credentials, externalId);
					if (existing) return existing;
				} catch (error) {
					if (error instanceof Error && error.message.includes(AMBIGUOUS_MUTATION)) throw error;
					throw mutationFailure('file-upload-reconcile', error, false);
				}
				throw new NonRetryableError(`${AMBIGUOUS_MUTATION} action=file-upload-reconcile-miss`);
			}

			const bytes = await privatePdfBytes(env, input.storageKey);
			const file = new File([bytes], `newsence-${input.processingId.slice(0, 96)}.pdf`, { type: PDF_MIME });
			try {
				const uploaded = await client(input.credentials.apiKey).files.create(
					{
						external_file_id: externalId,
						file,
						project_id: input.credentials.projectId,
						purpose: 'parse',
					},
					{ timeout: 60_000 },
				);
				return uploaded.id;
			} catch (error) {
				throw mutationFailure('file-upload', error, true);
			}
		},
		{
			rollback: async ({ output }) => {
				if (output) await deleteProviderFile(input.credentials, output);
			},
			rollbackConfig: CLEANUP_STEP,
		},
	);
}

async function deleteProviderFile(credentials: ProviderCredentials, fileId: string): Promise<void> {
	try {
		await client(credentials.apiKey).files.delete(fileId, { project_id: credentials.projectId });
	} catch (error) {
		if (!(error instanceof NotFoundError)) throw error;
	}
}

async function readJob(credentials: ProviderCredentials, job: Pick<ProviderJob, 'jobId' | 'startedAt'>): Promise<ProviderJob> {
	const response = await client(credentials.apiKey).parsing.get(job.jobId, { expand: ['usage'], project_id: credentials.projectId });
	return jobState(response.job, job.startedAt);
}

async function cancelKnownJob(credentials: ProviderCredentials, job: Pick<ProviderJob, 'jobId' | 'startedAt'>): Promise<void> {
	const current = await readJob(credentials, job);
	if (TERMINAL_STATUSES.has(current.status)) return;
	try {
		await client(credentials.apiKey).parsing.cancel(job.jobId, { project_id: credentials.projectId });
	} catch (error) {
		if (!TERMINAL_STATUSES.has((await readJob(credentials, job)).status)) throw error;
	}
}

/** Execute one paid whole-document fallback after Web has granted a per-document page allowance. */
export async function stagePaidLlamaParseFallback(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		grant: PaidPdfFallbackGrant | null;
		local: LocalPdfSummary;
		processingId: string;
		source: ProviderSource;
	},
): Promise<string | null> {
	const credentials = {
		apiKey: env.LLAMA_CLOUD_API_KEY?.trim() ?? '',
		projectId: env.LLAMA_CLOUD_PROJECT_ID?.trim() ?? '',
	};
	const admission = llamaParseAdmissionReason({
		grant: input.grant,
		hasCredentials: !!credentials.apiKey && !!credentials.projectId,
		local: input.local,
		source: input.source,
	});
	const externalId = admission === 'admitted' && input.source.kind === 'private-upload' ? providerFileExternalId(input.processingId) : null;
	let fileId: string | undefined;
	const logFallback = (event: { billedCredits?: number | null; error?: unknown; job?: ProviderJob; outcome: string }) => {
		const error = event.error || null;
		console.info({
			tag: 'PDF_PARSE',
			event: 'llamaparse_fallback',
			provider: 'llamaparse',
			provider_base_region: 'us',
			provider_external_file_id: externalId,
			provider_file_id: fileId ?? null,
			provider_job_id: event.job?.jobId ?? null,
			provider_sdk_version: LLAMA_CLOUD_SDK_VERSION,
			provider_status: error instanceof APIError && typeof error.status === 'number' ? error.status : null,
			provider_error: error ? (error instanceof Error ? error.name : 'UnknownError') : null,
			tier: LLAMA_PARSE_TIER,
			parser_version: LLAMA_PARSE_VERSION,
			page_count: input.local.totalPages,
			local_fallback_reasons: input.local.fallbackReasons,
			local_full_page_image_pages: input.local.fullPageImagePages,
			outcome: event.outcome,
			latency_ms: event.job ? Math.max(0, (event.job.observedAt || Date.now()) - event.job.startedAt) : null,
			billed_credits: event.billedCredits ?? event.job?.billedCredits ?? null,
		});
	};
	if (admission !== 'admitted') {
		if (admission !== 'local-usable') logFallback({ outcome: admission });
		return null;
	}

	if (input.source.kind === 'private-upload') {
		try {
			fileId = await stageProviderFile(env, step, {
				credentials,
				processingId: input.processingId,
				storageKey: input.source.storageKey,
			});
		} catch (error) {
			const ambiguous = !isDefinitiveFailure(error);
			logFallback({ error, outcome: ambiguous ? 'operator-reconciliation-required' : 'upload-failed' });
			if (ambiguous) throw error;
			return null;
		}
	}

	try {
		const parseSource = input.source.kind === 'public-url' ? { source_url: input.source.url } : { file_id: fileId! };
		let job: ProviderJob;
		try {
			job = await step.do(
				'file_id' in parseSource ? 'llamaparse-create-file-job-v1' : 'llamaparse-create-source-job-v2',
				CREATE_ONCE_STEP,
				async () => {
					const startedAt = Date.now();
					try {
						const created = await client(credentials.apiKey).parsing.create({
							client_name: 'newsence-core',
							disable_cache: false,
							output_options: { images_to_save: [] },
							page_ranges: { max_pages: input.local.totalPages! },
							processing_control: { timeouts: { base_in_seconds: 120, extra_time_per_page_in_seconds: 8 } },
							project_id: credentials.projectId,
							...parseSource,
							tier: LLAMA_PARSE_TIER,
							user_metadata: {
								local_parser_version: input.local.parserVersion,
								processing_id: input.processingId.slice(0, 128),
							},
							version: LLAMA_PARSE_VERSION,
						});
						return jobState(created, startedAt);
					} catch (error) {
						throw mutationFailure('job-create', error, false);
					}
				},
			);
		} catch (error) {
			const ambiguous = !isDefinitiveFailure(error);
			logFallback({ error, outcome: ambiguous ? 'operator-reconciliation-required' : 'job-create-failed' });
			if (ambiguous) throw error;
			return null;
		}

		let state = job;
		try {
			for (let attempt = 1; !TERMINAL_STATUSES.has(state.status) && attempt <= LLAMA_PARSE_POLL_ATTEMPTS; attempt++) {
				await step.sleep(`llamaparse-poll-wait-${attempt}-v2`, LLAMA_PARSE_POLL_INTERVAL);
				state = await step.do(`llamaparse-poll-${attempt}-v2`, READ_STEP, () => readJob(credentials, job));
			}
		} catch (error) {
			await step.do('llamaparse-cancel-job-v2', CLEANUP_STEP, () => cancelKnownJob(credentials, job));
			logFallback({ error, job, outcome: 'provider-failed' });
			return null;
		}
		if (!TERMINAL_STATUSES.has(state.status)) {
			await step.do('llamaparse-cancel-job-v2', CLEANUP_STEP, () => cancelKnownJob(credentials, job));
			logFallback({ job: state, outcome: 'timed-out' });
			return null;
		}
		if (state.status !== 'COMPLETED') {
			logFallback({ job: state, outcome: `job-${state.status.toLowerCase()}` });
			return null;
		}

		let result: { billedCredits: number | null; finishedAt: number; markdown: string | null };
		try {
			const stream = await step.do('llamaparse-read-result-v4', { ...READ_STEP, sensitive: 'output', timeout: '90 seconds' }, async () => {
				const response = await client(credentials.apiKey).parsing.get(
					job.jobId,
					{ expand: ['markdown', 'usage'], project_id: credentials.projectId },
					{ timeout: 60_000 },
				);
				return Response.json({
					billedCredits: response.job.usage?.credits ?? null,
					finishedAt: Date.now(),
					markdown: wholeDocumentMarkdown(response.markdown?.pages, input.local.totalPages!),
				}).body!;
			});
			result = await new Response(stream).json<typeof result>();
		} catch (error) {
			logFallback({ error, job, outcome: 'provider-failed' });
			return null;
		}
		logFallback({
			billedCredits: result.billedCredits,
			job: { ...state, observedAt: result.finishedAt },
			outcome: result.markdown ? 'cloud-replaced-local' : 'incomplete-cloud-result',
		});
		return result.markdown;
	} finally {
		if (fileId) await step.do('llamaparse-delete-file-v1', CLEANUP_STEP, () => deleteProviderFile(credentials, fileId));
	}
}
