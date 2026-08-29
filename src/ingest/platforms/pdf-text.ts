const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const SYMBOL_OR_PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/u;

function isUnsafePdfTextCharacter(character: string): boolean {
	const codePoint = character.codePointAt(0);
	return (
		codePoint === 0xfffd ||
		codePoint === 0x0b ||
		codePoint === 0x0c ||
		(codePoint !== undefined && (codePoint <= 0x08 || (codePoint >= 0x0e && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f)))
	);
}

/** Drop decoded PDF stream garbage without rejecting ordinary prose, code, or equations. */
export function usablePdfMarkdown(markdown: string, parserMarkedGarbled: boolean): string {
	let clean = '';
	let checked = 0;
	let unsafe = 0;
	let significant = 0;
	let symbols = 0;
	let run = 0;
	let longestRun = 0;
	for (const character of markdown) {
		checked++;
		if (isUnsafePdfTextCharacter(character)) {
			unsafe++;
			continue;
		}
		clean += character;
		if (WHITESPACE.test(character)) {
			run = 0;
			continue;
		}
		run++;
		longestRun = Math.max(longestRun, run);
		if (LETTER_OR_NUMBER.test(character)) significant++;
		else if (SYMBOL_OR_PUNCTUATION.test(character)) {
			significant++;
			symbols++;
		}
	}
	const unsafeGarbage = unsafe >= 3 && unsafe / Math.max(1, checked) >= 0.002;
	const printableGarbage = significant >= 256 && symbols / significant >= 0.45 && longestRun >= 80;
	if (parserMarkedGarbled || unsafeGarbage || printableGarbage) return '';
	clean = clean.trim();
	return LETTER_OR_NUMBER.test(clean) ? clean : '';
}
