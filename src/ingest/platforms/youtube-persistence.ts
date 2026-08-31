import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { YouTubeResourceData } from './youtube';

export async function persistYouTubeData(db: NodePgDatabase, resourceId: string, input: YouTubeResourceData): Promise<void> {
	await db.execute(sql`
		INSERT INTO youtube_transcripts (resource_id, transcript, language, chapters, ai_highlights)
		VALUES (
			${resourceId}::uuid, ${JSON.stringify(input.transcript.segments)}::jsonb, ${input.transcript.language},
			${JSON.stringify(input.transcript.chapters)}::jsonb, ${input.highlights ? JSON.stringify(input.highlights) : null}::jsonb
		)
		ON CONFLICT (resource_id) DO UPDATE SET
			transcript = EXCLUDED.transcript,
			language = EXCLUDED.language,
			chapters = EXCLUDED.chapters,
			ai_highlights = CASE
				WHEN jsonb_array_length(EXCLUDED.chapters) > 0 THEN NULL
				ELSE COALESCE(EXCLUDED.ai_highlights, youtube_transcripts.ai_highlights)
			END
	`);
}
