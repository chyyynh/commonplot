// Derivations of a written original — its card in each summary language, its entities and its content translations.
// Each is recorded in resource_derivations, so a failure leaves the Resource published and a later sweep runs it again.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { LANGUAGES, SCRIPT_NAMES, type SummaryLang } from '../contracts/languages';
import { RESOURCE_KINDS } from '../contracts/resource-kinds';
import { foreignWords, isTitleIn, isWrittenIn, isWrittenInOriginal } from '../contracts/resource-language';
import { coreExports, createInstances } from '../exports.ts';
import { AI_STEP, generateObject } from '../services/ai-model';
import { extractResourceEntities } from '../services/entities';
import { namedErrorMessage } from '../services/response';
import { STORAGE_STEP } from '../services/workflow-step';
import { withCoreDb } from '../store/db';
import {
	claimDueDerivations,
	completeEntities,
	completeSummary,
	type Derivation,
	type DerivationSource,
	type SummaryCard,
	failDerivation,
	loadDerivationSource,
} from '../store/derivations';
import { resumeTranslation } from './translation';

/** What this Workflow derives itself; translations run in their own. */
type DirectDerivation = Exclude<Derivation, { kind: 'translation' }>;

/** Runs one derivation for the text `inputHash` names; true when it wrote something. A failure is recorded, not thrown. */
export async function deriveResource(
	env: CoreEnv,
	step: WorkflowStep,
	resourceId: string,
	inputHash: string,
	source: DerivationSource,
	derivation: DirectDerivation,
	processingId: string,
): Promise<boolean> {
	const { kind, lang } = derivation;
	try {
		if (kind === 'summary') {
			const card = await step.do(`derive-summary-${lang}-v3`, AI_STEP, () => localizeResource(source, lang, env, processingId));
			return await step.do(`persist-derived-summary-${lang}-v3`, STORAGE_STEP, () =>
				withCoreDb(env, (db) => completeSummary(db, resourceId, inputHash, lang, card)),
			);
		}
		const entities = await step.do('derive-entities-v1', AI_STEP, () => extractResourceEntities(source, env, processingId));
		return await step.do('persist-derived-entities-v1', STORAGE_STEP, () =>
			withCoreDb(env, (db) => completeEntities(db, resourceId, inputHash, entities)),
		);
	} catch (error) {
		const message = namedErrorMessage(error);
		console.error({
			tag: 'DERIVATION',
			msg: 'Derivation failed',
			kind,
			lang,
			resource_id: resourceId,
			processing_id: processingId,
			error: message,
		});
		await step.do(`record-failed-${kind}${lang && `-${lang}`}-v1`, STORAGE_STEP, () =>
			withCoreDb(env, (db) => failDerivation(db, resourceId, derivation, inputHash, message)),
		);
		return false;
	}
}

type ResourceDerivationPayload = DirectDerivation & { resourceId: string; inputHash: string };

/** A derivation the sweep took over: the attempt that wrote its original failed it or never settled it. */
export class ResourceDerivationWorkflow extends WorkflowEntrypoint<CoreEnv, ResourceDerivationPayload> {
	async run(event: WorkflowEvent<ResourceDerivationPayload>, step: WorkflowStep) {
		const { resourceId, inputHash, ...derivation } = event.payload;
		// A failed load counts as an attempt too: the next attempt has a new instance id, and this one would never rerun.
		const source = await step
			.do('load-derivation-source-v2', STORAGE_STEP, () => withCoreDb(this.env, (db) => loadDerivationSource(db, resourceId, inputHash)))
			.catch(async (error: unknown) => {
				const message = namedErrorMessage(error);
				await step.do('record-failed-load-v1', STORAGE_STEP, () =>
					withCoreDb(this.env, (db) => failDerivation(db, resourceId, derivation, inputHash, message)),
				);
				return undefined;
			});
		if (source === undefined) return { status: 'unchanged' as const };
		if (!source) return { status: 'superseded' as const };
		if (!(await deriveResource(this.env, step, resourceId, inputHash, source, derivation, event.instanceId)))
			return { status: 'unchanged' as const };
		// Search documents lead with the summary.
		if (derivation.kind === 'summary') {
			await step.do('enqueue-summary-search-sync-v1', STORAGE_STEP, async () => {
				await this.env.RESOURCE_SEARCH_SYNC_QUEUE.send({ resourceId });
			});
		}
		return { status: 'written' as const };
	}
}

// Sized to regenerate every titled Resource's summaries within a day of a summary prompt change.
const DERIVATION_SWEEP_BATCH = 300;

/**
 * Starts each derivation whose attempt failed or never settled; its lease keeps the next sweep from starting it again.
 * The instance id names the text and the attempt, so a sweep that takes over a still-running attempt finds that instance
 * instead of starting a second one.
 */
export async function enqueueDueDerivations(db: NodePgDatabase): Promise<void> {
	const due = await claimDueDerivations(db, DERIVATION_SWEEP_BATCH);
	if (!due.length) return;
	const translations = due.flatMap((derivation) => (derivation.kind === 'translation' ? [derivation] : []));
	const resumed = await Promise.allSettled(
		translations.map(({ resourceId, inputHash, lang }) => resumeTranslation(db, resourceId, inputHash, lang)),
	);
	const instances = due
		.filter(({ kind }) => kind !== 'translation')
		.map(({ resourceId, kind, lang, inputHash, attempts }) => ({
			id: `rd-v2-${kind}${lang ? `-${lang}` : ''}-${resourceId}-${inputHash.slice(0, 16)}-${attempts}`,
			params: { resourceId, inputHash, ...({ kind, lang } as DirectDerivation) },
		}));
	await createInstances(coreExports.ResourceDerivationWorkflow, instances);
	console.info({
		tag: 'DERIVATION',
		msg: 'Due derivation sweep',
		started: instances.length,
		translations: translations.length,
		failed: resumed.filter(({ status }) => status === 'rejected').length,
	});
}

