#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const drizzlePath = resolve(root, 'src/db/schema.ts');
const prismaPath = resolve(root, '../../web-tanstack/prisma/schema.prisma');
const manualIndexesPath = resolve(root, '../../web-tanstack/prisma/manual-indexes.sql');
const resourceTypesPath = resolve(root, 'src/shared/resource-types.ts');

const drizzleSource = readFileSync(drizzlePath, 'utf8');
const prismaSource = readFileSync(prismaPath, 'utf8');
const manualIndexesSource = readFileSync(manualIndexesPath, 'utf8');
const resourceTypesSource = readFileSync(resourceTypesPath, 'utf8');

const PRISMA_SCALARS = new Set(['String', 'Int', 'BigInt', 'Boolean', 'DateTime', 'Decimal', 'Json', 'Bytes', 'Unsupported']);

function parsePrismaEnums(source) {
	const enums = new Set();
	const enumPattern = /enum\s+(\w+)\s*\{[\s\S]*?\n\}/g;
	for (const match of source.matchAll(enumPattern)) enums.add(match[1]);
	return enums;
}

function prismaBaseType(type) {
	return type
		.replaceAll('?', '')
		.replaceAll('[', '')
		.replaceAll(']', '')
		.replace(/^Unsupported\(.+$/, 'Unsupported');
}

function parsePrismaModels(source) {
	const enums = parsePrismaEnums(source);
	const tables = new Map();
	const modelPattern = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;

	for (const match of source.matchAll(modelPattern)) {
		const [, modelName, body] = match;
		const tableName = body.match(/@@map\("([^"]+)"\)/)?.[1] ?? modelName;
		const columns = new Set();

		for (const rawLine of body.split('\n')) {
			const line = rawLine.trim().replace(/\s+\/\/.*$/, '');
			if (!line || line.startsWith('//') || line.startsWith('@@')) continue;

			const [fieldName, rawType] = line.split(/\s+/, 2);
			if (!fieldName || !rawType) continue;

			const baseType = prismaBaseType(rawType);
			if (!PRISMA_SCALARS.has(baseType) && !enums.has(baseType)) continue;

			const columnName = line.match(/@map\("([^"]+)"\)/)?.[1] ?? fieldName;
			columns.add(columnName);
		}

		tables.set(tableName, { modelName, columns });
	}

	return tables;
}

function parseDrizzleTables(source) {
	const tables = [];
	const tablePattern = /export const (\w+)\s*=\s*pgTable\(\s*'([^']+)'\s*,\s*\{/g;
	const columnPattern = /^\s*\w+:\s*\w+(?:<[^>]+>)?\('([^']+)'/gm;

	for (const match of source.matchAll(tablePattern)) {
		const [, exportName, tableName] = match;
		const bodyStart = match.index + match[0].length - 1;
		const bodyEnd = findMatchingBrace(source, bodyStart);
		if (bodyEnd === -1) {
			tables.push({ exportName, tableName, columns: new Set() });
			continue;
		}
		const body = source.slice(bodyStart + 1, bodyEnd);
		const columns = new Set();
		for (const columnMatch of body.matchAll(columnPattern)) columns.add(columnMatch[1]);
		tables.push({ exportName, tableName, columns });
	}

	return tables;
}

