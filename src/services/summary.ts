import { z } from 'zod';
import type { AcquiredResource } from '../contracts/acquired-resource';
import type { ResourceKind } from '../contracts/resource';
import { generateObject } from './ai-model';

const ANALYSIS_CONTENT_MAX_LENGTH = 10_000;
const ANALYSIS_MODEL = 'google/gemini-3.5-flash-lite';

/** An acquired original, or a stored one whose summary is derived later. */
type SummarySource = Pick<AcquiredResource, 'title' | 'summary' | 'content' | 'source' | 'originalLang' | 'resourcePlatform'> & {
	kind: ResourceKind;
};

function analysisPrompt(resource: SummarySource) {
	return `文章資訊:
${resource.title ? `標題: ${resource.title}\n` : ''}來源: ${resource.source.trim()}
資源種類: ${resource.kind}
資源平台: ${resource.resourcePlatform ?? 'none'}
原文語言: ${resource.originalLang}
來源摘要: ${resource.summary ?? '未提供'}
內容:
${resource.content.trim().substring(0, ANALYSIS_CONTENT_MAX_LENGTH)}`;
}

/** Called only when acquisition supplied no summary. */
export async function summarizeResource(resource: SummarySource, env: CoreEnv, processingId: string) {
	const startedAt = performance.now();
	const { output, outputTokens } = await generateObject(
		env,
		ANALYSIS_MODEL,
		{ feature: 'resource-summary', processing_id: processingId },
		{
			prompt: analysisPrompt(resource),
			system: `以指定原文語言撰寫 1–2 句摘要；原文語言為 und 時使用內容的主要語言。
只產生一種語言，保留歸屬、語氣、限制與不確定性，不加入正文沒有的資訊。
討論串摘要描述討論內容；短貼文摘要長度應與原文相稱。`,
			output: { name: 'resource_summary', schema: z.object({ summary: z.string().trim().min(1) }) },
			maxTokens: 1000,
			temperature: 0.3,
		},
	);
	console.info({
		tag: 'AI',
		event: 'summary_completed',
		processing_id: processingId,
		model: ANALYSIS_MODEL,
		latency_ms: Math.round(performance.now() - startedAt),
		output_tokens: outputTokens,
	});
	return output.summary;
}
