const DOI_RE = /^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/i;
const MODERN_ARXIV_ID_RE = /^(\d{4}\.\d{4,5})(?:v\d+)?$/i;
const LEGACY_ARXIV_ID_RE = /^([a-z][a-z0-9.-]*\/[0-9]{7})(?:v\d+)?$/i;
const DOI_IN_TEXT_RE = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i;
const ARXIV_IN_TEXT_RE = /\barxiv(?:\.org\/(?:abs|html|pdf)\/|[.:\s]+)((?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v\d+)?)\b/i;
const ARXIV_DOI_PREFIX = '10.48550/arxiv.';
const OPENALEX_ID_RE = /^(?:https?:\/\/openalex\.org\/)?(?:works\/)?(W\d+)\/?$/i;

export const PAPER_IDENTIFIER_SCHEMES = ['doi', 'arxiv', 'openalex'] as const;
export type PaperIdentifierScheme = (typeof PAPER_IDENTIFIER_SCHEMES)[number];

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

function normalizePaperIdentifier(identifier: Omit<PaperIdentifier, 'preferred'> & { preferred?: boolean }): PaperIdentifier | null {
	const value =
		identifier.scheme === 'doi'
			? normalizeDoi(identifier.value)
			: identifier.scheme === 'arxiv'
				? normalizeArxivId(identifier.value)
				: normalizeOpenAlexId(identifier.value);
	return value ? { preferred: identifier.preferred !== false, scheme: identifier.scheme, value } : null;
}

/**
 * Normalize and deduplicate exact identifiers while keeping at most one
 * preferred value per scheme. Input order is meaningful: the resolver puts
 * the selected version of record before aliases from other versions.
 */
export function normalizePaperIdentifiers(
	identifiers: readonly (Omit<PaperIdentifier, 'preferred'> & { preferred?: boolean })[],
): PaperIdentifier[] {
	const deduplicated = new Map<string, PaperIdentifier>();
	for (const candidate of identifiers) {
		const identifier = normalizePaperIdentifier(candidate);
		if (!identifier) continue;
		const key = `${identifier.scheme}:${identifier.value}`;
		const existing = deduplicated.get(key);
		deduplicated.set(key, existing ? { ...existing, preferred: existing.preferred || identifier.preferred } : identifier);
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

export function paperIdentifiersFromIdentity(identity: PaperIdentity): PaperIdentifier[] {
	const normalized = normalizePaperIdentity(identity);
	if (!normalized) return [];
	return [
		...(normalized.doi ? [{ preferred: true, scheme: 'doi' as const, value: normalized.doi }] : []),
		...(normalized.arxivId ? [{ preferred: true, scheme: 'arxiv' as const, value: normalized.arxivId }] : []),
		...(normalized.openAlexId ? [{ preferred: true, scheme: 'openalex' as const, value: normalized.openAlexId }] : []),
	];
}

export function paperIdentityFromIdentifiers(identifiers: readonly PaperIdentifier[]): PaperIdentity | null {
	const normalized = normalizePaperIdentifiers(identifiers);
	const value = (scheme: PaperIdentifierScheme, accept: (value: string) => boolean = () => true) =>
		normalized.find((identifier) => identifier.scheme === scheme && identifier.preferred && accept(identifier.value))?.value ??
		normalized.find((identifier) => identifier.scheme === scheme && accept(identifier.value))?.value;
	const doi = value('doi', (candidate) => !candidate.startsWith(ARXIV_DOI_PREFIX)) ?? value('doi');
	const arxivId = value('arxiv');
	const openAlexId = value('openalex');
	return normalizePaperIdentity({ doi, arxivId, openAlexId });
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stripUnbalancedDoiPunctuation(value: string): string {
	let doi = value.replace(/[.,;]+$/, '');
	const count = (character: string) => [...doi].filter((item) => item === character).length;
	while (doi.endsWith(')') && count(')') > count('(')) doi = doi.slice(0, -1);
	while (doi.endsWith(']') && count(']') > count('[')) doi = doi.slice(0, -1);
	return doi;
}

export function normalizeDoi(value: unknown): string | null {
	const raw = nonEmptyString(value);
	if (!raw) return null;
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		// A malformed escape cannot become a valid DOI after normalization.
	}
	const doi = stripUnbalancedDoiPunctuation(
		decoded
			.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
			.replace(/^doi\s*:\s*/i, '')
			.trim(),
	).toLowerCase();
	if (/n{4,}|x{4,}/i.test(doi)) return null;
	return DOI_RE.test(doi) ? doi : null;
}

function arxivIdFromUrl(value: string): string | null {
	const url = URL.parse(value);
	if (!url) return null;
	if (url.hostname.toLowerCase() !== 'arxiv.org' && !url.hostname.toLowerCase().endsWith('.arxiv.org')) return null;
	return url.pathname.match(/^\/(?:abs|html|pdf)\/(.+?)(?:\.pdf)?\/?$/i)?.[1] ?? null;
}

export function normalizeArxivId(value: unknown): string | null {
	const raw = nonEmptyString(value);
	if (!raw) return null;
	const candidate = (arxivIdFromUrl(raw) ?? raw.replace(/^arxiv\s*:\s*/i, ''))
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

function arxivIdFromDoi(doi: string): string | null {
	return doi.startsWith(ARXIV_DOI_PREFIX) ? normalizeArxivId(doi.slice(ARXIV_DOI_PREFIX.length)) : null;
}

export function canonicalPaperUrl(identity: PaperIdentity): string {
	if (identity.arxivId) return `https://arxiv.org/abs/${identity.arxivId}`;
	if (identity.doi) return `https://doi.org/${identity.doi}`;
	if (identity.openAlexId) return `https://openalex.org/${identity.openAlexId}`;
	throw new Error('Paper identity has no canonical identifier');
}

/** Extract printed identifiers from PDF front matter or a single bibliography entry. */
export function paperIdentityFromText(value: unknown): PaperIdentity | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	const doi = normalizeDoi(value.match(DOI_IN_TEXT_RE)?.[1]);
	const arxivId = normalizeArxivId(value.match(ARXIV_IN_TEXT_RE)?.[1]) ?? (doi ? arxivIdFromDoi(doi) : null);
	if (!doi && !arxivId) return null;
	return {
		...(doi ? { doi } : {}),
		...(arxivId ? { arxivId } : {}),
	};
}

function normalizePaperIdentity(identity: PaperIdentity): PaperIdentity | null {
	const doi = normalizeDoi(identity.doi);
	const arxivId = normalizeArxivId(identity.arxivId) ?? (doi ? arxivIdFromDoi(doi) : null);
	const openAlexId = normalizeOpenAlexId(identity.openAlexId);
	return doi || arxivId || openAlexId
		? {
				...(doi ? { doi } : {}),
				...(arxivId ? { arxivId } : {}),
				...(openAlexId ? { openAlexId } : {}),
			}
		: null;
}
