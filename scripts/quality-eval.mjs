#!/usr/bin/env node
/**
 * Measures Core's quality question against a labeled set: each Resource in `quality-gold.json` is one a reader would
 * `save`, `skip`, or is `unsure` about. Reads each Resource's stored text, asks Jev the same question the Workflow asks,
 * and prints how well the scores order saves above skips and what each threshold would keep out. Run it after changing
 * the question, the text Jev reads, or the threshold. Read-only; Jev calls run through `cf ai run`.
 * Usage: DATABASE_URL=postgres://… node scripts/quality-eval.mjs
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { MONITOR_QUALITY_MIN, QUALITY_QUESTION, qualityState } from '../src/contracts/quality.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gold = JSON.parse(readFileSync(join(root, 'scripts/quality-gold.json'), 'utf8'));
const CONCURRENCY = 8;
const THRESHOLDS = [0.2, 0.25, MONITOR_QUALITY_MIN, 0.35, 0.4, 0.5];

const client = new pg.Client({
	connectionString: process.env.DATABASE_URL,
	ssl: process.env.DATABASE_SSL === 'off' ? false : { rejectUnauthorized: false },
});
await client.connect();
await client.query('SET default_transaction_read_only = on');
const { rows } = await client.query(
	`SELECT resource.id::text, resource.title, COALESCE(content.markdown, '') AS markdown
	 FROM resources resource LEFT JOIN resource_content content ON content.resource_id = resource.id
	 WHERE resource.id = ANY($1::uuid[])`,
	[gold.map(({ id }) => id)],
);
await client.end();
const texts = new Map(rows.map((row) => [row.id, qualityState(row.title, row.markdown)]));

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), 'quality-eval-'));
const scored = [];
let next = 0;
async function worker() {
	while (next < gold.length) {
		const item = gold[next++];
		const state = texts.get(item.id);
		if (state === undefined) {
			console.warn(`missing ${item.id} ${item.url}`);
			continue;
		}
		const body = join(dir, `${item.id}.json`);
		writeFileSync(body, JSON.stringify({ state, questions: { save: QUALITY_QUESTION } }));
		try {
			const { stdout } = await run('pnpm', ['exec', 'cf', 'ai', 'run', 'typesafe/jev', '--body', `@${body}`], {
				cwd: root,
				maxBuffer: 1e7,
			});
			const { result } = JSON.parse(stdout.slice(stdout.indexOf('{')));
			scored.push({ ...item, score: result.answers.save.noul });
		} catch (error) {
			console.warn(
				`failed ${item.url}: ${String(error.stderr ?? error)
					.trim()
					.split('\n')
					.at(-2)}`,
			);
		}
	}
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
rmSync(dir, { recursive: true });

const saves = scored.filter(({ label }) => label === 'save');
const skips = scored.filter(({ label }) => label === 'skip');
let wins = 0;
for (const save of saves) for (const skip of skips) wins += save.score > skip.score ? 1 : save.score === skip.score ? 0.5 : 0;
console.info(
	`scored ${scored.length}/${gold.length}; a save outranks a skip ${((100 * wins) / (saves.length * skips.length)).toFixed(1)}% of the time`,
);
for (const threshold of THRESHOLDS) {
	const lost = saves.filter(({ score }) => score < threshold).length;
	const kept = skips.filter(({ score }) => score >= threshold).length;
	console.info(
		`below ${threshold}${threshold === MONITOR_QUALITY_MIN ? ' (current)' : ''}: ${lost}/${saves.length} saves kept out, ${kept}/${skips.length} skips let in`,
	);
}
const byScore = (a, b) => a.score - b.score;
console.info('\nlowest saves:');
for (const { score, url } of saves.sort(byScore).slice(0, 5)) console.info(`  ${score.toFixed(2)} ${url}`);
console.info('highest skips:');
for (const { score, url } of skips.sort(byScore).reverse().slice(0, 5)) console.info(`  ${score.toFixed(2)} ${url}`);
