import type { ResourceKind, ResourcePlatform } from '../shared/resource';
import { PDF_MIME } from './platforms/pdf-constants.ts';

const TRANSLATABLE_RESOURCE_KINDS = ['blog', 'forum', 'post', 'paper'] as const;

export type ResourceTranslationCandidate = Readonly<{
	fileType: string | null;
	kind: ResourceKind;
	originalLang: string;
	resourcePlatform: ResourcePlatform | null;
	scope: 'corpus' | 'private';
	url: string | null;
}>;

type PdfTranslationAdmission = 'canonical-paper' | 'not-pdf' | 'private-upload' | 'unsupported';

function pdfTranslationAdmission(candidate: ResourceTranslationCandidate): PdfTranslationAdmission {
	if (candidate.fileType !== PDF_MIME) return 'not-pdf';
	if (candidate.resourcePlatform !== null) return 'unsupported';
	if (candidate.scope === 'corpus' && candidate.kind === 'paper') return 'canonical-paper';
	return candidate.scope === 'private' && candidate.kind === 'file' && candidate.url === null ? 'private-upload' : 'unsupported';
}

export function shouldEnqueueResourceTranslation(candidate: ResourceTranslationCandidate): boolean {
	const pdfAdmission = pdfTranslationAdmission(candidate);
	const privateUploadedPdf = pdfAdmission === 'private-upload';
	const translatableKind =
		(TRANSLATABLE_RESOURCE_KINDS as readonly string[]).includes(candidate.kind) || (candidate.kind === 'file' && privateUploadedPdf);
	return (
		candidate.originalLang !== 'zh-Hant' &&
		(candidate.scope === 'corpus' || privateUploadedPdf) &&
		translatableKind &&
		(Boolean(candidate.url) || privateUploadedPdf) &&
		pdfAdmission !== 'unsupported'
	);
}
