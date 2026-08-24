import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { connectCoreDb } from '@core-shared/db';
import { sha256Hex } from '@core-shared/hash';
import {
	type HostedResourceImage,
	hostedResourceImageFields,
	normalizedExternalMediaUrl,
	resourceImageSourceUrls,
} from '@core-shared/image-mapping';
import { normalizePaperIdentifiers, type PaperIdentifier } from '@core-shared/paper-identity';
import {
	canonicalizeOptionalResourceLang,
	canonicalizeResourceLang,
	isPaperIdentifier,
	ResourceIdentifiersSchema,
} from '@core-shared/resource';
import { ENTITY_TYPES, entityExtractionExclusionNames, type ResourceEntityInput, toStoredResourceEntities } from '@entities/normalize';
import { generateText, Output } from 'ai';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { syncCorpusItem } from '../search-index';
import { type ProcessingResource, stageStoredResource, stageUrlAcquisition } from './acquisition';
import { stageResourceImages } from './image-rehosting';
import { enqueueResourceTranslation } from './translation-workflow';

export const ResourceDraftTargetSchema = z
	.object({
		kind: z.literal('draft'),
		admission: z.discriminatedUnion('kind', [
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
			z.object({ kind: z.literal('subject'), parentResourceId: z.string().uuid() }).strict(),
			z.object({ kind: z.literal('userFilePaper'), fileResourceId: z.string().uuid() }).strict(),
		]),
		url: z
			.url({ protocol: /^https?$/ })
			.max(2_048)
			.refine((value) => {
				const url = URL.parse(value);
				return url !== null && !url.username && !url.password;
			}, 'URL credentials are not allowed'),
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
	})
	.strict();

export type ResourceDraftTarget = z.infer<typeof ResourceDraftTargetSchema>;

export type SourceResourceDraft = {
	sourceId: string;
	url: string;
	publishedDate: Date | null;
	summary: string | null;
	originalLang?: string;
	keywords?: string[];
	sourceAvatarUrl?: string | null;
};

/** Crosses the discovery -> Resource Workflow boundary for every monitor. */
export async function enqueueSourceDrafts(env: CoreEnv, drafts: SourceResourceDraft[]): Promise<number> {
	const instances = await Promise.all(
		drafts.map(async (draft) => {
			const originalLang = canonicalizeOptionalResourceLang(draft.originalLang);
			if (draft.publishedDate && !Number.isFinite(draft.publishedDate.getTime())) throw new Error('Source published date is invalid');
			const parsedUrl = URL.parse(draft.url.trim());
			if (!parsedUrl || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') || parsedUrl.username || parsedUrl.password) {
				throw new Error('Source resource URL must be external http(s)');
			}
			const summary = draft.summary?.trim() || null;
			const sourceAvatarUrl = normalizedExternalMediaUrl(draft.sourceAvatarUrl);
			const target = {
				kind: 'draft',
				admission: { kind: 'source', sourceId: draft.sourceId.trim() },
				url: parsedUrl.toString(),
				sourceHints: {
					...(summary ? { summary } : {}),
					...(originalLang ? { originalLang } : {}),
					...(draft.publishedDate ? { publishedDate: draft.publishedDate.toISOString() } : {}),
					...(draft.keywords?.length ? { keywords: draft.keywords } : {}),
					...(sourceAvatarUrl ? { sourceAvatarUrl } : {}),
				},
			} satisfies ResourceDraftTarget;
			return {
				id: `source-draft-v5-${await sha256Hex(JSON.stringify(target))}`,
				params: target,
			};
		}),
	);
	let created = 0;
	for (let offset = 0; offset < instances.length; offset += 100) {
		created += (await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch(instances.slice(offset, offset + 100))).length;
	}
	return created;
}

const ResourceProcessingTargetSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('storedBlob'),
			resourceId: z.string().uuid(),
		})
		.strict(),
	z
		.object({
			kind: z.literal('reacquire'),
			resourceId: z.string().uuid(),
		})
		.strict(),
	ResourceDraftTargetSchema,
]);

type ResourceProcessingTarget = z.infer<typeof ResourceProcessingTargetSchema>;

export const AutonomousResourceDraftIdSchema = z.string().regex(/^(?:source|subject)-draft-v[1-9]\d*-[0-9a-f]{64}$/);

const ResourceDraftRecoveryPayloadSchema = z
	.object({
		instanceId: AutonomousResourceDraftIdSchema,
	})
	.strict();

