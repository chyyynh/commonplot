import { XMLParser } from 'fast-xml-parser';
import { normalizeArxivId, normalizeDoi, paperIdentityFromText } from '../shared/paper-identity.ts';

export type GrobidPdfHeader = Readonly<{
	authors: string[];
	paperIdentifierText: string | null;
	title: string | null;
}>;

const MAX_IDENTIFIER_CHARS = 300;
const MAX_REFERENCE_URL_CHARS = 500;
const MAX_HEADER_AUTHORS = 100;
const MAX_HEADER_NAME_CHARS = 300;
const MAX_HEADER_TITLE_CHARS = 500;

type XmlObject = Record<string, unknown>;

const teiParser = new XMLParser({
	attributeNamePrefix: '',
	htmlEntities: true,
	ignoreAttributes: false,
	ignoreDeclaration: true,
	ignorePiTags: true,
	maxNestedTags: 100,
	parseTagValue: false,
	processEntities: {
		maxEntityCount: 10,
		maxEntitySize: 1_000,
		maxExpandedLength: 10_000,
		maxExpansionDepth: 3,
		maxTotalExpansions: 1_000,
	},
	removeNSPrefix: true,
	trimValues: false,
});

function xmlObject(value: unknown): XmlObject | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as XmlObject) : null;
}

function xmlValues(value: unknown): unknown[] {
	return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function xmlText(value: unknown): string {
	const text = typeof value === 'string' ? value : xmlObject(value)?.['#text'];
	return typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
}

function identifierTextFromHeader(biblStruct: XmlObject | null, analytic: XmlObject | null): string | null {
	let doi: string | null = null;
	let arxivId: string | null = null;
	for (const rawIdno of [...xmlValues(analytic?.idno), ...xmlValues(biblStruct?.idno)]) {
		const idno = xmlObject(rawIdno);
		const type = typeof idno?.type === 'string' ? idno.type.toLowerCase() : null;
		const value = xmlText(rawIdno);
		if (!value || value.length > MAX_IDENTIFIER_CHARS) continue;
		if (type === 'doi') doi ??= normalizeDoi(value);
		else if (type === 'arxiv') arxivId ??= normalizeArxivId(value.replace(/\s*\[[^\]]+\]\s*$/, ''));
		else {
			const identity = paperIdentityFromText(value);
			doi ??= identity?.doi ?? null;
			arxivId ??= identity?.arxivId ?? null;
		}
	}

	for (const rawPointer of [...xmlValues(analytic?.ptr), ...xmlValues(biblStruct?.ptr)]) {
		const target = xmlObject(rawPointer)?.target;
		if (typeof target !== 'string' || target.length > MAX_REFERENCE_URL_CHARS) continue;
		doi ??= normalizeDoi(target);
		arxivId ??= normalizeArxivId(target);
		if (doi && arxivId) break;
	}
	return [doi ? `DOI: ${doi}` : null, arxivId ? `arXiv: ${arxivId}` : null].filter(Boolean).join('\n') || null;
}

/** The uploaded-PDF paper gate uses only metadata extracted by GROBID itself. */
export function parseGrobidPdfHeaderTei(tei: string): GrobidPdfHeader {
	const parsed = xmlObject(teiParser.parse(tei));
	const fileDesc = xmlObject(xmlObject(xmlObject(parsed?.TEI)?.teiHeader)?.fileDesc);
	const titleNode = xmlValues(xmlObject(fileDesc?.titleStmt)?.title).find((value) => {
		const title = xmlObject(value);
		return title?.type?.toString().toLowerCase() === 'main' || title?.level?.toString().toLowerCase() === 'a';
	});
	const title = xmlText(titleNode).slice(0, MAX_HEADER_TITLE_CHARS) || null;
	const biblStruct = xmlObject(xmlObject(fileDesc?.sourceDesc)?.biblStruct);
	const analytic = xmlObject(biblStruct?.analytic);

	const authors: string[] = [];
	const seenAuthors = new Set<string>();
	for (const rawAuthor of xmlValues(analytic?.author)) {
		if (authors.length >= MAX_HEADER_AUTHORS) break;
		const personName = xmlObject(xmlObject(rawAuthor)?.persName);
		const name = ['forename', 'nameLink', 'surname', 'genName']
			.flatMap((part) => xmlValues(personName?.[part]))
			.map(xmlText)
			.filter(Boolean)
			.join(' ')
			.slice(0, MAX_HEADER_NAME_CHARS);
		const key = name.toLocaleLowerCase('en-US');
		if (!name || seenAuthors.has(key)) continue;
		seenAuthors.add(key);
		authors.push(name);
	}

	return { authors, paperIdentifierText: identifierTextFromHeader(biblStruct, analytic), title };
}
