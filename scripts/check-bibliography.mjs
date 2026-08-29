#!/usr/bin/env node

import assert from 'node:assert/strict';
import { bibliographyFromMarkdown, MAX_REFERENCE_TEXT_CHARS } from '../src/ingest/bibliography.ts';

const NUMERIC = `## 5 Conclusion

We showed the thing [1].

# References

[1] Jinyuan Fang, Yanwen Peng, Xi Zhang, Siwei Liu,

et al. A comprehensive survey of self-evolving ai agents. arXiv preprint arXiv:2508.07407v2, 2025. [2] Junyu Luo, Weizhi Zhang. Large language model agent: a survey. *Data Science and Engineering, pages 1-31, 2025.*

-----

[3] Timo Schick and Thomas Scialom. Toolformer: language models can teach themselves to use tools. https://doi.org/10.5555/3666122.3668485, 2023.`;

const entries = bibliographyFromMarkdown(NUMERIC);
assert.deepEqual(
	entries.map((entry) => entry.marker),
	[1, 2, 3],
);
assert.deepEqual(
	entries.map((entry) => entry.ordinal),
	[1, 2, 3],
);
assert.equal(
	entries[0]?.text,
	'Jinyuan Fang, Yanwen Peng, Xi Zhang, Siwei Liu, et al. A comprehensive survey of self-evolving ai agents. arXiv preprint arXiv:2508.07407v2, 2025.',
);
assert.equal(entries[0]?.arxivId, '2508.07407');
assert.equal(entries[0]?.url, 'https://arxiv.org/abs/2508.07407');
assert.equal(entries[1]?.url, null);
assert.equal(entries[2]?.doi, '10.5555/3666122.3668485');
assert.equal(entries[2]?.url, 'https://doi.org/10.5555/3666122.3668485');

const bracketedYear = bibliographyFromMarkdown(
	'# References\n\n[1] A. First. Title one, 2020. [2] B. Second. Reprinted [2025] edition, 2021. [3] C. Third. Title three, 2022.',
);
assert.equal(bracketedYear.length, 3);
assert.match(bracketedYear[1]?.text ?? '', /\[2025\] edition/);

const lineNumbered = bibliographyFromMarkdown(
	'# References\n\n1. Mang, C.S. Advancing motor rehabilitation.\n\nBMC Sports Sci 2021, 13, 132.\n\n2. Badawi, Y. Impairment mechanisms, 2020.\n\n3. Qiu, S. Wearable exoskeletons, 2022.',
);
assert.deepEqual(
	lineNumbered.map((entry) => entry.marker),
	[1, 2, 3],
);
assert.equal(lineNumbered[0]?.text, 'Mang, C.S. Advancing motor rehabilitation. BMC Sports Sci 2021, 13, 132.');

const bulleted = bibliographyFromMarkdown(
	'## References\n\n* Bai et al. [2025] Shuai Bai. Qwen2.5-VL, 2025.\n* Chandrasegaran et al. [2024] Keshigeyan Chandrasegaran. HourVideo, 2024.\n* Zhou et al. [2025] Junjie Zhou. MLVU, 2025.',
);
assert.equal(bulleted.length, 3);
assert.deepEqual(
	bulleted.map((entry) => entry.marker),
	[null, null, null],
);

const markerGap = bibliographyFromMarkdown(
	'# References\n\n1. A. One, 2020.\n\n2. B. Two, 2021.\n\n3. C. Three, 2022.\n\n14. N. Fourteen, 2023.\n\n15. O. Fifteen, 2024.',
);
assert.deepEqual(
	markerGap.map((entry) => entry.marker),
	[1, 2, 3, 14, 15],
);

const stopped = bibliographyFromMarkdown(
	'# References\n\n[1] A. One. 2020. [2] B. Two. 2021. [3] C. Three. 2022.\n\n## A Appendix\n\n[4] Not a reference.',
);
assert.deepEqual(
	stopped.map((entry) => entry.marker),
	[1, 2, 3],
);

const dehyphenated = bibliographyFromMarkdown(
	'## Bibliography\n\n[1] Anthropic. Claude 3.7 Sonnet, Febru-\nary 2025. [2] B. Two. 2021. [3] C. Three. 2022.',
);
assert.match(dehyphenated[0]?.text ?? '', /February 2025/);

const linked = bibliographyFromMarkdown(
	'# References\n\n[1] A. One. [URL https://example.test/a](https://example.test/a). [2] B. Two. 2021. [3] C. Three. 2022.',
);
assert.equal(linked[0]?.text, 'A. One. URL https://example.test/a.');
assert.equal(linked[0]?.url, 'https://example.test/a');

assert.deepEqual(
	bibliographyFromMarkdown(
		'## References\n\nAnthropic. Introducing Claude, March 2024a.\n\nAtanasova, P. and Lioma, C. Faithfulness tests, 2023.\n\nBai, Y. Constitutional AI, 2022.',
	),
	[],
);
assert.deepEqual(bibliographyFromMarkdown('# Intro\n\nSomething [1] and [2] and [3].'), []);
assert.deepEqual(bibliographyFromMarkdown('# References\n\n[1] A. One. [2] B. Two.'), []);

const normalized = bibliographyFromMarkdown(
	'# References\n\n[1] DOI 10.1000/EXAMPLE. arXiv:2402.12345v9. [2] arXiv:2401.12345v9. [3] https://user:secret@example.test/private.',
);
assert.equal(normalized[0]?.doi, '10.1000/example');
assert.equal(normalized[0]?.arxivId, '2402.12345');
assert.equal(normalized[0]?.url, 'https://doi.org/10.1000/example');
assert.equal(normalized[1]?.arxivId, '2401.12345');
assert.equal(normalized[2]?.url, null);

const arxivSeparators = bibliographyFromMarkdown(
	'# References\n\n[1] arXiv 2401.12345v9. [2] arXiv.2402.12345v2. [3] arXiv:hep-th/9901001v3.',
);
assert.deepEqual(
	arxivSeparators.map(({ arxivId }) => arxivId),
	['2401.12345', '2402.12345', 'hep-th/9901001'],
);

const balancedDoiPunctuation = bibliographyFromMarkdown(
	'# References\n\n[1] DOI 10.1002/(SICI)1099-0844(199912)17:4. [2] A. Two. 2021. [3] B. Three. 2022.',
);
assert.equal(balancedDoiPunctuation[0]?.doi, '10.1002/(sici)1099-0844(199912)17:4');
assert.equal(balancedDoiPunctuation[0]?.url, 'https://doi.org/10.1002/(sici)1099-0844(199912)17:4');

const longText = bibliographyFromMarkdown(`# References\n\n[1] ${'a'.repeat(700)} [2] B. Two. 2021. [3] C. Three. 2022.`)[0]?.text;
assert.equal(longText?.length, MAX_REFERENCE_TEXT_CHARS);
assert.ok(longText?.endsWith('…'));

console.info({
	event: 'bibliography_contract_smoke_passed',
	historicalBehaviorCases: 12,
	additionalContractCases: 6,
});
