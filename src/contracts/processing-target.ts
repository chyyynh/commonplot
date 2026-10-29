import { z } from 'zod';
import { ResourceUrlSchema } from './resource-url';

const ResourceDraftTargetSchema = z.strictObject({
	kind: z.literal('draft'),
	url: ResourceUrlSchema.max(2_048),
	// Not strict: a request queued before hints lost `originalLang` still carries it.
	sourceHints: z.object({ summary: z.string().max(20_000).optional(), publishedDate: z.iso.datetime().optional() }).optional(),
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
const RequestTargetSchema = z.discriminatedUnion('kind', [StoredBlobTargetSchema, ReacquireTargetSchema, ResourceDraftTargetSchema]);

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
export const IMPORT_WORKFLOW_PREFIX = 'app-ingest-v1-';
export const ImportWorkflowIdSchema = z.string().pipe(z.templateLiteral([IMPORT_WORKFLOW_PREFIX, z.uuidv4()]));

export const ResourceImportDispatchSchema = z.strictObject({
	workflowId: ImportWorkflowIdSchema,
	userId: z.string().min(1).max(128),
	/** Where Web files the Resource; null is the library. */
	notebookId: z.uuid().nullable(),
	/** What the inbox shows until the Resource has a title. */
	label: z.string().min(1).max(240),
	payload: z.discriminatedUnion('kind', [ResourceDraftTargetSchema.pick({ kind: true, url: true }), StoredBlobTargetSchema]),
});

export const SourceResourceDraftSchema = ResourceDraftTargetSchema.pick({ url: true, sourceHints: true });
export type SourceResourceDraft = z.infer<typeof SourceResourceDraftSchema>;
