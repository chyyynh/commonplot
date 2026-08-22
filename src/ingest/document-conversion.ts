function stripLeadingFrontmatter(markdown: string): string {
	return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
}

async function markdownFromDocument(
	env: CoreEnv,
	document: MarkdownDocument,
	context: { feature: string; processingId?: string },
	conversionOptions?: ConversionOptions,
): Promise<string> {
	const result = await env.AI.toMarkdown(document, {
		gateway: {
			id: 'core-ingest',
			collectLog: true,
			retries: { maxAttempts: 1 },
			metadata: {
				feature: context.feature,
				environment: env.AI_GATEWAY_ENVIRONMENT,
				...(context.processingId ? { processing_id: context.processingId } : {}),
			},
		},
		extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
		...(conversionOptions ? { conversionOptions } : {}),
	});
	if (result.format === 'error') throw new Error(`Workers AI toMarkdown failed: ${result.error}`);
	return stripLeadingFrontmatter(result.data);
}

export function markdownFromHtml(env: CoreEnv, html: string, url: string, processingId?: string): Promise<string> {
	return markdownFromDocument(
		env,
		{
			name: `${new URL(url).hostname.replace(/^www\./, '')}.html`,
			blob: new Blob([html], { type: 'text/html' }),
		},
		{ feature: 'html-to-markdown', processingId },
		{ html: { hostname: new URL(url).hostname } },
	);
}

export function markdownFromXml(env: CoreEnv, xml: string, processingId?: string): Promise<string> {
	return markdownFromDocument(
		env,
		{ name: 'openalex.grobid.xml', blob: new Blob([xml], { type: 'application/xml' }) },
		{ feature: 'xml-to-markdown', processingId },
	);
}
