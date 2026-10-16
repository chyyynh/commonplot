import { hash } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { SourceResourceDraftSchema, type SourceResourceDraft } from '../contracts/processing-target';
import { resolveResourceUrl } from '../contracts/resource-url';
import { coreExports } from '../exports.ts';
import { attachSourceToReadableResources, findResourcesByUrls } from '../store/resources';

/** Crosses the discovery -> Resource Workflow boundary for every monitor. */
export async function enqueueSourceDrafts(db: NodePgDatabase, sourceId: string, drafts: SourceResourceDraft[]) {
	const relation = { kind: 'source' as const, sourceId: z.uuid().parse(sourceId) };
	const seen = new Set<string>();
	let skipped = 0;
	const targets = drafts.flatMap((draft, index) => {
		const parsed = SourceResourceDraftSchema.safeParse(draft);
		if (parsed.success) {
			// Invalid drafts must not claim an identity and hide a valid duplicate.
			const url = resolveResourceUrl(parsed.data.url)!;
			if (seen.has(url.normalizedUrl)) return [];
			seen.add(url.normalizedUrl);
			return [{ url, target: { ...parsed.data, kind: 'draft' as const, relation } }];
		}
		skipped++;
		console.warn({
			tag: 'SOURCE',
			msg: 'Invalid source draft skipped',
			source_id: sourceId,
			item_index: index,
			error: parsed.error.message,
		});
		return [];
	});
	const known = await findResourcesByUrls(
		db,
		targets.map(({ url }) => url),
	);
	// A readable original only needs its discovery source attached.
	const attached = await attachSourceToReadableResources(
		db,
		sourceId,
		known.flatMap(({ resourceId, sourceId }) => (resourceId && !sourceId ? [resourceId] : [])),
	);
	const instances = known
		.flatMap(({ resourceId, sourceId: existingSourceId, normalizedUrl }, index) =>
			resourceId && (existingSourceId || attached.has(resourceId)) ? [] : [{ target: targets[index]!.target, normalizedUrl }],
		)
		.map(({ target, normalizedUrl }) => ({
			id: `source-draft-v7-${hash('sha256', `${sourceId}:${normalizedUrl}`, 'hex')}`,
			params: target,
			// A failed instance holds its ID, so a URL a feed keeps listing is retried daily rather than every hour.
			retention: { successRetention: '5 minutes', errorRetention: '1 day' } as const,
		}));
	let created = 0;
	for (let offset = 0; offset < instances.length; offset += 100) {
		created += (await coreExports.ResourceProcessingV2Workflow.createBatch(instances.slice(offset, offset + 100))).length;
	}
	return { created, deduplicated: drafts.length - skipped - created, skipped };
}
