import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const CHILD_ENV = 'NEWSENCE_ZOTERO_SDT_CHILD';
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function fail(message) {
	console.error(message);
	process.exit(1);
}

function parseArgs(argv) {
	const options = {
		documentWorker: process.env.ZOTERO_DOCUMENT_WORKER_DIR ?? null,
		includeDocument: false,
		output: null,
		pdf: null,
		runs: 1,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--document-worker') {
			options.documentWorker = argv[++index] ?? null;
		} else if (argument === '--pdf') {
			options.pdf = argv[++index] ?? null;
		} else if (argument === '--output') {
			options.output = argv[++index] ?? null;
		} else if (argument === '--runs') {
			options.runs = Number.parseInt(argv[++index] ?? '', 10);
		} else if (argument === '--include-document') {
			options.includeDocument = true;
		} else if (argument === '--help' || argument === '-h') {
			console.info(`Usage:
  pnpm spike:zotero-sdt -- --document-worker /path/to/document-worker --pdf /path/to/paper.pdf [options]

Options:
  --output /path/report.json  Save the JSON report instead of printing it
  --runs N                   Parse the PDF N times in one process (default: 1)
  --include-document         Include the complete materialized SDT in the report

ZOTERO_DOCUMENT_WORKER_DIR can replace --document-worker.`);
			process.exit(0);
		} else if (argument !== '--') {
			fail(`Unknown argument: ${argument}`);
		}
	}

	if (!options.documentWorker) fail('Missing --document-worker or ZOTERO_DOCUMENT_WORKER_DIR.');
	if (!options.pdf) fail('Missing --pdf.');
	if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10) {
		fail('--runs must be an integer between 1 and 10.');
	}

	options.documentWorker = resolve(options.documentWorker);
	options.pdf = resolve(options.pdf);
	if (options.output) options.output = resolve(options.output);
	return options;
}

function validatePaths(options) {
	const requiredPaths = [
		options.pdf,
		resolve(options.documentWorker, 'package.json'),
		resolve(options.documentWorker, 'scripts/pdfjs-setup.js'),
		resolve(options.documentWorker, 'build/metadata.json'),
		resolve(options.documentWorker, 'build/structured-document-text.js'),
		resolve(options.documentWorker, 'structured-document-text/src/pack/reader.js'),
	];
	for (const requiredPath of requiredPaths) {
		if (!existsSync(requiredPath)) fail(`Required path does not exist: ${requiredPath}`);
	}
}

function runWithUpstreamLoaders(options) {
	const upstreamRequire = createRequire(resolve(options.documentWorker, 'package.json'));
	let tsxLoader;
	try {
		tsxLoader = upstreamRequire.resolve('tsx');
	} catch {
		fail('The document-worker checkout is missing its dependencies. Run pnpm install there first.');
	}

	const child = spawnSync(
		process.execPath,
		['--import', resolve(options.documentWorker, 'scripts/pdfjs-setup.js'), '--import', tsxLoader, SCRIPT_PATH, ...process.argv.slice(2)],
		{
			cwd: options.documentWorker,
			env: { ...process.env, [CHILD_ENV]: '1' },
			stdio: 'inherit',
		},
	);
	if (child.error) fail(child.error.message);
	process.exit(child.status ?? 1);
}

