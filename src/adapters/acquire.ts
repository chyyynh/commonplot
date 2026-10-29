import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { AcquiredResource, AcquisitionInput, PlatformResource, ReadDocument } from '../contracts/acquired-resource';
import { normalizeAcquiredResource } from '../contracts/normalize-resource';
import { paperIdentifiersFromIdentity } from '../contracts/paper-identity';
import type { ResourceIdentifier } from '../contracts/resource';
import type { ResourcePlatform } from '../contracts/resource-kinds';
import { DETECTED_LANGUAGES } from '../contracts/resource-language';
import { RESOURCE_PLATFORMS, resolveResourceUrl } from '../contracts/resource-url';
import { PDF_MIME } from '../contracts/storage-keys';
import type { WorkCandidate } from '../services/crossref';
import { askJev } from '../services/entities';
import { errorMessage } from '../services/response';
import { stepJson } from '../services/workflow-step';
import { stagePdfDocument } from '../services/zotero-sdt-service.ts';
import { stageHackerNewsAcquisition } from './hackernews';
import { stageLessWrongAcquisition } from './lesswrong';
import { stagePaper, stageWorkCandidates } from './paper';
import { stageTwitterAcquisition } from './twitter';
import { stageWebAcquisition } from './web';
import { stageYouTubeAcquisition } from './youtube';

const MAX_REDIRECTS = 3;
const JEV_TEXT_CHARS = 3_000;
const IDENTIFY_STEP = { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '60 seconds' } as const;
/** Jev calls a document a paper from this probability; on 41 PDFs no non-paper scored above 0.62. */
const PAPER_CONFIDENCE = 0.7;
/** An error or bot-check page fails its acquisition only when Jev is this sure; a wrong guess would fail a real page. */
const ERROR_PAGE_CONFIDENCE = 0.8;
/** Jev picks a candidate work from this probability; on 41 PDFs every pick it made was right. */
const WORK_CONFIDENCE = 0.8;

/** How each platform's Resource is fetched, from the id `resolveResourceUrl` read. */
const PLATFORM_ACQUISITION: Record<
	ResourcePlatform,
	(env: CoreEnv, step: WorkflowStep, id: string) => Promise<PlatformResource | { redirect: string }>
> = {
	hackernews: (_env, step, id) => stageHackerNewsAcquisition(step, id),
	lesswrong: (_env, step, id) => stageLessWrongAcquisition(step, id),
	twitter: stageTwitterAcquisition,
	youtube: stageYouTubeAcquisition,
};

/** What a page or PDF reads as, as Jev is asked (the wording the thresholds were measured with); each maps to a kind or fails. */
const DOCUMENT_KINDS = {
	article: 'A news story, blog post, essay or opinion piece',
	thread: 'A discussion thread: a forum post, comments or replies',
	paper: 'A scholarly research paper: a journal or conference article, preprint or working paper',
	book: 'A book, a report (such as a survey, technical or policy report or white paper), or a slide deck',
	page: 'Another web page: a code repository, documentation, encyclopedia entry, AI model card, product page or listing',
	error: 'An error page: not found, server error or an empty page',
	blocked: 'A blocked page: a login wall, paywall, captcha or bot check instead of the content',
} as const;

type Identification = { kind: AcquiredResource['kind']; work: WorkCandidate | null };

/**
 * One Jev call answers what a document is and, when the PDF names works it may be, which one. A PDF that is not a paper
 * is a file; a web page an article unless it reads as a thread, another kind of page or a paper. Jev failing reads as no answer.
 */
