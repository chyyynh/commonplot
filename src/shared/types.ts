import type { ResourceIdentityColumns, ResourcePlatform, ResourceScope } from '@core-shared/resource-types';
import type { ResourceIdentifier } from './resource-identifiers';
import type { PaperRelationSnapshot, ResourceCreator, ResourceKindMetadata } from './resource-metadata';

type ResourceForProcessingBase = {
	id: string;
	source_id: string | null;
	scope: ResourceScope;
	original_lang: string;
	title: string;
	summary: string | null;
	content: string | null;
	url: string | null;
	source: string | null;
	published_date: string | null;
	tags: string[];
	keywords: string[];
	creators: ResourceCreator[];
	kind_metadata: ResourceKindMetadata | null;
	source_revision: string | null;
	resource_identifiers: ResourceIdentifier[];
	storage_key: string | null;
	file_type: string | null;
	normalized_url: string | null;
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
};

type AcquiredMaterialSpecialization<T extends ResourcePlatform> = T extends 'youtube' ? { youtubeTranscript: YoutubeTranscript } : unknown;

export type AcquiredMaterial<T extends ResourcePlatform = ResourcePlatform> = T extends unknown
	? AcquiredMaterialBase<T> & AcquiredMaterialSpecialization<T>
	: never;

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
	media?: TwitterMedia[];
	quotedTweet?: QuotedTweetData;
	externalUrl?: string;
	externalOgImage?: string | null;
	externalTitle?: string | null;
}

interface YouTubeMetadata {
	channelName: string;
	channelId?: string;
	channelAvatar?: string;
	durationSeconds?: number;
	viewCount?: number;
	likeCount?: number;
	commentCount?: number;
}

export interface HackerNewsMetadata {
	author?: string;
	points?: number;
	commentCount?: number;
	itemType?: 'story' | 'ask' | 'show' | 'job';
}

interface ResourceRepresentationMetadata {
	fileName: string;
	fileSize: number;
}

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

interface AcquisitionDataByProvider {
	twitter: TwitterMetadata;
	youtube: YouTubeMetadata;
	hackernews: HackerNewsMetadata;
}

export interface PdfExtractionMetadata {
	status: 'ok' | 'needs_ocr';
	pages: number;
}

type AcquisitionData<T extends ResourcePlatform> = T extends keyof AcquisitionDataByProvider ? AcquisitionDataByProvider[T] : null;

export type AcquisitionEnvelope<T extends ResourcePlatform = ResourcePlatform> = {
	data: AcquisitionData<T>;
	/** Hash of normalized source fields used to skip unchanged resync runs. */
	sourceSnapshotHash?: string;
	/** Primary file representation facts; MIME and blob identity stay scalar. */
	representation?: ResourceRepresentationMetadata;
};
