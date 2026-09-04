import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { sha256Hex } from '../shared/hash';
import { enrichUploadedPdfReferences } from './resource-references';

const RESOURCE_REFERENCE_WORKFLOW_REVISION = 'pdf-sdt-xr-v1';
const ResourceReferenceEnrichmentPayloadSchema = z.strictObject({
	referenceRevision: z.hash('md5').lowercase(),
	resourceId: z.uuid(),
	/** Optional for compatibility with already-running v1 Workflow instances. */
	source: z.strictObject({ fileResourceId: z.uuid(), kind: z.literal('uploadedPdf') }).optional(),
});

type ResourceReferenceEnrichmentPayload = z.infer<typeof ResourceReferenceEnrichmentPayloadSchema>;

export async function enqueueResourceReferenceEnrichment(
	env: CoreEnv,
	resourceId: string,
	referenceRevision: string,
	uploadedPdfResourceId: string,
): Promise<string> {
	const payload = {
		referenceRevision,
		resourceId,
		source: { fileResourceId: uploadedPdfResourceId, kind: 'uploadedPdf' },
	} satisfies ResourceReferenceEnrichmentPayload;
	const id = `rr-v5-${await sha256Hex(
		[RESOURCE_REFERENCE_WORKFLOW_REVISION, payload.resourceId, payload.referenceRevision, uploadedPdfResourceId, 'idempotent'].join('\n'),
	)}`;
	await env.RESOURCE_REFERENCE_ENRICHMENT_WORKFLOW.createBatch([{ id, params: payload }]);
	return id;
}

/** Reference enrichment stays off the critical path after the base PDF and its SDT sidecar are persisted. */
export class ResourceReferenceEnrichmentWorkflow extends WorkflowEntrypoint<CoreEnv, ResourceReferenceEnrichmentPayload> {
	async run(event: WorkflowEvent<ResourceReferenceEnrichmentPayload>, step: WorkflowStep): Promise<void> {
		const input = ResourceReferenceEnrichmentPayloadSchema.parse(event.payload);
		if (!input.source) return;
		await enrichUploadedPdfReferences(this.env, step, { ...input, uploadedPdfResourceId: input.source.fileResourceId });
	}
}
