import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import type {
	PersistResolvedResourceInput,
	PersistResolvedResourceResult,
	PersistResolvedResourceTarget,
} from '@app-domain/resource-graph-contracts';
import {
	DEFAULT_RESOURCE_LANG,
	ENTITY_TYPES,
	RESOURCE_CATEGORIES,
	type ResolvedResource,
	type ResourceCategory,
} from '@core-shared/resource';
import { type HostedResourceImage, hostedResourceImageFields, resourceImageSourceUrls } from '@core-shared/resource-image-mapping';
import { connectCoreDb } from '@db/connection';
import { entityExtractionExclusionNames, type ResourceEntityInput, toStoredResourceEntities } from '@entities/normalize';
import { loadResourceReacquisitionInput, loadStoredPdfInput, markStoredBlobProcessingFailed } from '@ingest/stored-resource';
import { generateText, Output } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { AI_SEARCH_SYNC_STEP_CONFIG, syncCorpusItem } from '../ai-search';
import { DURABLE_WORKFLOW_RETRIES } from '../workflow-control';
import { stageStoredPdfResource, stageUrlAcquisition } from './acquisition';
import { stageResourceImages } from './hosted-images';
import { enqueueSubjectDraft, parseResourceProcessingWorkflowPayload, type ResourceProcessingWorkflowPayload } from './resource-admission';
import { enqueueResourceTranslation } from './resource-translation-workflow';

const WORKFLOW_ENQUEUE_STEP_CONFIG = {
	retries: DURABLE_WORKFLOW_RETRIES,
	timeout: '30 seconds',
} as const satisfies WorkflowStepConfig;

type ResourceClassification = {
	tags: string[];
	keywords: string[];
	entities: ResourceEntityInput[];
	category: ResourceCategory;
};

type ResolvedProcessingCall = {
	resource: ResolvedResource;
	persistenceTarget: PersistResolvedResourceTarget;
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
	category: z.enum(RESOURCE_CATEGORIES),
});

const RESOURCE_CLASSIFICATION_SYSTEM_PROMPT = `你是專業的新聞分類和實體分析師。請只輸出符合 schema 的分類資料。

任務：
- 產生 tags、keywords、category
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
- 如果只能判斷出泛詞、版本碎片或來源名稱，寧可少提取

分類只能是：AI, Tech, Finance, Research, Business, Other。`;

async function classifyResource(resource: ResolvedResource, env: CoreEnv, processingId: string): Promise<ResourceClassification> {
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
		category: classification.category,
		entities: classification.entities.slice(0, 10),
		tags: resource.tags.length ? resource.tags : [...new Set([...tags, classification.category])],
		keywords: resource.keywords.length ? resource.keywords : classification.keywords.slice(0, 8),
	};
}

