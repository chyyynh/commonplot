import { z } from 'zod';
import type { RESOURCE_TYPES, ResourceCreator } from '../shared/resource';

const ENTITY_NAME_MAX_LENGTH = 255;
const MAX_EXCLUSION_NAMES = 10;
const ASCII_TICKER_ENTITY_RE = /^\$[a-z]{1,5}$/i;
const SOURCE_SUFFIX_CANONICALS = new Set([
	'ai',
	'article',
	'articles',
	'blog',
	'business',
	'crypto',
	'finance',
	'news',
	'research',
	'rss',
	'startup',
	'startups',
	'tech',
	'technology',
]);

export const ResourceEntitiesSchema = z
	.array(
		z.object({
			name: z.string().trim().min(1),
			name_cn: z.string().trim(),
			type: z.enum(['person', 'organization', 'product', 'technology', 'event', 'location']),
		}),
	)
	.max(10);

export type ResourceEntity = z.infer<typeof ResourceEntitiesSchema>[number];
type StoredResourceEntity = { k: string; n: string; cn: string | null; t: ResourceEntity['type'] };

// Keep punctuation that can be part of a real name; strip only surrounding quotes/brackets.
function canonicalEntityName(name: string): string {
	return name
		.toLowerCase()
		.normalize('NFKC')
		.replace(/\s+/g, ' ')
		.replace(/^[\s"'`“”‘’([{]+|[\s"'`“”‘’]+$/g, '')
		.trim();
}

function sourceAliases(source?: string | null): string[] {
	const value = source?.trim();
	if (!value) return [];
	const aliases = [value];
	const suffixMatch = value.match(/^(.+?)\s+[-–—|:]\s+(.+)$/);
	if (suffixMatch) {
		const [, base, suffix] = suffixMatch;
		const suffixTokens = canonicalEntityName(suffix)
			.split(/[\s/]+/)
			.filter(Boolean);
		if (suffixTokens.length && suffixTokens.every((token) => SOURCE_SUFFIX_CANONICALS.has(token))) aliases.push(base.trim());
	}

	const parsed = URL.parse(value.includes('://') ? value : `https://${value}`);
	const host = parsed?.hostname.replace(/^www\./, '');
	if (host) {
		aliases.push(host);
		const firstLabel = host.split('.')[0];
		if (host.includes('.') && firstLabel) aliases.push(firstLabel);
	}
	return aliases;
}

function creatorAliases(creators: readonly ResourceCreator[]): string[] {
	return creators.flatMap((creator) => {
		const name = creator.literal ?? ([creator.given, creator.family].filter(Boolean).join(' ') || null);
		if (!name) return [];
		const handle = creator.handle?.replace(/^@/, '').trim();
		return handle ? [name, handle, `@${handle}`] : [name];
	});
}

export function entityExtractionExclusionNames(
	resourcePlatform: (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number]['name'] | null,
	source?: string | null,
	creators: readonly ResourceCreator[] = [],
): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const name of [...sourceAliases(source), ...creatorAliases(creators), ...(resourcePlatform === null ? [] : [resourcePlatform])]) {
		const canonical = canonicalEntityName(name);
		if (!canonical || seen.has(canonical)) continue;
		seen.add(canonical);
		names.push(name.trim());
		if (names.length >= MAX_EXCLUSION_NAMES) break;
	}
	return names;
}

export function toStoredResourceEntities(
	entities: readonly ResourceEntity[],
	resourcePlatform: (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number]['name'] | null,
	source?: string | null,
	creators: readonly ResourceCreator[] = [],
): StoredResourceEntity[] {
	const excluded = new Set(entityExtractionExclusionNames(resourcePlatform, source, creators).map(canonicalEntityName));
	const stored = new Map<string, StoredResourceEntity>();
	for (const entity of entities) {
		const canonical = canonicalEntityName(entity.name);
		if (
			!canonical ||
			stored.has(canonical) ||
			/^[a-z0-9]{1,2}$/i.test(canonical) ||
			canonical.length > ENTITY_NAME_MAX_LENGTH ||
			entity.name.length > ENTITY_NAME_MAX_LENGTH ||
			entity.name_cn.length > ENTITY_NAME_MAX_LENGTH ||
			ASCII_TICKER_ENTITY_RE.test(canonical) ||
			excluded.has(canonical)
		) {
			continue;
		}
		stored.set(canonical, {
			k: canonical,
			n: entity.name,
			cn: entity.name_cn || null,
			t: entity.type,
		});
	}
	return [...stored.values()].sort((a, b) => a.k.localeCompare(b.k));
}
