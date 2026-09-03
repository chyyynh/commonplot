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

export type GrobidPdfReference = Readonly<{
	key: string;
	label: string | null;
	text: string;
}>;

export type GrobidPdfCitationMention = Readonly<{
	context: string;
	markerText: string;
	section: string | null;
	targetKeys: string[];
}>;

export type GrobidPdfFulltext = Readonly<{
	mentions: GrobidPdfCitationMention[];
	references: GrobidPdfReference[];
}>;

/** A stored PDF becomes a paper only when GROBID extracts a canonical academic identifier. */
export function grobidPaperIdentifierText(header: GrobidPdfHeader): string | null {
	const identifiers = [header.doi ? `DOI: ${header.doi}` : null, header.arxivId ? `arXiv: ${header.arxivId}` : null].filter(
		(value): value is string => value !== null,
	);
	return identifiers.length ? identifiers.join('\n') : null;
}

const BIBL_STRUCT_PATTERN = /<biblStruct\b([^>]*)>([\s\S]*?)<\/biblStruct>/gi;
const BODY_PATTERN = /<body\b[^>]*>([\s\S]*?)<\/body>/i;
const HEAD_PATTERN = /<head\b[^>]*>([\s\S]*?)<\/head>/gi;
const LIST_BIBL_PATTERN = /<listBibl\b[^>]*>([\s\S]*?)<\/listBibl>/gi;
const REFERENCE_PATTERN = /<ref\b([^>]*)>([\s\S]*?)<\/ref>/gi;
const SENTENCE_PATTERN = /<s\b[^>]*>([\s\S]*?)<\/s>/gi;
const TITLE_PATTERN = /<title\b([^>]*)>([\s\S]*?)<\/title>/gi;
const AUTHOR_PATTERN = /<author\b[^>]*>([\s\S]*?)<\/author>/gi;
const PERS_NAME_PATTERN = /<persName\b[^>]*>([\s\S]*?)<\/persName>/i;
const IDNO_PATTERN = /<idno\b([^>]*)>([\s\S]*?)<\/idno>/gi;
const NOTE_PATTERN = /<note\b([^>]*)>([\s\S]*?)<\/note>/gi;
const PTR_PATTERN = /<ptr\b([^>]*)\/?\s*>/gi;
const MAX_PDF_REFERENCES = 1_000;
const MAX_REFERENCE_TEXT_CHARS = 600;
const MAX_IDENTIFIER_CHARS = 300;
const MAX_REFERENCE_URL_CHARS = 500;
const MAX_HEADER_AUTHORS = 100;
const MAX_HEADER_NAME_CHARS = 300;
const MAX_HEADER_TITLE_CHARS = 500;
const MAX_CITATION_CONTEXT_CHARS = 1_200;
const MAX_CITATION_MARKER_CHARS = 128;
const MAX_CITATION_MENTIONS = 3_000;
const MAX_BIBLIOGRAPHY_KEY_CHARS = 200;
const MAX_SECTION_CHARS = 300;

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

function rawReferenceFromBiblStruct(xml: string): string {
	NOTE_PATTERN.lastIndex = 0;
	for (let match = NOTE_PATTERN.exec(xml); match !== null; match = NOTE_PATTERN.exec(xml)) {
		if (attribute(match[1] ?? '', 'type')?.toLowerCase() === 'raw_reference') return elementText(match[2] ?? '');
	}
	return elementText(xml);
}

function boundedReferenceText(value: string): string {
	return value.length > MAX_REFERENCE_TEXT_CHARS ? `${value.slice(0, MAX_REFERENCE_TEXT_CHARS - 1).trimEnd()}…` : value;
}

function boundedText(value: string, maxChars: number): string {
	return value.length > maxChars ? `${value.slice(0, maxChars - 1).trimEnd()}…` : value;
}

