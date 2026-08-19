import type {
	ForumKindMetadata,
	PaperKindMetadata,
	PostKindMetadata,
	ResourceCreator,
	ResourceKindMetadata,
	ResourceMediaAttachment,
	VideoKindMetadata,
} from '@core-shared/resource-metadata';
import type { AcquiredMaterial, AcquisitionEnvelope, PaperMetadata, ResourceForProcessing } from '@core-shared/types';

type CanonicalAcquisitionFields = Readonly<{
	creators: ResourceCreator[];
	kindMetadata: ResourceKindMetadata;
}>;

function literalCreator(
	role: ResourceCreator['role'],
	literal: string | null | undefined,
	extra: Omit<ResourceCreator, 'literal' | 'role'> = {},
): ResourceCreator[] {
	const name = literal?.trim();
	return name ? [{ role, literal: name, ...extra }] : [];
}

function twitterCreator(metadata: AcquisitionEnvelope<'twitter'>): ResourceCreator[] {
	const data = metadata.data;
	const handle = data.authorUserName?.replace(/^@/, '').trim();
	const profileUrl = handle ? `https://x.com/${encodeURIComponent(handle)}` : undefined;
	return literalCreator('author', data.authorName || handle, {
		...(handle ? { handle } : {}),
		...(data.authorProfilePicture?.trim() ? { avatarUrl: data.authorProfilePicture.trim() } : {}),
		...(profileUrl ? { profileUrl } : {}),
		...(data.authorVerified === undefined ? {} : { verified: data.authorVerified }),
	});
}

function postMetadata(metadata: AcquisitionEnvelope<'twitter'>): PostKindMetadata {
	const data = metadata.data;
	const attachments: ResourceMediaAttachment[] = (data.media ?? []).flatMap((media) => {
		if (!media.url?.trim()) return [];
		return [
			{
				kind: media.type === 'photo' ? 'image' : media.type === 'animated_gif' ? 'animated' : 'video',
				url: media.url.trim(),
				...(media.videoUrl?.trim() ? { videoUrl: media.videoUrl.trim() } : {}),
				...(media.width === undefined ? {} : { width: media.width }),
				...(media.height === undefined ? {} : { height: media.height }),
			},
		];
	});
	const externalUrl = data.externalUrl?.trim();
	const quoted = data.quotedTweet;
	const quoteHandle = quoted?.authorUserName?.replace(/^@/, '').trim();
	const quoteCreator = quoted
		? literalCreator('author', quoted.authorName || quoted.authorUserName, {
				...(quoteHandle ? { handle: quoteHandle } : {}),
				...(quoted.authorProfilePicture?.trim() ? { avatarUrl: quoted.authorProfilePicture.trim() } : {}),
				...(quoteHandle ? { profileUrl: `https://x.com/${encodeURIComponent(quoteHandle)}` } : {}),
			})[0]
		: undefined;
	return {
		attachments,
		...(externalUrl
			? {
					externalLink: {
						url: externalUrl,
						...(data.externalTitle?.trim() ? { title: data.externalTitle.trim() } : {}),
						...(data.externalOgImage?.trim() ? { imageUrl: data.externalOgImage.trim() } : {}),
					},
				}
			: {}),
		...(quoted?.text.trim() && quoteCreator ? { quote: { creator: quoteCreator, text: quoted.text.trim() } } : {}),
	};
}

function forumMetadata(metadata: AcquisitionEnvelope<'hackernews'>): ForumKindMetadata {
	const data = metadata.data;
	return {
		...(data.itemType ? { itemType: data.itemType } : {}),
		...(data.points === undefined ? {} : { points: data.points }),
		...(data.commentCount === undefined ? {} : { commentCount: data.commentCount }),
	};
}

function videoMetadata(metadata: AcquisitionEnvelope<'youtube'>): VideoKindMetadata {
	const data = metadata.data;
	return {
		...(data.durationSeconds === undefined ? {} : { durationSeconds: data.durationSeconds }),
		...(data.viewCount === undefined ? {} : { viewCount: data.viewCount }),
		...(data.likeCount === undefined ? {} : { likeCount: data.likeCount }),
		...(data.commentCount === undefined ? {} : { commentCount: data.commentCount }),
	};
}

export function canonicalFieldsFromAcquisition(acquired: AcquiredMaterial): CanonicalAcquisitionFields {
	switch (acquired.provider) {
		case null:
			return {
				creators: literalCreator('author', acquired.metadata.author),
				kindMetadata: acquired.metadata.siteName.trim() ? { siteName: acquired.metadata.siteName.trim() } : null,
			};
		case 'hackernews': {
			const metadata = acquired.acquisition as AcquisitionEnvelope<'hackernews'>;
			return {
				creators: literalCreator('submitter', metadata.data.author),
				kindMetadata: forumMetadata(metadata),
			};
		}
		case 'twitter':
			return {
				creators: twitterCreator(acquired.acquisition as AcquisitionEnvelope<'twitter'>),
				kindMetadata: postMetadata(acquired.acquisition as AcquisitionEnvelope<'twitter'>),
			};
		case 'youtube': {
			const metadata = acquired.acquisition as AcquisitionEnvelope<'youtube'>;
			return {
				creators: literalCreator('channel', metadata.data.channelName, {
					...(metadata.data.channelAvatar?.trim() ? { avatarUrl: metadata.data.channelAvatar.trim() } : {}),
					...(metadata.data.channelId?.trim()
						? { profileUrl: `https://www.youtube.com/channel/${encodeURIComponent(metadata.data.channelId.trim())}` }
						: {}),
				}),
				kindMetadata: videoMetadata(metadata),
			};
		}
	}
}

export function paperCanonicalFields(metadata: PaperMetadata): {
	creators: ResourceCreator[];
	kindMetadata: PaperKindMetadata;
} {
	return {
		creators: metadata.authors.flatMap((author) => literalCreator('author', author)),
		kindMetadata: {
			...(metadata.venue?.trim() ? { venue: metadata.venue.trim() } : {}),
			...(metadata.year === undefined ? {} : { year: metadata.year }),
			...(metadata.citedByCount === undefined ? {} : { citedByCount: metadata.citedByCount }),
			...(metadata.referenceCount === undefined ? {} : { referenceCount: metadata.referenceCount }),
			...(metadata.pdfUrl?.trim() ? { pdfUrl: metadata.pdfUrl.trim() } : {}),
			...(metadata.references ? { references: metadata.references } : {}),
			...(metadata.citations ? { citations: metadata.citations } : {}),
		},
	};
}

export function withPaperCanonicalFields(resource: ResourceForProcessing, metadata: PaperMetadata | null): ResourceForProcessing {
	if (!metadata) return resource;
	const canonical = paperCanonicalFields(metadata);
	return {
		...resource,
		creators: canonical.creators,
		kind_metadata: canonical.kindMetadata,
	};
}
