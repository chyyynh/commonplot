import type { ReferenceCitation } from './reference-citation';
import type { ResourceIdentifier } from './resource';
import type { ResourceCreator, ResourceKind, ResourceKindMetadata, ResourcePlatform } from './resource-kinds';

/** One reader line: whole sentences from one speaker, timed from its first cue. */
export type YouTubeTranscriptLine = Readonly<{ speakerTurn: boolean; startTime: number; text: string }>;

export type YouTubeChapter = { title: string; startTime: number; endTime?: number };

export type YouTubeTranscript = Readonly<{
	/** Null when YouTube's bot check withheld the captions: whether the video has any is unknown, so a later run may fetch them. */
	lines: YouTubeTranscriptLine[] | null;
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
	/** The Hacker News thread a link was acquired through; it becomes a key of the linked Resource, not a Resource. */
	hackerNewsId?: string;
	/** Only YouTube videos carry a transcript. */
	youtube?: YouTubeTranscript;
};

/** What entity extraction reads: an acquired original, or a stored one. */
export type EntitySource = Pick<AcquiredResource, 'title' | 'content'>;

/** Hints a source monitor or a subject carrier already resolved for a draft. */
export type SourceHints = Readonly<{ summary?: string; originalLang?: string; publishedDate?: string }>;

/** An owned PDF upload as Web describes it; its bytes live under `blobKey(contentHash)`. */
export type StoredPdf = Readonly<{ contentHash: string; fileName: string | null }>;

/** Everything acquisition needs, resolved before any adapter runs. */
export type AcquisitionInput = Readonly<
	| {
			kind: 'url';
			url: string;
			identifiers?: ResourceIdentifier[];
			sourceHints?: SourceHints;
	  }
	| { kind: 'storedPdf'; objectId: string; pdf: StoredPdf }
>;
