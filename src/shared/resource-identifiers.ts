import { isPaperIdentifierScheme, normalizePaperIdentifiers, type PaperIdentifier, type PaperIdentifierScheme } from './paper-identity.ts';
import type { ResourceIdentity } from './resource-types.ts';

const PLATFORM_RESOURCE_IDENTIFIER_SCHEMES = ['hackernews', 'twitter', 'youtube'] as const;

export type PlatformResourceIdentifierScheme = (typeof PLATFORM_RESOURCE_IDENTIFIER_SCHEMES)[number];

export type ResourceIdentifierScheme = PaperIdentifierScheme | PlatformResourceIdentifierScheme;

function isPlatformResourceIdentifierScheme(value: unknown): value is PlatformResourceIdentifierScheme {
	return typeof value === 'string' && (PLATFORM_RESOURCE_IDENTIFIER_SCHEMES as readonly string[]).includes(value);
}

export function isResourceIdentifierScheme(value: unknown): value is ResourceIdentifierScheme {
	return isPaperIdentifierScheme(value) || isPlatformResourceIdentifierScheme(value);
}

export type ResourceIdentifier = Readonly<{
	preferred: boolean;
	scheme: ResourceIdentifierScheme;
	value: string;
}>;

export function isPaperIdentifier(identifier: ResourceIdentifier): identifier is PaperIdentifier {
	return isPaperIdentifierScheme(identifier.scheme);
}

export function isResourceIdentifierCompatibleWithIdentity(identifier: ResourceIdentifier, identity: ResourceIdentity): boolean {
	switch (identity.kind) {
		case 'blog':
		case 'image':
		case 'file':
			return false;
		case 'forum':
			return identifier.scheme === 'hackernews';
		case 'post':
			return identifier.scheme === 'twitter';
		case 'video':
			return identifier.scheme === 'youtube';
		case 'paper':
			return isPaperIdentifier(identifier);
	}
}

function normalizePlatformIdentifier(
	identifier: Omit<ResourceIdentifier, 'preferred'> & { preferred?: boolean },
): ResourceIdentifier | null {
	const value = identifier.value.trim();
	if (!value) return null;
	if (identifier.scheme === 'hackernews' && !/^[1-9]\d*$/.test(value)) return null;
	if (identifier.scheme === 'twitter' && !/^\d+$/.test(value)) return null;
	if (identifier.scheme === 'youtube' && !/^[A-Za-z0-9_-]{6,20}$/.test(value)) return null;
	return { preferred: identifier.preferred !== false, scheme: identifier.scheme, value };
}

export function normalizeResourceIdentifiers(
	identifiers: readonly (Omit<ResourceIdentifier, 'preferred'> & { preferred?: boolean })[],
): ResourceIdentifier[] {
	const papers = normalizePaperIdentifiers(
		identifiers.filter((identifier): identifier is Omit<PaperIdentifier, 'preferred'> & { preferred?: boolean } =>
			isPaperIdentifierScheme(identifier.scheme),
		),
	);
	const platforms = identifiers.flatMap((identifier) => {
		if (isPaperIdentifierScheme(identifier.scheme)) return [];
		const normalized = normalizePlatformIdentifier(identifier);
		return normalized ? [normalized] : [];
	});
	const deduplicated = new Map<string, ResourceIdentifier>();
	for (const identifier of [...papers, ...platforms]) {
		const key = `${identifier.scheme}:${identifier.value}`;
		const existing = deduplicated.get(key);
		deduplicated.set(key, existing ? { ...existing, preferred: existing.preferred || identifier.preferred } : identifier);
	}
	const preferredSchemes = new Set<ResourceIdentifierScheme>();
	return [...deduplicated.values()].map((identifier) => {
		const preferred = identifier.preferred && !preferredSchemes.has(identifier.scheme);
		if (preferred) preferredSchemes.add(identifier.scheme);
		return { ...identifier, preferred };
	});
}
