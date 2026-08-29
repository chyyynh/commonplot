import type { WorkflowStep } from 'cloudflare:workers';
import {
	isAmbiguousProviderMutation,
	isTerminalProviderStatus,
	LLAMA_CLOUD_SDK_VERSION,
	LLAMA_PARSE_MAX_POLL_ATTEMPTS,
	LLAMA_PARSE_POLL_INTERVAL,
	LLAMA_PARSE_TIER,
	LLAMA_PARSE_VERSION,
	type PdfWorkflowIdentity,
	type ProviderCredentials,
	type ProviderFile,
	type ProviderJob,
	type PublicPdfProviderSource,
	providerError,
	stageCancelProviderJob,
	stageDeleteProviderFile,
	stageProviderFile,
	stageProviderJob,
	stageReadProviderJob,
	stageReadProviderResult,
} from './llama-cloud';
import { isAllowedPublicPdfUrl, llamaParseFallbackReason, wholeDocumentMarkdown } from './llama-parse-policy';
import { type LocalPdfAcquisition, requireUsableLocalPdf } from './pdf';

export type { PdfWorkflowIdentity } from './llama-cloud';

type FallbackLog = {
	billedCredits?: number | null;
	error?: unknown;
	file?: ProviderFile;
	finishedAt?: number;
	job?: ProviderJob;
	local: LocalPdfAcquisition;
	outcome: string;
};

function logFallback(input: FallbackLog): void {
	const error = input.error ? providerError(input.error) : null;
	console.info({
		tag: 'PDF_PARSE',
		event: 'llamaparse_fallback',
		provider: 'llamaparse',
		provider_base_region: 'us',
		provider_file_id: input.file?.fileId ?? null,
		provider_job_id: input.job?.jobId ?? null,
		provider_sdk_version: LLAMA_CLOUD_SDK_VERSION,
		provider_status: error?.status ?? null,
		provider_error: error?.name ?? null,
		tier: LLAMA_PARSE_TIER,
		parser_version: LLAMA_PARSE_VERSION,
		page_count: input.local.parse.totalPages,
		local_hard_defects: input.local.parse.hardDefects,
		outcome: input.outcome,
		latency_ms: input.file && input.finishedAt !== undefined ? Math.max(0, input.finishedAt - input.file.startedAt) : null,
		billed_credits: input.billedCredits ?? input.job?.billedCredits ?? null,
	});
}

function localMaterial(local: LocalPdfAcquisition) {
	return requireUsableLocalPdf(local, 'Public PDF');
}

async function cleanupFile(step: WorkflowStep, credentials: ProviderCredentials, file: ProviderFile): Promise<void> {
	await stageDeleteProviderFile(step, { credentials, fileId: file.fileId });
}

async function abandonJob(
	step: WorkflowStep,
	input: { credentials: ProviderCredentials; file: ProviderFile; job: ProviderJob; workflow: PdfWorkflowIdentity },
): Promise<void> {
	await stageCancelProviderJob(step, {
		credentials: input.credentials,
		jobId: input.job.jobId,
		workflowInstanceId: input.workflow.instanceId,
	});
	await cleanupFile(step, input.credentials, input.file);
}

/** Local-first public PDF resolution with one bounded, compensated paid fallback. */
export async function resolvePublicPdfAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		local: LocalPdfAcquisition;
		processingId: string;
		source: PublicPdfProviderSource;
		summary: 'derive' | 'preserve';
		workflow: PdfWorkflowIdentity;
	},
) {
	const credentials = {
		apiKey: env.LLAMA_CLOUD_API_KEY?.trim() ?? '',
		projectId: env.LLAMA_CLOUD_PROJECT_ID?.trim() ?? '',
	};
	const admission = llamaParseFallbackReason({
		enabled: env.LLAMA_PARSE_FALLBACK_ENABLED,
		hasApiKey: !!credentials.apiKey,
		hasProjectId: !!credentials.projectId,
		local: input.local.parse,
		scope: 'public',
	});
	if (admission !== 'admitted' || !isAllowedPublicPdfUrl(input.source.url)) {
		logFallback({ local: input.local, outcome: admission === 'admitted' ? 'source-ineligible' : admission });
		return localMaterial(input.local);
	}

	let file: ProviderFile;
	try {
		file = await stageProviderFile(env, step, { credentials, source: input.source, workflow: input.workflow });
	} catch (error) {
		const ambiguous = isAmbiguousProviderMutation(error);
		logFallback({ error, local: input.local, outcome: ambiguous ? 'operator-reconciliation-required' : 'upload-failed' });
		if (ambiguous) throw error;
		return localMaterial(input.local);
	}

	let job: ProviderJob;
	try {
		job = await stageProviderJob(step, {
			credentials,
			file,
			parserVersion: input.local.parse.parserVersion,
			processingId: input.processingId,
			workflow: input.workflow,
		});
	} catch (error) {
		const ambiguous = isAmbiguousProviderMutation(error);
		logFallback({ error, file, local: input.local, outcome: ambiguous ? 'operator-reconciliation-required' : 'job-create-failed' });
		if (ambiguous) throw error;
		await cleanupFile(step, credentials, file);
		return localMaterial(input.local);
	}

	let state = job;
	let fallback: FallbackLog | null = null;
	try {
		for (let attempt = 1; !isTerminalProviderStatus(state.status) && attempt <= LLAMA_PARSE_MAX_POLL_ATTEMPTS; attempt++) {
			await step.sleep(`llamaparse-poll-wait-${attempt}`, LLAMA_PARSE_POLL_INTERVAL);
			state = await stageReadProviderJob(step, { attempt, credentials, jobId: job.jobId });
		}
		if (!isTerminalProviderStatus(state.status)) {
			await abandonJob(step, { credentials, file, job, workflow: input.workflow });
			fallback = { file, finishedAt: state.observedAt, job: state, local: input.local, outcome: 'timed-out' };
		} else if (state.status !== 'COMPLETED') {
			await cleanupFile(step, credentials, file);
			fallback = {
				file,
				finishedAt: state.observedAt,
				job: state,
				local: input.local,
				outcome: `job-${state.status.toLowerCase()}`,
			};
		} else {
			const result = await stageReadProviderResult(step, { credentials, jobId: job.jobId });
			const markdown = wholeDocumentMarkdown(result.result.markdown?.pages, input.local.parse.totalPages ?? 0);
			await cleanupFile(step, credentials, file);
			fallback = {
				billedCredits: result.result.job.usage?.credits,
				file,
				finishedAt: result.finishedAt,
				job: state,
				local: input.local,
				outcome: markdown ? 'cloud-replaced-local' : 'incomplete-cloud-result',
			};
			if (markdown) {
				logFallback(fallback);
				return {
					...input.local.material,
					markdown,
					paperIdentifierText: markdown.slice(0, 20_000),
					...(input.summary === 'derive' ? { summary: markdown.slice(0, 500) || null } : {}),
				};
			}
		}
	} catch (error) {
		if (isAmbiguousProviderMutation(error)) throw error;
		try {
			await abandonJob(step, { credentials, file, job, workflow: input.workflow });
		} catch (cancelError) {
			logFallback({ error: cancelError, file, job, local: input.local, outcome: 'operator-reconciliation-required' });
			throw cancelError;
		}
		logFallback({ error, file, job, local: input.local, outcome: 'provider-failed' });
		return localMaterial(input.local);
	}
	logFallback(fallback);
	return localMaterial(input.local);
}
