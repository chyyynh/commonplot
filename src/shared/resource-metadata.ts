import { z } from 'zod';
import type { ResourceKind } from './resource-types';

export const RESOURCE_CREATOR_ROLES = ['author', 'editor', 'submitter', 'channel'] as const;

const optionalHttpUrl = z.url().refine((value) => {
	const protocol = new URL(value).protocol;
	return protocol === 'http:' || protocol === 'https:';
});

export const ResourceCreatorSchema = z
	.object({
		role: z.enum(RESOURCE_CREATOR_ROLES),
		given: z.string().trim().min(1).optional(),
		family: z.string().trim().min(1).optional(),
		literal: z.string().trim().min(1).optional(),
		handle: z.string().trim().min(1).optional(),
		avatarUrl: optionalHttpUrl.optional(),
		profileUrl: optionalHttpUrl.optional(),
		verified: z.boolean().optional(),
	})
	.refine((creator) => creator.given || creator.family || creator.literal, 'Creator must have a name');

export type ResourceCreator = Readonly<z.infer<typeof ResourceCreatorSchema>>;
export type ResourceCreatorRole = ResourceCreator['role'];

const ResourceMediaAttachmentSchema = z.object({
	kind: z.enum(['image', 'video', 'animated']),
	url: optionalHttpUrl,
	videoUrl: optionalHttpUrl.optional(),
	width: z.number().int().positive().optional(),
	height: z.number().int().positive().optional(),
});

const ResourceLinkAttachmentSchema = z.object({
	url: optionalHttpUrl,
	title: z.string().trim().min(1).optional(),
	imageUrl: optionalHttpUrl.optional(),
});

export type ResourceMediaAttachment = Readonly<z.infer<typeof ResourceMediaAttachmentSchema>>;
export type ResourceLinkAttachment = Readonly<z.infer<typeof ResourceLinkAttachmentSchema>>;

const BlogKindMetadataSchema = z.object({
	schemaVersion: z.literal(1),
	siteName: z.string().trim().min(1).optional(),
});

const ForumKindMetadataSchema = z.object({
	schemaVersion: z.literal(1),
	itemType: z.enum(['story', 'ask', 'show', 'job']).optional(),
	points: z.number().int().nonnegative().optional(),
	commentCount: z.number().int().nonnegative().optional(),
});

const PostQuoteSchema = z.object({
	creator: ResourceCreatorSchema,
	text: z.string().trim().min(1),
});

const PostKindMetadataSchema = z.object({
	schemaVersion: z.literal(1),
	attachments: z.array(ResourceMediaAttachmentSchema).max(16),
	externalLink: ResourceLinkAttachmentSchema.optional(),
	quote: PostQuoteSchema.optional(),
	threadPostCount: z.number().int().positive().optional(),
});

const VideoKindMetadataSchema = z.object({
	schemaVersion: z.literal(1),
	duration: z.string().trim().min(1).optional(),
	viewCount: z.number().int().nonnegative().optional(),
	likeCount: z.number().int().nonnegative().optional(),
	commentCount: z.number().int().nonnegative().optional(),
});

const PaperRelationItemSchema = z.object({
	openAlexId: z.string().regex(/^W\d+$/),
	doi: z.string().trim().min(1).optional(),
	title: z.string().trim().min(1),
	authors: z.array(z.string().trim().min(1)),
	venue: z.string().trim().min(1).optional(),
	year: z.number().int().positive().optional(),
	citedByCount: z.number().int().nonnegative().optional(),
});

const PaperRelationSnapshotSchema = z.object({
	total: z.number().int().nonnegative(),
	items: z.array(PaperRelationItemSchema),
});

const PaperKindMetadataSchema = z.object({
	schemaVersion: z.literal(1),
	abstract: z.string().trim().min(1).optional(),
	venue: z.string().trim().min(1).optional(),
	year: z.number().int().positive().optional(),
	citedByCount: z.number().int().nonnegative().optional(),
	referenceCount: z.number().int().nonnegative().optional(),
	pdfUrl: optionalHttpUrl.optional(),
	references: PaperRelationSnapshotSchema.optional(),
	citations: PaperRelationSnapshotSchema.optional(),
});

export type BlogKindMetadataV1 = Readonly<z.infer<typeof BlogKindMetadataSchema>>;
export type ForumKindMetadataV1 = Readonly<z.infer<typeof ForumKindMetadataSchema>>;
export type PostQuoteV1 = Readonly<z.infer<typeof PostQuoteSchema>>;
export type PostKindMetadataV1 = Readonly<z.infer<typeof PostKindMetadataSchema>>;
export type VideoKindMetadataV1 = Readonly<z.infer<typeof VideoKindMetadataSchema>>;
export type PaperRelationItem = Readonly<z.infer<typeof PaperRelationItemSchema>>;
export type PaperRelationSnapshot = Readonly<z.infer<typeof PaperRelationSnapshotSchema>>;
export type PaperKindMetadataV1 = Readonly<z.infer<typeof PaperKindMetadataSchema>>;

export type ResourceKindMetadataByKind = Readonly<{
	blog: BlogKindMetadataV1 | null;
	forum: ForumKindMetadataV1;
	post: PostKindMetadataV1;
	video: VideoKindMetadataV1;
	paper: PaperKindMetadataV1;
}>;

export type ResourceKindMetadata = ResourceKindMetadataByKind[keyof ResourceKindMetadataByKind];

export function parseResourceCreators(value: unknown): ResourceCreator[] {
	return z.array(ResourceCreatorSchema).parse(value);
}

export function parseResourceKindMetadata<K extends keyof ResourceKindMetadataByKind>(
	kind: K,
	value: unknown,
): ResourceKindMetadataByKind[K] {
	switch (kind) {
		case 'blog':
			return (value === null ? null : BlogKindMetadataSchema.parse(value)) as ResourceKindMetadataByKind[K];
		case 'forum':
			return ForumKindMetadataSchema.parse(value) as ResourceKindMetadataByKind[K];
		case 'post':
			return PostKindMetadataSchema.parse(value) as ResourceKindMetadataByKind[K];
		case 'video':
			return VideoKindMetadataSchema.parse(value) as ResourceKindMetadataByKind[K];
		case 'paper':
			return PaperKindMetadataSchema.parse(value) as ResourceKindMetadataByKind[K];
	}
}

export function parseStoredResourceKindMetadata(kind: ResourceKind, value: unknown): ResourceKindMetadata | null {
	if (kind === 'image' || kind === 'file') {
		if (value !== null) throw new Error(`${kind} resources cannot have kind metadata`);
		return null;
	}
	return parseResourceKindMetadata(kind, value);
}
