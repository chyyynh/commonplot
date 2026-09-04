#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESOURCE_TYPES } from '../src/shared/resource.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prismaPath = resolve(root, '../../web-tanstack/prisma/schema.prisma');
const manualIndexesPath = resolve(root, '../../web-tanstack/prisma/manual-indexes.sql');
const resourceReferencesMigrationPath = resolve(
	root,
	'../../web-tanstack/prisma/migrations/20260829123000_add_resource_references/migration.sql',
);
const dropResourceReferenceMarkerMigrationPath = resolve(
	root,
	'../../web-tanstack/prisma/migrations/20260903080000_drop_resource_reference_marker/migration.sql',
);
const resourceCitationMentionsMigrationPath = resolve(
	root,
	'../../web-tanstack/prisma/migrations/20260903090000_add_resource_citation_mentions/migration.sql',
);

const prismaSource = readFileSync(prismaPath, 'utf8');
const manualIndexesSource = readFileSync(manualIndexesPath, 'utf8');
const resourceReferencesMigrationSource = readFileSync(resourceReferencesMigrationPath, 'utf8');
const dropResourceReferenceMarkerMigrationSource = readFileSync(dropResourceReferenceMarkerMigrationPath, 'utf8');
const resourceCitationMentionsMigrationSource = readFileSync(resourceCitationMentionsMigrationPath, 'utf8');
const errors = [];

function parseDomainConstraint(source, constraintName, columnName) {
	const match = source.match(
		new RegExp(`ADD CONSTRAINT ${constraintName}\\s+CHECK \\((?:${columnName} IS NULL OR )?${columnName} IN \\(([^)]+)\\)\\);`),
	);
	return match ? [...match[1].matchAll(/'([^']+)'/g)].map((value) => value[1]) : null;
}

function parseResourceIdentityConstraint(source) {
	const body = source.match(/ADD CONSTRAINT resources_identity_check\s+CHECK\s*\(([\s\S]*?)\n {2}\);/)?.[1];
	if (!body) return null;
	const kindDomain = body.match(/kind IN \(([^)]+)\)/)?.[1];
	if (!kindDomain || !/resource_platform IS NULL\s+OR \(kind, resource_platform\) IN/.test(body)) return null;
	const platformKinds = [...body.matchAll(/\('([^']+)',\s*'([^']+)'\)/g)].map(([, kind, platform]) => [platform, kind]);
	return {
		kinds: [...kindDomain.matchAll(/'([^']+)'/g)].map((value) => value[1]),
		platformKinds,
	};
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
const repairWithoutDollarQuotedBodies = manualIndexesSource.replace(/\$\$[\s\S]*?\$\$/g, '$$body$$');
if (/^(?!\s*--)\s*(?:DELETE|INSERT|UPDATE|WITH\b|LOCK\s+TABLE\b)/im.test(repairWithoutDollarQuotedBodies)) {
	errors.push('manual-indexes.sql must not mutate application rows or lock tables; use an ordered migration');
}
if (/resources_type_check/.test(manualIndexesSource)) {
	errors.push('manual-indexes.sql must not recreate resources_type_check');
}
if (/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+resources_localized/i.test(manualIndexesSource)) {
	errors.push('manual-indexes.sql must not recreate the retired resources_localized projection');
}
const repairPreamble = manualIndexesSource.slice(0, manualIndexesSource.indexOf('-- ── exact external resource identity'));
if (!/\\set ON_ERROR_STOP on[\s\S]*\nBEGIN;\s*$/.test(repairPreamble) || !/\nCOMMIT;\s*$/.test(manualIndexesSource)) {
	errors.push('manual-indexes.sql must apply inside one top-level transaction');
}
for (const retiredConstraint of ['resources_kind_check', 'resources_resource_platform_check', 'resources_kind_platform_check']) {
	if (new RegExp(`ADD CONSTRAINT ${retiredConstraint}\\b`).test(manualIndexesSource)) {
		errors.push(`manual-indexes.sql must not recreate ${retiredConstraint}`);
	}
}

const resourceKinds = Object.keys(RESOURCE_TYPES);
const platformKindEntries = Object.entries(RESOURCE_TYPES).flatMap(([kind, { platforms }]) => platforms.map(({ name }) => [name, kind]));
const platformKinds = new Map(platformKindEntries);
if (platformKinds.size !== platformKindEntries.length) {
	errors.push('RESOURCE_TYPES platform names must be globally unique');
}

const resourceModelBody = prismaSource.match(/model Resource \{([\s\S]*?)\n\}/)?.[1] ?? '';
if (!/^\s*kind\s+String\s*$/m.test(resourceModelBody)) {
	errors.push('Prisma Resource.kind must be required and have no default');
}
if (!/^\s*resourcePlatform\s+String\?\s+@map\("resource_platform"\)\s*$/m.test(resourceModelBody)) {
	errors.push('Prisma Resource.resourcePlatform must be nullable, mapped to resource_platform, and have no default');
}

