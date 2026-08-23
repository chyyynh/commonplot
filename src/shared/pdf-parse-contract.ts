import { z } from 'zod';

export const PDF_PARSE_CONTRACT = {
	parserName: 'liteparse',
	parserVersion: '2.13.1',
	workingSchemaVersion: 1,
	litePolicyRevision: 'liteparse-pages-v3',
	enhancementPolicyRevision: 'selective-llamaparse-v2',
	maxEnhancedPages: 25,
} as const;

export type PdfParseProcessingPolicy = 'lite' | 'selective-enhancement';

/** App-authorized snapshot passed to Core; Core never re-derives entitlement. */
export type PdfParseAdmissionSnapshot = Readonly<{
	parseRunId: string;
	fileResourceId: string;
	revision: number;
	inputContentHash: string;
	workingSchemaVersion: typeof PDF_PARSE_CONTRACT.workingSchemaVersion;
	parserVersion: typeof PDF_PARSE_CONTRACT.parserVersion;
	policyRevision: typeof PDF_PARSE_CONTRACT.litePolicyRevision | typeof PDF_PARSE_CONTRACT.enhancementPolicyRevision;
	processingPolicy: PdfParseProcessingPolicy;
	entitlementFeature: string | null;
	maxEnhancedPages: number | null;
	maxProviderCredits: string | null;
}>;

export const PdfParseAdmissionSchema = z
	.object({
		parseRunId: z.string().uuid(),
		fileResourceId: z.string().uuid(),
		revision: z.number().int().positive(),
		inputContentHash: z.string().regex(/^[0-9a-f]{64}$/),
		workingSchemaVersion: z.literal(PDF_PARSE_CONTRACT.workingSchemaVersion),
		parserVersion: z.literal(PDF_PARSE_CONTRACT.parserVersion),
		policyRevision: z.union([z.literal(PDF_PARSE_CONTRACT.litePolicyRevision), z.literal(PDF_PARSE_CONTRACT.enhancementPolicyRevision)]),
		processingPolicy: z.enum(['lite', 'selective-enhancement']),
		entitlementFeature: z.string().trim().min(1).max(64).nullable(),
		maxEnhancedPages: z.number().int().positive().nullable(),
		maxProviderCredits: z
			.string()
			.regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,4})?$/)
			.nullable(),
	})
	.strict()
	.superRefine((admission, context) => {
		if (admission.processingPolicy === 'lite') {
			if (
				admission.policyRevision !== PDF_PARSE_CONTRACT.litePolicyRevision ||
				admission.entitlementFeature !== null ||
				admission.maxEnhancedPages !== null ||
				admission.maxProviderCredits !== null
			) {
				context.addIssue({
					code: 'custom',
					message: 'Lite PDF admission contains enhancement fields',
				});
			}
			return;
		}
		if (
			admission.policyRevision !== PDF_PARSE_CONTRACT.enhancementPolicyRevision ||
			admission.entitlementFeature === null ||
			admission.maxEnhancedPages === null
		) {
			context.addIssue({
				code: 'custom',
				message: 'Enhanced PDF admission is incomplete',
			});
		}
	});

export function parsePdfParseAdmission(value: unknown): PdfParseAdmissionSnapshot {
	return PdfParseAdmissionSchema.parse(value);
}
