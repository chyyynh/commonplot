/**
 * The languages Core writes a Resource's text in, kept here once: web-tanstack imports this file as is, so it imports
 * nothing. Every titled Resource is summarized in each summary language, written directly rather than translated; its
 * content is translated only into a content translation language. English is otherwise only ever a title.
 */
export const SUMMARY_LANGS = ['zh-Hant', 'en'] as const;
export type SummaryLang = (typeof SUMMARY_LANGS)[number];

export const CONTENT_TRANSLATION_LANGS = ['zh-Hant'] as const;
export type ContentTranslationLang = (typeof CONTENT_TRANSLATION_LANGS)[number];