function toArrayBuffer(buffer) {
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function countBy(items, getKey) {
	const counts = {};
	for (const item of items) {
		const key = getKey(item);
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

function walkNodes(nodes, parentPath = []) {
	const entries = [];
	if (!Array.isArray(nodes)) return entries;
	for (let index = 0; index < nodes.length; index += 1) {
		const node = nodes[index];
		if (!node || typeof node !== 'object') continue;
		const path = [...parentPath, index];
		entries.push({ node, path });
		if (Array.isArray(node.content)) entries.push(...walkNodes(node.content, path));
	}
	return entries;
}

function nodeText(node) {
	if (!node || typeof node !== 'object') return '';
	if (typeof node.text === 'string') return node.text;
	if (!Array.isArray(node.content)) return '';
	return node.content.map(nodeText).join('');
}

function round(value) {
	return Math.round(value * 100) / 100;
}

function ratio(numerator, denominator) {
	return denominator ? round(numerator / denominator) : null;
}

function countNonWhitespaceCharacters(text) {
	let count = 0;
	for (let index = 0; index < text.length; index += 1) {
		if (!/\s/u.test(text[index])) count += 1;
	}
	return count;
}

function countTextMapCharacters(textMap) {
	try {
		const runs = JSON.parse(textMap);
		if (!Array.isArray(runs)) return null;
		let count = 0;
		for (const run of runs) {
			if (!Array.isArray(run) || run.length < 6 || !Number.isInteger(run[0])) return null;
			const widthCount = run.length === 6 ? 1 : run.length - 6;
			count += Math.max(0, widthCount - (run[0] & 1));
		}
		return count;
	} catch {
		return null;
	}
}

function readDocumentWorkerCommit(documentWorker) {
	const result = spawnSync('git', ['-C', documentWorker, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
	return result.status === 0 ? result.stdout.trim() : null;
}

function summarizeDocument(document) {
	const entries = walkNodes(document.content);
	const blocks = entries.filter(
		({ node }) => typeof node.type === 'string' && node.type !== 'listitem' && node.type !== 'tablerow' && node.type !== 'tablecell',
	);
	const textNodes = [];

	function collectText(value, path = []) {
		if (Array.isArray(value)) {
			value.forEach((child, index) => {
				collectText(child, [...path, index]);
			});
			return;
		}
		if (!value || typeof value !== 'object') return;
		if (typeof value.text === 'string') {
			textNodes.push({ node: value, path });
			return;
		}
		if (Array.isArray(value.content)) collectText(value.content, path);
	}
	collectText(document.content);

	const referenceEntries = entries.filter(({ node }) => node.reference === true);
	const nodesByPath = new Map(entries.map((entry) => [entry.path.join('.'), entry.node]));
	const linkedTextNodes = textNodes
		.filter(({ node }) => Array.isArray(node.refs) && node.refs.length > 0)
		.map((entry) => ({
			...entry,
			referenceRefs: entry.node.refs.filter((ref) => nodesByPath.get(ref.join('.'))?.reference === true),
		}));
	const citationNodes = linkedTextNodes.filter(({ referenceRefs }) => referenceRefs.length > 0);
	const textCharacters = textNodes.reduce((sum, { node }) => sum + node.text.length, 0);
	const mappedCharacters = textNodes.reduce((sum, { node }) => sum + (node.anchor?.textMap ? node.text.length : 0), 0);
	const rectCharacters = textNodes.reduce((sum, { node }) => sum + (node.anchor?.pageRects?.length ? node.text.length : 0), 0);
	const referencedPaths = new Set(citationNodes.flatMap(({ referenceRefs }) => referenceRefs.map((ref) => ref.join('.'))));
	const decodedTextMaps = textNodes
		.filter(({ node }) => typeof node.anchor?.textMap === 'string')
		.map(({ node }) => ({
			actual: countTextMapCharacters(node.anchor.textMap),
			expected: countNonWhitespaceCharacters(node.text),
		}));
	const mappedCitationNodes = citationNodes.filter(({ node }) => typeof node.anchor?.textMap === 'string');

	return {
		schemaVersion: document.schemaVersion,
		processor: document.metadata.processor,
		source: document.metadata.source,
		catalog: {
			outlineItems: document.catalog.outline.length,
			pages: document.catalog.pages.length,
			pageTextSources: countBy(document.catalog.pages, (page) => page.textSource ?? 'unknown'),
			degradedPages: document.catalog.pages.filter((page) => page.extractionDegraded === true).length,
		},
		content: {
			characterCount: document.metadata.characterCount ?? textCharacters,
			textCharacters,
			topLevelBlocks: document.content.length,
			blockTypes: countBy(blocks, ({ node }) => node.type),
			flowClasses: countBy(blocks, ({ node }) => node.flowClass ?? 'body'),
			referenceEntries: referenceEntries.length,
			citationMarkers: citationNodes.length,
			citationTargets: citationNodes.reduce((sum, { referenceRefs }) => sum + referenceRefs.length, 0),
			uniqueCitationTargets: referencedPaths.size,
			nonBibliographyRefMarkers: linkedTextNodes.length - citationNodes.length,
		},
		mapping: {
			textNodes: textNodes.length,
			textMapNodes: decodedTextMaps.length,
			exactTextMapNodes: decodedTextMaps.filter(({ actual, expected }) => actual === expected).length,
			invalidTextMapNodes: decodedTextMaps.filter(({ actual }) => actual === null).length,
			pageRectNodes: textNodes.filter(({ node }) => Boolean(node.anchor?.pageRects?.length)).length,
			textMapCharacterCoverage: ratio(mappedCharacters, textCharacters),
			pageRectCharacterCoverage: ratio(rectCharacters, textCharacters),
			citationMarkerCoverage: ratio(mappedCitationNodes.length, citationNodes.length),
			citationMarkersWithTextMap: mappedCitationNodes.length,
		},
		samples: {
			outline: document.catalog.outline.slice(0, 12).map((item) => ({ ref: item.ref ?? null, title: item.title })),
			headings: blocks
				.filter(({ node }) => node.type === 'heading')
				.slice(0, 12)
				.map(({ node, path }) => ({ path, text: nodeText(node) })),
			references: referenceEntries.slice(0, 8).map(({ node, path }) => ({ backRefs: node.backRefs ?? [], path, text: nodeText(node) })),
			citations: citationNodes.slice(0, 12).map(({ node, path, referenceRefs }) => ({ marker: node.text, path, refs: referenceRefs })),
		},
	};
}

async function parsePdf(options) {
	const workerModule = await import(pathToFileURL(resolve(options.documentWorker, 'src/index.js')).href);
	const { openStructuredDocumentTextPack } = await import(
		pathToFileURL(resolve(options.documentWorker, 'structured-document-text/src/pack/reader.js')).href
	);
	const pdfBuffer = readFileSync(options.pdf);
	const sourceHash = createHash('md5').update(pdfBuffer).digest('hex');
	const dataProvider = (assetPath) => readFileSync(resolve(options.documentWorker, 'build', assetPath));
	const runs = [];
	let document;
	let packBytes = 0;

	for (let index = 0; index < options.runs; index += 1) {
		const progress = [];
		const startedAt = performance.now();
		const result = await workerModule.getStructuredDocumentText(toArrayBuffer(pdfBuffer), {
			contentType: 'application/pdf',
			dataProvider,
			onProgress: (value) => progress.push(value),
			password: '',
			sourceHash,
		});
		const parsedAt = performance.now();
		const reader = await openStructuredDocumentTextPack(result.buf, {
			inflate: (bytes) => new Uint8Array(inflateRawSync(bytes)),
		});
		document = await reader.materialize();
		const materializedAt = performance.now();
		packBytes = result.buf.byteLength;
		runs.push({
			materializeMs: round(materializedAt - parsedAt),
			parseMs: round(parsedAt - startedAt),
			progressEvents: progress.length,
			totalMs: round(materializedAt - startedAt),
		});
	}

	const summary = summarizeDocument(document);
	const report = {
		input: {
			documentWorkerCommit: readDocumentWorkerCommit(options.documentWorker),
			file: basename(options.pdf),
			pdfBytes: pdfBuffer.byteLength,
			sourceHash,
		},
		runs,
		sizes: {
			materializedJsonBytes: Buffer.byteLength(JSON.stringify(document)),
			packBytes,
			packToPdfRatio: ratio(packBytes, pdfBuffer.byteLength),
		},
		...summary,
	};
	if (options.includeDocument) report.document = document;
	return report;
}

const options = parseArgs(process.argv.slice(2));
validatePaths(options);
if (process.env[CHILD_ENV] !== '1') runWithUpstreamLoaders(options);

const report = await parsePdf(options);
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (options.output) {
	writeFileSync(options.output, serialized);
	console.info(`Wrote Zotero SDT spike report to ${isAbsolute(options.output) ? options.output : resolve(options.output)}`);
} else {
	process.stdout.write(serialized);
}
