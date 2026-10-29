/**
 * The languages Core writes a Resource's text in, kept here once: web-tanstack imports this file as is, so it imports
 * nothing. Every titled Resource gets a card in each summary language, its title and summary written together rather
 * than translated one by one; its content is translated only into a content translation language.
 */
export const SUMMARY_LANGS = ['zh-Hant', 'en'] as const;
export type SummaryLang = (typeof SUMMARY_LANGS)[number];

/**
 * Each summary language as a prompt names it and checks it. `scripts` are the Unicode scripts its prose is written in;
 * output in any other script, Latin and Greek aside, is a word the model left untranslated. `style` is how names and
 * terms read in it, and `last` what the prompt repeats at its end, where a model drifting into the original's
 * language needs it.
 */
export const LANGUAGES = {
	'zh-Hant': {
		name: 'Taiwan Traditional Chinese (繁體中文, zh-Hant)',
		scripts: ['Han'],
		style: `Use Taiwan vocabulary and full-width punctuation. Write only in Traditional Chinese characters or Latin script: never Simplified Chinese, Japanese kana or Korean Hangul.
Give Korean and Japanese names of people, companies, places and products their established Taiwan Chinese form (두산 → 斗山, SK하이닉스 → SK海力士, 삼성전자 → 三星電子), or Latin script when there is none; translate terms too (D램 → DRAM, 나노 → 奈米, ペルソナ → 人物設定).`,
		last: 'Translate every Korean and Japanese word: the text holds no Hangul or kana.',
	},
	en: {
		name: 'English',
		scripts: ['Latin'],
		style: 'Keep established English names of people, organizations and products.',
		last: '',
	},
} as const satisfies Record<SummaryLang, { name: string; scripts: readonly string[]; style: string; last: string }>;

export const CONTENT_TRANSLATION_LANGS = ['zh-Hant'] as const satisfies readonly SummaryLang[];
export type ContentTranslationLang = (typeof CONTENT_TRANSLATION_LANGS)[number];
