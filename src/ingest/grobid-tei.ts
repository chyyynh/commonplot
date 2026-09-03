import { normalizeArxivId, normalizeDoi, paperIdentityFromText } from '../shared/paper-identity.ts';

export type GrobidReferenceIdentifiers = Readonly<{
	arxivId: string | null;
	doi: string | null;
	url: string | null;
}>;

export type GrobidPdfHeader = GrobidReferenceIdentifiers &
	Readonly<{
		authors: string[];
		title: string | null;
	}>;

/** A stored PDF becomes a paper only when GROBID extracts a canonical academic identifier. */
export function grobidPaperIdentifierText(header: GrobidPdfHeader): string | null {
	const identifiers = [header.doi ? `DOI: ${header.doi}` : null, header.arxivId ? `arXiv: ${header.arxivId}` : null].filter(
		(value): value is string => value !== null,
	);
	return identifiers.length ? identifiers.join('\n') : null;
}

const TITLE_PATTERN = /<title\b([^>]*)>([\s\S]*?)<\/title>/gi;
const AUTHOR_PATTERN = /<author\b[^>]*>([\s\S]*?)<\/author>/gi;
const PERS_NAME_PATTERN = /<persName\b[^>]*>([\s\S]*?)<\/persName>/i;
const IDNO_PATTERN = /<idno\b([^>]*)>([\s\S]*?)<\/idno>/gi;
const PTR_PATTERN = /<ptr\b([^>]*)\/?\s*>/gi;
const MAX_IDENTIFIER_CHARS = 300;
const MAX_REFERENCE_URL_CHARS = 500;
const MAX_HEADER_AUTHORS = 100;
const MAX_HEADER_NAME_CHARS = 300;
const MAX_HEADER_TITLE_CHARS = 500;

function decodeXml(value: string): string {
	return value.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|apos|gt|lt|quot);/gi, (entity, decimal: string, hexadecimal: string) => {
		if (decimal) return String.fromCodePoint(Number(decimal));
		if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
		return { '&amp;': '&', '&apos;': "'", '&gt;': '>', '&lt;': '<', '&quot;': '"' }[entity.toLowerCase()] ?? entity;
	});
}

function attribute(attributes: string, name: string): string | null {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes);
	return match ? decodeXml(match[1] ?? match[2] ?? '').trim() || null : null;
}

function validHttpUrl(value: string | null): string | null {
	if (!value || value.length > MAX_REFERENCE_URL_CHARS) return null;
	const parsed = URL.parse(value);
	if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) return null;
	return parsed.toString();
}

function elementText(xml: string): string {
	return decodeXml(xml.replace(/<[^>]*>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim();
}

function identifiersFromBiblStruct(xml: string): GrobidReferenceIdentifiers {
	let doi: string | null = null;
	let arxivId: string | null = null;
	IDNO_PATTERN.lastIndex = 0;
	for (let match = IDNO_PATTERN.exec(xml); match !== null; match = IDNO_PATTERN.exec(xml)) {
		const type = attribute(match[1] ?? '', 'type')?.toLowerCase();
		const value = decodeXml((match[2] ?? '').replace(/<[^>]*>/g, ' '))
			.replace(/\s+/g, ' ')
			.trim();
		if (!value || value.length > MAX_IDENTIFIER_CHARS) continue;
		if (type === 'doi') doi ??= normalizeDoi(value);
		else if (type === 'arxiv') arxivId ??= normalizeArxivId(value.replace(/\s*\[[^\]]+\]\s*$/, ''));
		else {
			const identity = paperIdentityFromText(value);
			doi ??= identity?.doi ?? null;
			arxivId ??= identity?.arxivId ?? null;
		}
	}

	let pointerUrl: string | null = null;
	PTR_PATTERN.lastIndex = 0;
	for (let match = PTR_PATTERN.exec(xml); match !== null && pointerUrl === null; match = PTR_PATTERN.exec(xml)) {
		pointerUrl = validHttpUrl(attribute(match[1] ?? '', 'target'));
	}
	doi ??= normalizeDoi(pointerUrl);
	arxivId ??= normalizeArxivId(pointerUrl);

	return {
		arxivId,
		doi,
		url: doi ? `https://doi.org/${doi}` : arxivId ? `https://arxiv.org/abs/${arxivId}` : pointerUrl,
	};
}

/** The uploaded-PDF paper gate uses only metadata extracted by GROBID itself. */
export function parseGrobidPdfHeaderTei(tei: string): GrobidPdfHeader {
	let title: string | null = null;
	TITLE_PATTERN.lastIndex = 0;
	for (let match = TITLE_PATTERN.exec(tei); match !== null; match = TITLE_PATTERN.exec(tei)) {
		const attributes = match[1] ?? '';
		if (attribute(attributes, 'type')?.toLowerCase() !== 'main' && attribute(attributes, 'level')?.toLowerCase() !== 'a') continue;
		const candidate = elementText(match[2] ?? '').slice(0, MAX_HEADER_TITLE_CHARS);
		if (candidate) {
			title = candidate;
			break;
		}
	}

	const authors: string[] = [];
	const seenAuthors = new Set<string>();
	AUTHOR_PATTERN.lastIndex = 0;
	for (let match = AUTHOR_PATTERN.exec(tei); match !== null && authors.length < MAX_HEADER_AUTHORS; match = AUTHOR_PATTERN.exec(tei)) {
		const authorXml = match[1] ?? '';
		const name = elementText(PERS_NAME_PATTERN.exec(authorXml)?.[1] ?? authorXml).slice(0, MAX_HEADER_NAME_CHARS);
		const key = name.toLocaleLowerCase('en-US');
		if (!name || seenAuthors.has(key)) continue;
		seenAuthors.add(key);
		authors.push(name);
	}

	return { ...identifiersFromBiblStruct(tei), authors, title };
}
