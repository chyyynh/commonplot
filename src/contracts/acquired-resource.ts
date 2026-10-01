import type { ReferenceCitation } from './reference-citation';
import type { ResourceCreator, ResourceIdentifier, ResourceKind, ResourceKindMetadata, ResourcePlatform } from './resource';

/** One reader line: whole sentences from one speaker, timed from its first cue. */
export type YouTubeTranscriptLine = Readonly<{ speakerTurn: boolean; startTime: number; text: string }>;

export type YouTubeChapter = { title: string; startTime: number; endTime?: number };

export type YouTubeTranscript = Readonly<{
	lines: YouTubeTranscriptLine[];
	chapters: YouTubeChapter[];
}>;

// Adapters share an output contract; each adapter owns its mapping and identity.
export type AcquiredResource = {
	references?: readonly ({
		key: string;
		label: string | null;
		text: string;
		doi: string | null;
		arxivId: string | null;
	} & ReferenceCitation)[];
	kind: Exclude<ResourceKind, 'image'>;
	resourcePlatform: ResourcePlatform | null;
	resourceIdentifiers: ResourceIdentifier[];
	url: string | null;
	/** Null only for posts, which are an author and text. */
	title: string | null;
	summary: string | null;
	content: string;
	source: string;
	originalLang: string;
	publishedDate: string | null;
	creators: ResourceCreator[];
	kindMetadata: ResourceKindMetadata;
	fileType: string | null;
	/** The stored PDF a PDF representation was read from, by SHA-256. */
	pdfHash?: string;
	previewImageUrl: string | null;
	subjectUrl: string | null;
	/** Only YouTube videos carry a transcript. */
	youtube?: YouTubeTranscript;
};

/** Hints a source monitor or a subject carrier already resolved for a draft. */
export type SourceHints = Readonly<{ summary?: string; originalLang?: string; publishedDate?: string }>;

/** What the owner stored for an uploaded PDF; the Workflow reads it so adapters never touch the database. */
export type StoredPdf = Readonly<{
	contentHash: string;
	creators: ResourceCreator[];
	originalLang: string;
	publishedDate: string | null;
	source: string;
	storageKey: string;
	summary: string | null;
	title: string;
}>;

/** Everything acquisition needs, resolved before any adapter runs. */
export type AcquisitionInput = Readonly<
	| {
			kind: 'url';
			url: string;
			identifiers?: ResourceIdentifier[];
			sourceHints?: SourceHints;
	  }
	| { kind: 'storedPdf'; resourceId: string; pdf: StoredPdf }
>;
