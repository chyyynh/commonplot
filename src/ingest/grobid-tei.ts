import { XMLParser } from 'fast-xml-parser';
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

/** Trust GROBID alone only for canonical identifiers; title-and-author headers still need external corroboration. */
export function grobidPaperIdentifierText(header: GrobidPdfHeader): string | null {
	const identifiers = [header.doi ? `DOI: ${header.doi}` : null, header.arxivId ? `arXiv: ${header.arxivId}` : null].filter(
		(value): value is string => value !== null,
	);
	return identifiers.length ? identifiers.join('\n') : null;
}

const MAX_IDENTIFIER_CHARS = 300;
const MAX_REFERENCE_URL_CHARS = 500;
const MAX_HEADER_AUTHORS = 100;
const MAX_HEADER_NAME_CHARS = 300;
const MAX_HEADER_TITLE_CHARS = 500;

type XmlObject = Readonly<Record<string, unknown>>;
type XmlElement = Readonly<{
	attributes: XmlObject;
	children: readonly XmlObject[];
	name: string;
}>;

const teiParser = new XMLParser({
	attributeNamePrefix: '',
	htmlEntities: true,
	ignoreAttributes: false,
	ignoreDeclaration: true,
	ignorePiTags: true,
	maxNestedTags: 100,
	parseAttributeValue: false,
	parseTagValue: false,
	preserveOrder: true,
	processEntities: {
		enabled: true,
		maxEntityCount: 10,
		maxEntitySize: 1_000,
		maxExpandedLength: 10_000,
		maxExpansionDepth: 3,
		maxTotalExpansions: 1_000,
	},
	removeNSPrefix: true,
	trimValues: false,
});

function isXmlObject(value: unknown): value is XmlObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function xmlElement(node: XmlObject): XmlElement | null {
	for (const [name, value] of Object.entries(node)) {
		if (name === ':@' || name === '#text' || !Array.isArray(value)) continue;
		return {
			attributes: isXmlObject(node[':@']) ? node[':@'] : {},
			children: value.filter(isXmlObject),
			name,
		};
	}
	return null;
}

function* descendantElements(nodes: readonly XmlObject[], name: string): Generator<XmlElement> {
	for (const node of nodes) {
		const element = xmlElement(node);
		if (!element) continue;
		if (element.name.toLowerCase() === name) yield element;
		yield* descendantElements(element.children, name);
	}
}

function elementAttribute(element: XmlElement, name: string): string | null {
	for (const [attributeName, value] of Object.entries(element.attributes)) {
		if (attributeName.toLowerCase() !== name || typeof value !== 'string') continue;
		return value.trim() || null;
	}
	return null;
}

function collectElementText(nodes: readonly XmlObject[], parts: string[]): void {
	for (const node of nodes) {
		const text = node['#text'];
		if (typeof text === 'string') parts.push(text);
		const element = xmlElement(node);
		if (element) collectElementText(element.children, parts);
	}
}

function elementText(element: XmlElement): string {
	const parts: string[] = [];
	collectElementText(element.children, parts);
	return parts.join(' ').replace(/\s+/gu, ' ').trim();
}

function parseTei(tei: string): readonly XmlObject[] {
	const parsed: unknown = teiParser.parse(tei);
	return Array.isArray(parsed) ? parsed.filter(isXmlObject) : [];
}

function validHttpUrl(value: string | null): string | null {
	if (!value || value.length > MAX_REFERENCE_URL_CHARS) return null;
	const parsed = URL.parse(value);
	if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) return null;
	return parsed.toString();
}

function identifiersFromTei(elements: readonly XmlObject[]): GrobidReferenceIdentifiers {
	let doi: string | null = null;
	let arxivId: string | null = null;
	for (const idno of descendantElements(elements, 'idno')) {
		const type = elementAttribute(idno, 'type')?.toLowerCase();
		const value = elementText(idno);
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
	for (const pointer of descendantElements(elements, 'ptr')) {
		pointerUrl = validHttpUrl(elementAttribute(pointer, 'target'));
		if (pointerUrl) break;
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
	const elements = parseTei(tei);
	let title: string | null = null;
	for (const titleElement of descendantElements(elements, 'title')) {
		if (
			elementAttribute(titleElement, 'type')?.toLowerCase() !== 'main' &&
			elementAttribute(titleElement, 'level')?.toLowerCase() !== 'a'
		) {
			continue;
		}
		const candidate = elementText(titleElement).slice(0, MAX_HEADER_TITLE_CHARS);
		if (candidate) {
			title = candidate;
			break;
		}
	}

	const authors: string[] = [];
	const seenAuthors = new Set<string>();
	for (const author of descendantElements(elements, 'author')) {
		if (authors.length >= MAX_HEADER_AUTHORS) break;
		const personName = descendantElements(author.children, 'persname').next().value;
		const name = elementText(personName ?? author).slice(0, MAX_HEADER_NAME_CHARS);
		const key = name.toLocaleLowerCase('en-US');
		if (!name || seenAuthors.has(key)) continue;
		seenAuthors.add(key);
		authors.push(name);
	}

	return { ...identifiersFromTei(elements), authors, title };
}
