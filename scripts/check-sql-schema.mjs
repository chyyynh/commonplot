#!/usr/bin/env node
/**
 * Plans every statement Core sends to PostgreSQL against a migrated database,
 * so a schema change that breaks Core SQL fails CI instead of production.
 *
 * Core writes plain Drizzle `sql` templates without a schema of its own. This
 * finds each template passed to `.execute(`, inlines the shared `*_SQL`
 * fragments, renders every other interpolation as NULL, and runs EXPLAIN:
 * PostgreSQL resolves every table, column, function and cast without running
 * the statement. It then checks that the CHECK constraints accept exactly the
 * kinds, platforms, schemes, roles and entity types `resource-kinds.ts` lists,
 * and the monitor kinds and statuses `monitors.ts` lists.
 * Usage: DATABASE_URL=postgres://… node scripts/check-sql-schema.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { MONITOR_KINDS, MONITOR_STATUSES } from '../src/contracts/monitors.ts';
import {
	ENTITY_KEY_SCHEMES,
	ENTITY_TYPES,
	RESOURCE_CREATOR_ROLES,
	RESOURCE_KEY_SCHEMES,
	RESOURCE_KIND_NAMES,
	RESOURCE_PLATFORM_KINDS,
	RESOURCE_PLATFORM_NAMES,
} from '../src/contracts/resource-kinds.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRS = ['src/store', 'src/search'];

/** Reads a template literal starting after its opening backtick; returns text parts, expressions and the end. */
function readTemplate(source, start) {
	const parts = [''];
	const expressions = [];
	let index = start;
	while (index < source.length) {
		const char = source[index];
		if (char === '\\') {
			parts[parts.length - 1] += source.slice(index, index + 2);
			index += 2;
		} else if (char === '`') {
			return { parts, expressions, end: index + 1 };
		} else if (char === '$' && source[index + 1] === '{') {
			const end = readExpression(source, index + 2);
			expressions.push(source.slice(index + 2, end).trim());
			parts.push('');
			index = end + 1;
		} else {
			parts[parts.length - 1] += char;
			index += 1;
		}
	}
	throw new Error(`Unterminated template at ${start}`);
}

/** Finds the `}` closing an interpolation, skipping nested braces, strings and templates. */
function readExpression(source, start) {
	let depth = 0;
	let index = start;
	while (index < source.length) {
		const char = source[index];
		if (char === '`') index = readTemplate(source, index + 1).end;
		else if (char === "'" || char === '"') {
			index += 1;
			while (index < source.length && source[index] !== char) index += source[index] === '\\' ? 2 : 1;
			index += 1;
		} else {
			if (char === '{') depth += 1;
			if (char === '}') {
				if (depth === 0) return index;
				depth -= 1;
			}
			index += 1;
		}
	}
	throw new Error(`Unterminated interpolation at ${start}`);
}

/** Skips one string, template or bracketed group starting at `index`; returns the index after it. */
function skip(source, index) {
	const char = source[index];
	if (char === '`') return readTemplate(source, index + 1).end;
	if (char === "'" || char === '"') {
		let at = index + 1;
		while (at < source.length && source[at] !== char) at += source[at] === '\\' ? 2 : 1;
		return at + 1;
	}
	const close = { '(': ')', '[': ']', '{': '}' }[char];
	if (!close) return index + 1;
	let at = index + 1;
	while (at < source.length && source[at] !== close) at = skip(source, at);
	return at + 1;
}

/** The initializer of `const name = …` starting at `start`, up to its `;` or line end at depth 0. */
function readInitializer(source, start) {
	let at = start;
	while (at < source.length && source[at] !== ';' && source[at] !== '\n') at = skip(source, at);
	return source.slice(start, at).trim();
}

