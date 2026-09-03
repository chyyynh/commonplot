import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { sha256Hex } from '../shared/hash';
import { enrichUploadedPdfReferences } from './resource-references';

const RESOURCE_REFERENCE_WORKFLOW_REVISION = 'pdf-gr-xr-v3';
const ReferenceRevisionSchema = z.string().regex(/^[a-f\d]{32}$/);
const ForceRunKeySchema = z.string().regex(/^[a-f\d]{16}$/);
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
	options: { forceRunKey?: string; uploadedPdfResourceId: string },
): Promise<string> {
	const payload = ResourceReferenceEnrichmentPayloadSchema.parse({
		referenceRevision,
		resourceId,
		source: { fileResourceId: options.uploadedPdfResourceId, kind: 'uploadedPdf' },
	});
	const validatedForceRunKey = options.forceRunKey === undefined ? null : ForceRunKeySchema.parse(options.forceRunKey);
	const sourceRunKey = (await sha256Hex(options.uploadedPdfResourceId)).slice(0, 16);
	const baseId = validatedForceRunKey
		? `rr-${RESOURCE_REFERENCE_WORKFLOW_REVISION}-force-${payload.resourceId}-${validatedForceRunKey}`
		: `rr-${RESOURCE_REFERENCE_WORKFLOW_REVISION}-${payload.resourceId}-${payload.referenceRevision}`;
	const id = `${baseId}-${sourceRunKey}`;
	await env.RESOURCE_REFERENCE_ENRICHMENT_WORKFLOW.createBatch([{ id, params: payload }]);
	return id;
}

/** Reference enrichment stays off the critical path after GROBID has classified the base PDF. */
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
