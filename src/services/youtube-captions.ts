import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { coreExports } from '../exports.ts';
import { errorMessage } from './response.ts';

const CAPTION_FETCH_TIMEOUT_MS = 8_000;
/**
 * YouTube bot-checks individual Cloudflare egress machines. A fresh Durable
 * Object lands on another machine, and about 40% of machines pass (measured
 * 2026-09-26, independent of region), so retry on new instances, not in place.
 */
const CAPTION_FETCHER_ATTEMPTS = 8;
/** Attempts run in waves this wide: with 40% passing, three machines at once usually include one that passes. */
const CAPTION_ATTEMPT_WAVE = 3;
/** No new attempt starts after this, so the last one still ends inside the captions step's timeout. */
const CAPTION_DEADLINE_MS = 90_000;
const CAPTION_FETCHER_HINTS: readonly DurableObjectLocationHint[] = ['wnam', 'enam', 'weur', 'apac', 'oc', 'eeur', 'sam', 'me'];
const INNERTUBE_PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const ANDROID_CLIENT_VERSION = '20.10.38';
const ANDROID_USER_AGENT = `com.google.android.youtube/${ANDROID_CLIENT_VERSION} (Linux; U; Android 14)`;
const WEB_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)';

export type YouTubeCaptionCue = Readonly<{ startTime: number; endTime: number; text: string }>;
export type YouTubeCaptions = { cues: YouTubeCaptionCue[]; language: string | null };
type CaptionAttempt = ({ status: 'fetched' } & YouTubeCaptions) | { status: 'withheld' | 'unavailable'; reason: string };

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

/** The watch page inlines the same player response as `var ytInitialPlayerResponse = {...};</script>`. */
async function watchPagePlayer(videoId: string): Promise<PlayerResponse | string> {
	const response = await captionFetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: { 'User-Agent': WEB_USER_AGENT } });
	const html = await response.text();
	if (!response.ok) return `watch page HTTP ${response.status}`;
	if (html.includes('class="g-recaptcha"')) return 'watch page recaptcha';
	const json = /var ytInitialPlayerResponse = (\{.*?\});(?:var |<\/script>)/s.exec(html)?.[1];
	if (!json) return 'watch page without player response';
	return PlayerResponseSchema.parse(JSON.parse(json));
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

// Rolling ASR captions interleave `aAppend` line-break events that carry no duration.
const TimedTextSchema = z.object({
	events: z
		.array(
			z.object({
				tStartMs: z.number().nonnegative(),
				dDurationMs: z.number().nonnegative().optional(),
				segs: z.array(z.object({ utf8: z.string() })).optional(),
			}),
		)
		.default([]),
});

/** Timedtext JSON (`fmt=json3`): millisecond events whose segments hold plain text. */
async function fetchCaptionCues(videoId: string, track: CaptionTrack): Promise<YouTubeCaptionCue[]> {
	const url = new URL(track.baseUrl);
	if (!url.hostname.endsWith('.youtube.com')) throw new Error(`YouTube caption track ${videoId} points outside youtube.com`);
	url.searchParams.set('fmt', 'json3');
	const response = await captionFetch(url.href, { headers: { 'User-Agent': WEB_USER_AGENT } });
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`YouTube timedtext ${videoId} returned HTTP ${response.status}`);
	}
	return TimedTextSchema.parse(await response.json()).events.flatMap(({ tStartMs, dDurationMs, segs }) => {
		const text = segs
			?.map((segment) => segment.utf8)
			.join('')
			.trim();
		if (dDurationMs === undefined || !text) return [];
		return [{ startTime: tStartMs / 1000, endTime: (tStartMs + dDurationMs) / 1000, text }];
	});
}

/**
 * A video no machine can play: removed, private, members-only, age-gated or a stream not live. A sign-in demand that
 * asks to prove the caller is not a bot is the bot check instead.
 */
function unplayable(status: PlayerResponse['playabilityStatus']) {
	if (!status) return false;
	if (status.status === 'LOGIN_REQUIRED') return !/\bbot\b/i.test(status.reason ?? '');
	return ['ERROR', 'UNPLAYABLE', 'LIVE_STREAM_OFFLINE'].includes(status.status);
}

