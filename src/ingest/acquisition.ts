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
import { paperAbstractDocument, paperResource, stagePaperFullText, stagePaperMetadata } from './platforms/paper';
import { stageStoredPdfAcquisition } from './platforms/pdf';
import { PDF_MIME, type PaidPdfFallbackGrant } from './platforms/pdf-policy';
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
	/** The title a PDF prints on its title page; metadata found through the PDF must name the same work. */
	printedTitle?: string | null;
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

/** Full text, else the abstract, else the linked page carries a paper's body. */
async function stageLinkedPaper(
	env: CoreEnv,
	step: WorkflowStep,
	input: { paidPdfFallback: PaidPdfFallbackGrant | null; processingId: string; url: string; identifiers: ResourceIdentifier[] },
) {
	const work = await stagePaperMetadata(env, step, { identifiers: input.identifiers, processingId: input.processingId });
	const fullText = await stagePaperFullText(env, step, { work, identifiers: input.identifiers, processingId: input.processingId });
	if (fullText) return paperResource({ ...fullText, url: input.url, source: new URL(input.url).hostname }, work, input.identifiers);
	const abstract = work ? paperAbstractDocument(work) : null;
	if (abstract) return paperResource({ ...abstract, url: input.url, source: new URL(input.url).hostname }, work);
	const page = await stageWebAcquisition(env, step, input);
	return 'platform' in page ? page : paperResource(page, work, input.identifiers);
}

/** A fetched page or PDF names a paper only through its link or a verified title page. */
async function stageDiscoveredPaper(
	env: CoreEnv,
	step: WorkflowStep,
	document: AcquiredResource & { resourcePlatform: null },
	processingId: string,
) {
	if (!document.resourceIdentifiers.length) return document;
	const linkIdentifiers = resolveResourceUrl(document.url)?.identifiers ?? [];
	const work = await stagePaperMetadata(env, step, {
		identifiers: document.resourceIdentifiers,
		...(linkIdentifiers.length ? {} : { printedTitle: document.printedTitle ?? null }),
		processingId,
	});
	if (!work) return linkIdentifiers.length ? paperResource(document, null, linkIdentifiers) : { ...document, resourceIdentifiers: [] };
	// A linked PDF is already the full text; an article page yields to it.
	const fullText = document.fileType === PDF_MIME ? null : await stagePaperFullText(env, step, { work, processingId });
	return paperResource(fullText ? { ...fullText, url: document.url, source: document.source } : document, work);
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
		const acquired = identifiers.length
			? await stageLinkedPaper(env, step, { ...input, identifiers })
			: await stageWebAcquisition(env, step, input);
		if (!('platform' in acquired)) return identifiers.length ? acquired : stageDiscoveredPaper(env, step, acquired, input.processingId);
		detected = acquired.platform;
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
		const upload = await stageStoredPdfUpload(env, step, target, processingId);
		return {
			...finishAcquisition(upload.paper ?? upload.file, source),
			upload: upload.paper ? finishAcquisition(upload.file, source) : null,
		};
	}
	return {
		...finishAcquisition(
			await stageUrlAcquisition(env, step, { ...urlInput!, paidPdfFallback: target.paidPdfFallback ?? null, processingId }),
			source,
		),
		upload: null,
	};
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
	const uploaded = await stageStoredPdfAcquisition(env, step, target, processingId);
	const file = { ...uploaded, resourceIdentifiers: [] };
	const work = await stagePaperMetadata(env, step, {
		identifiers: uploaded.resourceIdentifiers,
		printedTitle: uploaded.printedTitle ?? null,
		processingId,
	});
	if (!work) return { file, paper: null };
	const abstract = paperAbstractDocument(work);
	const fullText = await stagePaperFullText(env, step, { work, processingId });
	// The public paper lives at its canonical identifier URL, not at the licensed PDF it was read from.
	const document = fullText ? { ...fullText, url: null, source: abstract?.source ?? fullText.source } : abstract;
	return { file, paper: document ? paperResource(document, work) : null };
}

function finishAcquisition(acquired: AcquiredResource, source: Extract<ResourceProcessingTarget, { kind: 'draft' }>['sourceHints']) {
	const { printedTitle: _printedTitle, ...resource } = acquired;
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
