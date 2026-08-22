#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prismaPath = resolve(root, '../../web-tanstack/prisma/schema.prisma');
const manualIndexesPath = resolve(root, '../../web-tanstack/prisma/manual-indexes.sql');
const resourceTypesPath = resolve(root, 'src/shared/resource-types.ts');

const prismaSource = readFileSync(prismaPath, 'utf8');
const manualIndexesSource = readFileSync(manualIndexesPath, 'utf8');
const resourceTypesSource = readFileSync(resourceTypesPath, 'utf8');
const errors = [];

function parseStringArray(source, name) {
	const declaration = source.match(new RegExp(`(?:export )?const ${name} = \\[([^\\]]*)\\] as const`));
	if (!declaration) return null;
	return [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function parseStringOrNullArrayRecord(source, name) {
	const body = source.match(new RegExp(`(?:export )?const ${name} = \\{([\\s\\S]*?)\\} as const`))?.[1];
	if (!body) return null;
	const entries = new Map();
	for (const match of body.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
		const values = [...match[2].matchAll(/'([^']+)'|\b(null)\b/g)].map((value) => value[1] ?? null);
		entries.set(match[1], values);
	}
	return entries.size > 0 ? entries : null;
}

function parseDomainConstraint(source, constraintName, columnName) {
	const match = source.match(
		new RegExp(`ADD CONSTRAINT ${constraintName}\\s+CHECK \\((?:${columnName} IS NULL OR )?${columnName} IN \\(([^)]+)\\)\\);`),
	);
	return match ? [...match[1].matchAll(/'([^']+)'/g)].map((value) => value[1]) : null;
}

function parseKindPlatformMatrix(source) {
	const body = source.match(/ADD CONSTRAINT resources_kind_platform_check\s+CHECK\s*\(\s*\(([\s\S]*?)\)\s+IS TRUE\s*\);/)?.[1];
	if (!body) return null;
	const pairs = [];
	for (const match of body.matchAll(/\(kind = '([^']+)' AND resource_platform (IS NULL|= '([^']+)')\)/g)) {
		pairs.push(`${match[1]}:${match[2] === 'IS NULL' ? 'null' : match[3]}`);
	}
	return { allowsLegacyNullPair: /\(kind IS NULL AND resource_platform IS NULL\)/.test(body), pairs };
}

function sameValues(actual, expected) {
	return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sameMembers(actual, expected) {
	return sameValues([...actual].sort(), [...expected].sort());
}

if (/^(?!\s*--)[^\r\n]*\bDROP\s+(?:TABLE|COLUMN)\b/im.test(manualIndexesSource)) {
	errors.push('manual-indexes.sql must not drop tables or columns; use an explicit cutover');
}
if (/resources_type_check/.test(manualIndexesSource)) {
	errors.push('manual-indexes.sql must not recreate resources_type_check');
}
if (/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+resources_localized/i.test(manualIndexesSource)) {
	errors.push('manual-indexes.sql must not recreate the retired resources_localized projection');
}

const resourceKinds = parseStringArray(resourceTypesSource, 'RESOURCE_KINDS');
const resourcePlatforms = parseStringArray(resourceTypesSource, 'RESOURCE_PLATFORMS');
const validKindPlatforms = parseStringOrNullArrayRecord(resourceTypesSource, 'VALID_KIND_PLATFORMS');
if (!resourceKinds || !resourcePlatforms || !validKindPlatforms) {
	errors.push(`Unable to parse canonical resource identity domains from ${resourceTypesPath}`);
} else {
	if (!sameMembers(validKindPlatforms.keys(), resourceKinds)) {
		errors.push('VALID_KIND_PLATFORMS keys differ from canonical RESOURCE_KINDS');
	}
	const unknownPlatforms = [...validKindPlatforms.values()]
		.flat()
		.filter((platform) => platform !== null && !resourcePlatforms.includes(platform));
	if (unknownPlatforms.length > 0) {
		errors.push(`VALID_KIND_PLATFORMS contains unknown platforms: ${[...new Set(unknownPlatforms)].join(', ')}`);
	}

	const resourceModelBody = prismaSource.match(/model Resource \{([\s\S]*?)\n\}/)?.[1] ?? '';
	if (!/^\s*kind\s+String\s*$/m.test(resourceModelBody)) {
		errors.push('Prisma Resource.kind must be required and have no default');
	}
	if (!/^\s*resourcePlatform\s+String\?\s+@map\("resource_platform"\)\s*$/m.test(resourceModelBody)) {
		errors.push('Prisma Resource.resourcePlatform must be nullable, mapped to resource_platform, and have no default');
	}

	const constrainedKinds = parseDomainConstraint(manualIndexesSource, 'resources_kind_check', 'kind');
	if (!constrainedKinds || !sameValues(constrainedKinds, resourceKinds)) {
		errors.push('resources_kind_check differs from canonical RESOURCE_KINDS');
	}
	const constrainedPlatforms = parseDomainConstraint(manualIndexesSource, 'resources_resource_platform_check', 'resource_platform');
	if (!constrainedPlatforms || !sameValues(constrainedPlatforms, resourcePlatforms)) {
		errors.push('resources_resource_platform_check differs from canonical RESOURCE_PLATFORMS');
	}
	const expectedPairs = [...validKindPlatforms.entries()].flatMap(([kind, platforms]) =>
		platforms.map((platform) => `${kind}:${platform ?? 'null'}`),
	);
	const matrix = parseKindPlatformMatrix(manualIndexesSource);
	if (!matrix || matrix.allowsLegacyNullPair || !sameMembers(matrix.pairs, expectedPairs)) {
		errors.push('resources_kind_platform_check differs from canonical VALID_KIND_PLATFORMS');
	}
}

const sourcePlatforms = parseStringArray(resourceTypesSource, 'SOURCE_PLATFORMS');
if (!sourcePlatforms) {
	errors.push(`Unable to parse canonical source platforms from ${resourceTypesPath}`);
} else {
	if (/\bcontent_mode\b|\bpoll_interval_minutes\b/.test(prismaSource)) {
		errors.push('Prisma Source model must not restore retired routing/cadence columns');
	}
	const platformConstraint = manualIndexesSource.match(/ADD CONSTRAINT sources_platform_check\s+CHECK \(platform IN \(([^)]+)\)\);/);
	const constrainedPlatforms = platformConstraint ? [...platformConstraint[1].matchAll(/'([^']+)'/g)].map((match) => match[1]) : null;
	if (!constrainedPlatforms || !sameMembers(constrainedPlatforms, sourcePlatforms)) {
		errors.push('sources_platform_check differs from canonical SOURCE_PLATFORMS');
	}
	const twitterHandleConstraint = manualIndexesSource.match(
		/ADD CONSTRAINT sources_twitter_handle_check\s+CHECK \(([\s\S]*?)\n {2}\);/,
	)?.[1];
	const normalizedTwitterConstraint = twitterHandleConstraint?.replace(/\s+/g, ' ').trim();
	if (
		!normalizedTwitterConstraint?.includes("platform <> 'twitter'") ||
		!normalizedTwitterConstraint.includes('handle = lower(handle)') ||
		!normalizedTwitterConstraint.includes("handle ~ '^[a-z0-9_]{1,15}$'")
	) {
		errors.push('sources_twitter_handle_check must enforce canonical Twitter handles');
	}
}

if (errors.length > 0) {
	console.error('Database contract drift detected:\n');
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

process.stdout.write('Database contract check passed for canonical resource/source domains and identity matrix.\n');
