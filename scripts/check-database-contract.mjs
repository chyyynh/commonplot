#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prismaPath = resolve(root, '../../web-tanstack/prisma/schema.prisma');
const manualIndexesPath = resolve(root, '../../web-tanstack/prisma/manual-indexes.sql');
const resourcePath = resolve(root, 'src/shared/resource.ts');

const prismaSource = readFileSync(prismaPath, 'utf8');
const manualIndexesSource = readFileSync(manualIndexesPath, 'utf8');
const resourceSource = readFileSync(resourcePath, 'utf8');
const errors = [];

function parseZodEnumProperty(source, name) {
	const declaration = source.match(new RegExp(`${name}: z\\.enum\\(\\[([^\\]]*)\\]\\)`));
	if (!declaration) return null;
	return [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function parseStringRecordProperty(source, name) {
	const body = source.match(new RegExp(`${name}: \\{([\\s\\S]*?)\\}`))?.[1];
	if (!body) return null;
	const entries = new Map();
	for (const match of body.matchAll(/(\w+):\s*'([^']+)'/g)) entries.set(match[1], match[2]);
	return entries.size > 0 ? entries : null;
}

function parseDomainConstraint(source, constraintName, columnName) {
	const match = source.match(
		new RegExp(`ADD CONSTRAINT ${constraintName}\\s+CHECK \\((?:${columnName} IS NULL OR )?${columnName} IN \\(([^)]+)\\)\\);`),
	);
	return match ? [...match[1].matchAll(/'([^']+)'/g)].map((value) => value[1]) : null;
}

function parsePlatformKindConstraint(source) {
	const body = source.match(/ADD CONSTRAINT resources_kind_platform_check\s+CHECK\s*\(([\s\S]*?)\);/)?.[1];
	if (!body) return null;
	const entries = new Map();
	for (const match of body.matchAll(/WHEN '([^']+)' THEN '([^']+)'/g)) entries.set(match[1], match[2]);
	return /resource_platform IS NULL\s+OR kind = CASE resource_platform/.test(body) && entries.size > 0 ? entries : null;
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

const resourceKinds = parseZodEnumProperty(resourceSource, 'kinds');
const platformKinds = parseStringRecordProperty(resourceSource, 'platformKinds');
const resourcePlatforms = platformKinds ? [...platformKinds.keys()] : null;
if (!resourceKinds || !resourcePlatforms || !platformKinds) {
	errors.push(`Unable to parse canonical resource identity domains from ${resourcePath}`);
} else {
	const unknownKinds = [...platformKinds.values()].filter((kind) => !resourceKinds.includes(kind));
	if (unknownKinds.length > 0) {
		errors.push(`RESOURCE_TYPES.platformKinds contains unknown kinds: ${[...new Set(unknownKinds)].join(', ')}`);
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
		errors.push('resources_kind_check differs from RESOURCE_TYPES.kinds');
	}
	const constrainedPlatforms = parseDomainConstraint(manualIndexesSource, 'resources_resource_platform_check', 'resource_platform');
	if (!constrainedPlatforms || !sameValues(constrainedPlatforms, resourcePlatforms)) {
		errors.push('resources_resource_platform_check differs from RESOURCE_TYPES.platformKinds');
	}
	const constrainedPlatformKinds = parsePlatformKindConstraint(manualIndexesSource);
	const expectedPlatformKinds = [...platformKinds].map(([platform, kind]) => `${platform}:${kind}`);
	const actualPlatformKinds = constrainedPlatformKinds
		? [...constrainedPlatformKinds].map(([platform, kind]) => `${platform}:${kind}`)
		: [];
	if (!constrainedPlatformKinds || !sameMembers(actualPlatformKinds, expectedPlatformKinds)) {
		errors.push('resources_kind_platform_check differs from RESOURCE_TYPES.platformKinds');
	}
}

const sourceModelBody = prismaSource.match(/model Source \{([\s\S]*?)\n\}/)?.[1] ?? '';
if (!/^\s*monitorKind\s+String\s+@map\("monitor_kind"\)\s*$/m.test(sourceModelBody)) {
	errors.push('Prisma Source.monitorKind must map to monitor_kind');
}
if (/^\s*platform\s+/m.test(sourceModelBody) || /\bcontent_mode\b|\bpoll_interval_minutes\b/.test(sourceModelBody)) {
	errors.push('Prisma Source model must not restore retired platform/routing/cadence columns');
}
const constrainedMonitorKinds = parseDomainConstraint(manualIndexesSource, 'sources_monitor_kind_check', 'monitor_kind');
if (!constrainedMonitorKinds || !sameValues(constrainedMonitorKinds, ['feed', 'twitter'])) {
	errors.push('sources_monitor_kind_check must allow only feed and twitter');
}
const twitterHandleConstraint = manualIndexesSource.match(/ADD CONSTRAINT sources_twitter_handle_check\s+CHECK \(([\s\S]*?)\n {2}\);/)?.[1];
const normalizedTwitterConstraint = twitterHandleConstraint?.replace(/\s+/g, ' ').trim();
if (
	!normalizedTwitterConstraint?.includes("monitor_kind <> 'twitter'") ||
	!normalizedTwitterConstraint.includes('handle = lower(handle)') ||
	!normalizedTwitterConstraint.includes("handle ~ '^[a-z0-9_]{1,15}$'")
) {
	errors.push('sources_twitter_handle_check must enforce canonical Twitter handles');
}

if (errors.length > 0) {
	console.error('Database contract drift detected:\n');
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

process.stdout.write('Database contract check passed for canonical resource/source domains and platform-kind mapping.\n');
