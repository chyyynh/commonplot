import { franc } from 'franc-min';
import { Converter } from 'opencc-js';

const RESOURCE_LANG_MAX_LENGTH = 35;

export function canonicalizeResourceLang(value: unknown): string {
	if (typeof value !== 'string') throw new Error(`Invalid resource language: ${String(value)}`);
	const lang = value.trim();
	if (!lang || lang.length > RESOURCE_LANG_MAX_LENGTH) throw new Error(`Invalid resource language: ${value}`);
	try {
		const canonical = Intl.getCanonicalLocales(lang)[0];
		if (!canonical || canonical.length > RESOURCE_LANG_MAX_LENGTH) throw new Error('Invalid locale');
		return canonical;
	} catch {
		throw new Error(`Invalid resource language: ${value}`);
	}
}

export function canonicalizeOptionalResourceLang(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const lang = value.trim().replaceAll('_', '-');
	if (!lang || lang.toLowerCase() === 'und') return null;
	try {
		return canonicalizeResourceLang(lang);
	} catch {
		return null;
	}
}

let chineseConverters: { toTraditional: (text: string) => string; toSimplified: (text: string) => string } | undefined;

/** Local detection only; uncertain text stays und instead of incurring an AI request. */
export function detectResourceLanguage(content: string, knownLanguage = 'und'): string {
	const known = canonicalizeResourceLang(knownLanguage);
	if (known !== 'und' && known !== 'zh') return known;
	const text = content
		.replace(/```[^]*?```|~~~[^]*?~~~/g, ' ')
		.replace(/`[^`\n]*`|https?:\/\/\S+|<[^>]+>/g, ' ')
		.trim()
		.slice(0, 20_000);
	if ((text.match(/\p{L}/gu)?.length ?? 0) < 20) return known;
	const detected = canonicalizeResourceLang(franc(text, { minLength: 20 }));
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
