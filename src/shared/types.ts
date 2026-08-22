import type { ContentResourceIdentity, ResourcePlatform } from '@core-shared/resource-types';
import type { ResourceIdentifier } from './resource-identifiers';
import type { PaperRelationSnapshot, ResourceCreator, ResourceKindMetadata } from './resource-metadata';

export type ResolvedResourceSubject = Readonly<{
	identifiers: ResourceIdentifier[];
	normalizedUrl: string;
	url: string;
}>;

type MaterializedResourceFields = {
	originalLang: string;
	title: string;
	summary: string | null;
	content: string;
	url: string | null;
	source: string;
	publishedDate: string | null;
	tags: string[];
	keywords: string[];
	creators: ResourceCreator[];
	kindMetadata: ResourceKindMetadata | null;
	sourceRevision: string;
	resourceIdentifiers: ResourceIdentifier[];
	fileType: string | null;
	normalizedUrl: string | null;
	previewImageUrl: string | null;
	subject: ResolvedResourceSubject | null;
};

export type MaterializedResource = ContentResourceIdentity & MaterializedResourceFields;

export const ENTITY_TYPES = ['person', 'organization', 'product', 'technology', 'event', 'location'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * One resource-local entity annotation stored on `resources.entities`. Keys
 * are short because every enriched resource can carry several of these.
 *
 * `k` is stable enough for a future consumer to group exact canonical matches;
 * `n`/`cn` are display labels and `t` is the entity class.
 */
export type StoredResourceEntity = {
	k: string;
	n: string;
	cn: string | null;
	t: EntityType;
};

export interface TranscriptSegment {
	startTime: number;
	endTime: number;
	text: string;
}

export interface YouTubeChapter {
	title: string;
	startTime: number;
	endTime?: number;
}

interface YouTubeHighlight {
	title: string;
	summary: string;
	startTime: number;
	endTime: number;
}

export interface YouTubeHighlights {
	version: '1.0';
	model: string;
	highlights: YouTubeHighlight[];
	generatedAt: string;
}

export interface YoutubeTranscript {
	videoId: string;
	segments: TranscriptSegment[];
	language: string | null;
	chapters: YouTubeChapter[];
	chaptersFromDescription: boolean;
}

export type YouTubeResourceSpecialization = Readonly<{
	kind: 'youtube';
	transcript: Omit<YoutubeTranscript, 'videoId'> | null;
	highlights: YouTubeHighlights | null;
}>;

export type ResolvedResource =
	| (Extract<MaterializedResource, { kind: 'video'; resourcePlatform: 'youtube' }> & {
			specialization: YouTubeResourceSpecialization;
	  })
	| (Exclude<MaterializedResource, { kind: 'video'; resourcePlatform: 'youtube' }> & {
			specialization: null;
	  });

type AcquiredMaterialBase<T extends ResourcePlatform> = {
	/** Acquisition adapter identity. This is not the Resource product identity. */
	provider: T;
	/** Validated final URL after redirects, when acquisition resolved one. */
	canonicalUrl?: string;
	fileType: string | null;
	title: string;
	/** Platform APIs return markdown or plain text for resource drafts. */
	markdown: string;
	/** Canonical preview image selected by the acquisition source. */
	previewImageUrl?: string | null;
	/** Canonical subject URL when this Resource is a platform carrier. */
	subjectUrl?: string;
	source: string;
	originalLang: string | null;
	publishedDate: string | null;
	summary: string | null;
	creators: ResourceCreator[];
	kindMetadata: ResourceKindMetadata;
	/** Hash of normalized source fields used to identify the acquired revision. */
	sourceSnapshotHash?: string;
};

type AcquiredMaterialSpecialization<T extends ResourcePlatform> = T extends 'youtube' ? { youtubeTranscript: YoutubeTranscript } : unknown;

export type AcquiredMaterial<T extends ResourcePlatform = ResourcePlatform> = T extends unknown
	? AcquiredMaterialBase<T> & AcquiredMaterialSpecialization<T>
	: never;

export interface PaperMetadata {
	title?: string;
	authors: string[];
	abstract?: string;
	venue?: string;
	year?: number;
	publicationDate?: string;
	citedByCount?: number;
	referenceCount?: number;
	pdfUrl?: string;
	references?: PaperRelationSnapshot;
	citations?: PaperRelationSnapshot;
}

export interface PdfExtractionMetadata {
	status: 'ok' | 'needs_ocr';
	pages: number;
}
