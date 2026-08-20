import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const sourceRoot = path.resolve('src');
const aliases = new Map([
	['@core-shared/', 'shared/'],
	['@db/', 'db/'],
	['@entities/', 'entities/'],
	['@ingest/', 'ingest/'],
]);

async function sourceFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const entryPath = path.join(directory, entry.name);
			return entry.isDirectory() ? sourceFiles(entryPath) : entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
		}),
	);
	return nested.flat();
}

function resolveInternalImport(sourceFile, specifier, files) {
	let candidate;
	if (specifier.startsWith('.')) {
		candidate = path.resolve(path.dirname(sourceFile), specifier);
	} else {
		for (const [prefix, target] of aliases) {
			if (specifier.startsWith(prefix)) candidate = path.join(sourceRoot, target, specifier.slice(prefix.length));
		}
	}
	if (!candidate) return null;
	for (const resolved of [candidate, `${candidate}.ts`, path.join(candidate, 'index.ts')]) {
		if (files.has(resolved)) return resolved;
	}
	return null;
}

function relativeName(file) {
	return path.relative(sourceRoot, file).split(path.sep).join('/');
}

function layerViolation(source, target) {
	if (source.startsWith('shared/') && !target.startsWith('shared/')) return 'shared may only depend on shared';
	if (source.startsWith('db/') && !target.startsWith('db/') && !target.startsWith('shared/')) {
		return 'db may only depend on db or shared';
	}
	if (
		source.startsWith('ingest/domain/') &&
		(target.startsWith('ingest/platforms/') ||
			target === 'ingest/acquisition.ts' ||
			target === 'ingest/resource-persistence.ts' ||
			target === 'ingest/workflow.ts')
	) {
		return 'ingest/domain must not depend on orchestration or platform adapters';
	}
	return null;
}

const files = new Set(await sourceFiles(sourceRoot));
const graph = new Map();
const violations = [];

for (const file of files) {
	const source = relativeName(file);
	const imports = ts.preProcessFile(await readFile(file, 'utf8'), true, true).importedFiles;
	const targets = imports.flatMap(({ fileName }) => {
		const targetFile = resolveInternalImport(file, fileName, files);
		if (!targetFile) return [];
		const target = relativeName(targetFile);
		const violation = layerViolation(source, target);
		if (violation) violations.push(`${source} -> ${target}: ${violation}`);
		return [targetFile];
	});
	graph.set(file, targets);
}

const state = new Map();
const stack = [];
const cycles = [];

function visit(file) {
	state.set(file, 1);
	stack.push(file);
	for (const target of graph.get(file) ?? []) {
		if (!state.has(target)) visit(target);
		else if (state.get(target) === 1) {
			const start = stack.lastIndexOf(target);
			cycles.push([...stack.slice(start), target].map(relativeName).join(' -> '));
		}
	}
	stack.pop();
	state.set(file, 2);
}

for (const file of files) if (!state.has(file)) visit(file);

const errors = [...new Set([...violations, ...cycles.map((cycle) => `dependency cycle: ${cycle}`)])].sort();
if (errors.length) {
	console.error(`Architecture check failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
	process.exitCode = 1;
} else {
	const edgeCount = [...graph.values()].reduce((total, targets) => total + targets.length, 0);
	console.info(`Architecture check passed (${files.size} files, ${edgeCount} internal imports)`);
}