function citationLabel(value: string): string | null {
	const label = value
		.replace(/^[\s([{]+/u, '')
		.replace(/[\s,;:.)\]}]+$/u, '')
		.trim();
	return label && label.length <= 64 ? label : null;
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

function bibliographyFromTei(tei: string): Array<GrobidPdfReference & { label: string | null }> {
	const references: Array<GrobidPdfReference & { label: string | null }> = [];
	const seenKeys = new Set<string>();
	LIST_BIBL_PATTERN.lastIndex = 0;
	for (let list = LIST_BIBL_PATTERN.exec(tei); list !== null; list = LIST_BIBL_PATTERN.exec(tei)) {
		const listXml = list[1] ?? '';
		BIBL_STRUCT_PATTERN.lastIndex = 0;
		for (let match = BIBL_STRUCT_PATTERN.exec(listXml); match !== null; match = BIBL_STRUCT_PATTERN.exec(listXml)) {
			if (references.length >= MAX_PDF_REFERENCES) throw new Error(`GROBID returned more than ${MAX_PDF_REFERENCES} references`);
			const text = boundedReferenceText(rawReferenceFromBiblStruct(match[2] ?? ''));
			if (!text) continue;
			const key = attribute(match[1] ?? '', 'xml:id') ?? `unlinked-${references.length + 1}`;
			if (key.length > MAX_BIBLIOGRAPHY_KEY_CHARS) throw new Error('GROBID returned an oversized bibliography key');
			if (seenKeys.has(key)) throw new Error(`GROBID returned duplicate bibliography key ${key}`);
			seenKeys.add(key);
			references.push({ key, label: null, text });
		}
	}
	return references;
}

type ReferenceMarker = Readonly<{
	end: number;
	start: number;
	text: string;
	targetKeys: string[];
}>;

function markerTargetKeys(attributes: string, referenceKeys: ReadonlySet<string>): string[] {
	const target = attribute(attributes, 'target');
	if (!target) return [];
	return [
		...new Set(
			target
				.split(/\s+/u)
				.map((value) => value.replace(/^#/, ''))
				.filter((value) => referenceKeys.has(value)),
		),
	];
}

function sentenceReferenceMarkers(sentenceXml: string, referenceKeys: ReadonlySet<string>): ReferenceMarker[] {
	const markers: ReferenceMarker[] = [];
	REFERENCE_PATTERN.lastIndex = 0;
	for (let match = REFERENCE_PATTERN.exec(sentenceXml); match !== null; match = REFERENCE_PATTERN.exec(sentenceXml)) {
		if (attribute(match[1] ?? '', 'type')?.toLowerCase() !== 'bibr') continue;
		const text = elementText(match[2] ?? '');
		const targetKeys = markerTargetKeys(match[1] ?? '', referenceKeys);
		if (!text || !targetKeys.length) continue;
		markers.push({ end: REFERENCE_PATTERN.lastIndex, start: match.index, targetKeys, text });
	}
	return markers;
}

function shouldMergeMarkers(previous: ReferenceMarker, current: ReferenceMarker, sentenceXml: string): boolean {
	if (/[\])}]\s*$/u.test(previous.text)) return false;
	return elementText(sentenceXml.slice(previous.end, current.start)) === '';
}

function groupedSentenceMarkers(sentenceXml: string, markers: readonly ReferenceMarker[]): ReferenceMarker[] {
	const groups: ReferenceMarker[] = [];
	for (const marker of markers) {
		const previous = groups.at(-1);
		if (!previous || !shouldMergeMarkers(previous, marker, sentenceXml)) {
			groups.push(marker);
			continue;
		}
		groups[groups.length - 1] = {
			end: marker.end,
			start: previous.start,
			text: elementText(sentenceXml.slice(previous.start, marker.end)),
			targetKeys: [...new Set([...previous.targetKeys, ...marker.targetKeys])],
		};
	}
	return groups;
}

/**
 * Reduce one full-text TEI response to the bounded bibliography and citation
 * relationships that are safe to cross a Workflow step boundary.
 */
export function parseGrobidPdfFulltextTei(tei: string): GrobidPdfFulltext {
	const mutableReferences = bibliographyFromTei(tei);
	const referencesByKey = new Map(mutableReferences.map((reference) => [reference.key, reference]));
	const referenceKeys = new Set(referencesByKey.keys());
	const bodyXml = BODY_PATTERN.exec(tei)?.[1] ?? '';
	const headings: Array<{ index: number; text: string }> = [];
	HEAD_PATTERN.lastIndex = 0;
	for (let match = HEAD_PATTERN.exec(bodyXml); match !== null; match = HEAD_PATTERN.exec(bodyXml)) {
		const text = boundedText(elementText(match[1] ?? ''), MAX_SECTION_CHARS);
		if (text) headings.push({ index: match.index, text });
	}

	const mentions: GrobidPdfCitationMention[] = [];
	let headingIndex = 0;
	let section: string | null = null;
	SENTENCE_PATTERN.lastIndex = 0;
	for (let sentence = SENTENCE_PATTERN.exec(bodyXml); sentence !== null; sentence = SENTENCE_PATTERN.exec(bodyXml)) {
		while (headingIndex < headings.length && (headings[headingIndex]?.index ?? Number.POSITIVE_INFINITY) < sentence.index) {
			section = headings[headingIndex]?.text ?? section;
			headingIndex += 1;
		}
		const sentenceXml = sentence[1] ?? '';
		const context = boundedText(elementText(sentenceXml), MAX_CITATION_CONTEXT_CHARS);
		if (!context) continue;
		const markers = sentenceReferenceMarkers(sentenceXml, referenceKeys);
		for (const group of groupedSentenceMarkers(sentenceXml, markers)) {
			if (mentions.length >= MAX_CITATION_MENTIONS) throw new Error(`GROBID returned more than ${MAX_CITATION_MENTIONS} citation mentions`);
			const markerText = boundedText(group.text, MAX_CITATION_MARKER_CHARS);
			if (!markerText) continue;
			for (const marker of markers.filter(({ start, end }) => start >= group.start && end <= group.end)) {
				if (marker.targetKeys.length !== 1) continue;
				const reference = referencesByKey.get(marker.targetKeys[0] ?? '');
				if (reference && reference.label === null) reference.label = citationLabel(marker.text);
			}
			mentions.push({ context, markerText, section, targetKeys: group.targetKeys });
		}
	}

	return {
		mentions,
		references: mutableReferences.map(({ key, label, text }) => ({ key, label, text })),
	};
}
