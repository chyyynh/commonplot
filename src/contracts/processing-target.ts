import { z } from 'zod';
import { PaidPdfFallbackGrantSchema } from './pdf-policy';
import { ResourceLanguageSchema } from './resource-language';
import { ResourceUrlSchema } from './resource-url';

const ResourceDraftRelationSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('source'), sourceId: z.uuid() }),
	z.strictObject({ kind: z.literal('subject'), parentResourceId: z.uuid(), parentOriginalHash: z.hash('md5') }),
]);

export type ResourceDraftRelation = z.infer<typeof ResourceDraftRelationSchema>;

export const ResourceDraftTargetSchema = z.strictObject({
	kind: z.literal('draft'),
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
	// Relations belong to Core's own background drafts; a Web admission always reports progress.
	payload: z.discriminatedUnion('kind', [ResourceDraftTargetSchema.omit({ relation: true }), StoredBlobTargetSchema]),
});

export const SourceResourceDraftSchema = ResourceDraftTargetSchema.pick({ url: true, sourceHints: true });
export type SourceResourceDraft = z.infer<typeof SourceResourceDraftSchema>;
