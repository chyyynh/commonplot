import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pLimit from 'p-limit';
import type { z } from 'zod';
import type { MonitorKind } from '../contracts/monitors';
import type { SourceResourceDraft } from '../contracts/processing-target';
import { errorMessage } from '../services/response';
import { claimDueMonitors, type DueMonitor, type MonitorInterval, recordMonitorCheck } from '../store/monitors';
import { enqueueMonitorDrafts } from './admission';
import { feedMonitor, youtubeMonitor } from './feed';
import { twitterMonitor } from './twitter';

export type Monitor<State> = Omit<DueMonitor, 'state'> & Readonly<{ state: State }>;

/** What one check found: the entries to admit, how many it dropped, the state for the next check, and what to log. */
type MonitorPoll<State> = Readonly<{
	drafts: SourceResourceDraft[];
	skipped: number;
	state: State;
	details?: Record<string, unknown>;
}>;

/** How one kind of monitor is checked. Its state is whatever it needs between checks, validated on the way in. */
export type MonitorAdapter<State extends Record<string, unknown>> = Readonly<{
	stateSchema: z.ZodType<State>;
	interval: MonitorInterval;
	/** Checks of this kind that run at once. */
	concurrency: number;
	poll(env: CoreEnv, monitor: Monitor<State>): Promise<MonitorPoll<State>>;
}>;

/** An adapter with its state type erased, so the runner can hold every kind in one table. */
type MonitorRunner = Pick<MonitorAdapter<Record<string, unknown>>, 'interval' | 'concurrency'> &
	Readonly<{ check(env: CoreEnv, monitor: DueMonitor): Promise<MonitorPoll<Record<string, unknown>>> }>;

function runner<State extends Record<string, unknown>>(adapter: MonitorAdapter<State>): MonitorRunner {
	return {
		interval: adapter.interval,
		concurrency: adapter.concurrency,
		check: (env, monitor) => adapter.poll(env, { ...monitor, state: adapter.stateSchema.parse(monitor.state) }),
	};
}

const MONITORS: Record<MonitorKind, MonitorRunner> = {
	feed: runner(feedMonitor),
	youtube: runner(youtubeMonitor),
	twitter: runner(twitterMonitor),
};
/** More than the cron ever finds due, so a backlog clears within a run or two. */
const CLAIM_LIMIT = 200;
/** From this many failed checks in a row a monitor logs as failing, which the weekly ingest review lists. */
const FAILING_FAILURES = 4;

type Failure = Readonly<{ kind: MonitorKind; name: string; failures: number; nextCheckAt?: string; error: string }>;

/**
 * Checks every monitor that is due, each kind at its own concurrency, and logs one MONITOR line per check. Monitors of a
 * kind that failed with the same error, such as a provider that is down, share one line.
 */
export async function runMonitors(env: CoreEnv, db: NodePgDatabase): Promise<void> {
	const due = await claimDueMonitors(db, CLAIM_LIMIT);
	const limits = new Map(Object.entries(MONITORS).map(([kind, monitor]) => [kind, pLimit(monitor.concurrency)]));
	const results = await Promise.allSettled(due.map((monitor) => limits.get(monitor.kind)!(() => checkMonitor(env, db, monitor))));
	const failed = new Map<string, Failure[]>();
	for (const [index, result] of results.entries()) {
		const { kind, name } = due[index]!;
		if (result.status === 'rejected') {
			console.error({ tag: 'MONITOR', msg: 'Monitor check was not recorded', kind, name, error: errorMessage(result.reason) });
		} else if (result.value) {
			const key = `${kind}\n${result.value.error}`;
			failed.set(key, [...(failed.get(key) ?? []), result.value]);
		}
	}
	for (const group of failed.values()) {
		const [first] = group as [Failure];
		const failures = Math.max(...group.map((failure) => failure.failures));
		console.error({
			tag: 'MONITOR',
			kind: first.kind,
			...(group.length === 1 ? { name: first.name, next_check_at: first.nextCheckAt } : { names: group.map(({ name }) => name) }),
			outcome: failures >= FAILING_FAILURES ? 'failing' : 'failed',
			failures,
			error: first.error,
		});
	}
}

/** Admits what one check found and logs it; a failed check is returned for `runMonitors` to log. */
async function checkMonitor(env: CoreEnv, db: NodePgDatabase, monitor: DueMonitor): Promise<Failure | undefined> {
	const { interval } = MONITORS[monitor.kind];
	let polled;
	try {
		polled = await MONITORS[monitor.kind].check(env, monitor);
	} catch (error) {
		const message = errorMessage(error);
		const checked = await recordMonitorCheck(db, monitor.id, interval, { error: message });
		return { kind: monitor.kind, name: monitor.name, failures: checked?.failures ?? 0, nextCheckAt: checked?.nextCheckAt, error: message };
	}
	const admission = await enqueueMonitorDrafts(db, monitor.id, polled.drafts);
	const checked = await recordMonitorCheck(db, monitor.id, interval, { state: polled.state });
	console.info({
		tag: 'MONITOR',
		kind: monitor.kind,
		name: monitor.name,
		outcome: admission.created ? 'new' : 'unchanged',
		created: admission.created,
		deduplicated: admission.deduplicated,
		skipped: polled.skipped + admission.skipped,
		failures: 0,
		next_check_at: checked?.nextCheckAt,
		...polled.details,
	});
	return undefined;
}
