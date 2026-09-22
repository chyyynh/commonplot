import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { sql } from 'drizzle-orm';
import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
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
import { stagePaperAcquisition } from './platforms/paper';
import { stageStoredPdfAcquisition } from './platforms/pdf';
import type { PaidPdfFallbackGrant } from './platforms/pdf-policy';
import { resolveResourceUrl } from './platforms/resource-url';
import { stageTwitterAcquisition } from './platforms/twitter-acquisition';
import { stageWebAcquisition } from './platforms/web';
import { stageYouTubeAcquisition } from './platforms/youtube';
import { ResourceLanguageSchema, detectResourceLanguage } from './resource-language';

// Adapters share an output contract; each adapter owns its mapping and identity.
export type AcquiredResource = {
	citations?: { references: readonly { key: string; label: string | null; text: string }[] } | null;
	kind: Exclude<ResourceKind, 'image'>;
	resourcePlatform: ResourcePlatform | null;
	resourceIdentifiers: ResourceIdentifier[];
	url: string | null;
	title: string;
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

function nodeText(node: Nodes): string {
	return 'value' in node ? node.value : 'children' in node ? node.children.map(nodeText).join('') : '';
}

/** Remove a duplicate heading only after Core has resolved the resource title. */
function withoutDuplicateResourceTitle(markdown: string, title: string): string {
	const first = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: gfmFromMarkdown() }).children[0];
	const comparable = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
	if (first?.type !== 'heading' || comparable(nodeText(first)) !== comparable(title)) return markdown;
	const end = first.position?.end.offset;
	if (end === undefined) return markdown;
	const body = markdown.slice(end).trimStart();
	return body || markdown;
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
		const web = identifiers.length
			? await stagePaperAcquisition(env, step, { ...input, identifiers })
			: await stageWebAcquisition(env, step, input);
		if (!('platform' in web)) {
			return !identifiers.length && web.resourceIdentifiers.length
				? stagePaperAcquisition(env, step, { resource: web, processingId: input.processingId })
				: web;
		}
		detected = web.platform;
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
						const url = resolveResourceUrl(rows[0].url)?.url;
						if (!url) throw new NonRetryableError(`Resource ${target.resourceId} has no valid external HTTP URL and cannot be reacquired`);
						return { url, identifiers: ResourceIdentifiersSchema.parse(rows[0].identifiers) };
					},
				)
			: target.kind === 'draft'
				? { url: target.url }
				: null;
	const acquired =
		target.kind === 'storedBlob'
			? await stagePaperAcquisition(env, step, { ...(await stageStoredPdfAcquisition(env, step, target)), processingId })
			: await stageUrlAcquisition(env, step, { ...urlInput!, paidPdfFallback: target.paidPdfFallback ?? null, processingId });
	const source = target.kind === 'draft' ? target.sourceHints : undefined;
	const language = ResourceLanguageSchema.safeParse(acquired.originalLang).data;
	const parsedDate = Date.parse(acquired.publishedDate ?? '');
	const publishedDate = Number.isNaN(parsedDate) ? (source?.publishedDate ?? null) : new Date(parsedDate).toISOString();
	const content = withoutDuplicateResourceTitle(acquired.content, acquired.title);
	return {
		...acquired,
		content,
		originalLang: detectResourceLanguage(content, language && language !== 'und' ? language : (source?.originalLang ?? 'und')),
		publishedDate,
		summary: acquired.summary?.trim() || source?.summary?.trim() || null,
	};
}
