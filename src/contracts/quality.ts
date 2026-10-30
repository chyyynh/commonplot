/**
 * How Core judges a Resource's quality, kept here once: the Workflow asks it, and `scripts/quality-eval.mjs` measures the
 * same question against the labeled set in `scripts/quality-gold.json`. Imports nothing, so the script runs it in Node.
 */

/** Jev reads at most 32k tokens, and Chinese is about one token a character; past this, the opening is enough to judge. */
export const QUALITY_TEXT_CHARS = 28_000;

/**
 * A monitor's entry scoring below this is not kept. On the labeled set no entry a reader would save scored below 0.31,
 * while about half of those a reader would skip did.
 */
export const MONITOR_QUALITY_MIN = 0.3;

/** The quality question, judged on the content and not its topic (the wording the threshold was measured with). */
export const QUALITY_QUESTION = {
	type: 'noul',
	instructions:
		'This platform is a reading and research library for curious, thoughtful readers, open to any subject. Readers save what is worth reading in full or worth referencing later. Judge the quality of the content, not its topic: would a thoughtful reader likely save this, because it offers substance such as original reporting, analysis, an explanation, research, a useful guide or a notable announcement? A passing quip, reaction, chatter, gossip, hiring post, advertisement, event promotion or thin rewrite of other news would not be saved.',
} as const;

/** What Jev reads: the title, if any, and the text from its start. */
export function qualityState(title: string | null, content: string): string {
	return `${title ? `Title: ${title}\n\n` : ''}${content}`.trim().slice(0, QUALITY_TEXT_CHARS);
}
