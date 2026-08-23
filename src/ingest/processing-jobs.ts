// Validated Workflow payloads and enqueue entrypoints for app, monitor, and derived-resource jobs.
import { type ResourceDraftAdmission, TwitterProviderSequenceSchema } from '@app-domain/resource-graph-contracts';
import { sha256Hex } from '@core-shared/hash';
import { canonicalizeOptionalResourceLang } from '@core-shared/resource';
import { normalizeUrl, parseExternalHttpUrl, validatedExternalMediaUrl } from '@core-shared/url';
import { z } from 'zod';
import { PdfParseAdmissionSchema } from '../shared/pdf-parse-contract.ts';

const DraftAdmissionSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('profileSave'),
			userId: z.string().trim().min(1).max(255),
			visibility: z.enum(['public', 'private']),
		})
		.strict(),
	z
		.object({
			kind: z.literal('container'),
			userId: z.string().trim().min(1).max(255),
			container: z
				.object({
					kind: z.enum(['collection', 'workspace']),
					id: z.string().uuid(),
				})
				.strict(),
		})
		.strict(),
	z.object({ kind: z.literal('source'), sourceId: z.string().uuid() }).strict(),
	z
		.object({
			kind: z.literal('subject'),
			parentResourceId: z.string().uuid(),
		})
		.strict(),
	z
		.object({
			kind: z.literal('userFilePaper'),
			fileResourceId: z.string().uuid(),
		})
		.strict(),
]);

const ResourceDraftTargetSchema = z
	.object({
		kind: z.literal('draft'),
		admission: DraftAdmissionSchema,
		url: z
			.url({ protocol: /^https?$/ })
			.max(2_048)
			.refine((value) => parseExternalHttpUrl(value) !== null, 'URL credentials are not allowed'),
		sourceHints: z
			.object({
				summary: z.string().max(20_000).optional(),
				originalLang: z.string().trim().min(1).max(35).optional(),
				publishedDate: z.iso.datetime().optional(),
				keywords: z.array(z.string().max(500)).max(100).optional(),
				sourceAvatarUrl: z.url().max(2_048).optional(),
			})
			.strict()
			.optional(),
		providerSequence: TwitterProviderSequenceSchema.optional(),
	})
	.strict();

const ResourceProcessingWorkflowPayloadSchema = z
	.object({
		target: z.discriminatedUnion('kind', [
			z
				.object({
					kind: z.literal('storedBlob'),
					resourceId: z.string().uuid(),
					parseAdmission: PdfParseAdmissionSchema,
				})
				.strict()
				.superRefine((target, context) => {
					if (target.resourceId !== target.parseAdmission.fileResourceId) {
						context.addIssue({
							code: 'custom',
							message: 'Stored PDF admission Resource id does not match its target',
						});
					}
				}),
			z
				.object({
					kind: z.literal('reacquire'),
					resourceId: z.string().uuid(),
				})
				.strict(),
			ResourceDraftTargetSchema,
		]),
	})
	.strict();

export type ResourceProcessingWorkflowPayload = z.infer<typeof ResourceProcessingWorkflowPayloadSchema>;
type ResourceDraftTarget = Extract<ResourceProcessingWorkflowPayload['target'], { kind: 'draft' }>;

export function parseResourceProcessingWorkflowPayload(value: unknown): ResourceProcessingWorkflowPayload {
	return ResourceProcessingWorkflowPayloadSchema.parse(value);
}

export type SourceResourceDraft = {
	sourceId: string;
	url: string;
	publishedDate: Date | null;
	summary: string | null;
	originalLang?: string;
	keywords?: string[];
	sourceAvatarUrl?: string | null;
	/** Monotonic provider event sequence used to reject stale draft commits. */
	providerSequence?: string;
};

export type AppResourceDraftInput = Readonly<{
	instanceId: string;
	url: string;
	admission: Extract<ResourceDraftAdmission, { kind: 'profileSave' | 'container' }>;
}>;

type SourceResourceAdmissionOutcome = 'created' | 'existing';

const SOURCE_DRAFT_WORKFLOW_REVISION = 'source-draft-v4';
const WORKFLOW_CREATE_BATCH_SIZE = 100;

export async function enqueueAppResourceDraft(env: CoreEnv, input: AppResourceDraftInput): Promise<string> {
	if (!/^app-draft-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.instanceId)) {
		throw new Error('Invalid app draft Workflow ID');
	}
	const parsed = parseExternalHttpUrl(input.url);
	if (!parsed) throw new Error('Only http(s) URLs without credentials are allowed');
	const url = normalizeUrl(parsed.toString());
	const target = ResourceDraftTargetSchema.parse({
		kind: 'draft',
		admission: input.admission,
		url,
	});
	await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([{ id: input.instanceId, params: { target } }]);
	return input.instanceId;
}

function sourceDraftTarget(base: SourceResourceDraft): ResourceDraftTarget {
	const originalLang = canonicalizeOptionalResourceLang(base.originalLang);
	if (base.publishedDate && !Number.isFinite(base.publishedDate.getTime())) throw new Error('Source published date is invalid');
	const publishedDate = base.publishedDate?.toISOString() ?? null;
	const parsedUrl = parseExternalHttpUrl(base.url.trim());
	if (!parsedUrl) throw new Error('Source resource URL must be external http(s)');
	const url = normalizeUrl(parsedUrl.toString());
	const summary = base.summary?.trim() || null;
	const keywords = base.keywords ?? [];
	const sourceAvatarUrl = validatedExternalMediaUrl(base.sourceAvatarUrl);
	return ResourceDraftTargetSchema.parse({
		kind: 'draft',
		admission: { kind: 'source', sourceId: base.sourceId.trim() },
		url,
		sourceHints: {
			...(summary ? { summary } : {}),
			...(originalLang ? { originalLang } : {}),
			...(publishedDate ? { publishedDate } : {}),
			...(keywords.length ? { keywords } : {}),
			...(sourceAvatarUrl ? { sourceAvatarUrl } : {}),
		},
		...(base.providerSequence?.trim() ? { providerSequence: base.providerSequence.trim() } : {}),
	});
}

export async function enqueueSubjectDraft(
	env: CoreEnv,
	input: {
		parentResourceId: string;
		url: string;
	},
): Promise<string> {
	const target = ResourceDraftTargetSchema.parse({
		kind: 'draft',
		admission: {
			kind: 'subject',
			parentResourceId: input.parentResourceId,
		},
		url: normalizeUrl(input.url),
	});
	const identity = await sha256Hex(JSON.stringify(target));
	const id = `subject-draft-v3-${identity}`;
	await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([{ id, params: { target } }]);
	return id;
}

export async function admitDiscoveredSourceResources(
	env: CoreEnv,
	drafts: SourceResourceDraft[],
): Promise<SourceResourceAdmissionOutcome[]> {
	const instances = await Promise.all(
		drafts.map(async (draft) => {
			const target = sourceDraftTarget(draft);
			return {
				id: `${SOURCE_DRAFT_WORKFLOW_REVISION}-${await sha256Hex(JSON.stringify(target))}`,
				params: { target },
			};
		}),
	);
	const createdIds = new Set<string>();
	for (let offset = 0; offset < instances.length; offset += WORKFLOW_CREATE_BATCH_SIZE) {
		const created = await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch(instances.slice(offset, offset + WORKFLOW_CREATE_BATCH_SIZE));
		for (const instance of created) createdIds.add(instance.id);
	}
	return instances.map(({ id }) => (createdIds.has(id) ? 'created' : 'existing'));
}