async function stageIdentify(
	env: CoreEnv,
	step: WorkflowStep,
	document: ReadDocument,
	candidates: readonly WorkCandidate[],
	processingId: string,
): Promise<Identification> {
	const pdf = document.fileType === PDF_MIME;
	const fallback: Identification = { kind: pdf ? 'file' : 'blog', work: null };
	const answers = await stepJson(step, 'identify-document-v1', IDENTIFY_STEP, async () => {
		const questions = {
			kind: { type: 'choice' as const, instructions: 'What kind of document is this?', criteria: DOCUMENT_KINDS },
			...(candidates.length
				? {
						work: {
							type: 'choice' as const,
							instructions: 'Which of these published works is this document itself (not a work it cites)?',
							criteria: {
								...Object.fromEntries(
									candidates.map(({ title, authors, year, venue }, index) => [
										`w${index}`,
										[title, authors.slice(0, 3).join(', '), year, venue].filter(Boolean).join(' · '),
									]),
								),
								none: 'None of these; this document is not any of these works',
							},
						},
					}
				: {}),
		};
		const source = document.url ? `URL: ${document.url}` : 'Uploaded file';
		const state = `Title: ${document.title ?? ''}\n${source}\n\n${document.content.slice(0, JEV_TEXT_CHARS)}`;
		const { answers } = await askJev(env, { feature: 'resource-identification', processing_id: processingId }, state, questions);
		const probabilities = (id: string) => {
			const answer = answers[id];
			return answer && 'probabilities' in answer ? answer.probabilities : {};
		};
		return { kind: probabilities('kind'), work: probabilities('work') };
	}).catch((error: unknown) => {
		console.error({ tag: 'IDENTIFY', event: 'identify_failed', processing_id: processingId, error: errorMessage(error) });
		return null;
	});
	if (!answers) return fallback;
	const [picked, workConfidence = 0] = Object.entries(answers.work).sort((a, b) => b[1] - a[1])[0] ?? [];
	const work = picked && picked !== 'none' && workConfidence >= WORK_CONFIDENCE ? (candidates[Number(picked.slice(1))] ?? null) : null;
	const [answer = 'article', confidence = 0] = Object.entries(answers.kind).sort((a, b) => b[1] - a[1])[0] ?? [];
	console.info({
		tag: 'IDENTIFY',
		event: 'document_identified',
		processing_id: processingId,
		url: document.url,
		kind: answers.kind,
		work: answers.work,
		candidates: candidates.map(({ doi }) => doi),
		picked: work?.doi ?? null,
	});
	// An upload is its owner's file whatever it reads as.
	if ((answer === 'error' || answer === 'blocked') && confidence >= ERROR_PAGE_CONFIDENCE && document.url !== null) {
		throw new NonRetryableError(
			`${answer === 'error' ? 'gone' : 'blocked'}: the page reads as ${answer === 'error' ? 'an error' : 'a blocked'} page (${confidence.toFixed(2)})`,
		);
	}
	if (work || (answers.kind.paper ?? 0) >= PAPER_CONFIDENCE) return { kind: 'paper', work };
	if (pdf) return fallback;
	return { kind: answer === 'thread' ? 'forum' : answer === 'page' ? 'page' : 'blog', work: null };
}

/**
 * A page or PDF is identified as a work when it prints one Jev confirms, and then reads as that paper. Otherwise its
 * kind is what Jev reads it as and its identity is its URL, or for an upload its bytes, which stays its owner's file.
 */
async function stageDocument(env: CoreEnv, step: WorkflowStep, document: ReadDocument, processingId: string): Promise<AcquiredResource> {
	const { printed, ...read } = document;
	const candidates = printed ? await stageWorkCandidates(step, printed, processingId) : [];
	const { kind, work } = await stageIdentify(env, step, document, candidates, processingId);
	if (work) {
		const identifiers = paperIdentifiersFromIdentity({ doi: work.doi });
		const paper = await stagePaper(env, step, { identifiers, pdf: read, candidate: work, processingId });
		if (paper) return paper;
	}
	const resourceKind = read.url === null ? 'file' : kind;
	// A thread's or an unidentified paper's metadata is empty; an article's and a file's is null.
	const kindMetadata = resourceKind === 'forum' || resourceKind === 'paper' ? {} : null;
	return { ...read, kind: resourceKind, kindMetadata, resourcePlatform: null, resourceIdentifiers: [] };
}

