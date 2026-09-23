import { NonRetryableError } from 'cloudflare:workflows';
import { XMLParser } from 'fast-xml-parser';
import { normalizeArxivId, normalizeDoi, paperIdentifiersFromIdentity, paperIdentityFromText } from '../shared/paper-identity.ts';
import { readBoundedResponseText } from '../shared/response.ts';

const MAX_ERROR_BODY_BYTES = 1_000;
const MAX_GROBID_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_IDENTIFIER_CHARS = 300;
const MAX_REFERENCE_URL_CHARS = 500;
const ARRAY_TAG_NAMES = new Set(['author', 'forename', 'genName', 'idno', 'nameLink', 'ptr', 'surname', 'title']);

type XmlObject = Record<string, unknown>;

const teiParser = new XMLParser({
	alwaysCreateTextNode: true,
	attributeNamePrefix: '',
	attributeValueProcessor: (name, value) => (name === 'level' || name === 'type' ? value.toLowerCase() : value),
	htmlEntities: true,
	ignoreAttributes: false,
	ignorePiTags: true,
	isArray: (tagName, _jPath, _isLeaf, isAttribute) => !isAttribute && ARRAY_TAG_NAMES.has(tagName),
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

const xmlElements = (value: unknown): XmlObject[] => (value ?? []) as XmlObject[];

function xmlText(value: XmlObject | undefined): string {
	const text = value?.['#text'];
	return typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
}

function identifiersFromHeader(biblStruct: XmlObject | null, analytic: XmlObject | null) {
	let doi: string | null = null;
	let arxivId: string | null = null;
	for (const idno of [...xmlElements(analytic?.idno), ...xmlElements(biblStruct?.idno)]) {
		const value = xmlText(idno);
		if (!value || value.length > MAX_IDENTIFIER_CHARS) continue;
		if (idno.type === 'doi') doi ??= normalizeDoi(value);
		else if (idno.type === 'arxiv') arxivId ??= normalizeArxivId(value.replace(/\s*\[[^\]]+\]\s*$/, ''));
		else {
			const identity = paperIdentityFromText(value);
			doi ??= identity?.doi ?? null;
			arxivId ??= identity?.arxivId ?? null;
		}
	}

	for (const pointer of [...xmlElements(analytic?.ptr), ...xmlElements(biblStruct?.ptr)]) {
		const target = pointer.target;
		if (typeof target !== 'string' || target.length > MAX_REFERENCE_URL_CHARS) continue;
		doi ??= normalizeDoi(target);
		arxivId ??= normalizeArxivId(target);
		if (doi && arxivId) break;
	}
	return paperIdentifiersFromIdentity({ ...(doi ? { doi } : {}), ...(arxivId ? { arxivId } : {}) });
}

/** The uploaded-PDF paper gate uses only metadata extracted by GROBID itself. */
export async function parseGrobidPdfHeader(response: Response) {
	const tei = await readBoundedResponseText(response, response.ok ? MAX_GROBID_RESPONSE_BYTES : MAX_ERROR_BODY_BYTES, 'GROBID response');
	if (!response.ok) {
		// GROBID reports deterministic PDF failures as HTTP 500 with a bracketed
		// code. Classify them in the Workflow, after the Container RPC boundary.
		const permanent =
			[400, 401, 403, 404, 413, 415, 422].includes(response.status) ||
			(response.status === 500 && /^\[(?:BAD_INPUT_DATA|NO_BLOCKS|TOO_MANY_BLOCKS|TOO_MANY_TOKENS)\]/u.test(tei));
		const ErrorType = permanent ? NonRetryableError : Error;
		throw new ErrorType(`GROBID processHeaderDocument failed with ${response.status}${tei ? `: ${tei}` : ''}`);
	}
	const parsed = xmlObject(teiParser.parse(tei));
	const fileDesc = xmlObject(xmlObject(xmlObject(parsed?.TEI)?.teiHeader)?.fileDesc);
	const titleNode = xmlElements(xmlObject(fileDesc?.titleStmt)?.title).find((title) => title.type === 'main' || title.level === 'a');
	const title = xmlText(titleNode) || null;
	const biblStruct = xmlObject(xmlObject(fileDesc?.sourceDesc)?.biblStruct);
	const analytic = xmlObject(biblStruct?.analytic);

	const authors = new Map<string, string>();
	for (const author of xmlElements(analytic?.author)) {
		const personName = xmlObject(author.persName);
		const name = ['forename', 'nameLink', 'surname', 'genName']
			.flatMap((part) => xmlElements(personName?.[part]))
			.map(xmlText)
			.filter(Boolean)
			.join(' ');
		const key = name.toLocaleLowerCase('en-US');
		if (name && !authors.has(key)) authors.set(key, name);
	}

	return { authors: [...authors.values()], resourceIdentifiers: identifiersFromHeader(biblStruct, analytic), title };
}

export type GrobidPdfHeader = Awaited<ReturnType<typeof parseGrobidPdfHeader>>;
