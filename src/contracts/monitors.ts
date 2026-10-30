/**
 * What Core watches for new entries, kept here once: web-tanstack imports this file for the `monitors` columns' types,
 * and `scripts/check-sql-schema.mjs` fails when the CHECK constraints accept anything else.
 */

/** A feed (RSS, Atom or JSON Feed) by its URL, or a YouTube channel or an X account by its `entity_keys` account. */
export const MONITOR_KINDS = ['feed', 'youtube', 'twitter'] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];

/** A paused monitor is one someone stopped; a failing one stays active and backs off on its own. */
export const MONITOR_STATUSES = ['active', 'paused'] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];
