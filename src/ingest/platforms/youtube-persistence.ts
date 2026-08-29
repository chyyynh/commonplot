import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { YouTubeResourceData } from './youtube';

export type PreparedYouTubeData = Readonly<{
	highlightsGeneratedAt: Date | null;
	input: YouTubeResourceData;
}>;

export function prepareYouTubeData(input: YouTubeResourceData): PreparedYouTubeData {
	const highlightsGeneratedAt = input.highlights ? new Date(input.highlights.generatedAt) : null;
	if (highlightsGeneratedAt && Number.isNaN(highlightsGeneratedAt.getTime())) {
		throw new TypeError('YouTube highlights generation date is invalid');
	}
	return { highlightsGeneratedAt, input };
}

export async function persistYouTubeData(db: NodePgDatabase, resourceId: string, data: PreparedYouTubeData): Promise<void> {
	const { highlightsGeneratedAt, input } = data;
	await db.execute(sql`
		INSERT INTO youtube_transcripts (
			resource_id, transcript, language, chapters, chapters_from_description,
			fetched_at, ai_highlights, highlights_generated_at
		) VALUES (
			${resourceId}::uuid, ${JSON.stringify(input.transcript.segments)}::jsonb, ${input.transcript.language},
			${JSON.stringify(input.transcript.chapters)}::jsonb, ${input.transcript.chaptersFromDescription},
			NOW(), ${input.highlights ? JSON.stringify(input.highlights) : null}::jsonb, ${highlightsGeneratedAt}
		)
		ON CONFLICT (resource_id) DO UPDATE SET
			transcript = EXCLUDED.transcript,
			language = EXCLUDED.language,
			chapters = EXCLUDED.chapters,
			chapters_from_description = EXCLUDED.chapters_from_description,
			fetched_at = NOW(),
			ai_highlights = CASE
				WHEN jsonb_array_length(EXCLUDED.chapters) > 0 THEN NULL
				ELSE COALESCE(EXCLUDED.ai_highlights, youtube_transcripts.ai_highlights)
			END,
			highlights_generated_at = CASE
				WHEN jsonb_array_length(EXCLUDED.chapters) > 0 THEN NULL
				ELSE COALESCE(EXCLUDED.highlights_generated_at, youtube_transcripts.highlights_generated_at)
			END
	`);
}
