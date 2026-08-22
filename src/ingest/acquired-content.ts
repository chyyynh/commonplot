import type { WorkflowStepConfig } from 'cloudflare:workers';
import { sha256Hex } from '@core-shared/hash';
import { parseResourceCreators, parseStoredResourceKindMetadata } from '@core-shared/resource-metadata';
import { type ResourcePlatform, resourceIdentityForDetectedPlatform } from '@core-shared/resource-types';
import type { AcquiredMaterial } from '@core-shared/types';
import { z } from 'zod';

type WithSourceSnapshot<T extends AcquiredMaterial> = T extends unknown ? T & { sourceSnapshotHash: string } : never;

export type NormalizedAcquiredContent<T extends ResourcePlatform = ResourcePlatform> = WithSourceSnapshot<AcquiredMaterial<T>>;

export const DEFAULT_ACQUISITION_STEP_CONFIG = {
	retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
	timeout: '120 seconds',
} as const satisfies WorkflowStepConfig;

const nullableStringSchema = z.string().nullable();
const acquiredContentShape = {
	canonicalUrl: z.url().optional(),
	fileType: nullableStringSchema,
	title: z.string().trim().min(1),
	markdown: z.string(),
	previewImageUrl: nullableStringSchema.optional(),
	subjectUrl: z.string().optional(),
	source: z.string().trim().min(1),
	originalLang: nullableStringSchema,
	publishedDate: nullableStringSchema,
	summary: nullableStringSchema,
	creators: z.unknown().transform((value) => parseResourceCreators(value)),
	sourceSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
};

export function acquiredContentSchema<const T extends ResourcePlatform, Extra extends z.ZodRawShape>(resourcePlatform: T, extra: Extra) {
	const kind = resourcePlatform === null ? 'blog' : resourceIdentityForDetectedPlatform(resourcePlatform).kind;
	return z.looseObject({
		resourcePlatform: z.literal(resourcePlatform),
		...acquiredContentShape,
		kindMetadata: z.unknown().transform((value) => parseStoredResourceKindMetadata(kind, value)),
		...extra,
	});
}

export const NullPlatformAcquiredContentSchema: z.ZodType<NormalizedAcquiredContent<null>> = acquiredContentSchema(null, {});

export async function normalizeAcquiredContent<T extends AcquiredMaterial>(acquired: T): Promise<WithSourceSnapshot<T>> {
	const providerFacts =
		acquired.resourcePlatform !== null || acquired.subjectUrl
			? {
					...(acquired.resourcePlatform !== null ? { platformId: acquired.platformId } : {}),
					...(acquired.subjectUrl ? { subjectUrl: acquired.subjectUrl } : {}),
				}
			: null;
	const sourceSnapshotHash = await sha256Hex(
		JSON.stringify({
			resourcePlatform: acquired.resourcePlatform,
			canonicalUrl: acquired.canonicalUrl,
			fileType: acquired.fileType,
			title: acquired.title,
			markdown: acquired.markdown.trim(),
			source: acquired.source,
			originalLang: acquired.originalLang,
			publishedDate: acquired.publishedDate,
			summary: acquired.summary,
			creators: acquired.creators,
			kindMetadata: acquired.kindMetadata,
			providerFacts,
		}),
	);
	return { ...acquired, sourceSnapshotHash } as WithSourceSnapshot<T>;
}
