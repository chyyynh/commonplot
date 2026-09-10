import { sql } from 'drizzle-orm';
import { connectCoreDb } from '../shared/db';
import { structuredPdfCropManifestKey } from './zotero-sdt-service.ts';

const PUBLIC_CROP_PATTERN = /\/api\/media\/asset\/public-pdf-crops\/([a-f\d]{64})\/([a-f\d]{64})\/(\d+(?:\.\d+)*-p\d+-[a-f\d]{16})\.png/gu;
const MAX_MANIFEST_BYTES = 64 * 1024;

/** Publish only persisted references to crops produced from an independent public fetch. */
export async function publishPublicPdfCrops(env: CoreEnv, resourceId: string): Promise<void> {
	const db = await connectCoreDb(env);
	const result = await db.execute<{ content: string }>(sql`
		SELECT original.content
		FROM resources resource
		JOIN resource_translations original ON original.resource_id = resource.id AND original.lang = resource.original_lang
		WHERE resource.id = ${resourceId}::uuid AND resource.scope = 'corpus' AND resource.enrichment_status = 'enriched'
	`);
	const content = result.rows[0]?.content;
	if (!content) return;
	const groups = new Map<string, { sourceHash: string; inputHash: string; cropIds: Set<string> }>();
	for (const [, sourceHash, inputHash, cropId] of content.matchAll(PUBLIC_CROP_PATTERN)) {
		const groupKey = `${sourceHash}/${inputHash}`;
		const group = groups.get(groupKey) ?? { sourceHash: sourceHash!, inputHash: inputHash!, cropIds: new Set<string>() };
		group.cropIds.add(cropId!);
		groups.set(groupKey, group);
	}
	for (const { sourceHash, inputHash, cropIds } of groups.values()) {
		const prefix = `public-pdf/${sourceHash}/${inputHash}`;
		const pdfStorageKey = `${prefix}/source.pdf`;
		const source = await env.R2.head(pdfStorageKey);
		if (
			source?.customMetadata?.scope !== 'corpus' ||
			source.customMetadata.sourceSha256 !== sourceHash ||
			source.customMetadata.inputSha256 !== inputHash
		) {
			throw new Error('Public PDF crop publication has no independent public source');
		}
		const object = await env.R2.get(structuredPdfCropManifestKey(pdfStorageKey, inputHash));
		if (!object) throw new Error('Public PDF crop publication manifest is missing');
		if (object.size > MAX_MANIFEST_BYTES) {
			await object.body.cancel('Invalid public PDF manifest size');
			throw new Error('Public PDF crop publication manifest is too large');
		}
		const manifest: { inputSha256?: unknown; pdfStorageKey?: unknown; ready?: unknown; state?: unknown } = await object.json();
		const ready = manifest.ready;
		if (
			manifest.inputSha256 !== inputHash ||
			manifest.pdfStorageKey !== pdfStorageKey ||
			manifest.state !== 'complete' ||
			!Array.isArray(ready) ||
			[...cropIds].some((id) => !ready.includes(id))
		) {
			throw new Error('Public PDF crop publication includes unready images');
		}
		await env.R2.put(`${prefix}/publication.json`, JSON.stringify({ resourceId, cropIds: [...cropIds] }), {
			httpMetadata: { contentType: 'application/json' },
		});
	}
}
