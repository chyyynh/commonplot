import { z } from 'zod';

const CAPTION_FETCH_TIMEOUT_MS = 8_000;
const INNERTUBE_PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const ANDROID_CLIENT_VERSION = '20.10.38';
const ANDROID_USER_AGENT = `com.google.android.youtube/${ANDROID_CLIENT_VERSION} (Linux; U; Android 14)`;
const WEB_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)';

export type YouTubeCaptionCue = Readonly<{ startTime: number; endTime: number; text: string }>;

const CaptionTrackSchema = z.object({
	baseUrl: z.string().min(1),
	languageCode: z.string().min(1),
	kind: z.string().optional(),
});
type CaptionTrack = z.infer<typeof CaptionTrackSchema>;

const PlayerResponseSchema = z.object({
	playabilityStatus: z.object({ status: z.string(), reason: z.string().optional() }).optional(),
	captions: z
		.object({
			playerCaptionsTracklistRenderer: z.object({
				captionTracks: z.array(CaptionTrackSchema).optional(),
				audioTracks: z.array(z.object({ defaultCaptionTrackIndex: z.number().int().optional() })).optional(),
			}),
		})
		.optional(),
});
type PlayerResponse = z.infer<typeof PlayerResponseSchema>;

/** YouTube withheld the player (bot check, rate limit); another attempt may be served normally. */
export class YouTubeCaptionsWithheldError extends Error {
	override name = 'YouTubeCaptionsWithheldError';
}

function captionFetch(input: string, init: RequestInit = {}) {
	return fetch(input, { ...init, signal: AbortSignal.timeout(CAPTION_FETCH_TIMEOUT_MS) });
}

async function innerTubePlayer(videoId: string): Promise<PlayerResponse | string> {
	const response = await captionFetch(INNERTUBE_PLAYER_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'User-Agent': ANDROID_USER_AGENT },
		body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: ANDROID_CLIENT_VERSION } }, videoId }),
	});
	if (!response.ok) {
		await response.body?.cancel();
		return `InnerTube HTTP ${response.status}`;
	}
	return PlayerResponseSchema.parse(await response.json());
}

/** The watch page inlines the same player response as `var ytInitialPlayerResponse = {...};`. */
async function watchPagePlayer(videoId: string): Promise<PlayerResponse | string> {
	const response = await captionFetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: { 'User-Agent': WEB_USER_AGENT } });
	const html = await response.text();
	if (!response.ok) return `watch page HTTP ${response.status}`;
	if (html.includes('class="g-recaptcha"')) return 'watch page recaptcha';
	const start = html.indexOf('var ytInitialPlayerResponse = ');
	if (start === -1) return 'watch page without player response';
	const jsonStart = start + 'var ytInitialPlayerResponse = '.length;
	let depth = 0;
	for (let i = jsonStart; i < html.length; i++) {
		if (html[i] === '{') depth++;
		else if (html[i] === '}' && --depth === 0) return PlayerResponseSchema.parse(JSON.parse(html.slice(jsonStart, i + 1)));
	}
	return 'watch page player response is truncated';
}

/**
 * Dubbed videos list caption tracks for every dubbed audio language, sorted by
 * name, so the first track is often an Arabic dub. Prefer the spoken language,
 * then the track YouTube itself selects for the original audio.
 */
function originalTrack(player: PlayerResponse, audioLanguage: string | null): CaptionTrack | null {
	const renderer = player.captions?.playerCaptionsTracklistRenderer;
	const tracks = renderer?.captionTracks ?? [];
	if (!tracks.length) return null;
	const language = audioLanguage?.toLowerCase();
	const base = language?.split('-')[0];
	const spoken = [
		...tracks.filter((track) => track.languageCode.toLowerCase() === language),
		...tracks.filter((track) => track.languageCode.toLowerCase() !== language && track.languageCode.split('-')[0]?.toLowerCase() === base),
	];
	const defaultIndex = renderer?.audioTracks?.[0]?.defaultCaptionTrackIndex;
	return (
		spoken.find((track) => track.kind !== 'asr') ??
		spoken[0] ??
		(defaultIndex === undefined ? undefined : tracks[defaultIndex]) ??
		tracks.find((track) => track.kind === 'asr') ??
		tracks[0]!
	);
}

function decodeEntities(text: string) {
	return (
		text
			// srv1 escapes the already-escaped caption text, so `&amp;` goes first.
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#39;|&apos;/g, "'")
			.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
			.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
	);
}

/** Classic timedtext XML (`fmt=srv1`): `<text start="s" dur="s">…</text>`, timestamps in seconds. */
async function fetchCaptionCues(videoId: string, track: CaptionTrack): Promise<YouTubeCaptionCue[]> {
	const url = new URL(track.baseUrl);
	if (!url.hostname.endsWith('.youtube.com')) throw new Error(`YouTube caption track ${videoId} points outside youtube.com`);
	url.searchParams.set('fmt', 'srv1');
	const response = await captionFetch(url.href, { headers: { 'User-Agent': WEB_USER_AGENT } });
	if (!response.ok) {
		await response.body?.cancel();
		throw new YouTubeCaptionsWithheldError(`YouTube timedtext ${videoId} returned HTTP ${response.status}`);
	}
	const xml = await response.text();
	return [...xml.matchAll(/<text start="([^"]*)" dur="([^"]*)"[^>]*>([^<]*)<\/text>/g)].flatMap(([, start, dur, raw]) => {
		const startTime = Number(start);
		const duration = Number(dur);
		if (!Number.isFinite(startTime) || startTime < 0 || !Number.isFinite(duration) || duration < 0) {
			throw new Error(`YouTube transcript ${videoId} has an invalid cue timestamp`);
		}
		const text = decodeEntities(raw ?? '').trim();
		return text ? [{ startTime, endTime: startTime + duration, text }] : [];
	});
}

/**
 * Captions in the video's spoken language. Returns no cues only when YouTube
 * served the player and it lists no captions; a withheld player throws so the
 * caller can retry.
 */
export async function fetchYouTubeCaptions(
	videoId: string,
	audioLanguage: string | null,
): Promise<{ cues: YouTubeCaptionCue[]; language: string | null }> {
	const withheld: string[] = [];
	for (const load of [innerTubePlayer, watchPagePlayer]) {
		const player = await load(videoId).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
		if (typeof player === 'string' || player.playabilityStatus?.status !== 'OK') {
			withheld.push(
				typeof player === 'string'
					? player
					: `${player.playabilityStatus?.status ?? 'no status'}: ${player.playabilityStatus?.reason ?? 'no reason'}`,
			);
			continue;
		}
		const track = originalTrack(player, audioLanguage);
		if (!track) return { cues: [], language: null };
		return { cues: await fetchCaptionCues(videoId, track), language: track.languageCode };
	}
	throw new YouTubeCaptionsWithheldError(`YouTube withheld the player for ${videoId}: ${withheld.join('; ')}`);
}
