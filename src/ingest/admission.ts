import { inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { sha256Hex } from '../shared/hash';
import { PaidPdfFallbackGrantSchema } from './platforms/pdf-policy';
import { resolveResourceUrl, ResourceUrlSchema } from './platforms/resource-url';
import { ResourceLanguageSchema } from './resource-language';

const ResourceDraftRelationSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('source'), sourceId: z.uuid() }),
	z.strictObject({ kind: z.literal('subject'), parentResourceId: z.uuid(), parentAcquisitionRevision: z.hash('md5') }),
]);

export type ResourceDraftRelation = z.infer<typeof ResourceDraftRelationSchema>;

export const ResourceDraftTargetSchema = z.strictObject({
	kind: z.literal('draft'),
	progress: z.boolean().optional(),
	paidPdfFallback: PaidPdfFallbackGrantSchema.optional(),
	relation: ResourceDraftRelationSchema.optional(),
	saveTarget: z.record(z.string(), z.json()).optional(),
	url: ResourceUrlSchema,
	sourceHints: z
		.strictObject({
			summary: z.string().max(20_000).optional(),
			originalLang: ResourceLanguageSchema.optional().catch(undefined),
			publishedDate: z.iso.datetime().optional(),
			keywords: z.array(z.string().max(500)).max(100).optional(),
		})
		.optional(),
});

const StoredResourceTargetSchema = z.strictObject({
	kind: z.enum(['storedBlob', 'reacquire']),
	paidPdfFallback: PaidPdfFallbackGrantSchema.optional(),
	resourceId: z.uuid(),
});

export const ResourceProcessingTargetSchema = z.discriminatedUnion('kind', [StoredResourceTargetSchema, ResourceDraftTargetSchema]);

export type ResourceProcessingTarget = z.infer<typeof ResourceProcessingTargetSchema>;

export const ResourceImportDispatchSchema = z.strictObject({
	workflowId: z.string().pipe(z.templateLiteral(['app-ingest-v1-', z.uuidv4()])),
	payload: z.discriminatedUnion('kind', [ResourceDraftTargetSchema, StoredResourceTargetSchema.extend({ kind: z.literal('storedBlob') })]),
});

export type SourceResourceDraft = Pick<z.infer<typeof ResourceDraftTargetSchema>, 'url' | 'sourceHints'>;

/** Crosses the discovery -> Resource Workflow boundary for every monitor. */
export async function enqueueSourceDrafts(
	env: CoreEnv,
	db: NodePgDatabase,
	sourceId: string,
	drafts: SourceResourceDraft[],
): Promise<number> {
	const targets = drafts.map((draft) =>
		ResourceDraftTargetSchema.parse({
			...draft,
			kind: 'draft',
			relation: { kind: 'source', sourceId },
		}),
	);
	if (!targets.length) return 0;
	const resolvedUrls = targets.map(({ url }) => resolveResourceUrl(url)!);
	const urls = resolvedUrls.flatMap(({ url, normalizedUrl }) => [url, normalizedUrl]);
	const known = await db.execute<{ normalized_url: string | null; url: string | null }>(sql`
		SELECT resource.url, resource.normalized_url
		FROM resources resource
		WHERE resource.scope = 'corpus'
		  AND resource.source_id IS NOT NULL
		  AND (${inArray(sql`resource.url`, urls)} OR ${inArray(sql`resource.normalized_url`, urls)})
	`);
	const knownUrls = new Set(known.rows.flatMap(({ normalized_url, url }) => [url, normalized_url]).filter((url) => url !== null));
	const instances = await Promise.all(
		targets
			.filter(({ url }, index) => !knownUrls.has(url) && !knownUrls.has(resolvedUrls[index]!.normalizedUrl))
			.map(async (target) => ({
				id: `source-draft-v7-${await sha256Hex(`${sourceId}:${resolveResourceUrl(target.url)!.normalizedUrl}`)}`,
				params: target,
				retention: { successRetention: '5 minutes', errorRetention: '1 hour' } as const,
			})),
	);
	let created = 0;
	for (let offset = 0; offset < instances.length; offset += 100) {
		created += (await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch(instances.slice(offset, offset + 100))).length;
	}
	return created;
}
