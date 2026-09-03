import assert from 'node:assert/strict';
import { alignCitationMentions } from '../src/ingest/citation-alignment.ts';
import { selectCrossrefReference } from '../src/ingest/crossref.ts';
import { grobidPaperIdentifierText, parseGrobidPdfFulltextTei, parseGrobidPdfHeaderTei } from '../src/ingest/grobid-tei.ts';

const parsedPdfHeader = parseGrobidPdfHeaderTei(`<TEI><teiHeader><fileDesc>
	<titleStmt><title level="a" type="main">Stigmergy &amp; Open Collaboration</title></titleStmt>
	<sourceDesc><biblStruct><analytic>
		<author><persName><forename>Alex</forename><surname>Smith</surname></persName></author>
		<author><persName><forename>Bo</forename><surname>Chen</surname></persName></author>
		<idno type="DOI">10.1000/HEADER</idno>
	</analytic></biblStruct></sourceDesc>
</fileDesc></teiHeader></TEI>`);
assert.deepEqual(parsedPdfHeader, {
	arxivId: null,
	authors: ['Alex Smith', 'Bo Chen'],
	doi: '10.1000/header',
	title: 'Stigmergy & Open Collaboration',
	url: 'https://doi.org/10.1000/header',
});
assert.equal(grobidPaperIdentifierText(parsedPdfHeader), 'DOI: 10.1000/header');
assert.equal(
	grobidPaperIdentifierText(
		parseGrobidPdfHeaderTei(
			'<TEI><teiHeader><fileDesc><titleStmt><title type="main">Report</title></titleStmt></fileDesc></teiHeader></TEI>',
		),
	),
	null,
	'GROBID header metadata without a canonical academic identifier must not promote an uploaded PDF to paper',
);

const references = parseGrobidPdfFulltextTei(`<TEI><text><listBibl>
	<biblStruct><note type="raw_reference">A. First &amp; B. Second. Direct PDF parsing, 2020.</note><idno type="DOI">10.1000/ignored</idno></biblStruct>
	<biblStruct><note type="raw_reference">C. Third. Durable workflows, 2022.</note></biblStruct>
</listBibl></text></TEI>`).references.map(({ text }) => text);
assert.deepEqual(references, ['A. First & B. Second. Direct PDF parsing, 2020.', 'C. Third. Durable workflows, 2022.']);
assert.equal(
	parseGrobidPdfFulltextTei(
		`<TEI><text><listBibl><biblStruct><note type="raw_reference">${'a'.repeat(700)}</note></biblStruct></listBibl></text></TEI>`,
	).references[0]?.text.length,
	600,
);

const fulltext = parseGrobidPdfFulltextTei(`<TEI>
	<teiHeader><sourceDesc><biblStruct xml:id="paper"><note type="raw_reference">The paper itself</note></biblStruct></sourceDesc></teiHeader>
	<text><body><div><head>Prior work</head><p>
		<s>One result is established <ref type="bibr" target="#b0">[1]</ref>.</s>
		<s>Two sources support the claim <ref type="bibr" target="#b1">[2,</ref><ref type="bibr" target="#b3">5]</ref>.</s>
	</p></div></body><back><listBibl>
		<biblStruct xml:id="b0"><note type="raw_reference">A. First. Direct PDF parsing, 2020.</note></biblStruct>
		<biblStruct xml:id="b1"><note type="raw_reference">B. Second. Durable workflows, 2021.</note></biblStruct>
		<biblStruct xml:id="b3"><note type="raw_reference">D. Fourth. Safe citation links, 2023.</note></biblStruct>
	</listBibl></back></text>
</TEI>`);
assert.deepEqual(fulltext.references, [
	{ key: 'b0', label: '1', text: 'A. First. Direct PDF parsing, 2020.' },
	{ key: 'b1', label: '2', text: 'B. Second. Durable workflows, 2021.' },
	{ key: 'b3', label: '5', text: 'D. Fourth. Safe citation links, 2023.' },
]);
assert.deepEqual(fulltext.mentions, [
	{ context: 'One result is established [1] .', markerText: '[1]', section: 'Prior work', targetKeys: ['b0'] },
	{
		context: 'Two sources support the claim [2, 5] .',
		markerText: '[2, 5]',
		section: 'Prior work',
		targetKeys: ['b1', 'b3'],
	},
]);

