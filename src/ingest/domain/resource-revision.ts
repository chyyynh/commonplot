// Source snapshot revision: the hash that detects unchanged source content across runs.

import { sha256Hex } from '@core-shared/hash';
import type { ResourceForProcessing } from '@core-shared/types';

export async function resourceSourceRevision(resource: ResourceForProcessing): Promise<string> {
	if (resource.source_revision) return resource.source_revision;
	return sha256Hex(
		JSON.stringify({
			content: resource.content,
			fileType: resource.file_type ?? null,
			kind: resource.kind,
			originalLang: resource.original_lang,
			publishedDate: resource.published_date,
			resourcePlatform: resource.resource_platform,
			summary: resource.summary,
			title: resource.title,
			translationSource: 'original',
			url: resource.url,
		}),
	);
}