/** One attempt from the current machine; a withheld or unplayable player is a result, not an error. */
async function attemptCaptions(videoId: string, audioLanguage: string | null): Promise<CaptionAttempt> {
	const withheld: string[] = [];
	for (const load of [innerTubePlayer, watchPagePlayer]) {
		const player = await load(videoId).catch((error: unknown) => errorMessage(error));
		if (typeof player !== 'string' && unplayable(player.playabilityStatus))
			return { status: 'unavailable', reason: `${player.playabilityStatus?.status}: ${player.playabilityStatus?.reason ?? 'no reason'}` };
		if (typeof player === 'string' || player.playabilityStatus?.status !== 'OK') {
			withheld.push(
				typeof player === 'string'
					? player
					: `${player.playabilityStatus?.status ?? 'no status'}: ${player.playabilityStatus?.reason ?? 'no reason'}`,
			);
			continue;
		}
		const track = originalTrack(player, audioLanguage);
		if (!track) return { status: 'fetched', cues: [], language: null };
		return { status: 'fetched', cues: await fetchCaptionCues(videoId, track), language: track.languageCode };
	}
	return { status: 'withheld', reason: withheld.join('; ') };
}

/** Stateless: each instance exists only to run an attempt from another egress machine. */
export class YouTubeCaptionFetcher extends DurableObject<CoreEnv> {
	attempt(videoId: string, audioLanguage: string | null): Promise<CaptionAttempt> {
		return attemptCaptions(videoId, audioLanguage);
	}
}

/**
 * Captions in the video's spoken language. Returns no cues when the video has none or cannot be played, and null when
 * YouTube's bot check withheld them on every attempt, so whether it has any is unknown.
 */
export async function fetchYouTubeCaptions(videoId: string, audioLanguage: string | null): Promise<YouTubeCaptions | null> {
	const withheld: string[] = [];
	const deadline = Date.now() + CAPTION_DEADLINE_MS;
	const run = (attempt: number) => {
		const hint = CAPTION_FETCHER_HINTS[(attempt - 1) % CAPTION_FETCHER_HINTS.length];
		// A failed timedtext fetch or instance is just another lost draw.
		return (
			attempt === 0 || !hint
				? attemptCaptions(videoId, audioLanguage)
				: coreExports.YouTubeCaptionFetcher.get(coreExports.YouTubeCaptionFetcher.newUniqueId(), { locationHint: hint }).attempt(
						videoId,
						audioLanguage,
					)
		)
			.catch((error: unknown): CaptionAttempt => ({ status: 'withheld', reason: errorMessage(error) }))
			.then((result) => ({ attempt, where: hint ?? 'workflow', result }));
	};
	for (let first = 0; first < CAPTION_FETCHER_ATTEMPTS && Date.now() < deadline; first += CAPTION_ATTEMPT_WAVE) {
		const wave = Array.from({ length: Math.min(CAPTION_ATTEMPT_WAVE, CAPTION_FETCHER_ATTEMPTS - first) }, (_, index) => run(first + index));
		// The first attempt that decides wins; the wave's others are left to finish unread.
		const decided = await new Promise<Awaited<ReturnType<typeof run>> | null>((resolve) => {
			let pending = wave.length;
			for (const attempt of wave)
				void attempt.then((outcome) => {
					if (outcome.result.status !== 'withheld') resolve(outcome);
					else {
						withheld.push(`${outcome.where}: ${outcome.result.reason}`);
						if (--pending === 0) resolve(null);
					}
				});
		});
		if (decided?.result.status === 'fetched') {
			const { cues, language } = decided.result;
			console.info({ tag: 'YOUTUBE', msg: 'Captions fetched', videoId, attempt: decided.attempt, count: cues.length, language });
			return { cues, language };
		}
		if (decided?.result.status === 'unavailable') {
			console.info({ tag: 'YOUTUBE', msg: 'Video unplayable; using video description', videoId, reason: decided.result.reason });
			return { cues: [], language: null };
		}
	}
	console.warn({ tag: 'YOUTUBE', msg: 'Captions withheld on every attempt; using video description', videoId, withheld });
	return null;
}
