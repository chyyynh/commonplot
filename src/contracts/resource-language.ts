import { LANGUAGES, type SummaryLang } from './languages';

/**
 * What Jev may answer an original's language is: every summary language, so a summary is never rewritten in its own
 * language, plus the ones a reader may need converted or translated. Any other language is `und`, which is written
 * in each summary language like the rest; `zxx` is no prose at all.
 */
export const DETECTED_LANGUAGES = {
	en: 'English',
	'zh-Hant': 'Chinese written in Traditional characters',
	'zh-Hans': 'Chinese written in Simplified characters',
	ja: 'Japanese',
	ko: 'Korean',
} as const satisfies Record<SummaryLang, string> & Record<string, string>;

/** A text's letters against `lang`: those in its own scripts, and whether any is in neither those nor Latin or Greek, which spell names anywhere. */
function scriptCounts(text: string, lang: SummaryLang) {
	const scripts: readonly string[] = LANGUAGES[lang].scripts;
	const letters = text.match(/\p{L}/gu)?.length ?? 0;
	const own = text.match(new RegExp(`[${scripts.map((script) => `\\p{Script=${script}}`).join('')}]`, 'gu'))?.length ?? 0;
	const latinScript = scripts.includes('Latin');
	const shared = text.match(latinScript ? /\p{Script=Greek}/gu : /[\p{Script=Latin}\p{Script=Greek}]/gu)?.length ?? 0;
	// A model that breaks off mid-reply sometimes spells the rest as `\uXXXX` escapes.
	const foreign = letters - own - shared > 0 || /\\u[\da-f]{4}/iu.test(text);
	return { letters, own, latinScript, foreign };
}

/**
 * Whether generated prose reads as `lang`: every letter is in one of the language's scripts, or Latin or Greek, which
 * spell names and symbols in any language, and the language's own scripts carry at least half of the words. A word
 * in any other script is one the model left untranslated (a Korean company name in a Chinese summary).
 */
export function isWrittenIn(text: string, lang: SummaryLang): boolean {
	const { letters, own, latinScript, foreign } = scriptCounts(text, lang);
	if (!letters || foreign) return false;
	if (latinScript) return own > 0;
	// Latin names count as words, so prose naming products in English still reads as written in `lang`.
	const nameWords = text.match(/[\p{Script=Latin}\p{Script=Greek}]+/gu)?.length ?? 0;
	return own / (own + nameWords) >= 0.5;
}

/** Whether a title may stand in `lang`: no script foreign to it. A title may be names alone, such as "GPT-5". */
export function isTitleIn(text: string, lang: SummaryLang): boolean {
	return text.trim() !== '' && !scriptCounts(text, lang).foreign;
}

/**
 * Whether an original is already written in `lang`, a region (`en-US`) included: its title and text are then that
 * language's, and nothing is translated into it.
 */
export function isWrittenInOriginal(originalLang: string, lang: SummaryLang): boolean {
	return originalLang === lang || originalLang.startsWith(`${lang}-`);
}
