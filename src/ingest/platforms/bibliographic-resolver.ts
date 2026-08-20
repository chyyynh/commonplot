import { fetchWithTimeout, readTextWithLimit } from '@core-shared/http';
import {
	normalizePaperIdentifiers,
	type PaperIdentifier,
	type PaperIdentifierScheme,
	paperIdentifiersFromIdentity,
	paperIdentityFromText,
	resolveExactPaperInput,
} from '@core-shared/paper-identity';
import { z } from 'zod';

const CITOID_BASE = 'https://en.wikipedia.org/api/rest_v1/data/citation/zotero/';
const CITOID_TIMEOUT_MS = 8_000;
const CITOID_RESPONSE_MAX_BYTES = 1024 * 1024;
const CITOID_USER_AGENT = 'Newsence/1.0 (https://www.newsence.app; bibliographic metadata resolver)';
const IDENTIFIER_SCAN_CHARS = 3_000;
const ARXIV_DOI_PREFIX = '10.48550/arxiv.';

const CitoidItemSchema = z
	.object({
		DOI: z.string().nullish(),
		archiveID: z.string().nullish(),
		extra: z.string().nullish(),
		itemType: z.string().nullish(),
		url: z.string().nullish(),
	})
	.passthrough();

const CitoidResponseSchema = z.array(CitoidItemSchema);
const ACADEMIC_ITEM_TYPES = new Set(['journalArticle', 'conferencePaper', 'preprint', 'thesis', 'manuscript']);

function citoidQueryUrl(value: string | null | undefined): string | null {
	if (!value?.trim() || resolveExactPaperInput(value)) return null;
	try {
		const url = new URL(value);
		if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
		return url.toString();
	} catch {
		return null;
	}
}

function citoidItemIdentifiers(item: z.infer<typeof CitoidItemSchema>): PaperIdentifier[] {
	const identity = paperIdentityFromText(
		[item.DOI ? `DOI: ${item.DOI}` : '', item.archiveID ?? '', item.url ?? '', item.extra?.slice(0, IDENTIFIER_SCAN_CHARS) ?? '']
			.filter(Boolean)
			.join('\n'),
	);
	return identity ? paperIdentifiersFromIdentity(identity) : [];
}

async function resolveCitoidIdentifiers(url: string): Promise<PaperIdentifier[]> {
	const response = await fetchWithTimeout(
		`${CITOID_BASE}${encodeURIComponent(url)}`,
		{
			headers: {
				Accept: 'application/json',
				'Api-User-Agent': CITOID_USER_AGENT,
				'User-Agent': CITOID_USER_AGENT,
			},
		},
		CITOID_TIMEOUT_MS,
	);
	if (!response.ok) {
		const status = response.status;
		const retryAfter = response.headers.get('retry-after');
		await response.body?.cancel();
		if (status === 429) {
			throw new Error(`Citoid request failed with HTTP 429${retryAfter ? `; retry_after_seconds=${retryAfter}` : ''}`);
		}
		console.warn({ tag: 'CITOID', event: 'translation_unavailable', status });
		return [];
	}
	const items = CitoidResponseSchema.parse(JSON.parse(await readTextWithLimit(response, CITOID_RESPONSE_MAX_BYTES)));
	const academicItem = items.find((item) => item.itemType && ACADEMIC_ITEM_TYPES.has(item.itemType));
	return academicItem ? normalizePaperIdentifiers(citoidItemIdentifiers(academicItem)) : [];
}

function choosePreferredIdentifiers(identifiers: readonly PaperIdentifier[]): PaperIdentifier[] {
	const normalized = normalizePaperIdentifiers(identifiers.map((identifier) => ({ ...identifier, preferred: false })));
	const preferred = new Map<PaperIdentifierScheme, string>();
	for (const scheme of ['doi', 'arxiv', 'openalex'] as const) {
		const candidates = normalized.filter((identifier) => identifier.scheme === scheme);
		const selected =
			scheme === 'doi' ? (candidates.find((identifier) => !identifier.value.startsWith(ARXIV_DOI_PREFIX)) ?? candidates[0]) : candidates[0];
		if (selected) preferred.set(scheme, selected.value);
	}
	return normalizePaperIdentifiers(
		normalized.map((identifier) => ({
			...identifier,
			preferred: preferred.get(identifier.scheme) === identifier.value,
		})),
	);
}

/**
 * One resolver boundary for every paper ingest path. Exact identifiers and PDF
 * front matter stay local. Only an ordinary public URL needs Citoid's hosted
 * Zotero translators, keeping the public service's 1 rps budget off DOI/arXiv
 * and backfill traffic.
 */
export async function resolveBibliographicIdentifiers(input: {
	identifierText?: string | null;
	seedIdentifiers?: readonly PaperIdentifier[];
	translateUrl?: boolean;
	url?: string | null;
}): Promise<PaperIdentifier[]> {
	const exact = resolveExactPaperInput(input.url)?.identity;
	const citoidUrl = input.translateUrl ? citoidQueryUrl(input.url) : null;
	const citoid = citoidUrl
		? await resolveCitoidIdentifiers(citoidUrl).catch((error) => {
				if (error instanceof Error && error.message.includes('HTTP 429')) throw error;
				console.warn({
					tag: 'CITOID',
					event: 'translation_failed',
					error: error instanceof Error ? error.message : String(error),
				});
				return [];
			})
		: [];
	const fromText = input.identifierText?.trim() ? paperIdentityFromText(input.identifierText.slice(0, IDENTIFIER_SCAN_CHARS)) : null;
	return choosePreferredIdentifiers([
		...(exact ? paperIdentifiersFromIdentity(exact) : []),
		...citoid,
		...(fromText ? paperIdentifiersFromIdentity(fromText) : []),
		...(input.seedIdentifiers ?? []),
	]);
}
