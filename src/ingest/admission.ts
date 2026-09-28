import { hash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { PaidPdfFallbackGrantSchema } from './platforms/pdf-policy';
import { resolveResourceUrl, ResourceUrlSchema } from './platforms/resource-url';
import { ResourceLanguageSchema } from './resource-language';
import { findResourcesByUrls } from './resource-persistence';

const ResourceDraftRelationSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('source'), sourceId: z.uuid() }),
	z.strictObject({ kind: z.literal('subject'), parentResourceId: z.uuid(), parentOriginalHash: z.hash('md5') }),
]);

export type ResourceDraftRelation = z.infer<typeof ResourceDraftRelationSchema>;

export const ResourceDraftTargetSchema = z.strictObject({
	kind: z.literal('draft'),
	progress: z.boolean().optional(),
	paidPdfFallback: PaidPdfFallbackGrantSchema.optional(),
	relation: ResourceDraftRelationSchema.optional(),
	saveTarget: z.record(z.string(), z.json()).optional(),
	url: ResourceUrlSchema.max(2_048),
	sourceHints: z
		.strictObject({
			summary: z.string().max(20_000).optional(),
			originalLang: ResourceLanguageSchema.optional().catch(undefined),
			publishedDate: z.iso.datetime().optional(),
		})
		.optional(),
});

const StoredBlobTargetSchema = z.strictObject({
	kind: z.literal('storedBlob'),
	paidPdfFallback: PaidPdfFallbackGrantSchema.optional(),
	resourceId: z.uuid(),
});

const ReacquireTargetSchema = z.strictObject({
	kind: z.literal('reacquire'),
	/** Replace the stored original even when the new one is less complete or much shorter. */
	force: z.boolean().optional(),
	paidPdfFallback: PaidPdfFallbackGrantSchema.optional(),
	resourceId: z.uuid(),
});

export const ResourceProcessingTargetSchema = z.discriminatedUnion('kind', [
	StoredBlobTargetSchema,
	ReacquireTargetSchema,
	ResourceDraftTargetSchema,
]);

export type ResourceProcessingTarget = z.infer<typeof ResourceProcessingTargetSchema>;

export const ResourceImportDispatchSchema = z.strictObject({
	workflowId: z.string().pipe(z.templateLiteral(['app-ingest-v1-', z.uuidv4()])),
	payload: z.discriminatedUnion('kind', [ResourceDraftTargetSchema, StoredBlobTargetSchema]),
});

const SourceResourceDraftSchema = ResourceDraftTargetSchema.pick({ url: true, sourceHints: true });
export type SourceResourceDraft = z.infer<typeof SourceResourceDraftSchema>;

/** Crosses the discovery -> Resource Workflow boundary for every monitor. */
export async function enqueueSourceDrafts(env: CoreEnv, db: NodePgDatabase, sourceId: string, drafts: SourceResourceDraft[]) {
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
	const unassigned = known.flatMap(({ resourceId, sourceId }) => (resourceId && !sourceId ? [resourceId] : []));
	// A readable original only needs its discovery source attached.
	const attached = new Set<string>();
	if (unassigned.length) {
		const { rows } = await db.execute<{ id: string }>(sql`
			UPDATE resources
			SET source_id = ${sourceId}::uuid, updated_at = NOW()
			WHERE id = ANY(${sql.param(unassigned)}::uuid[]) AND scope = 'corpus' AND source_id IS NULL
			  AND EXISTS (
			    SELECT 1 FROM resource_translations original
			    WHERE original.resource_id = resources.id AND original.lang = resources.original_lang
			      AND (resources.kind = 'post' OR BTRIM(original.title) <> '') AND BTRIM(original.content) <> ''
			  )
			RETURNING id::text
		`);
		for (const { id } of rows) attached.add(id);
	}
	const instances = known
		.flatMap(({ resourceId, sourceId: existingSourceId, normalizedUrl }, index) =>
			resourceId && (existingSourceId || attached.has(resourceId)) ? [] : [{ target: targets[index]!.target, normalizedUrl }],
		)
		.map(({ target, normalizedUrl }) => ({
			id: `source-draft-v7-${hash('sha256', `${sourceId}:${normalizedUrl}`, 'hex')}`,
			params: target,
			retention: { successRetention: '5 minutes', errorRetention: '1 hour' } as const,
		}));
	let created = 0;
	for (let offset = 0; offset < instances.length; offset += 100) {
		created += (await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch(instances.slice(offset, offset + 100))).length;
	}
	return { created, deduplicated: drafts.length - skipped - created, skipped };
}
