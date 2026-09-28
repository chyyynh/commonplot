import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toString } from 'mdast-util-to-string';
import { gfm } from 'micromark-extension-gfm';
import type { AcquiredResource, AcquisitionInput, SourceHints } from '../contracts/acquired-resource';
import type { PaidPdfFallbackGrant } from '../contracts/pdf-policy';
import type { ResourceIdentifier } from '../contracts/resource';
import { detectResourceLanguage, ResourceLanguageSchema } from '../contracts/resource-language';
import { resolveResourceUrl } from '../contracts/resource-url';
import { stageHackerNewsAcquisition } from './hackernews';
import { stageLessWrongAcquisition } from './lesswrong';
import { stagePaper } from './paper';
import { stageStoredPdfAcquisition } from './pdf';
import { stageTwitterAcquisition } from './twitter';
import { stageWebAcquisition } from './web';
import { stageYouTubeAcquisition } from './youtube';

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

export async function stageResourceAcquisition(env: CoreEnv, step: WorkflowStep, input: AcquisitionInput, processingId: string) {
	if (input.kind === 'storedPdf') {
		const { file, paper } = await stageStoredPdfUpload(env, step, input, processingId);
		return paper
			? { resource: finishAcquisition(paper), privateFile: finishAcquisition(file) }
			: { resource: finishAcquisition(file), privateFile: null };
	}
	const resource = await stageUrlAcquisition(env, step, { ...input, processingId });
	return { resource: finishAcquisition(resource, input.sourceHints), privateFile: null };
}

/**
 * An uploaded PDF always stays its uploader's private file. When its title page names a
 * paper, the public paper is built from licensed full text or the abstract, never the upload.
 */
async function stageStoredPdfUpload(
	env: CoreEnv,
	step: WorkflowStep,
	input: Extract<AcquisitionInput, { kind: 'storedPdf' }>,
	processingId: string,
) {
	const { titlePageText, resourceIdentifiers, ...uploaded } = await stageStoredPdfAcquisition(env, step, input, processingId);
	const paper = await stagePaper(env, step, { identifiers: resourceIdentifiers, titlePageText, url: null, processingId });
	// A file that is a paper carries the paper's title and authors instead of its file name.
	const file = {
		...uploaded,
		resourceIdentifiers: [],
		title: paper?.title ?? uploaded.title,
		creators: paper?.creators.length ? paper.creators : uploaded.creators,
	};
	return { file, paper };
}

function finishAcquisition(resource: AcquiredResource, source?: SourceHints) {
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
