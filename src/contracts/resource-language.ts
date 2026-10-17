import { franc } from 'franc-min';
import { Converter } from 'opencc-js';
import { z } from 'zod';

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

let chineseConverters: { toTraditional: (text: string) => string; toSimplified: (text: string) => string } | undefined;

/** Local detection only; uncertain text stays und instead of incurring an AI request. */
export function detectResourceLanguage(content: string, knownLanguage = 'und'): string {
	const known = ResourceLanguageSchema.parse(knownLanguage);
	if (known !== 'und' && known !== 'zh') return known;
	const text = content
		.replace(/```[^]*?```|~~~[^]*?~~~/g, ' ')
		.replace(/`[^`\n]*`|https?:\/\/\S+|<[^>]+>/g, ' ')
		.trim()
		.slice(0, 20_000);
	if ((text.match(/\p{L}/gu)?.length ?? 0) < 20) return known;
	const detected = ResourceLanguageSchema.parse(franc(text, { minLength: 20 }));
	if (detected === 'und') return known;
	if (detected !== 'zh') return detected;
	chineseConverters ??= {
		toTraditional: Converter({ from: 'cn', to: 't' }),
		toSimplified: Converter({ from: 't', to: 'cn' }),
	};
	const chars = [...text];
	const difference = (converted: string) => [...converted].filter((char, index) => char !== chars[index]).length;
	const simplified = difference(chineseConverters.toTraditional(text));
	const traditional = difference(chineseConverters.toSimplified(text));
	return traditional > simplified ? 'zh-Hant' : simplified > traditional ? 'zh-Hans' : 'zh';
}

/**
 * Whether generated prose reads as `lang`: Taiwan Traditional Chinese with no Simplified forms, or English with no
 * CJK script. Names in other scripts may appear; the prose around them may not.
 */
export function isWrittenIn(text: string, lang: 'zh-Hant' | 'en'): boolean {
	const letters = text.match(/\p{L}/gu)?.length ?? 0;
	const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
	const otherCjk = text.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
	if (!letters || otherCjk) return false;
	if (lang === 'en') return han === 0 && (text.match(/\p{Script=Latin}/gu)?.length ?? 0) / letters >= 0.9;
	// Latin names count as words, so Chinese prose naming products in English still reads as Chinese.
	const latinWords = text.match(/\p{Script=Latin}+/gu)?.length ?? 0;
	if (han / (han + latinWords) < 0.5) return false;
	chineseConverters ??= {
		toTraditional: Converter({ from: 'cn', to: 't' }),
		toSimplified: Converter({ from: 't', to: 'cn' }),
	};
	const chars = [...text];
	const simplified = [...chineseConverters.toTraditional(text)].filter((char, index) => char !== chars[index]).length;
	return simplified <= Math.max(1, Math.floor(han / 50));
}

/**
 * English, or a code for no linguistic content, undetermined or private-use text: an English title would
 * add nothing. A POSIX pattern, so SQL applies the same rule to `original_lang` with `~*`.
 */
export const WITHOUT_ENGLISH_METADATA_LANG_PATTERN = '^(en|zxx|und|mis|mul|art|q[a-t][a-z])(-|$)';

export function isEnglishLanguage(lang: string): boolean {
	return /^en(-|$)/i.test(lang);
}

/** Recommendation vectors read English, so every other named language gets an English title. */
export function needsEnglishMetadata(lang: string): boolean {
	return !new RegExp(WITHOUT_ENGLISH_METADATA_LANG_PATTERN, 'i').test(lang);
}
