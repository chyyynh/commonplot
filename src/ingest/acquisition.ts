import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { sql } from 'drizzle-orm';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toString } from 'mdast-util-to-string';
import { gfm } from 'micromark-extension-gfm';
import { connectCoreDb } from '../shared/db';
import {
	ResourceIdentifiersSchema,
	type ResourceCreator,
	type ResourceIdentifier,
	type ResourceKind,
	type ResourceKindMetadata,
	type ResourcePlatform,
} from '../shared/resource';
import type { ResourceProcessingTarget } from './admission';
import { stageHackerNewsAcquisition } from './platforms/hackernews';
import { stageLessWrongAcquisition } from './platforms/lesswrong';
import { stagePaper } from './platforms/paper';
import { stageStoredPdfAcquisition } from './platforms/pdf';
import type { PaidPdfFallbackGrant } from './platforms/pdf-policy';
import { resolveResourceUrl, ResourceUrlSchema } from './platforms/resource-url';
import { stageTwitterAcquisition } from './platforms/twitter-acquisition';
import { stageWebAcquisition } from './platforms/web';
import { stageYouTubeAcquisition } from './platforms/youtube';
import type { ReferenceCitation } from './reference-citation';
import { ResourceLanguageSchema, detectResourceLanguage } from './resource-language';

// Adapters share an output contract; each adapter owns its mapping and identity.
export type AcquiredResource = {
	references?: readonly ({
		key: string;
		label: string | null;
		text: string;
		doi: string | null;
		arxivId: string | null;
	} & ReferenceCitation)[];
	kind: Exclude<ResourceKind, 'image'>;
	resourcePlatform: ResourcePlatform | null;
	resourceIdentifiers: ResourceIdentifier[];
	url: string | null;
	/** Null only for posts, which are an author and text. */
	title: string | null;
	summary: string | null;
	content: string;
	source: string;
	originalLang: string;
	publishedDate: string | null;
	creators: ResourceCreator[];
	kindMetadata: ResourceKindMetadata;
	fileType: string | null;
	previewImageUrl: string | null;
	subjectUrl: string | null;
};

/** Remove a duplicate heading only after Core has resolved the resource title. */
function withoutDuplicateResourceTitle(markdown: string, title: string): string {
	const first = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: gfmFromMarkdown() }).children[0];
	const comparable = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
	if (first?.type !== 'heading' || comparable(toString(first, { includeImageAlt: false })) !== comparable(title)) return markdown;
	const end = first.position?.end.offset;
	if (end === undefined) return markdown;
	const body = markdown.slice(end).trimStart();
	return body || markdown;
}

/** A linked paper with neither full text nor an abstract is not acquired. */
async function stageLinkedPaper(
	env: CoreEnv,
	step: WorkflowStep,
	input: { processingId: string; url: string; identifiers: ResourceIdentifier[] },
) {
	const paper = await stagePaper(env, step, input);
	if (!paper) throw new NonRetryableError(`Paper ${input.url} has no readable full text or abstract`);
	return paper;
}

async function stageUrlAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		paidPdfFallback: PaidPdfFallbackGrant | null;
		processingId: string;
		url: string;
		identifiers?: ResourceIdentifier[];
	},
) {
	let detected = resolveResourceUrl(input.url);
	if (!detected) throw new NonRetryableError('Resource URL must be HTTP(S) without credentials');
	if (!detected.resourcePlatform) {
		const identifiers = [...(input.identifiers ?? []), ...detected.identifiers];
		if (identifiers.length) return stageLinkedPaper(env, step, { ...input, identifiers });
		const acquired = await stageWebAcquisition(env, step, input);
		if (!('platform' in acquired)) return acquired;
		detected = acquired.platform;
		if (!detected.resourcePlatform)
			return stageLinkedPaper(env, step, { processingId: input.processingId, url: detected.url, identifiers: detected.identifiers });
	}

	const platformId = detected.identifiers[0]!.value;
	switch (detected.resourcePlatform) {
		case 'hackernews':
			return stageHackerNewsAcquisition(env, step, {
				itemId: platformId,
				processingId: input.processingId,
			});
		case 'lesswrong':
			return stageLessWrongAcquisition(step, platformId);
		case 'twitter':
			return stageTwitterAcquisition(env, step, {
				processingId: input.processingId,
				tweetId: platformId,
			});
		case 'youtube':
			return stageYouTubeAcquisition(env, step, platformId);
		default:
			throw new NonRetryableError('Redirected resource has no supported platform');
	}
}

