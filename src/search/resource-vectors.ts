import { RESOURCE_KINDS } from '../contracts/resource-kinds';
import { isEnglishLanguage } from '../contracts/resource-language';
import { coreGatewayOptions } from '../services/ai-model';
import type { CorpusDocument } from './search-index';

// Postgres is canonical; RESOURCE_VECTORS holds one vector per searchable corpus Resource, for recommendations.
const EMBEDDING_MODEL = '@cf/baai/bge-m3';
// bge-m3 reads at most 512 tokens; English title and summary fit well inside that.
const VECTOR_TEXT_MAX_CHARS = 1_500;

/**
 * Every vector reads English where the Resource has it, so neighbours compare like with like. An untitled kind's text
 * opens with the text itself; Resources without English fall back to their original.
 */
function resourceVectorText(document: CorpusDocument): string {
	const original = document.translations.find((translation) => translation.lang === document.original_lang);
	const english = isEnglishLanguage(document.original_lang)
		? original
		: (document.translations.find((translation) => translation.lang === 'en' && translation.title?.trim()) ?? original);
	if (!english) throw new Error(`Resource vector ${document.id} is missing its ${document.original_lang} translation`);
	const parts = RESOURCE_KINDS[document.kind].titled ? [english.title, english.summary] : [english.content];
	const text = parts
		.map((part) => part?.replace(/\s+/g, ' ').trim())
		.filter(Boolean)
		.join('\n')
		.slice(0, VECTOR_TEXT_MAX_CHARS);
	if (!text) throw new Error(`Resource vector ${document.id} has no text`);
	return text;
}

/** Upserts the current documents' vectors and deletes the rest, in one embedding call and one write each. */
export async function syncResourceVectors(
	env: CoreEnv,
	documents: readonly CorpusDocument[],
	deletedIds: readonly string[],
): Promise<void> {
	if (documents.length) {
		const texts = documents.map(resourceVectorText);
		const output = await env.AI.run(EMBEDDING_MODEL, { text: texts }, coreGatewayOptions(env, { feature: 'resource-vectors' }));
		const vectors = 'data' in output ? output.data : undefined;
		if (!vectors || vectors.length !== texts.length)
			throw new Error(`${EMBEDDING_MODEL} returned ${vectors?.length ?? 0} of ${texts.length} vectors`);
		await env.RESOURCE_VECTORS.upsert(
			documents.map((document, index) => ({
				id: document.id,
				values: vectors[index]!,
				metadata: {
					kind: document.kind,
					// Unix seconds: Vectorize filters ranges on numbers only.
					...(document.published_at === null ? {} : { published_at: Math.floor(new Date(document.published_at).getTime() / 1000) }),
					// Carriers such as HN threads and reposts name the Resource they discuss.
					...(document.subject_id ? { subject_id: document.subject_id } : {}),
				},
			})),
		);
	}
	if (deletedIds.length) await env.RESOURCE_VECTORS.deleteByIds([...deletedIds]);
}
