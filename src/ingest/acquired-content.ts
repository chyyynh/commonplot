import { sha256Hex } from '@core-shared/hash';
import { parseResourceCreators, parseStoredResourceKindMetadata } from '@core-shared/resource-metadata';
import { type ResourcePlatform, resourceIdentityForDetectedPlatform } from '@core-shared/resource-types';
import type { AcquiredMaterial } from '@core-shared/types';
import { z } from 'zod';
import { sanitizeExtractedMarkdown } from './domain/content-sanitization';

type WithSourceSnapshot<T extends AcquiredMaterial> = T extends unknown
	? Omit<T, 'markdown' | 'sourceSnapshotHash'> & { markdown: string; sourceSnapshotHash: string }
	: never;

export type NormalizedAcquiredContent<T extends ResourcePlatform = ResourcePlatform> = WithSourceSnapshot<AcquiredMaterial<T>>;

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

function sourceSnapshotHash(acquired: AcquiredMaterial, markdown: string): Promise<string> {
	const providerFacts =
		acquired.resourcePlatform !== null || acquired.subjectUrl
			? {
					...(acquired.resourcePlatform !== null ? { platformId: acquired.platformId } : {}),
					...(acquired.subjectUrl ? { subjectUrl: acquired.subjectUrl } : {}),
				}
			: null;
	return sha256Hex(
		JSON.stringify({
			resourcePlatform: acquired.resourcePlatform,
			canonicalUrl: acquired.canonicalUrl,
			fileType: acquired.fileType,
			title: acquired.title,
			markdown,
			source: acquired.source,
			originalLang: acquired.originalLang,
			publishedDate: acquired.publishedDate,
			summary: acquired.summary,
			creators: acquired.creators,
			kindMetadata: acquired.kindMetadata,
			providerFacts,
		}),
	);
}

export async function normalizeAcquiredContent<T extends AcquiredMaterial>(acquired: T): Promise<WithSourceSnapshot<T>> {
	const markdown = sanitizeExtractedMarkdown(acquired.markdown);
	return { ...acquired, markdown, sourceSnapshotHash: await sourceSnapshotHash(acquired, markdown) } as WithSourceSnapshot<T>;
}

export function acquiredContentArtifact(acquired: NormalizedAcquiredContent): ReadableStream<Uint8Array> {
	return new Blob([JSON.stringify(acquired)], { type: 'application/json' }).stream();
}

export async function readAcquiredContentArtifact<T>(artifact: ReadableStream<Uint8Array>, schema: z.ZodType<T>): Promise<T> {
	return schema.parse(await new Response(artifact).json());
}
