import { z } from 'zod';
import { isPaperIdentifierScheme, PAPER_IDENTIFIERS } from './paper-identity.ts';
import { type EntityType, PAPER_IDENTIFIER_SCHEMES, RESOURCE_PLATFORM_NAMES } from './resource-kinds.ts';
import { RESOURCE_PLATFORMS } from './resource-url';

const ResourceIdentifierSchemeSchema = z.enum([...PAPER_IDENTIFIER_SCHEMES, ...RESOURCE_PLATFORM_NAMES]);

function canonicalIdentifierValue(scheme: z.infer<typeof ResourceIdentifierSchemeSchema>, value: string): string | null {
	if (isPaperIdentifierScheme(scheme)) return PAPER_IDENTIFIERS[scheme].normalize(value);
	const identifier = RESOURCE_PLATFORMS[scheme].identifier.safeParse(value);
	return identifier.success ? identifier.data : null;
}

const ResourceIdentifierSchema = z
	.strictObject({ preferred: z.boolean(), scheme: ResourceIdentifierSchemeSchema, value: z.string() })
	.refine(
		(identifier) => canonicalIdentifierValue(identifier.scheme, identifier.value) === identifier.value,
		'Identifier is not canonical',
	);

export const ResourceIdentifiersSchema = z.array(ResourceIdentifierSchema).refine((identifiers) => {
	const values = identifiers.map(({ scheme, value }) => `${scheme}:${value}`);
	const schemes = identifiers.map(({ scheme }) => scheme);
	const preferredSchemes = identifiers.filter(({ preferred }) => preferred).map(({ scheme }) => scheme);
	return (
		new Set(values).size === values.length &&
		new Set(preferredSchemes).size === preferredSchemes.length &&
		new Set(preferredSchemes).size === new Set(schemes).size
	);
}, 'Identifiers must be unique with exactly one preferred value per scheme');

export type ResourceIdentifier = Readonly<z.infer<typeof ResourceIdentifierSchema>>;

/**
 * Case, width, spacing, dashes and punctuation never tell two entities apart. A parenthetical qualifier,
 * the maker, does only for a single bare word ("Pi (Inflection AI)"); a longer or versioned name is
 * already specific, so "GPT-6 Astra (OpenAI)" is "GPT-6 Astra".
 */
export function entityKey(name: string): string {
	const normalized = name.normalize('NFKC').toLowerCase().trim();
	const bare = normalized.replace(/\s*\([^)]*\)\s*$/u, '');
	const specific = bare !== normalized && (/\s/u.test(bare) || /\d/u.test(bare));
	return (specific ? bare : normalized).replace(/[\s\p{Pd}_.·・'’"]+/gu, '');
}

/** `weight`: how much the Resource is about the entity, from 0 (named in passing) to 1 (its sole subject). */
export type ResourceEntity = Readonly<{
	name: string;
	type: EntityType;
	weight: number;
}>;
