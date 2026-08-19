import type {
	ResourceIdentityColumns,
	ResourcePlatform,
	ResourceScope,
	ResourceTranslationSource,
	SourceAcquisitionMode,
} from '@core-shared/resource-types';
import type { PaperIdentifier } from './paper-identity';
import type { ResourceIdentifier } from './resource-identifiers';
import type { ResourceCreator, ResourceKindMetadata } from './resource-metadata';

export type ResourceLocaleText = {
	title?: string | null;
	summary?: string | null;
	content?: string | null;
	keywords?: string[] | null;
	source?: ResourceTranslationSource;
};

export type ResourceTranslationMap = Record<string, ResourceLocaleText | undefined>;

type ResourceForProcessingBase = {
	id: string;
	source_id: string | null;
	source_acquisition_mode?: SourceAcquisitionMode | null;
	scope: ResourceScope;
	original_lang: string;
	title: string;
	summary: string | null;
	content: string | null;
	translations: ResourceTranslationMap;
	url: string | null;
	og_image_url?: string | null;
	source: string | null;
	published_date: string | null;
	tags: string[];
	keywords: string[];
	creators: ResourceCreator[];
	kind_metadata: ResourceKindMetadata | null;
	source_revision: string | null;
	subject_resource_id: string | null;
	resource_identifiers: ResourceIdentifier[];
	paper_identifiers?: PaperIdentifier[];
	// Blob/private resource raw columns (undefined for source URL drafts).
	storage_key?: string | null;
	file_type?: string | null;
	normalized_url?: string | null;
};

export type ResourceForProcessing = ResourceForProcessingBase & ResourceIdentityColumns;

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

type AcquiredMaterialBase<T extends ResourcePlatform> = {
	/** Acquisition adapter identity. This is not the Resource product identity. */
	provider: T;
	fileType: string | null;
	title: string;
	/** Platform APIs return markdown or plain text for resource drafts. */
	markdown: string;
	/** Canonical preview image selected by the acquisition source. */
	previewImageUrl?: string | null;
	metadata: {
		author: string | null;
		language: string | null;
		publishedDate: string | null;
		siteName: string;
		description: string | null;
	};
	acquisition: AcquisitionEnvelope<T>;
	youtubeTranscript?: YoutubeTranscript;
};

export type AcquiredMaterial<T extends ResourcePlatform = ResourcePlatform> = AcquiredMaterialBase<T>;

export interface TwitterMedia {
	url: string;
	type: 'photo' | 'video' | 'animated_gif';
	videoUrl?: string;
	width?: number;
	height?: number;
}

export interface TwitterAuthorFields {
	authorName: string;
	authorUserName: string;
	authorProfilePicture?: string;
	authorVerified?: boolean;
}

export interface QuotedTweetData {
	authorName: string;
	authorUserName: string;
	authorProfilePicture?: string;
	text: string;
}

export interface RetweetedByData {
	tweetId?: string;
	tweetUrl?: string;
	retweetedAt?: string;
	authorName: string;
	authorUserName: string;
	authorProfilePicture?: string;
	authorVerified?: boolean;
}

interface TwitterMetadata extends TwitterAuthorFields {
	tweetId?: string;
	coverImageUrl?: string;
	media?: TwitterMedia[];
	createdAt?: string;
	quotedTweet?: QuotedTweetData;
	externalUrl?: string;
	externalOgImage?: string | null;
	externalTitle?: string | null;
}

interface YouTubeMetadata {
	videoId: string;
	channelName: string;
	channelId?: string;
	channelAvatar?: string;
	durationSeconds?: number;
	thumbnailUrl?: string;
	viewCount?: number;
	likeCount?: number;
	commentCount?: number;
	publishedAt?: string;
	description?: string;
	tags?: string[];
}

export interface HackerNewsMetadata {
	itemId: string;
	author?: string;
	points?: number;
	commentCount?: number;
	itemType?: 'story' | 'ask' | 'show' | 'job';
	storyUrl?: string | null;
}

interface ResourceRepresentationMetadata {
	fileName: string;
	fileSize: number;
}

export interface PaperMetadata {
	schemaVersion: 3;
	source: 'openalex';
	resolvedAt: string;
	metricsUpdatedAt: string;
	doi?: string;
	arxivId?: string;
	openAlexId?: string;
	title?: string;
	authors: string[];
	abstract?: string;
	venue?: string;
	year?: number;
	publicationDate?: string;
	citedByCount?: number;
	referenceCount?: number;
	pdfUrl?: string;
	pdfLicense?: string;
	references?: PaperRelationSnapshot;
	citations?: PaperRelationSnapshot;
}

export interface PaperRelationItem {
	openAlexId: string;
	doi?: string;
	title: string;
	authors: string[];
	venue?: string;
	year?: number;
	citedByCount?: number;
}

export interface PaperRelationSnapshot {
	total: number;
	items: PaperRelationItem[];
}

interface AcquisitionDataByProvider {
	twitter: TwitterMetadata;
	youtube: YouTubeMetadata;
	hackernews: HackerNewsMetadata;
}

export interface PdfExtractionMetadata {
	status: 'ok' | 'needs_ocr';
	parser: 'liteparse';
	chars: number;
	pages: number;
}

type AcquisitionData<T extends ResourcePlatform> = T extends keyof AcquisitionDataByProvider ? AcquisitionDataByProvider[T] : null;

export type AcquisitionEnvelope<T extends ResourcePlatform = ResourcePlatform> = {
	fetchedAt: string;
	data: AcquisitionData<T>;
	/** Hash of normalized source fields used to skip unchanged resync runs. */
	sourceSnapshotHash?: string;
	/** Primary file representation facts; MIME and blob identity stay scalar. */
	representation?: ResourceRepresentationMetadata;
};
