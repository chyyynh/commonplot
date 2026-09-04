import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { sha256Hex } from '../shared/hash';
import { enrichUploadedPdfReferences } from './resource-references';

const RESOURCE_REFERENCE_WORKFLOW_REVISION = 'pdf-sdt-xr-v1';
const ReferenceRevisionSchema = z.string().regex(/^[a-f\d]{32}$/);
const WorkflowInstanceIdSchema = z
	.string()
	.max(100)
	.regex(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/);
const UploadedPdfSourceSchema = z.strictObject({ fileResourceId: z.uuid(), kind: z.literal('uploadedPdf') });
const ResourceReferenceEnrichmentPayloadSchema = z.strictObject({
	referenceRevision: ReferenceRevisionSchema,
	resourceId: z.uuid(),
	/** Optional for compatibility with already-running v1 Workflow instances. */
	source: UploadedPdfSourceSchema.optional(),
});

type ResourceReferenceEnrichmentPayload = z.infer<typeof ResourceReferenceEnrichmentPayloadSchema>;

export async function enqueueResourceReferenceEnrichment(
	env: CoreEnv,
	resourceId: string,
	referenceRevision: string,
	uploadedPdfResourceId: string,
): Promise<string> {
	const payload = ResourceReferenceEnrichmentPayloadSchema.parse({
		referenceRevision,
		resourceId,
		source: { fileResourceId: uploadedPdfResourceId, kind: 'uploadedPdf' },
	});
	const runDigest = await sha256Hex(
		[RESOURCE_REFERENCE_WORKFLOW_REVISION, payload.resourceId, payload.referenceRevision, uploadedPdfResourceId, 'idempotent'].join('\n'),
	);
	const id = WorkflowInstanceIdSchema.parse(`rr-v5-${runDigest}`);
	await env.RESOURCE_REFERENCE_ENRICHMENT_WORKFLOW.createBatch([{ id, params: payload }]);
	return id;
}

/** Reference enrichment stays off the critical path after the base PDF and its SDT sidecar are persisted. */
export class ResourceReferenceEnrichmentWorkflow extends WorkflowEntrypoint<CoreEnv, ResourceReferenceEnrichmentPayload> {
	async run(event: WorkflowEvent<ResourceReferenceEnrichmentPayload>, step: WorkflowStep): Promise<void> {
		const input = ResourceReferenceEnrichmentPayloadSchema.parse(event.payload);
		if (!input.source) return;
		await enrichUploadedPdfReferences(this.env, step, {
			referenceRevision: input.referenceRevision,
			resourceId: input.resourceId,
			uploadedPdfResourceId: input.source.fileResourceId,
		});
	}
}
