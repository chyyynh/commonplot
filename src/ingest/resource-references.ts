import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { connectCoreDb } from '../shared/db';
import { alignCitationMentions } from './citation-alignment';
import { resolveCrossrefReference } from './crossref';
import { GROBID_CONTAINER_NAME } from './grobid-container';
import type { GrobidPdfFulltext } from './grobid-tei';
import { MAX_PDF_BYTES, PDF_MIME } from './platforms/pdf-constants';

const CROSSREF_BATCH_SIZE = 3;
const REFERENCE_DB_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
const GROBID_STEP = { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '600 seconds' } as const;

type CrossrefMetadataUpdate = NonNullable<Awaited<ReturnType<typeof resolveCrossrefReference>>> & Readonly<{ ordinal: number }>;

async function loadUploadedPdfSource(
	db: NodePgDatabase,
	resourceId: string,
	fileResourceId: string,
	referenceRevision: string,
): Promise<string> {
	const result = await db.execute<{ storage_key: string }>(sql`
		SELECT blob.storage_key
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
		LIMIT 1
	`);
	const source = result.rows[0];
	if (!source) throw new NonRetryableError('Uploaded PDF is no longer attached to this paper revision');
	return source.storage_key;
}

async function replaceStoredCitationData(
	db: NodePgDatabase,
	resourceId: string,
	referenceRevision: string,
	fulltext: GrobidPdfFulltext,
): Promise<Readonly<{ alignedMentionCount: number; mentionCount: number; referenceCount: number }>> {
	const source = await db.execute<{ content: string | null }>(sql`
		SELECT original.content
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		WHERE resource.id = ${resourceId}::uuid
		  AND resource.scope = 'corpus'
		  AND resource.kind = 'paper'
		  AND MD5(jsonb_build_array(original.lang, original.title, original.summary, original.content)::text) = ${referenceRevision}
		LIMIT 1
	`);
	const paper = source.rows[0];
	if (!paper) throw new NonRetryableError('Paper revision changed before GROBID citations could be aligned');
	const referenceOrdinalByKey = new Map(fulltext.references.map(({ key }, index) => [key, index + 1]));
	const mentions = alignCitationMentions(
		paper.content ?? '',
		fulltext.mentions.flatMap(({ context, markerText, section, targetKeys }) => {
			const referenceOrdinals = [...new Set(targetKeys.flatMap((key) => referenceOrdinalByKey.get(key) ?? []))];
			return referenceOrdinals.length ? [{ context, markerText, referenceOrdinals, section }] : [];
		}),
	);

	return db.transaction(async (tx) => {
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
		if (!current.rows[0]) throw new NonRetryableError('Paper revision changed before GROBID citations could be stored');

		await tx.execute(sql`DELETE FROM resource_citation_mentions WHERE resource_id = ${resourceId}::uuid`);
		await tx.execute(sql`DELETE FROM resource_references WHERE resource_id = ${resourceId}::uuid`);
		if (fulltext.references.length) {
			const referenceValues = sql.join(
				fulltext.references.map(({ label, text }, index) => sql`(${resourceId}::uuid, ${index + 1}, ${label}::text, ${text})`),
				sql`, `,
			);
			await tx.execute(sql`
				INSERT INTO resource_references (resource_id, ordinal, label, text)
				VALUES ${referenceValues}
			`);
		}
		if (mentions.length) {
			const mentionValues = sql.join(
				mentions.map(
					({ contentEnd, contentStart, context, markerText, section }, index) =>
						sql`(
							${resourceId}::uuid, ${index + 1}, ${markerText}, ${context}, ${section}::text,
							${contentStart}::integer, ${contentEnd}::integer, ${referenceRevision}
						)`,
				),
				sql`, `,
			);
			await tx.execute(sql`
				INSERT INTO resource_citation_mentions (
					resource_id, ordinal, marker_text, context, section, content_start, content_end, content_revision
				)
				VALUES ${mentionValues}
			`);

			const targetValues = sql.join(
				mentions.flatMap(({ referenceOrdinals }, mentionIndex) =>
					referenceOrdinals.map((referenceOrdinal) => sql`(${resourceId}::uuid, ${mentionIndex + 1}, ${referenceOrdinal})`),
				),
				sql`, `,
			);
			await tx.execute(sql`
				INSERT INTO resource_citation_targets (resource_id, mention_ordinal, reference_ordinal)
				VALUES ${targetValues}
			`);
		}
		return {
			alignedMentionCount: mentions.filter(({ contentStart }) => contentStart !== null).length,
			mentionCount: mentions.length,
			referenceCount: fulltext.references.length,
		};
	});
}

function sqlTextArray(values: readonly string[]) {
	return values.length
		? sql`ARRAY[${sql.join(
				values.map((value) => sql`${value}`),
				sql`, `,
			)}]::text[]`
		: sql`ARRAY[]::text[]`;
}