export async function stageResourceAcquisition(env: CoreEnv, step: WorkflowStep, target: ResourceProcessingTarget, processingId: string) {
	const urlInput =
		target.kind === 'reacquire'
			? await step.do(
					'load-resource-reacquisition-source-v3',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					async () => {
						const db = await connectCoreDb(env);
						const { rows } = await db.execute<{ url: string | null; identifiers: unknown }>(sql`
							SELECT resource.url, COALESCE((
								SELECT jsonb_agg(jsonb_build_object('scheme', scheme, 'value', value, 'preferred', is_preferred)
									ORDER BY scheme, is_preferred DESC, value)
								FROM resource_identifiers WHERE resource_id = resource.id
							), '[]'::jsonb) AS identifiers
							FROM resources resource WHERE resource.id = ${target.resourceId}::uuid
						`);
						if (!rows[0]) throw new NonRetryableError(`Failed to fetch resource ${target.resourceId}: not found`);
						const url = ResourceUrlSchema.safeParse(rows[0].url).data;
						if (!url) throw new NonRetryableError(`Resource ${target.resourceId} has no valid external HTTP URL and cannot be reacquired`);
						return { url, identifiers: ResourceIdentifiersSchema.parse(rows[0].identifiers) };
					},
				)
			: target.kind === 'draft'
				? { url: target.url }
				: null;
	const source = target.kind === 'draft' ? target.sourceHints : undefined;
	if (target.kind === 'storedBlob') {
		const { file, paper } = await stageStoredPdfUpload(env, step, target, processingId);
		return paper
			? { resource: finishAcquisition(paper, source), privateFile: finishAcquisition(file, source) }
			: { resource: finishAcquisition(file, source), privateFile: null };
	}
	const resource = await stageUrlAcquisition(env, step, { ...urlInput!, paidPdfFallback: target.paidPdfFallback ?? null, processingId });
	return { resource: finishAcquisition(resource, source), privateFile: null };
}

/**
 * An uploaded PDF always stays its uploader's private file. When its title page names a
 * paper, the public paper is built from licensed full text or the abstract, never the upload.
 */
async function stageStoredPdfUpload(
	env: CoreEnv,
	step: WorkflowStep,
	target: Readonly<{ paidPdfFallback?: PaidPdfFallbackGrant; resourceId: string }>,
	processingId: string,
) {
	const { printedTitle, resourceIdentifiers, ...uploaded } = await stageStoredPdfAcquisition(env, step, target, processingId);
	const file = { ...uploaded, resourceIdentifiers: [] };
	const paper = await stagePaper(env, step, { identifiers: resourceIdentifiers, printedTitle, url: null, processingId });
	return { file, paper };
}

function finishAcquisition(resource: AcquiredResource, source: Extract<ResourceProcessingTarget, { kind: 'draft' }>['sourceHints']) {
	const language = ResourceLanguageSchema.safeParse(resource.originalLang).data;
	const parsedDate = Date.parse(resource.publishedDate ?? '');
	const publishedDate = Number.isNaN(parsedDate) ? (source?.publishedDate ?? null) : new Date(parsedDate).toISOString();
	const content = resource.title ? withoutDuplicateResourceTitle(resource.content, resource.title) : resource.content;
	return {
		...resource,
		content,
		originalLang: detectResourceLanguage(content, language && language !== 'und' ? language : (source?.originalLang ?? 'und')),
		publishedDate,
		summary: resource.summary?.trim() || source?.summary?.trim() || null,
	};
}
