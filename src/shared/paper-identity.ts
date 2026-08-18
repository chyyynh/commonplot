const DOI_RE = /^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/i;
const MODERN_ARXIV_ID_RE = /^(\d{4}\.\d{4,5})(?:v\d+)?$/i;
const LEGACY_ARXIV_ID_RE = /^([a-z][a-z0-9.-]*\/[0-9]{7})(?:v\d+)?$/i;
const DOI_IN_TEXT_RE = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)\b/i;
const ARXIV_IN_TEXT_RE = /\barxiv\s*:\s*([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?\b/i;
const ARXIV_DOI_PREFIX = '10.48550/arxiv.';
const OPENALEX_ID_RE = /^(?:https?:\/\/openalex\.org\/)?(W\d+)\/?$/i;

export const PAPER_IDENTIFIER_SCHEMES = ['doi', 'arxiv', 'openalex'] as const;
export type PaperIdentifierScheme = (typeof PAPER_IDENTIFIER_SCHEMES)[number];

export type PaperIdentity = Readonly<{
	arxivId?: string;
	doi?: string;
	openAlexId?: string;
}>;

export type ResolvedPaperInput = Readonly<{
	canonicalUrl: string;
	identity: PaperIdentity;
}>;

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
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
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

function identityFromDoi(doi: string): PaperIdentity {
	const arxivId = arxivIdFromDoi(doi);
	return { doi, ...(arxivId ? { arxivId } : {}) };
}

export function canonicalPaperUrl(identity: PaperIdentity): string {
	if (identity.arxivId) return `https://arxiv.org/abs/${identity.arxivId}`;
	if (identity.doi) return `https://doi.org/${identity.doi}`;
	if (identity.openAlexId) return `https://openalex.org/${identity.openAlexId}`;
	throw new Error('Paper identity has no DOI or arXiv id');
}

/**
 * Resolve only exact, user-supplied paper identities. Ordinary web URLs return
 * null so their URL semantics remain owned by the general ingest normalizer.
 */
export function resolveExactPaperInput(value: unknown): ResolvedPaperInput | null {
	if (typeof value !== 'string') return null;
	const raw = value.trim();
	if (!raw) return null;
	const openAlexId = normalizeOpenAlexId(raw);
	if (openAlexId) {
		const identity = { openAlexId };
		return { canonicalUrl: canonicalPaperUrl(identity), identity };
	}

	const arxivId = normalizeArxivId(raw);
	if (arxivId) {
		const doi = normalizeDoi(raw);
		const identity = { arxivId, ...(doi ? { doi } : {}) };
		return { canonicalUrl: canonicalPaperUrl(identity), identity };
	}

	const doi = normalizeDoi(raw);
	if (!doi) return null;
	const identity = identityFromDoi(doi);
	return { canonicalUrl: canonicalPaperUrl(identity), identity };
}

/** Extract exact identifiers from bounded PDF/front-matter text. */
export function paperIdentityFromText(value: unknown): PaperIdentity | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	const doi = normalizeDoi(value.match(DOI_IN_TEXT_RE)?.[1]);
	const arxivId = normalizeArxivId(value.match(ARXIV_IN_TEXT_RE)?.[1]);
	if (!doi && !arxivId) return null;
	const doiIdentity = doi ? identityFromDoi(doi) : null;
	return {
		...(doi ? { doi } : {}),
		...((arxivId ?? doiIdentity?.arxivId) ? { arxivId: arxivId ?? doiIdentity?.arxivId } : {}),
	};
}

export function normalizePaperIdentity(identity: PaperIdentity): PaperIdentity | null {
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

export function paperIdentityLockKeys(identity: PaperIdentity): string[] {
	const normalized = normalizePaperIdentity(identity);
	if (!normalized) return [];
	return [
		...(normalized.arxivId ? [`arxiv:${normalized.arxivId}`] : []),
		...(normalized.doi ? [`doi:${normalized.doi}`] : []),
		...(normalized.openAlexId ? [`openalex:${normalized.openAlexId}`] : []),
	].sort();
}