async function persistCrossrefMetadata(
	db: NodePgDatabase,
	resourceId: string,
	referenceRevision: string,
	updates: readonly CrossrefMetadataUpdate[],
): Promise<number> {
	if (!updates.length) return 0;
	const values = sql.join(
		updates.map(
			({ authors, doi, ordinal, title, url, venue, year }) =>
				sql`(
					${ordinal}::integer, ${doi}::text, ${url}::text, ${title}::text,
					${sqlTextArray(authors)}, ${year}::integer, ${venue}::text
				)`,
		),
		sql`, `,
	);
	const result = await db.execute(sql`
		UPDATE resource_references AS reference
		SET doi = incoming.doi,
		    url = incoming.url,
		    title = incoming.title,
		    authors = incoming.authors,
		    year = incoming.year,
		    venue = incoming.venue
		FROM (VALUES ${values}) AS incoming(ordinal, doi, url, title, authors, year, venue)
		WHERE reference.resource_id = ${resourceId}::uuid
		  AND reference.ordinal = incoming.ordinal
		  AND ROW(reference.doi, reference.url, reference.title, reference.authors, reference.year, reference.venue)
		      IS DISTINCT FROM ROW(incoming.doi, incoming.url, incoming.title, incoming.authors, incoming.year, incoming.venue)
		  AND EXISTS (
		    SELECT 1
		    FROM resources resource
		    JOIN resource_translations original
		      ON original.resource_id = resource.id
		     AND original.lang = resource.original_lang
		    WHERE resource.id = reference.resource_id
		      AND MD5(jsonb_build_array(original.lang, original.title, original.summary, original.content)::text) = ${referenceRevision}
		  )
	`);
	return result.rowCount ?? 0;
}

async function resolveCrossrefUpdates(
	step: WorkflowStep,
	references: readonly string[],
): Promise<{ attemptedCount: number; updates: CrossrefMetadataUpdate[] }> {
	const updates: CrossrefMetadataUpdate[] = [];
	for (let offset = 0; offset < references.length; offset += CROSSREF_BATCH_SIZE) {
		const batch = references.slice(offset, offset + CROSSREF_BATCH_SIZE);
		let resolutions: Array<Awaited<ReturnType<typeof resolveCrossrefReference>>>;
		try {
			resolutions = await step.do(
				`resolve-crossref-reference-batch-v1-${offset / CROSSREF_BATCH_SIZE}`,
				{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => Promise.all(batch.map((text) => resolveCrossrefReference(text))),
			);
		} catch (error) {
			console.warn({
				tag: 'CROSSREF',
				event: 'reference_resolution_batch_failed',
				first_ordinal: offset + 1,
				reference_count: batch.length,
				error: error instanceof Error ? error.message : String(error),
			});
			resolutions = [];
		}
		for (const [index, resolution] of resolutions.entries()) {
			if (resolution) updates.push({ ...resolution, ordinal: offset + index + 1 });
		}
		if (offset + CROSSREF_BATCH_SIZE < references.length) {
			await step.sleep(`pace-crossref-batch-v2-${offset / CROSSREF_BATCH_SIZE}`, '1 second');
		}
	}
	return { attemptedCount: references.length, updates };
}

/** GROBID owns PDF reference extraction; Crossref owns bibliographic identifier resolution. */
export async function enrichUploadedPdfReferences(
	env: CoreEnv,
	step: WorkflowStep,
	input: Readonly<{ referenceRevision: string; resourceId: string; uploadedPdfResourceId: string }>,
): Promise<void> {
	try {
		const storageKey = await step.do('load-uploaded-pdf-reference-source-v1', REFERENCE_DB_STEP, async () =>
			loadUploadedPdfSource(await connectCoreDb(env), input.resourceId, input.uploadedPdfResourceId, input.referenceRevision),
		);
		const fulltext = await step.do('parse-uploaded-pdf-fulltext-v1', GROBID_STEP, async () => {
			const object = await env.R2.get(storageKey);
			if (!object) throw new NonRetryableError('Uploaded PDF object is missing');
			if (object.size < 1 || object.size > MAX_PDF_BYTES) {
				await object.body.cancel('Uploaded PDF size is outside the supported range');
				throw new NonRetryableError(`Uploaded PDF must contain 1-${MAX_PDF_BYTES} bytes`);
			}
			const grobid = env.GROBID.getByName(GROBID_CONTAINER_NAME);
			using parsed = await grobid.processPdfFulltext(object.body, object.size);
			// RPC plain-object results are disposable stubs. Copy the bounded data
			// into a normal serializable value before Workflow persists the step.
			return {
				mentions: parsed.mentions.map(({ context, markerText, section, targetKeys }) => ({
					context,
					markerText,
					section,
					targetKeys: [...targetKeys],
				})),
				references: parsed.references.map(({ key, label, text }) => ({ key, label, text })),
			} satisfies GrobidPdfFulltext;
		});
		const stored = await step.do('replace-uploaded-pdf-citations-v1', REFERENCE_DB_STEP, async () =>
			replaceStoredCitationData(await connectCoreDb(env), input.resourceId, input.referenceRevision, fulltext),
		);
		const crossref = await resolveCrossrefUpdates(
			step,
			fulltext.references.map(({ text }) => text),
		);
		const enrichedCount = crossref.updates.length
			? await step.do('persist-crossref-reference-metadata-v1', REFERENCE_DB_STEP, async () =>
					persistCrossrefMetadata(await connectCoreDb(env), input.resourceId, input.referenceRevision, crossref.updates),
				)
			: 0;
		console.info({
			tag: 'RESOURCE_REFERENCES',
			event: 'reference_enrichment_completed',
			resource_id: input.resourceId,
			grobid_reference_count: fulltext.references.length,
			grobid_mention_count: fulltext.mentions.length,
			stored_reference_count: stored.referenceCount,
			stored_mention_count: stored.mentionCount,
			aligned_mention_count: stored.alignedMentionCount,
			crossref_attempted_count: crossref.attemptedCount,
			crossref_enriched_count: enrichedCount,
		});
	} catch (error) {
		console.warn({
			tag: 'RESOURCE_REFERENCES',
			event: 'reference_enrichment_skipped',
			resource_id: input.resourceId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
