import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { connectCoreDb } from '../shared/db';
import { sha256Hex } from '../shared/hash';
import { resolveCrossrefReference } from './crossref';
import { matchesUploadedPdfRendition } from './pdf-rendition';
import { PDF_MIME } from './platforms/pdf-constants';
import { readStructuredPdfArtifact } from './zotero-sdt-service.ts';
import { normalizeStructuredPdf, type StructuredPdfDocument, structuredPdfSourceCrops } from './zotero-sdt.ts';

const CROSSREF_BATCH_SIZE = 3;
const REFERENCE_DB_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
const REFERENCE_SDT_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '90 seconds' } as const;
const RESOURCE_REFERENCE_WORKFLOW_REVISION = 'pdf-sdt-xr-v3';
const ResourceReferenceEnrichmentPayloadSchema = z.strictObject({
	referenceRevision: z.hash('md5').lowercase(),
	resourceId: z.uuid(),
	source: z.strictObject({ fileResourceId: z.uuid(), kind: z.literal('uploadedPdf') }),
});

type CrossrefMetadataUpdate = NonNullable<Awaited<ReturnType<typeof resolveCrossrefReference>>> & Readonly<{ ordinal: number }>;
type ResourceReferenceEnrichmentPayload = z.infer<typeof ResourceReferenceEnrichmentPayloadSchema>;

async function loadUploadedPdfSource(db: NodePgDatabase, resourceId: string, fileResourceId: string, referenceRevision: string) {
	const result = await db.execute<{ content_hash: string | null; storage_key: string }>(sql`
		SELECT blob.content_hash, blob.storage_key
		FROM resources blob
		JOIN user_files owned ON owned.resource_id = blob.id
		JOIN profile_resources profile
		  ON profile.id = owned.profile_resource_id
		 AND profile.user_id = owned.user_id
		JOIN resources paper ON paper.id = profile.resource_id
		JOIN resource_translations original
		  ON original.resource_id = paper.id
		 AND original.lang = paper.original_lang
		WHERE blob.id = ${fileResourceId}::uuid
		  AND blob.scope = 'private'
		  AND blob.kind = 'file'
		  AND blob.file_type = ${PDF_MIME}
		  AND blob.storage_key IS NOT NULL
		  AND paper.id = ${resourceId}::uuid
		  AND paper.scope = 'corpus'
		  AND paper.kind = 'paper'
		  AND MD5(jsonb_build_array(original.lang, original.title, original.summary, original.content)::text) = ${referenceRevision}
	`);
	const source = result.rows[0];
	if (!source) throw new NonRetryableError('Uploaded PDF is no longer attached to this paper revision');
	const contentHash = source.content_hash;
	if (!contentHash || !/^[a-f\d]{64}$/u.test(contentHash)) throw new NonRetryableError('Uploaded PDF has no valid content hash');
	return { contentHash, storageKey: source.storage_key };
}