const resourceReferenceModelBody = prismaSource.match(/model ResourceReference \{([\s\S]*?)\n\}/)?.[1] ?? '';
if (
	!/^\s*resourceId\s+String\s+@map\("resource_id"\)\s+@db\.Uuid\s*$/m.test(resourceReferenceModelBody) ||
	!/^\s*ordinal\s+Int\s*$/m.test(resourceReferenceModelBody) ||
	!/^\s*text\s+String\s+@db\.VarChar\(600\)\s*$/m.test(resourceReferenceModelBody) ||
	!/^\s*@@id\(\[resourceId, ordinal\]\)\s*$/m.test(resourceReferenceModelBody)
) {
	errors.push('Prisma ResourceReference must preserve the ordered 600-character resource_references contract');
}
const normalizedResourceReferencesMigration = resourceReferencesMigrationSource.replace(/\s+/g, ' ');
if (
	!/PRIMARY KEY \("resource_id", "ordinal"\)/.test(normalizedResourceReferencesMigration) ||
	!/ON DELETE CASCADE ON UPDATE CASCADE/.test(normalizedResourceReferencesMigration) ||
	!/CHECK \("ordinal" > 0\)/.test(normalizedResourceReferencesMigration) ||
	!/CHECK \("marker" IS NULL OR "marker" > 0\)/.test(normalizedResourceReferencesMigration) ||
	!/CHECK \(BTRIM\("text"\) <> '' AND CHAR_LENGTH\("text"\) <= 600\)/.test(normalizedResourceReferencesMigration)
) {
	errors.push('resource_references migration must enforce compound identity, cascade deletion, and text bounds');
}
if (!/DROP COLUMN "marker"/.test(dropResourceReferenceMarkerMigrationSource)) {
	errors.push('resource reference marker cutover must drop the retired marker column');
}
const resourceCitationMentionModelBody = prismaSource.match(/model ResourceCitationMention \{([\s\S]*?)\n\}/)?.[1] ?? '';
const resourceCitationTargetModelBody = prismaSource.match(/model ResourceCitationTarget \{([\s\S]*?)\n\}/)?.[1] ?? '';
if (
	!/@@id\(\[resourceId, ordinal\]\)/.test(resourceCitationMentionModelBody) ||
	!/@@id\(\[resourceId, mentionOrdinal, referenceOrdinal\]\)/.test(resourceCitationTargetModelBody) ||
	!/@@index\(\[resourceId, referenceOrdinal, mentionOrdinal\], map: "resource_citation_targets_reference_idx"\)/.test(
		resourceCitationTargetModelBody,
	)
) {
	errors.push('Prisma citation mention models must preserve grouped-target and reverse-reference contracts');
}
const normalizedResourceCitationMentionsMigration = resourceCitationMentionsMigrationSource.replace(/\s+/g, ' ');
for (const requiredCitationContract of [
	'CREATE TABLE resource_citation_mentions',
	'CREATE TABLE resource_citation_targets',
	'PRIMARY KEY (resource_id, mention_ordinal, reference_ordinal)',
	'FOREIGN KEY (resource_id, reference_ordinal) REFERENCES resource_references(resource_id, ordinal)',
	"CHECK (content_revision ~ '^[0-9a-f]{32}$')",
	'CREATE INDEX resource_citation_targets_reference_idx',
]) {
	if (!normalizedResourceCitationMentionsMigration.includes(requiredCitationContract)) {
		errors.push(`citation mention migration is missing: ${requiredCitationContract}`);
	}
}
const normalizedManualIndexes = manualIndexesSource.replace(/\s+/g, ' ');
if (
	!normalizedManualIndexes.includes(
		"ADD CONSTRAINT resources_source_name_check CHECK ( (source_name IS NULL AND kind IN ('file', 'image')) OR ( source_name IS NOT NULL AND source_name = BTRIM(source_name) AND source_name <> '' ) );",
	)
) {
	errors.push('manual-indexes.sql must require canonical source_name for non-blob Resources');
}
if (
	!normalizedManualIndexes.includes(
		'ADD CONSTRAINT resources_og_image_dimensions_check CHECK ( (og_image_width IS NULL AND og_image_height IS NULL) OR ( og_image_url IS NOT NULL AND og_image_width IS NOT NULL AND og_image_height IS NOT NULL AND og_image_width > 0 AND og_image_height > 0 ) );',
	)
) {
	errors.push('manual-indexes.sql must require canonical OG image dimensions to be a positive pair');
}
for (const [constraint, check] of [
	['resource_references_ordinal_check', 'ordinal > 0'],
	['resource_references_text_check', "BTRIM(text) <> '' AND CHAR_LENGTH(text) <= 600"],
]) {
	if (!normalizedManualIndexes.includes(`ADD CONSTRAINT ${constraint} CHECK (${check});`)) {
		errors.push(`manual-indexes.sql must mirror ${constraint} exactly`);
	}
}
for (const citationConstraint of [
	'resource_references_label_check',
	'resource_references_title_check',
	'resource_references_authors_check',
	'resource_references_year_check',
	'resource_references_venue_check',
	'resource_citation_mentions_ordinal_check',
	'resource_citation_mentions_marker_text_check',
	'resource_citation_mentions_context_check',
	'resource_citation_mentions_section_check',
	'resource_citation_mentions_offsets_check',
]) {
	if (!normalizedManualIndexes.includes(`ADD CONSTRAINT ${citationConstraint}`)) {
		errors.push(`manual-indexes.sql must mirror ${citationConstraint}`);
	}
}
if (!normalizedManualIndexes.includes('CREATE INDEX IF NOT EXISTS resource_citation_targets_reference_idx')) {
	errors.push('manual-indexes.sql must repair the citation target reverse-reference index');
}

const constrainedIdentity = parseResourceIdentityConstraint(manualIndexesSource);
const expectedPlatformKinds = [...platformKinds].map(([platform, kind]) => `${platform}:${kind}`);
const actualPlatformKinds = constrainedIdentity?.platformKinds.map(([platform, kind]) => `${platform}:${kind}`) ?? [];
if (
	!constrainedIdentity ||
	!sameValues(constrainedIdentity.kinds, resourceKinds) ||
	constrainedIdentity.platformKinds.length !== new Set(actualPlatformKinds).size ||
	!sameMembers(actualPlatformKinds, expectedPlatformKinds)
) {
	errors.push('resources_identity_check differs from RESOURCE_TYPES');
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
