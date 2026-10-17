import { z } from 'zod';
import { isWrittenIn } from '../contracts/resource-language';
import type { DerivationSource, SummaryLang } from '../store/derivations';
import { generateObject } from './ai-model';

const ANALYSIS_CONTENT_MAX_LENGTH = 10_000;
const ANALYSIS_MODEL = 'google/gemini-3.5-flash-lite';
const DESCRIPTION_MAX_LENGTH = 1_500;

const SUMMARY_TARGETS = {
	'zh-Hant': {
		language: 'Taiwan Traditional Chinese (繁體中文, zh-Hant)',
		style: `Use Taiwan vocabulary and full-width punctuation. Write only in Traditional Chinese characters or Latin script: never Simplified Chinese, Japanese kana or Korean Hangul.
Give Korean and Japanese names of people, companies, places and products their established Taiwan Chinese form (두산 → 斗山, SK하이닉스 → SK海力士, 삼성전자 → 三星電子), or Latin script when there is none; translate terms too (D램 → DRAM, 나노 → 奈米, ペルソナ → 人物設定).`,
		last: 'Translate every Korean and Japanese word: the summary holds no Hangul or kana.',
	},
	en: {
		language: 'English',
		style: 'Keep established English names of people, organizations and products.',
		last: '',
	},
} as const;

function analysisPrompt(resource: DerivationSource) {
	const description = resource.description?.trim().substring(0, DESCRIPTION_MAX_LENGTH);
	return `${resource.title ? `Title: ${resource.title}\n` : ''}Source: ${resource.source.trim()}
Kind: ${resource.kind}
Platform: ${resource.resourcePlatform ?? 'none'}
${description ? `Source's own description (may be boilerplate or link lists; use only what the content supports): ${description}\n` : ''}Content:
${resource.content.trim().substring(0, ANALYSIS_CONTENT_MAX_LENGTH)}`;
}

/** A summary written directly in `lang`; output in any other language is rejected so the step retries. */
export async function summarizeResource(resource: DerivationSource, lang: SummaryLang, env: CoreEnv, processingId: string) {
	const startedAt = performance.now();
	const { output, outputTokens } = await generateObject(
		env,
		ANALYSIS_MODEL,
		{ feature: 'resource-summary', processing_id: processingId, target_lang: lang },
		{
			// The language comes last too: a model summarizing a Japanese original otherwise drifts into Japanese.
			prompt: `${analysisPrompt(resource)}\n\nWrite the summary in ${SUMMARY_TARGETS[lang].language}. ${SUMMARY_TARGETS[lang].last}`.trim(),
			system: `Write a 1–2 sentence summary in ${SUMMARY_TARGETS[lang].language}, whatever the original language.
${SUMMARY_TARGETS[lang].style}
Preserve attribution, tone, limitations and uncertainty; add nothing the content does not say.
A discussion thread's summary describes the discussion; a short post's summary is proportionate to it.
Plain text only: no Markdown, LaTeX or other markup.`,
			output: { name: 'resource_summary', schema: z.object({ summary: z.string().trim().min(1) }) },
			maxTokens: 1000,
			temperature: 0.3,
		},
	);
	if (!isWrittenIn(output.summary, lang)) throw new Error(`Summary is not written in ${lang}: ${output.summary.slice(0, 200)}`);
	console.info({
		tag: 'AI',
		event: 'summary_completed',
		processing_id: processingId,
		model: ANALYSIS_MODEL,
		target_lang: lang,
		latency_ms: Math.round(performance.now() - startedAt),
		output_tokens: outputTokens,
	});
	return output.summary;
}
