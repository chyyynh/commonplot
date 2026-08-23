const LETTER = /\p{L}/u;
const NUMBER = /\p{N}/u;
const SYMBOL_OR_PUNCTUATION = /[\p{P}\p{S}]/u;
const UNSAFE_PDF_TEXT_SOURCE = String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]`;
const UNSAFE_PDF_TEXT = new RegExp(UNSAFE_PDF_TEXT_SOURCE, 'gu');
const MIN_UNSAFE_CHARACTERS = 3;
const MIN_UNSAFE_RATIO = 0.002;
const MIN_SYMBOL_SAMPLE = 256;
const MIN_SYMBOL_RATIO = 0.45;
const MIN_BINARY_LIKE_RUN = 80;

export type PdfTextSanitationSummary = Readonly<{
	checkedCharacters: number;
	strippedControlCharacters: number;
	strippedReplacementCharacters: number;
	unsafeRatio: number;
	symbolRatio: number;
	longestNonWhitespaceRun: number;
	isGarbled: boolean;
	reasons: string[];
}>;

export type PdfTextSanitation = PdfTextSanitationSummary & Readonly<{ text: string }>;

function isUnsafePdfTextCharacter(character: string): boolean {
	const codePoint = character.codePointAt(0);
	return (
		codePoint === 0xfffd ||
		codePoint === 0x0b ||
		codePoint === 0x0c ||
		(codePoint !== undefined && (codePoint <= 0x08 || (codePoint >= 0x0e && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f)))
	);
}

export function stripUnsafePdfText(text: string): string {
	return text.replace(UNSAFE_PDF_TEXT, '');
}

type PdfTextCounters = {
	checkedCharacters: number;
	strippedControlCharacters: number;
	strippedReplacementCharacters: number;
	letters: number;
	numbers: number;
	symbols: number;
	longestNonWhitespaceRun: number;
};

function scanPdfText(text: string, counters: PdfTextCounters): void {
	let nonWhitespaceRun = 0;
	for (const character of text) {
		counters.checkedCharacters += 1;
		if (character === '\uFFFD') {
			counters.strippedReplacementCharacters += 1;
			continue;
		}
		if (isUnsafePdfTextCharacter(character)) {
			counters.strippedControlCharacters += 1;
			continue;
		}
		if (/\s/u.test(character)) {
			nonWhitespaceRun = 0;
			continue;
		}
		nonWhitespaceRun += 1;
		counters.longestNonWhitespaceRun = Math.max(counters.longestNonWhitespaceRun, nonWhitespaceRun);
		if (LETTER.test(character)) counters.letters += 1;
		else if (NUMBER.test(character)) counters.numbers += 1;
		else if (SYMBOL_OR_PUNCTUATION.test(character)) counters.symbols += 1;
	}
}

export function assessPdfTexts(texts: readonly string[]): PdfTextSanitationSummary {
	const counters: PdfTextCounters = {
		checkedCharacters: 0,
		strippedControlCharacters: 0,
		strippedReplacementCharacters: 0,
		letters: 0,
		numbers: 0,
		symbols: 0,
		longestNonWhitespaceRun: 0,
	};
	for (const text of texts) scanPdfText(text, counters);

	const unsafeCharacters = counters.strippedControlCharacters + counters.strippedReplacementCharacters;
	const significantCharacters = counters.letters + counters.numbers + counters.symbols;
	const symbolRatio = significantCharacters === 0 ? 0 : counters.symbols / significantCharacters;
	const unsafeRatio = counters.checkedCharacters === 0 ? 0 : unsafeCharacters / counters.checkedCharacters;
	const reasons: string[] = [];
	// A couple of stray controls are stripped without failing useful prose. A
	// repeated density signal catches decoded stream bytes and replacement runs.
	if (unsafeCharacters >= MIN_UNSAFE_CHARACTERS && unsafeRatio >= MIN_UNSAFE_RATIO) reasons.push('unsafe-character-density');
	// Printable binary encodings can avoid controls entirely. Require a large,
	// symbol-heavy, unbroken run so equations and ordinary code stay valid.
	if (
		significantCharacters >= MIN_SYMBOL_SAMPLE &&
		symbolRatio >= MIN_SYMBOL_RATIO &&
		counters.longestNonWhitespaceRun >= MIN_BINARY_LIKE_RUN
	) {
		reasons.push('symbol-density');
	}

	return {
		checkedCharacters: counters.checkedCharacters,
		strippedControlCharacters: counters.strippedControlCharacters,
		strippedReplacementCharacters: counters.strippedReplacementCharacters,
		unsafeRatio,
		symbolRatio,
		longestNonWhitespaceRun: counters.longestNonWhitespaceRun,
		isGarbled: reasons.length > 0,
		reasons,
	};
}

export function sanitizePdfText(text: string): PdfTextSanitation {
	return { text: stripUnsafePdfText(text), ...assessPdfTexts([text]) };
}