type ResourceClassification = {
	tags: string[];
	keywords: string[];
	entities: ResourceEntityInput[];
};

type ResolvedProcessingCall = {
	keywordHints: readonly string[];
	resource: ProcessingResource;
	persistenceTarget:
		| Readonly<{ kind: 'draft'; admission: ResourceDraftTarget['admission'] }>
		| Readonly<{ kind: 'existing'; resourceId: string }>;
	processingId: string;
};

const CLASSIFICATION_CONTENT_MAX_LENGTH = 10000;

const ResourceClassificationSchema = z.object({
	tags: z.array(z.string().min(1)).min(1),
	keywords: z.array(z.string().min(1)).min(1),
	entities: z.array(
		z.object({
			name: z.string().min(1),
			name_cn: z.string().min(1),
			type: z.enum(ENTITY_TYPES),
		}),
	),
});

const RESOURCE_CLASSIFICATION_SYSTEM_PROMPT = `你是專業的新聞分類和實體分析師。請只輸出符合 schema 的分類資料。

任務：
- 產生 tags、keywords
- 擷取重要 named entities

標籤規則：
- AI相關: AI, MachineLearning, DeepLearning, NLP, ComputerVision, LLM, GenerativeAI
- 產品相關: Coding, VR, AR, Robotics, Automation, SoftwareDevelopment, API
- 產業應用: Tech, Finance, Healthcare, Education, Gaming, Enterprise, Creative
- 事件類型: Funding, IPO, Acquisition, ProductLaunch, Research, Partnership
- 新聞性質: Review, Opinion, Analysis, Feature, Interview, Tutorial, Announcement

實體擷取規則：
- 提取 3-8 個最重要的具名實體；如果文章太短，可以少於 3 個
- type 只能是 person, organization, product, technology, event, location
- name 用英文或原文慣用名稱；name_cn 用繁體中文，若無慣用中文名則與 name 相同
- 不要把文章來源、平台、作者名稱當作實體，除非文章主題就是該來源、平台或作者本身
- 不要提取泛詞、短縮碎片、股票代號或單字母縮寫，例如 AI、X、Go、US、C、RL、PI、$GOOGL
- 模型、產品、活動請使用完整慣用名稱，例如 Claude Opus 4.7、DeepSeek V4、TechCrunch Disrupt 2026
- 如果只能判斷出泛詞、版本碎片或來源名稱，寧可少提取`;

