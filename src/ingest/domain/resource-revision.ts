// Source snapshot revision: the hash that detects unchanged source content across runs.

import { sha256Hex } from '@core-shared/hash';
import type { ResourceTranslationSource } from '@core-shared/resource-types';
import type { ResourceForProcessing } from '@core-shared/types';

export type ResourceSourceSnapshotInput = {
	content: string | null;
	fileType: string | null;
	kind: string;
	originalLang: string;
	publishedDate: string | null;
	resourcePlatform: string | null;
	summary: string | null;
	title: string;
	translationSource: ResourceTranslationSource;
	url: string | null;
};

export function resourceSourceSnapshotHash(input: ResourceSourceSnapshotInput): Promise<string> {
	return sha256Hex(JSON.stringify(input));
}

export function resourceSourceSnapshotInput(resource: ResourceForProcessing): ResourceSourceSnapshotInput {
	return {
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
	};
}

export async function resourceSourceRevision(resource: ResourceForProcessing): Promise<string> {
	return resource.source_revision ?? resourceSourceSnapshotHash(resourceSourceSnapshotInput(resource));
}
