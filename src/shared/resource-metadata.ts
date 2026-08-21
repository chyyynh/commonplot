import { z } from 'zod';
import type { ResourceKind } from './resource-types';
import { parseExternalHttpUrl } from './url.ts';

const RESOURCE_CREATOR_ROLES = ['author', 'editor', 'submitter', 'channel'] as const;

const optionalHttpUrl = z.url().refine((value) => parseExternalHttpUrl(value) !== null);

const ResourceCreatorSchema = z
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

export function resourceCreatorName(creator: ResourceCreator | undefined): string | null {
	return creator?.literal ?? ([creator?.given, creator?.family].filter(Boolean).join(' ') || null);
}

export function literalCreator(
	role: ResourceCreator['role'],
	literal: string | null | undefined,
	extra: Omit<ResourceCreator, 'literal' | 'role'> = {},
): ResourceCreator[] {
	const name = literal?.trim();
	return name ? [{ role, literal: name, ...extra }] : [];
}

const ResourceMediaAttachmentSchema = z.object({
	kind: z.enum(['image', 'video', 'animated']),
	url: optionalHttpUrl,
	videoUrl: optionalHttpUrl.optional(),
	width: z.number().int().positive().optional(),
	height: z.number().int().positive().optional(),
});

export type ResourceMediaAttachment = Readonly<z.infer<typeof ResourceMediaAttachmentSchema>>;

const BlogKindMetadataSchema = z.object({
	siteName: z.string().trim().min(1).optional(),
});

const ForumKindMetadataSchema = z.object({
	itemType: z.enum(['story', 'ask', 'show', 'job']).optional(),
	points: z.number().int().nonnegative().optional(),
	commentCount: z.number().int().nonnegative().optional(),
});

const PostQuoteSchema = z.object({
	creator: ResourceCreatorSchema,
	text: z.string().trim().min(1),
});

const PostKindMetadataSchema = z.object({
	attachments: z.array(ResourceMediaAttachmentSchema).max(16),
	quote: PostQuoteSchema.optional(),
	threadPostCount: z.number().int().positive().optional(),
});

const VideoKindMetadataSchema = z.object({
	durationSeconds: z.number().int().positive().optional(),
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
	venue: z.string().trim().min(1).optional(),
	year: z.number().int().positive().optional(),
	citedByCount: z.number().int().nonnegative().optional(),
	referenceCount: z.number().int().nonnegative().optional(),
	pdfUrl: optionalHttpUrl.optional(),
	references: PaperRelationSnapshotSchema.optional(),
	citations: PaperRelationSnapshotSchema.optional(),
});

type BlogKindMetadata = Readonly<z.infer<typeof BlogKindMetadataSchema>>;
export type ForumKindMetadata = Readonly<z.infer<typeof ForumKindMetadataSchema>>;
export type PostKindMetadata = Readonly<z.infer<typeof PostKindMetadataSchema>>;
export type VideoKindMetadata = Readonly<z.infer<typeof VideoKindMetadataSchema>>;
export type PaperRelationItem = Readonly<z.infer<typeof PaperRelationItemSchema>>;
export type PaperRelationSnapshot = Readonly<z.infer<typeof PaperRelationSnapshotSchema>>;
export type PaperKindMetadata = Readonly<z.infer<typeof PaperKindMetadataSchema>>;

export type ResourceKindMetadataByKind = Readonly<{
	blog: BlogKindMetadata | null;
	forum: ForumKindMetadata;
	post: PostKindMetadata;
	video: VideoKindMetadata;
	paper: PaperKindMetadata;
}>;

export type ResourceKindMetadata = ResourceKindMetadataByKind[keyof ResourceKindMetadataByKind];

export function parseResourceCreators(value: unknown): ResourceCreator[] {
	return z.array(ResourceCreatorSchema).parse(value);
}

export function parseStoredResourceKindMetadata(kind: ResourceKind, value: unknown): ResourceKindMetadata | null {
	switch (kind) {
		case 'blog':
			return value === null ? null : BlogKindMetadataSchema.parse(value);
		case 'forum':
			return ForumKindMetadataSchema.parse(value);
		case 'post':
			return PostKindMetadataSchema.parse(value);
		case 'video':
			return VideoKindMetadataSchema.parse(value);
		case 'paper':
			return PaperKindMetadataSchema.parse(value);
		case 'image':
		case 'file':
			if (value !== null) throw new Error(`${kind} resources cannot have kind metadata`);
			return null;
	}
}