async function classifyResource(
	resource: ProcessingResource,
	keywordHints: readonly string[],
	env: CoreEnv,
	processingId: string,
): Promise<ResourceClassification> {
	console.info({ tag: 'AI', msg: 'Analyzing', title: resource.title.substring(0, 80) });
	const excludedEntities = entityExtractionExclusionNames(resource.resourcePlatform, resource.source, resource.creators);
	const excludedLine = excludedEntities.length ? `\n實體排除名單: ${excludedEntities.join(', ')}` : '';
	const summaryLine = resource.summary?.trim() ? `\n摘要: ${resource.summary.trim()}` : '';
	const prompt = `文章資訊:
標題: ${resource.title}
來源: ${resource.source.trim()}
資源種類: ${resource.kind}
資源平台: ${resource.resourcePlatform ?? 'none'}${excludedLine}${summaryLine}
內容:
${resource.content.trim().substring(0, CLASSIFICATION_CONTENT_MAX_LENGTH)}`;
	const { finishReason, output: classification } = await generateText({
		model: createWorkersAI({ binding: env.AI })('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
			gateway: {
				id: 'core-ingest',
				collectLog: true,
				retries: { maxAttempts: 1 },
				metadata: {
					feature: 'resource-classification',
					environment: env.AI_GATEWAY_ENVIRONMENT,
					processing_id: processingId,
				},
			},
			extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
		}),
		prompt,
		system: RESOURCE_CLASSIFICATION_SYSTEM_PROMPT,
		output: Output.object({ schema: ResourceClassificationSchema }),
		maxOutputTokens: 500,
		temperature: 0.3,
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error('Resource classification hit its output token cap');
	const tags = classification.tags.slice(0, 5);
	return {
		entities: classification.entities.slice(0, 10),
		tags,
		keywords: keywordHints.length ? [...keywordHints] : classification.keywords.slice(0, 8),
	};
}

function resolvedResourceMutation(
	resource: ProcessingResource,
	classification: ResourceClassification,
	hostedImages: readonly HostedResourceImage[],
) {
	const media = hostedResourceImageFields(
		{ creators: resource.creators, kindMetadata: resource.kindMetadata, ogImageUrl: resource.previewImageUrl },
		hostedImages,
	);
	return {
		kind: resource.kind,
		resourcePlatform: resource.resourcePlatform,
		identifiers: resource.resourceIdentifiers,
		creators: media.creators,
		kindMetadata: media.kindMetadata,
		...(resource.youtube ? { youtube: resource.youtube } : {}),
		originalLang: resource.originalLang,
		title: resource.title,
		summary: resource.summary,
		content: resource.content,
		keywords: classification.keywords,
		tags: classification.tags,
		entities: toStoredResourceEntities(classification.entities, resource.resourcePlatform, resource.source, resource.creators),
		subjectReference: resource.subject
			? {
					identifiers: resource.subject.identifiers,
					normalizedUrl: resource.subject.normalizedUrl,
				}
			: null,
		url: resource.url,
		normalizedUrl: resource.normalizedUrl ?? resource.url,
		fileType: resource.fileType ?? null,
		publishedDate: resource.publishedDate,
		ogImageUrl: media.ogImageUrl,
	};
}

type ResourceReacquisitionInput = {
	originalLang: string;
	paperIdentifiers: PaperIdentifier[];
	publishedDate: string | null;
	summary: string | null;
	url: string;
};

type ResourceReacquisitionRow = {
	original_lang: string;
	published_date: Date | string | null;
	resource_identifiers: unknown;
	summary: string | null;
	url: string | null;
};

async function loadResourceReacquisitionInput(db: NodePgDatabase, resourceId: string): Promise<ResourceReacquisitionInput> {
	const result = await db.execute<ResourceReacquisitionRow>(sql`
		SELECT
			original.summary,
			resource.original_lang,
			(
				SELECT jsonb_agg(
					jsonb_build_object(
						'preferred', identifier.is_preferred,
						'scheme', identifier.scheme,
						'value', identifier.value
					)
					ORDER BY identifier.scheme, identifier.is_preferred DESC, identifier.value
				)
				FROM resource_identifiers identifier
				WHERE identifier.resource_id = resource.id
				  AND identifier.scheme IN ('doi', 'arxiv', 'openalex')
			) AS resource_identifiers,
			resource.url,
			resource.published_date
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		WHERE resource.id = ${resourceId}::uuid
		LIMIT 1
	`);
	const row = result.rows[0];
	if (!row) throw new Error(`Failed to fetch resource ${resourceId}: not found`);
	const url = row.url ? URL.parse(row.url) : null;
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
		throw new Error(`Resource ${resourceId} has no valid external HTTP URL and cannot be reacquired`);
	}
	const publishedDate = row.published_date instanceof Date ? row.published_date : row.published_date ? new Date(row.published_date) : null;
	if (publishedDate && !Number.isFinite(publishedDate.getTime())) throw new Error('Invalid published_date: expected date');
	return {
		originalLang: canonicalizeResourceLang(row.original_lang),
		paperIdentifiers: normalizePaperIdentifiers(ResourceIdentifiersSchema.parse(row.resource_identifiers ?? []).filter(isPaperIdentifier)),
		publishedDate: publishedDate?.toISOString() ?? null,
		summary: row.summary,
		url: url.toString(),
	};
}