async function replaceStoredCitationData(
	db: NodePgDatabase,
	resourceId: string,
	referenceRevision: string,
	document: StructuredPdfDocument,
	inputContentHash: string,
) {
	const source = await db.execute<{ content: string }>(sql`
		SELECT COALESCE(original.content, '') AS content
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		WHERE resource.id = ${resourceId}::uuid
		  AND resource.scope = 'corpus'
		  AND resource.kind = 'paper'
		  AND MD5(jsonb_build_array(original.lang, original.title, original.summary, original.content)::text) = ${referenceRevision}
	`);
	const content = source.rows[0]?.content;
	if (content === undefined) throw new NonRetryableError('Paper revision changed before structured citations could be stored');
	const readySourceCrops = structuredPdfSourceCrops(document);
	const structured = normalizeStructuredPdf(document, { inputContentHash, readySourceCrops });
	if (!matchesUploadedPdfRendition(content, structured.markdown)) {
		console.info({ tag: 'RESOURCE_REFERENCES', event: 'retained_public_rendition', resource_id: resourceId });
		return { referenceTexts: [] as string[], mentionCount: 0, alignedMentionCount: 0 };
	}
	const hasExactStructuredContent = content === structured.markdown;
	const referenceOrdinalByKey = new Map(structured.references.map(({ key }, index) => [key, index + 1]));
	const mentions = structured.mentions.flatMap(({ contentEnd, contentStart, context, markerText, section, targetKeys }) => {
		const referenceOrdinals = [...new Set(targetKeys.flatMap((key) => referenceOrdinalByKey.get(key) ?? []))];
		if (!referenceOrdinals.length) return [];
		const exactOffset = hasExactStructuredContent && content.slice(contentStart, contentEnd) === markerText;
		return [
			{
				contentEnd: exactOffset ? contentEnd : null,
				contentStart: exactOffset ? contentStart : null,
				context,
				markerText,
				referenceOrdinals,
				section,
			},
		];
	});

	await db.transaction(async (tx) => {
		const current = await tx.execute<{ id: string }>(sql`
			SELECT resource.id::text
			FROM resources resource
			JOIN resource_translations original
			  ON original.resource_id = resource.id
			 AND original.lang = resource.original_lang
			WHERE resource.id = ${resourceId}::uuid
			  AND resource.scope = 'corpus'
			  AND resource.kind = 'paper'
			  AND MD5(jsonb_build_array(original.lang, original.title, original.summary, original.content)::text) = ${referenceRevision}
			FOR UPDATE OF resource
		`);
		if (!current.rows[0]) throw new NonRetryableError('Paper revision changed before structured citations could be stored');

		await tx.execute(sql`DELETE FROM resource_citation_mentions WHERE resource_id = ${resourceId}::uuid`);
		await tx.execute(sql`DELETE FROM resource_references WHERE resource_id = ${resourceId}::uuid`);
		await tx.execute(sql`
			INSERT INTO resource_references (resource_id, ordinal, label, text)
			SELECT ${resourceId}::uuid, incoming.ordinal::integer, incoming.value->>'label', incoming.value->>'text'
			FROM jsonb_array_elements(${JSON.stringify(structured.references)}::jsonb)
			WITH ORDINALITY AS incoming(value, ordinal)
		`);
		await tx.execute(sql`
			WITH incoming AS MATERIALIZED (
				SELECT
					ordinal::integer,
					value->>'markerText' AS marker_text,
					value->>'context' AS context,
					value->>'section' AS section,
					(value->>'contentStart')::integer AS content_start,
					(value->>'contentEnd')::integer AS content_end,
					value->'referenceOrdinals' AS reference_ordinals
				FROM jsonb_array_elements(${JSON.stringify(mentions)}::jsonb)
				WITH ORDINALITY AS mention(value, ordinal)
			), inserted_mentions AS (
				INSERT INTO resource_citation_mentions (
					resource_id, ordinal, marker_text, context, section, content_start, content_end
				)
				SELECT ${resourceId}::uuid, ordinal, marker_text, context, section, content_start, content_end
				FROM incoming
				RETURNING ordinal
			)
			INSERT INTO resource_citation_targets (resource_id, mention_ordinal, reference_ordinal)
			SELECT ${resourceId}::uuid, incoming.ordinal, target.value::integer
			FROM incoming
			JOIN inserted_mentions USING (ordinal)
			CROSS JOIN LATERAL jsonb_array_elements_text(incoming.reference_ordinals) AS target(value)
		`);
	});
	return {
		alignedMentionCount: mentions.filter(({ contentStart }) => contentStart !== null).length,
		mentionCount: mentions.length,
		referenceTexts: structured.references.map(({ text }) => text),
	};
}

async function persistCrossrefMetadata(
	db: NodePgDatabase,
	resourceId: string,
	referenceRevision: string,
	updates: readonly CrossrefMetadataUpdate[],
): Promise<number> {
	const result = await db.execute(sql`
		UPDATE resource_references AS reference
		SET (doi, url, title, authors, year, venue) =
		    (incoming.doi, incoming.url, incoming.title, incoming.authors, incoming.year, incoming.venue)
		FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS incoming(
			ordinal integer, doi text, url text, title text, authors text[], year integer, venue text
		)
		JOIN resources resource ON resource.id = ${resourceId}::uuid
		JOIN resource_translations original
		  ON original.resource_id = resource.id AND original.lang = resource.original_lang
		WHERE reference.resource_id = resource.id
		  AND reference.ordinal = incoming.ordinal
		  AND ROW(reference.doi, reference.url, reference.title, reference.authors, reference.year, reference.venue)
		      IS DISTINCT FROM ROW(incoming.doi, incoming.url, incoming.title, incoming.authors, incoming.year, incoming.venue)
		  AND MD5(jsonb_build_array(original.lang, original.title, original.summary, original.content)::text) = ${referenceRevision}
	`);
	return result.rowCount ?? 0;
}

