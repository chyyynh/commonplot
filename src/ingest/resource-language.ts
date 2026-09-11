import { franc } from 'franc-min';
import { Converter } from 'opencc-js';
import { canonicalizeResourceLang } from '../shared/resource';

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
