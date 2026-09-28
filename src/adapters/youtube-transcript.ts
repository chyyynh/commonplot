import type { YouTubeTranscriptLine } from '../contracts/acquired-resource';
import { paragraphsMarkdown } from '../contracts/markdown';
import type { YouTubeCaptionCue } from '../services/youtube-captions';

const LINE_MIN_CHARS = 60;
const LINE_MAX_CHARS = 300;
const SPEAKER_TURN = /\s*>>\s*/g;
const SENTENCE_END = /[.!?]\s+|[。！？]\s*/g;

type CueFragment = { endsSentence: boolean; speakerTurn: boolean; startTime: number; text: string };

/**
 * Splits a caption cue at speaker turns and sentence ends. Cues carry one
 * start/end pair, so a fragment's start is interpolated by character offset.
 */
function cueFragments(cue: YouTubeCaptionCue): CueFragment[] {
	const fragments: CueFragment[] = [];
	const length = Math.max(cue.text.length, 1);
	const startAt = (offset: number) => cue.startTime + ((cue.endTime - cue.startTime) * offset) / length;
	const turns = [...cue.text.matchAll(SPEAKER_TURN)];
	const pieces = turns.length
		? [
				{ from: 0, to: turns[0]!.index, turn: false },
				...turns.map((turn, index) => ({
					from: turn.index + turn[0].length,
					to: turns[index + 1]?.index ?? cue.text.length,
					turn: true,
				})),
			]
		: [{ from: 0, to: cue.text.length, turn: false }];
	for (const piece of pieces) {
		const pieceText = cue.text.slice(piece.from, piece.to);
		let from = 0;
		let turn = piece.turn;
		const push = (to: number, endsSentence: boolean) => {
			const text = pieceText.slice(from, to).trim();
			if (text) {
				fragments.push({ endsSentence, speakerTurn: turn, startTime: startAt(piece.from + from), text });
				turn = false;
			}
			from = to;
		};
		for (const end of pieceText.matchAll(SENTENCE_END)) push(end.index + end[0].length, true);
		push(pieceText.length, /[.!?。！？]\s*$/.test(pieceText));
	}
	return fragments;
}

/** Caption cues are screen-sized fragments; readers and translation want sentences grouped by speaker. */
export function buildTranscriptLines(cues: readonly YouTubeCaptionCue[]): YouTubeTranscriptLine[] {
	const lines: YouTubeTranscriptLine[] = [];
	let current: { speakerTurn: boolean; startTime: number; texts: string[] } | null = null;
	let length = 0;
	let lastStart = 0;
	const close = () => {
		if (current?.texts.length)
			lines.push({ speakerTurn: current.speakerTurn, startTime: current.startTime, text: current.texts.join(' ') });
		current = null;
		length = 0;
	};
	for (const cue of cues) {
		for (const fragment of cueFragments(cue)) {
			if (fragment.speakerTurn) close();
			// Rolling captions overlap; keep starts monotonic for playback lookup.
			lastStart = Math.max(lastStart, fragment.startTime);
			current ??= { speakerTurn: fragment.speakerTurn, startTime: lastStart, texts: [] };
			current.texts.push(fragment.text);
			length += fragment.text.length + 1;
			if ((fragment.endsSentence && length >= LINE_MIN_CHARS) || length >= LINE_MAX_CHARS) close();
		}
	}
	close();
	return lines;
}

/**
 * Content keeps one Markdown paragraph per line, so the translation alignment
 * path `[i]` pairs line `i` with its translation.
 */
export function transcriptMarkdown(lines: readonly YouTubeTranscriptLine[]): string {
	return paragraphsMarkdown(lines.map((line) => line.text));
}