async function resolveCrossrefUpdates(step: WorkflowStep, references: readonly string[]): Promise<CrossrefMetadataUpdate[]> {
	const updates: CrossrefMetadataUpdate[] = [];
	for (let offset = 0; offset < references.length; offset += CROSSREF_BATCH_SIZE) {
		const batch = references.slice(offset, offset + CROSSREF_BATCH_SIZE);
		const resolutions = await Promise.all(
			batch.map((text, index) =>
				step
					.do(
						`resolve-crossref-reference-v2-${offset + index + 1}`,
						{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
						() => resolveCrossrefReference(text),
					)
					.catch((error) => {
						console.warn({
							tag: 'CROSSREF',
							event: 'reference_resolution_failed',
							ordinal: offset + index + 1,
							error: error instanceof Error ? error.message : String(error),
						});
						return null;
					}),
			),
		);
		for (const [index, resolution] of resolutions.entries()) {
			if (resolution) updates.push({ ...resolution, ordinal: offset + index + 1 });
		}
		if (offset + CROSSREF_BATCH_SIZE < references.length) {
			await step.sleep(`pace-crossref-batch-v2-${offset / CROSSREF_BATCH_SIZE}`, '1 second');
		}
	}
	return updates;
}

export async function enqueueResourceReferenceEnrichment(
	env: CoreEnv,
	resourceId: string,
	referenceRevision: string,
	uploadedPdfResourceId: string,
) {
	const id = `rr-v5-${await sha256Hex(
		[RESOURCE_REFERENCE_WORKFLOW_REVISION, resourceId, referenceRevision, uploadedPdfResourceId, 'idempotent'].join('\n'),
	)}`;
	await env.RESOURCE_REFERENCE_ENRICHMENT_WORKFLOW.createBatch([
		{ id, params: { referenceRevision, resourceId, source: { fileResourceId: uploadedPdfResourceId, kind: 'uploadedPdf' } } },
	]);
}

/** Zotero SDT owns PDF references and citation links; Crossref metadata enrichment stays off the critical path. */
export class ResourceReferenceEnrichmentWorkflow extends WorkflowEntrypoint<CoreEnv, ResourceReferenceEnrichmentPayload> {
	async run(event: WorkflowEvent<ResourceReferenceEnrichmentPayload>, step: WorkflowStep): Promise<void> {
		const input = ResourceReferenceEnrichmentPayloadSchema.parse(event.payload);
		const source = await step.do('load-uploaded-pdf-reference-source-v2', REFERENCE_DB_STEP, async () =>
			loadUploadedPdfSource(await connectCoreDb(this.env), input.resourceId, input.source.fileResourceId, input.referenceRevision),
		);
		const stored = await step.do('replace-uploaded-pdf-citations-v3', REFERENCE_SDT_STEP, async () => {
			const document = await readStructuredPdfArtifact(this.env, source.storageKey, source.contentHash);
			if (!document) throw new NonRetryableError('Structured PDF artifact is missing or stale');
			const db = await connectCoreDb(this.env);
			return replaceStoredCitationData(db, input.resourceId, input.referenceRevision, document, source.contentHash);
		});
		const crossrefUpdates = await resolveCrossrefUpdates(step, stored.referenceTexts);
		const enrichedCount = crossrefUpdates.length
			? await step.do('persist-crossref-reference-metadata-v1', REFERENCE_DB_STEP, async () =>
					persistCrossrefMetadata(await connectCoreDb(this.env), input.resourceId, input.referenceRevision, crossrefUpdates),
				)
			: 0;
		console.info({
			tag: 'RESOURCE_REFERENCES',
			event: 'reference_enrichment_completed',
			resource_id: input.resourceId,
			stored_reference_count: stored.referenceTexts.length,
			stored_mention_count: stored.mentionCount,
			aligned_mention_count: stored.alignedMentionCount,
			crossref_enriched_count: enrichedCount,
		});
	}
}