/** Every `sql\`…\`` in a file, the SQL fragments it binds to names, and which templates are executed. */
function scan(file) {
	const source = readFileSync(file, 'utf8');
	const statements = [];
	for (const match of source.matchAll(/\bsql`/g)) {
		const before = source.slice(Math.max(0, match.index - 200), match.index);
		if (!/\.execute(?:<[\s\S]*?>)?\(\s*$/.test(before)) continue;
		statements.push({
			...readTemplate(source, match.index + 4),
			offset: match.index,
			line: source.slice(0, match.index).split('\n').length,
		});
	}
	const definitions = [];
	for (const match of source.matchAll(/\bconst (\w+) = /g)) {
		const start = match.index + match[0].length;
		const lambda = source.slice(start).match(/^\((\w+)[^)]*\) => (?=sql`)/);
		const bodyStart = start + (lambda?.[0].length ?? 0);
		// Only SQL fragments: a template, or a call to another `*_SQL` fragment.
		if (!/^(?:sql`|[A-Z][A-Z_]*_SQL\()/.test(source.slice(bodyStart, bodyStart + 64))) continue;
		const body = readInitializer(source, bodyStart);
		definitions.push({ name: match[1], offset: match.index, parameter: lambda?.[1] ?? null, body });
	}
	return { file: relative(root, file), statements, definitions };
}

const files = SOURCE_DIRS.flatMap((dir) =>
	readdirSync(join(root, dir))
		.filter((name) => name.endsWith('.ts'))
		.map((name) => join(root, dir, name)),
).map(scan);
// Module constants such as READABLE_ORIGINAL_SQL may be imported by another file.
const shared = files.flatMap(({ definitions }) => definitions.filter(({ name }) => /^[A-Z][A-Z_]*_SQL$/.test(name)));
const MAX_VARIANTS = 64;

/**
 * Every SQL text a template can produce, as `{ text, choices }`: values become NULL, fragments are
 * inlined, and both sides of a conditional are expanded. One condition (`existing` and `!existing`)
 * takes one value per statement, so impossible combinations are not checked.
 */
function render(template, scope) {
	let variants = [{ text: template.parts[0], choices: new Map() }];
	template.expressions.forEach((expression, index) => {
		const options = renderExpression(expression, scope);
		variants = variants
			.flatMap((variant) =>
				options.flatMap((option) => {
					const choices = merge(variant.choices, option.choices);
					return choices ? [{ text: variant.text + option.text + template.parts[index + 1], choices }] : [];
				}),
			)
			.slice(0, MAX_VARIANTS);
	});
	return variants;
}

function merge(left, right) {
	const merged = new Map(left);
	for (const [condition, value] of right) {
		if (merged.has(condition) && merged.get(condition) !== value) return null;
		merged.set(condition, value);
	}
	return merged;
}

const plain = (text) => [{ text, choices: new Map() }];

function renderExpression(expression, scope) {
	const text = expression
		.trim()
		.replace(/^\(([\s\S]*)\)$/, '$1')
		.trim();
	if (scope.bindings.has(text)) return scope.bindings.get(text);
	if (text.startsWith('sql`')) return render(readTemplate(text, 4), scope);
	const inArray = text.match(/^inArray\(sql`([^`]*)`/);
	if (inArray) return plain(`${inArray[1]} IN (NULL)`);
	const conditional = conditionalBranches(text);
	if (conditional) {
		const { condition, whenTrue, whenFalse } = conditional;
		const negated = condition.startsWith('!');
		const key = condition.replace(/^!+/, '').trim();
		return [
			[whenTrue, !negated],
			[whenFalse, negated],
		].flatMap(([branch, value]) =>
			renderExpression(branch, scope).flatMap((option) => {
				const choices = merge(option.choices, new Map([[key, value]]));
				return choices ? [{ text: option.text, choices }] : [];
			}),
		);
	}
	const call = text.match(/^(\w+)\(([\s\S]*)\)$/);
	const definition = lookup(call?.[1] ?? text, scope);
	if (definition && call && definition.parameter) {
		const argument = renderExpression(call[2], scope);
		return renderExpression(definition.body, { ...scope, bindings: new Map([[definition.parameter, argument]]) });
	}
	if (definition && !call && !definition.parameter) return renderExpression(definition.body, { ...scope, offset: definition.offset });
	return plain('NULL');
}

/** The nearest earlier binding of `name` in the same file, else a shared module constant. */
function lookup(name, scope) {
	const local = scope.definitions.filter((d) => d.name === name && d.offset < scope.offset).at(-1);
	return local ?? shared.find((d) => d.name === name);
}

/** `a ? b : c` at the top level of an expression, as its condition and branches. */
function conditionalBranches(text) {
	let question = -1;
	for (let at = 0; at < text.length;) {
		const char = text[at];
		if (char === '?' && text[at + 1] !== '?' && text[at + 1] !== '.' && text[at - 1] !== '?') {
			if (question < 0) question = at;
		} else if (char === ':' && question >= 0) {
			return { condition: text.slice(0, question).trim(), whenTrue: text.slice(question + 1, at), whenFalse: text.slice(at + 1) };
		}
		at = '`\'"([{'.includes(char) ? skip(text, at) : at + 1;
	}
	return null;
}

const statements = files.flatMap(({ file, statements, definitions }) =>
	statements.flatMap((statement) =>
		render(statement, { definitions, offset: statement.offset, bindings: new Map() }).map(({ text }, variant, all) => ({
			where: `${file}:${statement.line}${all.length > 1 ? ` (variant ${variant + 1}/${all.length})` : ''}`,
			text,
		})),
	),
);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const failures = [];
for (const { where, text } of statements) {
	try {
		await client.query('BEGIN');
		await client.query(`EXPLAIN ${text}`);
	} catch (error) {
		failures.push({ where, error: error.message, text });
	} finally {
		await client.query('ROLLBACK');
	}
}

/** Runs a CHECK constraint over candidate rows, so its lists are compared by what it accepts rather than its text. */
async function constraintAccepts(name, columns, rows) {
	const { rows: found } = await client.query('SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = $1', [
		name,
	]);
	if (found.length !== 1) throw new Error(`Constraint ${name} not found`);
	const literal = (value) => (value === null ? 'NULL::text' : `'${value}'::text`);
	const values = rows.map((row, index) => `(${index}, ${row.map(literal).join(', ')})`).join(', ');
	const { rows: accepted } = await client.query(
		`SELECT COALESCE(${found[0].definition.replace(/^CHECK /, '')}, true) AS ok FROM (VALUES ${values}) AS candidate(i, ${columns.join(', ')}) ORDER BY i`,
	);
	return accepted.map(({ ok }) => ok);
}

const UNKNOWN = 'unknown';
const listed = (name, column, list) => ({
	name,
	columns: [column],
	rows: [...list, UNKNOWN].map((value) => [value]),
	expect: ([value]) => list.includes(value),
});
const contracts = [
	{
		name: 'resources_identity_check',
		columns: ['kind', 'resource_platform'],
		rows: [...RESOURCE_KIND_NAMES, UNKNOWN].flatMap((kind) =>
			[null, ...RESOURCE_PLATFORM_NAMES, UNKNOWN].map((platform) => [kind, platform]),
		),
		expect: ([kind, platform]) =>
			RESOURCE_KIND_NAMES.includes(kind) && (platform === null || (RESOURCE_PLATFORM_KINDS[platform] ?? []).includes(kind)),
	},
	listed('resource_keys_scheme_check', 'scheme', RESOURCE_KEY_SCHEMES),
	listed('entity_keys_scheme_check', 'scheme', ENTITY_KEY_SCHEMES),
	listed('resource_creators_role_check', 'role', RESOURCE_CREATOR_ROLES),
	listed('entities_type_check', 'type', ENTITY_TYPES),
	listed('monitors_kind_check', 'kind', MONITOR_KINDS),
	listed('monitors_status_check', 'status', MONITOR_STATUSES),
];
const drifts = [];
for (const { name, columns, rows, expect } of contracts) {
	const accepted = await constraintAccepts(name, columns, rows);
	for (const [index, row] of rows.entries())
		if (accepted[index] !== expect(row)) drifts.push(`${name} ${accepted[index] ? 'accepts' : 'rejects'} (${row.join(', ')})`);
}
await client.end();

for (const { where, error, text } of failures) console.error(`✗ ${where}: ${error}\n${text.trim()}\n`);
for (const drift of drifts) console.error(`✗ ${drift}, unlike the contracts`);
console.info(`${statements.length - failures.length}/${statements.length} Core statements plan against the migrated schema.`);
console.info(
	`${contracts.length - new Set(drifts.map((drift) => drift.split(' ')[0])).size}/${contracts.length} CHECK constraints match the contracts.`,
);
if (failures.length || drifts.length) process.exit(1);
