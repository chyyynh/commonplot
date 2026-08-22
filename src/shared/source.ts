export const SOURCE_PLATFORMS = ['rss', 'lesswrong', 'twitter', 'youtube'] as const;

export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number];

export const SOURCE_INPUT_MAX_LENGTH = 2048;

export function isSourcePlatform(value: unknown): value is SourcePlatform {
	return typeof value === 'string' && (SOURCE_PLATFORMS as readonly string[]).includes(value);
}
