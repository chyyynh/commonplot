import { z } from 'zod';
import { ResourceLanguageSchema } from './resource-language';
import { ResourceUrlSchema } from './resource-url';

export const ResourceDraftTargetSchema = z.strictObject({
	kind: z.literal('draft'),
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
	objectId: z.uuid(),
});

const ReacquireTargetSchema = z.strictObject({
	kind: z.literal('reacquire'),
	/** Replace the stored original even when the new one is less complete or much shorter. */
	force: z.boolean().optional(),
	resourceId: z.uuid(),
});

/** What a request asks Core to acquire; who asked lives on the request row. */
export const RequestTargetSchema = z.discriminatedUnion('kind', [StoredBlobTargetSchema, ReacquireTargetSchema, ResourceDraftTargetSchema]);

export type RequestTarget = z.infer<typeof RequestTargetSchema>;

const requestId = { requestId: z.uuid() };

/** A workflow acquires for the request it leads, and settles every request waiting on the same key. */
export const ResourceProcessingTargetSchema = z.discriminatedUnion('kind', [
	StoredBlobTargetSchema.extend(requestId),
	ReacquireTargetSchema.extend(requestId),
	ResourceDraftTargetSchema.extend(requestId),
]);

export type ResourceProcessingTarget = z.infer<typeof ResourceProcessingTargetSchema>;

/** Web's handle for one import; its UUID is the import's request id. */
export const ImportWorkflowIdSchema = z.string().pipe(z.templateLiteral(['app-ingest-v1-', z.uuidv4()]));

export const ResourceImportDispatchSchema = z.strictObject({
	workflowId: ImportWorkflowIdSchema,
	payload: z.discriminatedUnion('kind', [
		z.strictObject({
			kind: z.literal('draft'),
			url: ResourceUrlSchema.max(2_048),
			saveTarget: z.strictObject({
				kind: z.literal('resourceSave'),
				userId: z.string().min(1).max(128),
				notebookId: z.uuid().nullable(),
			}),
		}),
		StoredBlobTargetSchema,
	]),
});

export const SourceResourceDraftSchema = ResourceDraftTargetSchema.pick({ url: true, sourceHints: true });
export type SourceResourceDraft = z.infer<typeof SourceResourceDraftSchema>;
