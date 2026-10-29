import { franc } from 'franc-min';
import { Converter } from 'opencc-js';
import { z } from 'zod';
import { LANGUAGE_SCRIPTS, type SummaryLang } from './languages';

export const ResourceLanguageSchema = z
	.string()
	.trim()
	.min(1)
	.max(35)
	.transform((value, ctx) => {
		try {
			const locale = new Intl.Locale(value.replaceAll('_', '-'));
			if (locale.language !== 'zh') return locale.toString();
			// Store Chinese by script; bare zh stays unknown until the text is inspected.
			const script = locale.script ?? (locale.region ? locale.maximize().script : undefined);
			return script ? `zh-${script}` : 'zh';
		} catch {
			ctx.issues.push({ code: 'custom', message: 'Invalid resource language', input: value });
			return z.NEVER;
		}
	})
	.pipe(z.string().max(35));

let converters: { toTraditional: (text: string) => string; toSimplified: (text: string) => string } | undefined;

/** OpenCC converters, built on first use. */
function chineseConverters() {
	return (converters ??= {
		toTraditional: Converter({ from: 'cn', to: 'tw' }),
		toSimplified: Converter({ from: 'tw', to: 'cn' }),
	});
}

/**
 * The language a text's script shows when Han, kana or Hangul is over 30% of its letters. franc misreads such text
 * mixed with English words (Chinese posts naming products come back as French), and a site may tag it `en`.
 */
function cjkLanguage(text: string): 'ko' | 'ja' | 'zh' | null {
	const letters = text.match(/\p{L}/gu)?.length ?? 0;
	const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
	const kana = text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
	const hangul = text.match(/\p{Script=Hangul}/gu)?.length ?? 0;
	if (!letters || (han + kana + hangul) / letters <= 0.3) return null;
	if (hangul >= han + kana) return 'ko';
	return kana > (han + kana) * 0.1 ? 'ja' : 'zh';
}

/**
 * Local detection only; uncertain text stays und instead of incurring an AI request. A declared language is trusted
 * unless it is written in Latin script and the text is mostly CJK.
 */
export function detectResourceLanguage(content: string, knownLanguage = 'und'): string {
	const known = ResourceLanguageSchema.parse(knownLanguage);
	const text = content
		.replace(/```[^]*?```|~~~[^]*?~~~/g, ' ')
		.replace(/`[^`\n]*`|https?:\/\/\S+|<[^>]+>/g, ' ')
		.trim()
		.slice(0, 20_000);
	const cjk = cjkLanguage(text);
	const contradicted = cjk !== null && known !== 'und' && new Intl.Locale(known).maximize().script === 'Latn';
	if (known !== 'und' && known !== 'zh' && !contradicted) return known;
	if ((text.match(/\p{L}/gu)?.length ?? 0) < 20) return known;
	const detected = cjk ?? ResourceLanguageSchema.parse(franc(text, { minLength: 20 }));
	if (detected === 'und') return known;
	if (detected !== 'zh') return detected;
	const chars = [...text];
	const difference = (converted: string) => [...converted].filter((char, index) => char !== chars[index]).length;
	const { toTraditional, toSimplified } = chineseConverters();
	const simplified = difference(toTraditional(text));
	const traditional = difference(toSimplified(text));
	return traditional > simplified ? 'zh-Hant' : simplified > traditional ? 'zh-Hans' : 'zh';
}

/**
 * Whether generated prose reads as `lang`: every letter is in one of the language's scripts, or Latin or Greek, which
 * spell names and symbols in any language, and the language's own scripts carry at least half of the words. A word
 * in any other script is one the model left untranslated (a Korean company name in a Chinese summary).
 */
export function isWrittenIn(text: string, lang: SummaryLang): boolean {
	const scripts = LANGUAGE_SCRIPTS[lang];
	const letters = text.match(/\p{L}/gu)?.length ?? 0;
	// A model that breaks off mid-reply sometimes spells the rest as `\uXXXX` escapes.
	if (!letters || /\\u[\da-f]{4}/iu.test(text)) return false;
	const own = text.match(new RegExp(`[${scripts.map((script) => `\\p{Script=${script}}`).join('')}]`, 'gu'))?.length ?? 0;
	const latinScript = scripts.includes('Latin');
	const shared = text.match(latinScript ? /\p{Script=Greek}/gu : /[\p{Script=Latin}\p{Script=Greek}]/gu)?.length ?? 0;
	if (own + shared < letters) return false;
	if (latinScript) return own > 0;
	// Latin names count as words, so prose naming products in English still reads as written in `lang`.
	const nameWords = text.match(/[\p{Script=Latin}\p{Script=Greek}]+/gu)?.length ?? 0;
	return own / (own + nameWords) >= 0.5;
}

/**
 * Recommendation vectors read English, so every other named language gets an English title. English, or a code for no
 * linguistic content, undetermined or private-use text, needs none: an English title would add nothing.
 */
export function needsEnglishMetadata(lang: string): boolean {
	return !/^(en|zxx|und|mis|mul|art|q[a-t][a-z])(-|$)/i.test(lang);
}
