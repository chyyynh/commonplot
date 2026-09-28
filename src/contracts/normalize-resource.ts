import { toString } from 'mdast-util-to-string';
import type { AcquiredResource, SourceHints } from './acquired-resource';
import { parseMarkdown } from './markdown';
import { isPaperIdentifierScheme } from './paper-identity';
import { RESOURCE_KIND_METADATA, RESOURCE_PLATFORMS, ResourceCreatorsSchema, ResourceIdentifiersSchema } from './resource';
import { detectResourceLanguage, ResourceLanguageSchema } from './resource-language';
import { resolveResourceUrl } from './resource-url';

/** Remove a duplicate heading only after Core has resolved the resource title. */
function withoutDuplicateResourceTitle(markdown: string, title: string): string {
	const first = parseMarkdown(markdown).children[0];
	const comparable = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
	if (first?.type !== 'heading' || comparable(toString(first, { includeImageAlt: false })) !== comparable(title)) return markdown;
	const end = first.position?.end.offset;
	if (end === undefined) return markdown;
	const body = markdown.slice(end).trimStart();
	return body || markdown;
}

/**
 * The one normalization every adapter output passes through, before any paid enrichment: trims text, fills source
 * hints, resolves language, date, URLs, and checks the identity invariants the database also enforces.
 */
export function normalizeAcquiredResource(resource: AcquiredResource, hints?: SourceHints) {
	const title = resource.title?.trim() || null;
	const summary = resource.summary?.trim() || hints?.summary?.trim() || null;
	if (resource.kind === 'post' ? title !== null || summary !== null : !title) {
		throw new TypeError('Posts have no title or summary; every other Resource requires a title');
	}
	const content = (title ? withoutDuplicateResourceTitle(resource.content, title) : resource.content).trim();
	if (!content) throw new TypeError('Resolved Resource requires content');
	const source = resource.source.trim();
	if (!source) throw new TypeError('Resolved Resource requires a source name');
	const identifiers = ResourceIdentifiersSchema.parse(resource.resourceIdentifiers);
	if (
		resource.resourcePlatform !== null
			? !(RESOURCE_PLATFORMS[resource.resourcePlatform].kinds as readonly string[]).includes(resource.kind) ||
				!identifiers.length ||
				identifiers.some(({ scheme }) => scheme !== resource.resourcePlatform)
			: resource.kind === 'paper'
				? !identifiers.length || identifiers.some((identifier) => !isPaperIdentifierScheme(identifier.scheme))
				: identifiers.length > 0
	) {
		throw new TypeError('Resource identifiers do not match its identity');
	}
	if (resource.resourcePlatform === 'youtube' ? !resource.youtube : resource.youtube !== undefined) {
		throw new TypeError('YouTube data requires a YouTube video Resource');
	}
	const resolvedUrl = resolveResourceUrl(resource.url);
	if (resource.url !== null && !resolvedUrl) throw new TypeError('Resource URL must be HTTP(S) without credentials');
	const subject = resolveResourceUrl(resource.subjectUrl);
	if (resource.subjectUrl !== null && !subject) throw new TypeError('Subject URL must be HTTP(S) without credentials');
	const declaredLang = ResourceLanguageSchema.safeParse(resource.originalLang).data;
	const parsedDate = Date.parse(resource.publishedDate ?? '');
	const publishedDate = Number.isNaN(parsedDate) ? (hints?.publishedDate ?? null) : new Date(parsedDate).toISOString();
	// A date in the future is a provider error; the Resource was published by today at the latest.
	const today = new Date().toISOString().slice(0, 10);
	return {
		...resource,
		title,
		summary,
		content,
		source,
		resourceIdentifiers: identifiers,
		creators: ResourceCreatorsSchema.parse(resource.creators),
		kindMetadata: RESOURCE_KIND_METADATA[resource.kind].parse(resource.kindMetadata),
		originalLang: ResourceLanguageSchema.parse(
			detectResourceLanguage(content, declaredLang && declaredLang !== 'und' ? declaredLang : (hints?.originalLang ?? 'und')),
		),
		publishedDate: publishedDate && publishedDate.slice(0, 10) > today ? new Date(today).toISOString() : publishedDate,
		url: resolvedUrl?.url ?? null,
		normalizedUrl: resolvedUrl?.normalizedUrl ?? null,
		subject,
	};
}

export type NormalizedResource = ReturnType<typeof normalizeAcquiredResource>;
