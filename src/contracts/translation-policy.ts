import { PDF_MIME } from './pdf-policy';
import type { ResourceKind, ResourcePlatform } from './resource';

export const TRANSLATABLE_RESOURCE_KINDS = ['blog', 'forum', 'post', 'paper', 'video'] as const;

export type ResourceTranslationCandidate = Readonly<{
	fileType: string | null;
	kind: ResourceKind;
	originalLang: string;
	resourcePlatform: ResourcePlatform | null;
	scope: 'corpus' | 'private';
	url: string | null;
}>;

export function shouldEnqueueResourceTranslation(candidate: ResourceTranslationCandidate): boolean {
	const privateUploadedPdf =
		candidate.fileType === PDF_MIME &&
		candidate.resourcePlatform === null &&
		candidate.scope === 'private' &&
		candidate.kind === 'file' &&
		candidate.url === null;
	if (privateUploadedPdf) return candidate.originalLang !== 'zh-Hant';
	return (
		candidate.originalLang !== 'zh-Hant' &&
		candidate.scope === 'corpus' &&
		Boolean(candidate.url) &&
		(TRANSLATABLE_RESOURCE_KINDS as readonly string[]).includes(candidate.kind) &&
		(candidate.fileType !== PDF_MIME || (candidate.kind === 'paper' && candidate.resourcePlatform === null))
	);
}
