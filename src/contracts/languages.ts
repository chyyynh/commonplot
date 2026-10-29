/**
 * The languages Core writes a Resource's text in, kept here once: web-tanstack imports this file as is, so it imports
 * nothing. Every titled Resource gets a card in each summary language, its title and summary written together rather
 * than translated one by one; its content is translated only into a content translation language.
 */
export const SUMMARY_LANGS = ['zh-Hant', 'en'] as const;
export type SummaryLang = (typeof SUMMARY_LANGS)[number];

/** How a prompt names each Unicode script a summary language is written in. */
export const SCRIPT_NAMES = { Han: 'Chinese characters', Latin: 'Latin letters' } as const;

/**
 * Each summary language as a prompt names it and checks it. `scripts` are the Unicode scripts its prose is written in;
 * output in any other script, Latin and Greek aside, is a word the model left untranslated, and the prompt's rule on
 * names comes from them too. `style` is any convention of the language beyond that.
 */
export const LANGUAGES = {
	'zh-Hant': {
		name: 'Taiwan Traditional Chinese (繁體中文, zh-Hant)',
		scripts: ['Han'],
		style: 'Use Taiwan vocabulary and full-width punctuation.',
	},
	en: { name: 'English', scripts: ['Latin'], style: '' },
} as const satisfies Record<SummaryLang, { name: string; scripts: readonly (keyof typeof SCRIPT_NAMES)[]; style: string }>;

export const CONTENT_TRANSLATION_LANGS = ['zh-Hant'] as const satisfies readonly SummaryLang[];
export type ContentTranslationLang = (typeof CONTENT_TRANSLATION_LANGS)[number];