// The summary

const ANALYSIS_CONTENT_MAX_LENGTH = 10_000;
const ANALYSIS_MODEL = 'google/gemini-3.5-flash-lite';
const DESCRIPTION_MAX_LENGTH = 1_500;

function analysisPrompt(resource: DerivationSource) {
	const description = resource.description?.trim().substring(0, DESCRIPTION_MAX_LENGTH);
	return `${resource.title ? `Title: ${resource.title}\n` : ''}Source: ${resource.source.trim()}
Kind: ${resource.kind}
Platform: ${resource.resourcePlatform ?? 'none'}
${description ? `Source's own description (may be boilerplate or link lists; use only what the content supports): ${description}\n` : ''}Content:
${resource.content.trim().substring(0, ANALYSIS_CONTENT_MAX_LENGTH)}`;
}

const CardSchema = z.object({ summary: z.string().trim().min(1) });
const TitledCardSchema = CardSchema.extend({ title: z.string().trim().min(1) });

/** The scripts a card in `lang` may use, as a prompt names them: the language's own, and Latin, which spells names anywhere. */
function writtenScripts(lang: SummaryLang) {
	const scripts = [...new Set([...LANGUAGES[lang].scripts, 'Latin' as const])].map((script) => SCRIPT_NAMES[script]);
	return new Intl.ListFormat('en', { type: 'conjunction' }).format(scripts);
}

/**
 * A Resource's card in `lang`: its summary, written directly in `lang`, and its title translated with the content in
 * view, so the two name things alike. A title already in `lang` stays the original's. A card with words left in a
 * script foreign to `lang` is corrected once; output still not in `lang` is rejected so the step retries.
 */
async function localizeResource(resource: DerivationSource, lang: SummaryLang, env: CoreEnv, processingId: string) {
	const startedAt = performance.now();
	const { name, style } = LANGUAGES[lang];
	const scripts = writtenScripts(lang);
	const titled =
		RESOURCE_KINDS[resource.kind].titled && Boolean(resource.title?.trim()) && !isWrittenInOriginal(resource.originalLang, lang);
	const schema: z.ZodType<SummaryCard> = titled ? TitledCardSchema : CardSchema;
	const metadata = { feature: 'resource-summary', processing_id: processingId, target_lang: lang };
	const generated = await generateObject(env, ANALYSIS_MODEL, metadata, {
		// The language comes last too: a model summarizing a Japanese original otherwise drifts into Japanese.
		prompt: `${analysisPrompt(resource)}\n\n${titled ? 'Translate the title and write the summary' : 'Write the summary'} in ${name}. Every word is in ${scripts}.`,
		system: `${titled ? `Translate the title into ${name} and write` : 'Write'} a 1–2 sentence summary in ${name}, whatever the original language.
Write only in ${scripts}. A name or term from another language takes its established ${name} form; with none, it takes its usual English or romanized form in Latin letters. Never leave a word in the original's script.${style ? `\n${style}` : ''}
${titled ? 'The title is a faithful translation of the original title: keep its meaning, claims and tone, neither shortening nor adding to it, and use the content only to choose the right sense of a word and the established form of a name.\n' : ''}Preserve attribution, tone, limitations and uncertainty; add nothing the content does not say.
A discussion thread's summary describes the discussion; a short post's summary is proportionate to it.
Plain text only: no Markdown, LaTeX or other markup.`,
		output: { name: 'resource_summary', schema },
		maxTokens: 1000,
		temperature: 0.3,
	});
	let card = generated.output;
	let outputTokens = generated.outputTokens;
	const foreign = foreignWords(`${card.title ?? ''}\n${card.summary}`, lang);
	if (foreign.length > 0) {
		// The model mostly leaves a name or term in the original's script; pointed at those words, it rewrites them.
		const corrected = await generateObject(
			env,
			ANALYSIS_MODEL,
			{ ...metadata, feature: 'resource-summary-correction' },
			{
				prompt: `${JSON.stringify(card)}\n\nNot in ${scripts}: ${foreign.join(', ')}`,
				system: `You correct a ${name} title and summary. Rewrite only the words listed, each in its established ${name} form or, with none, its usual English or romanized form in Latin letters; keep everything else exactly. Every word ends up in ${scripts}.`,
				output: { name: 'resource_summary', schema },
				maxTokens: 1000,
				temperature: 0,
			},
		);
		card = corrected.output;
		outputTokens = (outputTokens ?? 0) + (corrected.outputTokens ?? 0);
	}
	if (!isWrittenIn(card.summary, lang)) throw new Error(`Summary is not written in ${lang}: ${card.summary.slice(0, 200)}`);
	if (card.title !== undefined && !isTitleIn(card.title, lang))
		throw new Error(`Title is not written in ${lang}: ${card.title.slice(0, 200)}`);
	console.info({
		tag: 'AI',
		event: 'summary_completed',
		processing_id: processingId,
		model: ANALYSIS_MODEL,
		target_lang: lang,
		titled,
		corrected: foreign,
		latency_ms: Math.round(performance.now() - startedAt),
		output_tokens: outputTokens,
	});
	return card;
}
