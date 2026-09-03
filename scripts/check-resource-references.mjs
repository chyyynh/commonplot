import assert from 'node:assert/strict';
import { selectCrossrefReference } from '../src/ingest/crossref.ts';
import { grobidPaperIdentifierText, parseGrobidPdfHeaderTei, parseGrobidPdfReferencesTei } from '../src/ingest/grobid-tei.ts';

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

const references = parseGrobidPdfReferencesTei(`<TEI><text><listBibl>
	<biblStruct><note type="raw_reference">A. First &amp; B. Second. Direct PDF parsing, 2020.</note><idno type="DOI">10.1000/ignored</idno></biblStruct>
	<biblStruct><note type="raw_reference">C. Third. Durable workflows, 2022.</note></biblStruct>
</listBibl></text></TEI>`);
assert.deepEqual(references, ['A. First & B. Second. Direct PDF parsing, 2020.', 'C. Third. Durable workflows, 2022.']);
assert.equal(
	parseGrobidPdfReferencesTei(
		`<TEI><text><listBibl><biblStruct><note type="raw_reference">${'a'.repeat(700)}</note></biblStruct></listBibl></text></TEI>`,
	)[0]?.length,
	600,
);

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
				author: [{ family: 'Miehling' }],
				published: { 'date-parts': [[2024]] },
				title: ['Language Models in Dialogue: Conversational Maxims for Human-AI Interactions'],
			},
		],
	},
};
const crossrefCitation =
	'Erik Miehling, Manish Nagireddy, Prasanna Sattigeri, et al. 2024. Language Models in Dialogue: Conversational Maxims for Human-AI Interactions.';
assert.deepEqual(selectCrossrefReference(crossrefCitation, crossrefResponse), {
	doi: '10.18653/v1/2024.findings-emnlp.843',
	url: 'https://doi.org/10.18653/v1/2024.findings-emnlp.843',
});
assert.equal(selectCrossrefReference(crossrefCitation.replace('2024', '2023'), crossrefResponse), null);
assert.equal(
	selectCrossrefReference('Miehling et al. 2024. Language Models.', {
		status: 'ok',
		message: { items: [crossrefResponse.message.items[1]] },
	}),
	null,
);

console.info({ event: 'resource_reference_contract_smoke_passed', cases: 9 });