function findMatchingBrace(source, openIndex) {
	let depth = 0;
	for (let index = openIndex; index < source.length; index++) {
		const char = source[index];
		if (char === '{') depth++;
		else if (char === '}') {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

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

function sqlStringValues(source) {
	return [...source.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function parseDomainConstraint(source, constraintName, columnName) {
	const match = source.match(
		new RegExp(`ADD CONSTRAINT ${constraintName}\\s+CHECK \\((?:${columnName} IS NULL OR )?${columnName} IN \\(([^)]+)\\)\\);`),
	);
	return match ? sqlStringValues(match[1]) : null;
}

function parseKindPlatformMatrixBody(body) {
	if (!body) return null;
	const pairs = [];
	for (const match of body.matchAll(/\(kind = '([^']+)' AND resource_platform (IS NULL|= '([^']+)')\)/g)) {
		pairs.push(`${match[1]}:${match[2] === 'IS NULL' ? 'null' : match[3]}`);
	}
	return {
		allowsLegacyNullPair: /\(kind IS NULL AND resource_platform IS NULL\)/.test(body),
		pairs,
	};
}

function parseConstraintKindPlatformMatrix(source) {
	const body = source.match(/ADD CONSTRAINT resources_kind_platform_check\s+CHECK\s*\(\s*\(([\s\S]*?)\)\s+IS TRUE\s*\);/)?.[1];
	return parseKindPlatformMatrixBody(body);
}

function expectedKindPlatformPairs(matrix) {
	return [...matrix.entries()].flatMap(([kind, platforms]) => platforms.map((platform) => `${kind}:${platform ?? 'null'}`));
}

function sameValues(actual, expected) {
	return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sameMembers(actual, expected) {
	return sameValues([...actual].sort(), [...expected].sort());
}

const prismaTables = parsePrismaModels(prismaSource);
const drizzleTables = parseDrizzleTables(drizzleSource);
const errors = [];

if (/^(?!\s*--)[^\r\n]*\bDROP\s+(?:TABLE|COLUMN)\b/im.test(manualIndexesSource)) {
	errors.push('manual-indexes.sql must not drop tables or columns; use an explicit cutover');
}

if (drizzleTables.length === 0) errors.push(`No Drizzle pgTable definitions found in ${drizzlePath}`);

for (const table of drizzleTables) {
	const prismaTable = prismaTables.get(table.tableName);
	if (!prismaTable) {
		errors.push(`Drizzle table ${table.exportName} maps to "${table.tableName}", which is absent from Prisma schema`);
		continue;
	}

	for (const column of table.columns) {
		if (!prismaTable.columns.has(column)) {
			errors.push(
				`Drizzle table ${table.exportName}."${column}" is absent from Prisma model ${prismaTable.modelName} (${table.tableName})`,
			);
		}
	}
	for (const column of prismaTable.columns) {
		if (!table.columns.has(column)) {
			errors.push(
				`Prisma model ${prismaTable.modelName}."${column}" is absent from Drizzle table ${table.exportName} (${table.tableName})`,
			);
		}
	}
}

if (/\bRESOURCE_TYPES\b|type:\s*text\('type'/.test(drizzleSource)) {
	errors.push('Drizzle resources must not expose the retired type column/domain');
}
if (/resources_type_check/.test(manualIndexesSource)) {
	errors.push('manual-indexes.sql must not recreate resources_type_check');
}

const resourceKinds = parseStringArray(resourceTypesSource, 'RESOURCE_KINDS');
const resourcePlatforms = parseStringArray(resourceTypesSource, 'RESOURCE_PLATFORMS');
const validKindPlatforms = parseStringOrNullArrayRecord(resourceTypesSource, 'VALID_KIND_PLATFORMS');
if (!resourceKinds || !resourcePlatforms || !validKindPlatforms) {
	errors.push(`Unable to parse canonical resource identity domains from ${resourceTypesPath}`);
} else {
	const matrixKinds = [...validKindPlatforms.keys()];
	if (!sameMembers(matrixKinds, resourceKinds)) {
		errors.push('VALID_KIND_PLATFORMS keys differ from canonical RESOURCE_KINDS');
	}
	const unknownMatrixPlatforms = [...validKindPlatforms.values()]
		.flat()
		.filter((platform) => platform !== null && !resourcePlatforms.includes(platform));
	if (unknownMatrixPlatforms.length > 0) {
		errors.push(`VALID_KIND_PLATFORMS contains unknown platforms: ${[...new Set(unknownMatrixPlatforms)].join(', ')}`);
	}

	if (!/kind:\s*text\('kind',\s*\{\s*enum:\s*RESOURCE_KINDS\s*\}\)\.notNull\(\),/.test(drizzleSource)) {
		errors.push('Drizzle resources.kind must be required and use the canonical RESOURCE_KINDS domain');
	}
	if (!/resourcePlatform:\s*text\('resource_platform',\s*\{\s*enum:\s*RESOURCE_PLATFORMS\s*\}\),/.test(drizzleSource)) {
		errors.push('Drizzle resources.resourcePlatform must be nullable and use the canonical RESOURCE_PLATFORMS domain');
	}

	const resourceModelBody = prismaSource.match(/model Resource \{([\s\S]*?)\n\}/)?.[1] ?? '';
	if (!/^\s*kind\s+String\s*$/m.test(resourceModelBody)) {
		errors.push('Prisma Resource.kind must be required and have no default');
	}
	if (!/^\s*resourcePlatform\s+String\?\s+@map\("resource_platform"\)\s*$/m.test(resourceModelBody)) {
		errors.push('Prisma Resource.resourcePlatform must be nullable, mapped to resource_platform, and have no default');
	}

	const expectedPairs = expectedKindPlatformPairs(validKindPlatforms);
	const constrainedKinds = parseDomainConstraint(manualIndexesSource, 'resources_kind_check', 'kind');
	if (!constrainedKinds || !sameValues(constrainedKinds, resourceKinds)) {
		errors.push('manual-indexes.sql resources_kind_check differs from canonical RESOURCE_KINDS');
	}
	const constrainedPlatforms = parseDomainConstraint(manualIndexesSource, 'resources_resource_platform_check', 'resource_platform');
	if (!constrainedPlatforms || !sameValues(constrainedPlatforms, resourcePlatforms)) {
		errors.push('manual-indexes.sql resources_resource_platform_check differs from canonical RESOURCE_PLATFORMS');
	}
	const matrix = parseConstraintKindPlatformMatrix(manualIndexesSource);
	if (!matrix || matrix.allowsLegacyNullPair || !sameMembers(matrix.pairs, expectedPairs)) {
		errors.push('manual-indexes.sql resources_kind_platform_check differs from canonical VALID_KIND_PLATFORMS');
	}
	if (!/r\.source_id,\s*r\.kind,\s*r\.resource_platform\s+FROM resources/.test(manualIndexesSource)) {
		errors.push('manual-indexes.sql resources_localized must append kind and resource_platform after source_id');
	}
}

const sourcePlatforms = parseStringArray(resourceTypesSource, 'SOURCE_PLATFORMS');
if (!sourcePlatforms) {
	errors.push(`Unable to parse canonical source platforms from ${resourceTypesPath}`);
} else {
	if (!/platform:\s*text\('platform',\s*\{\s*enum:\s*SOURCE_PLATFORMS\s*\}\)/.test(drizzleSource)) {
		errors.push('Drizzle sources.platform must use the canonical SOURCE_PLATFORMS domain');
	}
	if (!/acquisitionMode:\s*text\('content_mode'\)\.notNull\(\)/.test(drizzleSource)) {
		errors.push('Drizzle sources.acquisitionMode must retain the content_mode compatibility column');
	}
	const platformConstraint = manualIndexesSource.match(/ADD CONSTRAINT sources_platform_check\s+CHECK \(platform IN \(([^)]+)\)\);/);
	const constrainedPlatforms = platformConstraint ? [...platformConstraint[1].matchAll(/'([^']+)'/g)].map((match) => match[1]) : null;
	if (!constrainedPlatforms || !sameMembers(constrainedPlatforms, sourcePlatforms)) {
		errors.push('sources_platform_check differs from canonical SOURCE_PLATFORMS');
	}
	const acquisitionConstraint = manualIndexesSource.match(
		/ADD CONSTRAINT sources_acquisition_mode_check\s+CHECK \(([\s\S]*?)\n {2}\);/,
	)?.[1];
	const normalizedAcquisitionConstraint = acquisitionConstraint?.replace(/\s+/g, ' ').trim();
	if (
		!normalizedAcquisitionConstraint?.includes("platform IN ('rss', 'lesswrong', 'youtube') AND content_mode = 'web'") ||
		!normalizedAcquisitionConstraint.includes("platform = 'twitter' AND content_mode = 'platform'")
	) {
		errors.push('sources_acquisition_mode_check must derive its compatibility value from platform');
	}
}

if (errors.length > 0) {
	console.error('Drizzle/Prisma schema drift detected:\n');
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

process.stdout.write(
	`Drizzle/Prisma drift check passed for ${drizzleTables.length} complete table definitions and canonical resource/source domains and identity matrix.\n`,
);
