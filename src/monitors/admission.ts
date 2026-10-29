import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { SourceResourceDraftSchema, type SourceResourceDraft } from '../contracts/processing-target';
import { resolveResourceUrl } from '../contracts/resource-url';
import { recordFulfilledMonitorRequests, settledMonitorRequestKeys } from '../store/requests';
import { findResourcesByUrls } from '../store/resources';
import { admitRequests } from '../workflows/requests';

/**
 * Crosses the discovery -> Resource boundary for every monitor. A monitor asks for each URL once: a URL it already asked
 * for is skipped, even one that redirects to a stored Resource under another URL, and a failed one is asked again only
 * after its wait.
 */
export async function enqueueMonitorDrafts(db: NodePgDatabase, monitorId: string, drafts: SourceResourceDraft[]) {
	const seen = new Set<string>();
	let skipped = 0;
	const targets = drafts.flatMap((draft, index) => {
		const parsed = SourceResourceDraftSchema.safeParse(draft);
		if (parsed.success) {
			// Invalid drafts must not claim an identity and hide a valid duplicate.
			const url = resolveResourceUrl(parsed.data.url)!;
			const key = `url:${url.normalizedUrl}`;
			if (seen.has(key)) return [];
			seen.add(key);
			return [{ url, key, target: { ...parsed.data, kind: 'draft' as const } }];
		}
		skipped++;
		console.warn({
			tag: 'MONITOR',
			msg: 'Invalid monitor draft skipped',
			monitor_id: monitorId,
			item_index: index,
			error: parsed.error.message,
		});
		return [];
	});
	const asked = await settledMonitorRequestKeys(
		db,
		monitorId,
		targets.map(({ key }) => key),
	);
	const fresh = targets.filter(({ key }) => !asked.has(key));
	const known = await findResourcesByUrls(
		db,
		fresh.map(({ url }) => url),
	);
	// A readable original only needs its discovery recorded.
	await recordFulfilledMonitorRequests(
		db,
		monitorId,
		fresh.flatMap(({ key, url }, index) => {
			const { resourceId } = known[index]!;
			return resourceId ? [{ key, url: url.url, resourceId }] : [];
		}),
	);
	const leads = await admitRequests(
		db,
		fresh.flatMap(({ target }, index) => (known[index]!.resourceId ? [] : [{ requester: 'monitor' as const, monitorId, target }])),
	);
	const requested = fresh.length - known.filter(({ resourceId }) => resourceId).length;
	return { created: leads.length, deduplicated: drafts.length - skipped - requested, skipped };
}