function resolvedResourceMutation(
	resource: ResolvedResource,
	classification: ResourceClassification,
	hostedImages: readonly HostedResourceImage[],
): Omit<PersistResolvedResourceInput, 'target'> {
	const media = hostedResourceImageFields(
		{ creators: resource.creators, kindMetadata: resource.kindMetadata, ogImageUrl: resource.previewImageUrl },
		hostedImages,
	);
	return {
		identity: resource,
		identifiers: resource.resourceIdentifiers,
		creators: media.creators,
		kindMetadata: media.kindMetadata,
		youtube:
			resource.specialization?.kind === 'youtube'
				? { transcript: resource.specialization.transcript, highlights: resource.specialization.highlights }
				: null,
		originalLang: resource.originalLang,
		title: resource.title,
		summary: resource.summary,
		content: resource.content,
		keywords: classification.keywords,
		tags: classification.tags,
		category: classification.category,
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

async function resolveProcessingCall(
	env: CoreEnv,
	step: WorkflowStep,
	target: ResourceProcessingWorkflowPayload['target'],
	instanceId: string,
): Promise<ResolvedProcessingCall> {
	if (target.kind === 'draft') {
		const origin = {
			originalLang: target.sourceHints?.originalLang ?? DEFAULT_RESOURCE_LANG,
			summary: target.sourceHints?.summary ?? null,
			url: target.url,
			publishedDate: target.sourceHints?.publishedDate ?? null,
			tags: [],
			keywords: target.sourceHints?.keywords ?? [],
			normalizedUrl: target.url,
			resourceIdentifiers: [],
		};
		return {
			resource: await stageUrlAcquisition(env, step, {
				discoverRelatedContent: target.admission.kind !== 'source',
				isMonitoredOnly: target.admission.kind === 'source',
				origin,
				processingId: instanceId,
				...(target.providerSequence ? { providerSequence: target.providerSequence } : {}),
				sourceAvatarUrl: target.sourceHints?.sourceAvatarUrl ?? null,
				sourceUrl: target.url,
				translatePaperUrl: target.admission.kind !== 'source',
			}),
			persistenceTarget: {
				kind: 'draft',
				admission: target.admission,
				providerSequence: target.providerSequence ?? null,
			},
		};
	}

	if (target.kind === 'storedBlob') {
		const storedPdf = await step.do(
			'load-stored-pdf-input-v1',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => loadStoredPdfInput(await connectCoreDb(env), target.resourceId),
			{
				rollback: async () => markStoredBlobProcessingFailed(await connectCoreDb(env), target.resourceId),
				rollbackConfig: {
					retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
					timeout: '30 seconds',
				},
			},
		);
		return stageStoredPdfResource(env, step, storedPdf);
	}

	const snapshot = await step.do(
		'load-resource-reacquisition-input-v1',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		async () => loadResourceReacquisitionInput(await connectCoreDb(env), target.resourceId),
	);
	return {
		resource: await stageUrlAcquisition(env, step, {
			discoverRelatedContent: true,
			isMonitoredOnly: snapshot.isMonitoredOnly,
			origin: snapshot,
			processingId: target.resourceId,
			sourceAvatarUrl: snapshot.sourceAvatarUrl,
			sourceUrl: snapshot.url,
			translatePaperUrl: snapshot.translatePaperUrl,
		}),
		persistenceTarget: {
			kind: 'existing',
			resourceId: target.resourceId,
			storageKey: snapshot.storageKey,
		},
	};
}

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceProcessingWorkflowPayload> {
	async run(event: WorkflowEvent<ResourceProcessingWorkflowPayload>, step: WorkflowStep) {
		const { target } = parseResourceProcessingWorkflowPayload(event.payload);
		const processingId = target.kind === 'draft' ? event.instanceId : target.resourceId;
		const call = await resolveProcessingCall(this.env, step, target, event.instanceId);
		const resource = call.resource;

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
			step.do('classify-resource', { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' }, () =>
				classifyResource(resource, this.env, processingId),
			),
			stageResourceImages(this.env, step, processingId, imageSources),
		]);
		const persistence = await step.do<PersistResolvedResourceResult>(
			'persist-resolved-resource-v1',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() =>
				this.env.DOMAIN.persistResolvedResource({
					...resolvedResourceMutation(resource, classification, hostedImages),
					target: call.persistenceTarget,
				}),
		);
		if (!persistence.persisted) {
			return { resourceId: persistence.resourceId };
		}
		const persistedResourceId = persistence.resourceId;
		const translationRevision = persistence.translationRevision;
		const followUps: Promise<unknown>[] = [
			step.do('sync-resolved-ai-search-v1', AI_SEARCH_SYNC_STEP_CONFIG, async () => {
				const db = await connectCoreDb(this.env);
				await Promise.all(
					[persistedResourceId, ...persistence.retiredResourceIds].map((resourceId) => syncCorpusItem(this.env, db, resourceId)),
				);
			}),
		];
		if (translationRevision) {
			followUps.push(
				step.do('enqueue-resource-translation-v2', WORKFLOW_ENQUEUE_STEP_CONFIG, () =>
					enqueueResourceTranslation(this.env, persistedResourceId, translationRevision),
				),
			);
		}
		const subject = resource.subject;
		if (subject && !persistence.subjectAttached) {
			followUps.push(
				step.do('enqueue-resolved-subject-child-v1', WORKFLOW_ENQUEUE_STEP_CONFIG, () =>
					enqueueSubjectDraft(this.env, {
						parentResourceId: persistedResourceId,
						url: subject.normalizedUrl,
					}),
				),
			);
		}
		await Promise.all(followUps);

		console.info({ tag: 'WORKFLOW', msg: 'Completed', resource_id: persistedResourceId, target_kind: target.kind });
		return { resourceId: persistedResourceId };
	}
}