async function stageUrlAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: { processingId: string; url: string; identifiers?: ResourceIdentifier[]; redirects?: number },
): Promise<AcquiredResource> {
	const detected = resolveResourceUrl(input.url);
	if (!detected) throw new NonRetryableError('Resource URL must be HTTP(S) without credentials');
	const redirect = (url: string) => {
		const redirects = (input.redirects ?? 0) + 1;
		if (redirects > MAX_REDIRECTS) throw new NonRetryableError(`Resource ${input.url} redirects more than ${MAX_REDIRECTS} times`);
		return stageUrlAcquisition(env, step, { processingId: input.processingId, url, redirects });
	};
	const { resourcePlatform: platform, identifiers } = detected;
	if (platform) {
		const id = identifiers[0]!.value;
		const acquired = await PLATFORM_ACQUISITION[platform](env, step, id);
		// A Hacker News link submission is the page it links to; its thread becomes a key of that Resource.
		if ('redirect' in acquired) return { ...(await redirect(acquired.redirect)), hackerNewsId: id };
		return { ...acquired, resourcePlatform: platform, resourceIdentifiers: identifiers, url: RESOURCE_PLATFORMS[platform].url(id) };
	}
	const paperIdentifiers = [...(input.identifiers ?? []), ...identifiers];
	if (paperIdentifiers.length) {
		const paper = await stagePaper(env, step, { identifiers: paperIdentifiers, processingId: input.processingId });
		if (!paper) throw new NonRetryableError(`Paper ${input.url} has no readable full text or abstract`);
		return paper;
	}
	const page = await stageWebAcquisition(env, step, detected.url);
	if ('redirect' in page) return redirect(page.redirect);
	return stageDocument(env, step, page, input.processingId);
}

/**
 * The language an original is written in, as Jev reads its title and text: a detected language, `und` for any other
 * one or when Jev fails, `zxx` for no prose. Its top answer is taken however sure: on 400 stored originals it was right
 * wherever it disagreed with the stored language, and its unsure answers split a language with no prose. What a source
 * declares is not asked: X tags Chinese posts `ja`, and pages often keep a template's `en`.
 */
async function stageLanguage(env: CoreEnv, step: WorkflowStep, resource: AcquiredResource, processingId: string): Promise<string> {
	const text = `${resource.title ?? ''}\n\n${resource.content}`.trim();
	if (!/\p{L}/u.test(text)) return 'zxx';
	const answer = await stepJson(step, 'identify-language-v1', IDENTIFY_STEP, async () => {
		const { answers } = await askJev(env, { feature: 'resource-language', processing_id: processingId }, text.slice(0, JEV_TEXT_CHARS), {
			language: {
				type: 'choice',
				instructions: 'What language is the document mainly written in (its prose, not names, code or quoted terms)?',
				criteria: { ...DETECTED_LANGUAGES, other: 'Another language', none: 'No prose: code, data, numbers or an empty page' },
			},
		});
		const language = answers.language;
		return language && 'probabilities' in language ? language.probabilities : {};
	}).catch((error: unknown) => {
		console.error({ tag: 'IDENTIFY', event: 'language_failed', processing_id: processingId, error: errorMessage(error) });
		return {};
	});
	const [picked = 'other'] = Object.entries(answer).sort((a, b) => b[1] - a[1])[0] ?? [];
	return picked === 'other' ? 'und' : picked === 'none' ? 'zxx' : picked;
}

async function stageAcquired(env: CoreEnv, step: WorkflowStep, input: AcquisitionInput, processingId: string) {
	if (input.kind === 'url') return stageUrlAcquisition(env, step, { ...input, processingId });
	const { contentHash, fileName } = input.pdf;
	const document = await stagePdfDocument(env, step, {
		url: null,
		fileName,
		inputContentHash: contentHash,
		sourceLabel: `Stored PDF ${input.objectId}`,
	});
	return stageDocument(env, step, document, processingId);
}

export async function stageResourceAcquisition(env: CoreEnv, step: WorkflowStep, input: AcquisitionInput, processingId: string) {
	const resource = await stageAcquired(env, step, input, processingId);
	const originalLang = await stageLanguage(env, step, resource, processingId);
	return normalizeAcquiredResource(resource, originalLang, input.kind === 'url' ? input.sourceHints : undefined);
}
