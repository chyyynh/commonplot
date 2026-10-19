import { cleanText } from './markdown';
import { PAPER_IDENTIFIER_SCHEMES } from './resource-kinds.ts';

// DOI suffixes are opaque printable Unicode, not an ASCII publisher-specific alphabet.
const DOI_RE = /^10\.\d{4,9}\/[^\s\p{C}]+$/u;
const MODERN_ARXIV_ID_RE = /^(\d{4}\.\d{4,5})(?:v\d+)?$/i;
const LEGACY_ARXIV_ID_RE = /^([a-z][a-z0-9.-]*\/[0-9]{7})(?:v\d+)?$/i;
// Typesetting can break a line right after the DOI prefix's slash, or after a dot inside
// the suffix (ACM's "10.1145/3772318. 3791316"; the first part is the proceedings' DOI).
const DOI_IN_TEXT_RE = /\b(?:https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/[^\S\n]?(?:(?!\]\()\S)+(?:(?<=\.)\s\d{5,}\b)?/iu;
const ARXIV_IN_TEXT_RE = /\barxiv(?:\.org\/(?:abs|html|pdf)\/|[.:\s]+)((?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v\d+)?)\b/i;
const ARXIV_DOI_PREFIX = '10.48550/arxiv.';
const OPENALEX_ID_RE = /^(?:https?:\/\/openalex\.org\/)?(?:works\/)?(W\d+)\/?$/i;

type PaperIdentifierScheme = (typeof PAPER_IDENTIFIER_SCHEMES)[number];

export function isPaperIdentifierScheme(value: unknown): value is PaperIdentifierScheme {
	return typeof value === 'string' && (PAPER_IDENTIFIER_SCHEMES as readonly string[]).includes(value);
}

export type PaperIdentifier = Readonly<{
	preferred: boolean;
	scheme: PaperIdentifierScheme;
	value: string;
}>;

export type PaperIdentity = Readonly<{
	arxivId?: string;
	doi?: string;
	openAlexId?: string;
}>;

/**
 * Merge canonical identifiers while keeping at most one
 * preferred value per scheme. Input order is meaningful: the resolver puts
 * the selected version of record before aliases from other versions.
 */
export function mergePaperIdentifiers(identifiers: readonly PaperIdentifier[]): PaperIdentifier[] {
	const deduplicated = new Map<string, PaperIdentifier>();
	for (const candidate of identifiers) {
		const key = `${candidate.scheme}:${candidate.value}`;
		deduplicated.set(key, { ...candidate, preferred: deduplicated.get(key)?.preferred || candidate.preferred });
	}

	const preferredSchemes = new Set<PaperIdentifierScheme>();
	const normalized: PaperIdentifier[] = [];
	for (const identifier of deduplicated.values()) {
		const preferred = identifier.preferred && !preferredSchemes.has(identifier.scheme);
		if (preferred) preferredSchemes.add(identifier.scheme);
		normalized.push({ ...identifier, preferred });
	}
	for (const scheme of PAPER_IDENTIFIER_SCHEMES) {
		if (preferredSchemes.has(scheme)) continue;
		const index = normalized.findIndex((identifier) => identifier.scheme === scheme);
		if (index >= 0) normalized[index] = { ...normalized[index]!, preferred: true };
	}
	return normalized;
}

/** Adapter inputs have already been normalized; an arXiv DOI also identifies its preprint. */
export function paperIdentifiersFromIdentity({
	doi,
	arxivId = normalizeArxivId(doi) ?? undefined,
	openAlexId,
}: PaperIdentity): PaperIdentifier[] {
	return [
		...(doi ? [{ preferred: true, scheme: 'doi' as const, value: doi }] : []),
		...(arxivId ? [{ preferred: true, scheme: 'arxiv' as const, value: arxivId }] : []),
		...(openAlexId ? [{ preferred: true, scheme: 'openalex' as const, value: openAlexId }] : []),
	];
}

/** Select from the adapter's normalized identifiers without normalizing the list again. */
export function paperIdentityFromIdentifiers(identifiers: readonly PaperIdentifier[]): PaperIdentity | null {
	const value = (scheme: PaperIdentifierScheme, accept: (value: string) => boolean = () => true) =>
		identifiers.find((identifier) => identifier.scheme === scheme && identifier.preferred && accept(identifier.value))?.value ??
		identifiers.find((identifier) => identifier.scheme === scheme && accept(identifier.value))?.value;
	const doi = value('doi', (candidate) => !candidate.startsWith(ARXIV_DOI_PREFIX)) ?? value('doi');
	const arxivId = value('arxiv') ?? normalizeArxivId(doi);
	const openAlexId = value('openalex');
	return doi || arxivId || openAlexId
		? { ...(doi ? { doi } : {}), ...(arxivId ? { arxivId } : {}), ...(openAlexId ? { openAlexId } : {}) }
		: null;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stripUnbalancedDoiPunctuation(value: string): string {
	let doi = value.replace(/[.,;'"`*]+$/, '');
	const count = (character: string) => [...doi].filter((item) => item === character).length;
	for (const [open, close] of ['()', '[]', '<>', '{}']) {
		while (doi.endsWith(close!) && count(close!) > count(open!)) doi = doi.slice(0, -1);
	}
	return doi;
}

export function normalizeDoi(value: unknown): string | null {
	const raw = nonEmptyString(value);
	if (!raw) return null;
	let doi = raw.replace(/^doi\s*:\s*/i, '').trim();
	if (/^https?:\/\//i.test(doi)) {
		const url = URL.parse(doi);
		if (!url || !/^(?:dx\.)?doi\.org$/i.test(url.hostname) || url.username || url.password || url.port) return null;
		try {
			doi = decodeURIComponent(url.pathname.slice(1));
		} catch {
			return null;
		}
	}
	doi = doi.toLowerCase();
	if (/n{4,}|x{4,}/i.test(doi)) return null;
	return DOI_RE.test(doi) ? doi : null;
}

export function normalizeArxivId(value: unknown): string | null {
	const raw = nonEmptyString(value);
	if (!raw) return null;
	const doi = normalizeDoi(raw);
	const url = URL.parse(raw);
	const path =
		url && (url.hostname === 'arxiv.org' || url.hostname.endsWith('.arxiv.org'))
			? url.pathname.match(/^\/(?:abs|html|pdf)\/(.+?)(?:\.pdf)?\/?$/i)?.[1]
			: null;
	const candidate = (doi?.startsWith(ARXIV_DOI_PREFIX) ? doi.slice(ARXIV_DOI_PREFIX.length) : (path ?? raw.replace(/^arxiv\s*:\s*/i, '')))
		.replace(/[?#].*$/, '')
		.replace(/\.pdf$/i, '')
		.trim();
	const modern = candidate.match(MODERN_ARXIV_ID_RE)?.[1];
	if (modern) {
		const month = Number(modern.slice(2, 4));
		return month >= 1 && month <= 12 ? modern : null;
	}
	return candidate.match(LEGACY_ARXIV_ID_RE)?.[1]?.toLowerCase() ?? null;
}

export function normalizeOpenAlexId(value: unknown): string | null {
	const raw = nonEmptyString(value);
	return raw?.match(OPENALEX_ID_RE)?.[1]?.toUpperCase() ?? null;
}

/** Each paper identifier scheme: how a value is normalized to it, and the `PaperIdentity` field it fills. */
export const PAPER_IDENTIFIERS = {
	doi: { normalize: normalizeDoi, identityKey: 'doi' },
	arxiv: { normalize: normalizeArxivId, identityKey: 'arxivId' },
	openalex: { normalize: normalizeOpenAlexId, identityKey: 'openAlexId' },
} as const satisfies Record<PaperIdentifierScheme, { normalize: (value: unknown) => string | null; identityKey: keyof PaperIdentity }>;

/** What `value` reads as under every scheme, by `PaperIdentity` field; null where it is not that identifier. */
export function normalizePaperIdentifiers(value: unknown) {
	return Object.fromEntries(
		PAPER_IDENTIFIER_SCHEMES.map((scheme) => [PAPER_IDENTIFIERS[scheme].identityKey, PAPER_IDENTIFIERS[scheme].normalize(value)]),
	) as { [K in keyof PaperIdentity]-?: string | null };
}

/** A published paper lives at its version of record; a preprint at arXiv. */
export function canonicalPaperUrl(identity: PaperIdentity): string {
	if (identity.doi && !identity.doi.startsWith(ARXIV_DOI_PREFIX))
		return `https://doi.org/${identity.doi.split('/').map(encodeURIComponent).join('/')}`;
	if (identity.arxivId) return `https://arxiv.org/abs/${identity.arxivId}`;
	if (identity.doi) return `https://doi.org/${identity.doi.split('/').map(encodeURIComponent).join('/')}`;
	if (identity.openAlexId) return `https://openalex.org/${identity.openAlexId}`;
	throw new Error('Paper identity has no canonical identifier');
}

/** Extract printed identifiers from PDF front matter or a single bibliography entry. */
export function paperIdentityFromText(value: unknown): PaperIdentity | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	const match = value.match(DOI_IN_TEXT_RE)?.[0];
	const doi = match ? normalizeDoi(stripUnbalancedDoiPunctuation(match.replace(/\/\s+/u, '/').replace(/\.\s+/u, '.'))) : null;
	const arxivId = normalizeArxivId(value.match(ARXIV_IN_TEXT_RE)?.[1]) ?? normalizeArxivId(doi);
	if (!doi && !arxivId) return null;
	return {
		...(doi ? { doi } : {}),
		...(arxivId ? { arxivId } : {}),
	};
}

/** Compare bibliographic text without case, accents, or punctuation. */
export function normalizeBibliographicText(value: string): string {
	return cleanText(
		value
			.normalize('NFKD')
			.replace(/\p{Mark}/gu, '')
			.toLocaleLowerCase('en-US')
			.replace(/[^\p{Letter}\p{Number}]+/gu, ' '),
	);
}