async function resolveProcessingCall(
	env: CoreEnv,
	step: WorkflowStep,
	target: ResourceProcessingTarget,
	instanceId: string,
): Promise<ResolvedProcessingCall> {
	if (target.kind === 'draft') {
		const monitor =
			target.admission.kind === 'source'
				? {
						avatarUrl: target.sourceHints?.sourceAvatarUrl ?? null,
					}
				: null;
		return {
			keywordHints: target.sourceHints?.keywords ?? [],
			processingId: instanceId,
			resource: await stageUrlAcquisition(env, step, {
				hints: {
					originalLang: target.sourceHints?.originalLang ?? null,
					publishedDate: target.sourceHints?.publishedDate ?? null,
					summary: target.sourceHints?.summary ?? null,
				},
				monitor,
				processingId: instanceId,
				url: target.url,
			}),
			persistenceTarget: {
				kind: 'draft',
				admission: target.admission,
			},
		};
	}

	if (target.kind === 'storedBlob') {
		return stageStoredResource(env, step, target);
	}

	const snapshot = await step.do(
		'load-resource-reacquisition-input-v1',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		async () => loadResourceReacquisitionInput(await connectCoreDb(env), target.resourceId),
	);
	return {
		keywordHints: [],
		processingId: target.resourceId,
		resource: await stageUrlAcquisition(env, step, {
			hints: {
				originalLang: snapshot.originalLang,
				publishedDate: snapshot.publishedDate,
				summary: snapshot.summary,
			},
			monitor: null,
			paperIdentifiers: snapshot.paperIdentifiers,
			processingId: target.resourceId,
			url: snapshot.url,
		}),
		persistenceTarget: {
			kind: 'existing',
			resourceId: target.resourceId,
		},
	};
}

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceProcessingTarget> {
	async run(event: WorkflowEvent<ResourceProcessingTarget>, step: WorkflowStep) {
		const target = ResourceProcessingTargetSchema.parse(event.payload);
		const call = await resolveProcessingCall(this.env, step, target, event.instanceId);
		const resource = call.resource;
		const processingId = call.processingId;

		console.info({
			tag: 'WORKFLOW',
			msg: 'Starting',
			resourceKind: resource.kind,
			resourcePlatform: resource.resourcePlatform,
			processing_id: processingId,
			target_kind: target.kind,
		});
		const imageSources = resourceImageSourceUrls({
			creators: resource.creators,
			kindMetadata: resource.kindMetadata,
			ogImageUrl: resource.previewImageUrl,
		});
		const [classification, hostedImages] = await Promise.all([
			step.do('classify-resource', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' }, () =>
				classifyResource(resource, call.keywordHints, this.env, processingId),
			),
			stageResourceImages(this.env, step, processingId, imageSources),
		]);
		const persistence = await step.do(
			'persist-resolved-resource-scope-v2',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				using result = await this.env.DOMAIN.persistResolvedResource({
					...resolvedResourceMutation(resource, classification, hostedImages),
					target: call.persistenceTarget,
				});
				return {
					resourceId: result.resourceId,
					scope: result.scope,
					subjectAttached: result.subjectAttached,
					translationRevision: result.translationRevision,
				};
			},
		);
		const { resourceId: persistedResourceId, scope, subjectAttached, translationRevision } = persistence;
		const followUps: Promise<unknown>[] = [];
		if (scope === 'corpus') {
			followUps.push(
				step.do(
					'sync-resolved-ai-search-v1',
					{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '90 seconds' },
					async () => {
						const db = await connectCoreDb(this.env);
						await syncCorpusItem(this.env, db, persistedResourceId);
					},
				),
			);
		}
		if (translationRevision) {
			followUps.push(
				step.do(
					'enqueue-resource-translation-v2',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					() => enqueueResourceTranslation(this.env, persistedResourceId, translationRevision),
				),
			);
		}
		const subject = resource.subject;
		if (subject && !subjectAttached) {
			followUps.push(
				step.do(
					'enqueue-resolved-subject-child-v1',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					async () => {
						const subjectTarget = ResourceDraftTargetSchema.parse({
							kind: 'draft',
							admission: { kind: 'subject', parentResourceId: persistedResourceId },
							url: subject.normalizedUrl,
						});
						const id = `subject-draft-v3-${await sha256Hex(JSON.stringify(subjectTarget))}`;
						await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([{ id, params: subjectTarget }]);
						return id;
					},
				),
			);
		}
		await Promise.all(followUps);

		console.info({ tag: 'WORKFLOW', msg: 'Completed', resource_id: persistedResourceId, target_kind: target.kind });
		return { resourceId: persistedResourceId };
	}
}

/** Gives an autonomous source or subject draft one delayed whole-Workflow retry. */
export class ResourceDraftRecoveryWorkflow extends WorkflowEntrypoint<CoreEnv, z.infer<typeof ResourceDraftRecoveryPayloadSchema>> {
	async run(event: WorkflowEvent<z.infer<typeof ResourceDraftRecoveryPayloadSchema>>, step: WorkflowStep) {
		const { instanceId } = ResourceDraftRecoveryPayloadSchema.parse(event.payload);
		await step.sleep('resource-draft-recovery-delay-v1', '15 minutes');
		const outcome = await step.do(
			'resource-draft-restart-once-v1',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const instance = await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.get(instanceId);
				const state = await instance.status();
				if (state.status === 'unknown') throw new Error(`Resource Workflow ${instanceId} has unknown status`);
				if (state.status !== 'errored') return state.status;
				await instance.restart();
				return 'restarted' as const;
			},
		);
		console.info({ tag: 'RESOURCE_RECOVERY', event: 'resource_draft_recovery_completed', instance_id: instanceId, outcome });
		return { outcome };
	}
}