const markdown = `# Paper\n\n## Prior work\n\nOne result is established [1].\n\nTwo sources support the claim [2, 5].`;
const aligned = alignCitationMentions(
	markdown,
	fulltext.mentions.map((mention) => ({
		...mention,
		referenceOrdinals: mention.targetKeys.map((key) => fulltext.references.findIndex((reference) => reference.key === key) + 1),
	})),
);
assert.equal(markdown.slice(aligned[0]?.contentStart ?? 0, aligned[0]?.contentEnd ?? 0), '[1]');
assert.deepEqual(aligned[1]?.referenceOrdinals, [2, 3]);
assert.equal(markdown.slice(aligned[1]?.contentStart ?? 0, aligned[1]?.contentEnd ?? 0), '[2, 5]');
assert.equal(
	alignCitationMentions('Repeated [1]. Repeated [1].', [
		{ context: 'Repeated [1].', markerText: '[1]', referenceOrdinals: [1], section: null },
	])[0]?.contentStart,
	null,
	'ambiguous sentence matches must never produce an inline offset',
);

const pseudoTagMarkdown =
	'<Mattern (2020)</Mattern> contextualizes that this is the party line in other creative industries such as fashion and architecture: proponents reassure that AI-driven design tools will not make human workers redundant.';
const pseudoTagAligned = alignCitationMentions(pseudoTagMarkdown, [
	{
		context:
			'Mattern (2020) contextualizes that this is the party line in other creative industries such as fashion and architecture: proponents reassure that AI-driven design tools will not make human workers redundant.',
		markerText: 'Mattern (2020)',
		referenceOrdinals: [34],
		section: 'Manual creativity',
	},
])[0];
assert.equal(pseudoTagAligned?.contentStart, 1, 'extraction pseudo-tags must not prevent an otherwise exact citation alignment');
assert.equal(pseudoTagMarkdown.slice(pseudoTagAligned?.contentStart ?? 0, pseudoTagAligned?.contentEnd ?? 0), 'Mattern (2020)');

const crossrefResponse = {
	status: 'ok',
	message: {
		items: [
			{
				DOI: '10.1007/978-3-031-02176-3_1',
				author: [{ family: 'McTear' }],
				published: { 'date-parts': [[2021]] },
				title: ['Introducing Dialogue Systems'],
			},
			{
				DOI: '10.18653/V1/2024.FINDINGS-EMNLP.843',
				author: [{ family: 'Miehling', given: 'Erik' }],
				'container-title': ['Findings of EMNLP'],
				published: { 'date-parts': [[2024]] },
				title: ['Language Models in Dialogue: Conversational Maxims for Human-AI Interactions'],
			},
		],
	},
};
const crossrefCitation =
	'Erik Miehling, Manish Nagireddy, Prasanna Sattigeri, et al. 2024. Language Models in Dialogue: Conversational Maxims for Human-AI Interactions.';
assert.deepEqual(selectCrossrefReference(crossrefCitation, crossrefResponse), {
	authors: ['Erik Miehling'],
	doi: '10.18653/v1/2024.findings-emnlp.843',
	title: 'Language Models in Dialogue: Conversational Maxims for Human-AI Interactions',
	url: 'https://doi.org/10.18653/v1/2024.findings-emnlp.843',
	venue: 'Findings of EMNLP',
	year: 2024,
});
assert.equal(selectCrossrefReference(crossrefCitation.replace('2024', '2023'), crossrefResponse), null);
assert.equal(
	selectCrossrefReference('Miehling et al. 2024. Language Models.', {
		status: 'ok',
		message: { items: [crossrefResponse.message.items[1]] },
	}),
	null,
);

console.info({ event: 'resource_reference_contract_smoke_passed', cases: 17 });
