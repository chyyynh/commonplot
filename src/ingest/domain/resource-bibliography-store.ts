import { type BibliographicMetadata, bibliographyFromSemanticScholar, type ResourceCreator } from '@core-shared/bibliography';
import type { PaperMetadata } from '@core-shared/types';
import type { CoreDb } from '@db/client';
import { bibliographicMetadata, resourceCreators } from '@db/schema';
import { asc, eq } from 'drizzle-orm';

type StoredBibliographicMetadata = Omit<typeof bibliographicMetadata.$inferInsert, 'createdAt' | 'resourceId' | 'updatedAt'>;

type StoredResourceCreator = Omit<typeof resourceCreators.$inferInsert, 'resourceId'>;

function jsonValuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((value, index) => jsonValuesEqual(value, right[index]));
	}
	if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
	const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key) => Object.hasOwn(rightRecord, key) && jsonValuesEqual(leftRecord[key], rightRecord[key]))
	);
}

function storedMetadata(metadata: BibliographicMetadata): StoredBibliographicMetadata {
	return {
		cslType: metadata.cslType,
		abstractText: metadata.abstractText ?? null,
		containerTitle: metadata.containerTitle ?? null,
		publisher: metadata.publisher ?? null,
		publisherPlace: metadata.publisherPlace ?? null,
		volume: metadata.volume ?? null,
		issue: metadata.issue ?? null,
		pages: metadata.pages ?? null,
		edition: metadata.edition ?? null,
		issued: metadata.issued ?? null,
		doi: metadata.doi ?? null,
		arxivId: metadata.arxivId ?? null,
		isbn: metadata.isbn ?? null,
		issn: metadata.issn ?? null,
		pmid: metadata.pmid ?? null,
		archive: metadata.archive ?? null,
		archiveLocation: metadata.archiveLocation ?? null,
		rights: metadata.rights ?? null,
		extra: metadata.extra ?? null,
	};
}

function storedCreator(creator: ResourceCreator): StoredResourceCreator {
	return {
		role: creator.role,
		orderIndex: creator.orderIndex,
		firstName: 'firstName' in creator ? (creator.firstName ?? null) : null,
		lastName: 'lastName' in creator ? (creator.lastName ?? null) : null,
		name: 'name' in creator ? creator.name : null,
		orcid: creator.orcid ?? null,
	};
}

/**
 * Materialize provider-independent paper facts beside the compatibility JSONB.
 * Callers already hold the Resource row lock, so comparison and replacement
 * remain atomic without a second concurrency protocol.
 */
export async function syncSemanticScholarBibliography(
	db: CoreDb,
	input: Readonly<{
		kind: string;
		paperEnrichment: PaperMetadata | null;
		resourceId: string;
	}>,
): Promise<boolean> {
	if (input.kind !== 'paper' || !input.paperEnrichment) return false;
	const bibliography = bibliographyFromSemanticScholar(input.paperEnrichment);
	const desiredMetadata = storedMetadata(bibliography.metadata);
	const desiredCreators = bibliography.creators.map(storedCreator);
	const [currentMetadata, currentCreators] = await Promise.all([
		db
			.select({
				cslType: bibliographicMetadata.cslType,
				abstractText: bibliographicMetadata.abstractText,
				containerTitle: bibliographicMetadata.containerTitle,
				publisher: bibliographicMetadata.publisher,
				publisherPlace: bibliographicMetadata.publisherPlace,
				volume: bibliographicMetadata.volume,
				issue: bibliographicMetadata.issue,
				pages: bibliographicMetadata.pages,
				edition: bibliographicMetadata.edition,
				issued: bibliographicMetadata.issued,
				doi: bibliographicMetadata.doi,
				arxivId: bibliographicMetadata.arxivId,
				isbn: bibliographicMetadata.isbn,
				issn: bibliographicMetadata.issn,
				pmid: bibliographicMetadata.pmid,
				archive: bibliographicMetadata.archive,
				archiveLocation: bibliographicMetadata.archiveLocation,
				rights: bibliographicMetadata.rights,
				extra: bibliographicMetadata.extra,
			})
			.from(bibliographicMetadata)
			.where(eq(bibliographicMetadata.resourceId, input.resourceId))
			.limit(1),
		db
			.select({
				role: resourceCreators.role,
				orderIndex: resourceCreators.orderIndex,
				firstName: resourceCreators.firstName,
				lastName: resourceCreators.lastName,
				name: resourceCreators.name,
				orcid: resourceCreators.orcid,
			})
			.from(resourceCreators)
			.where(eq(resourceCreators.resourceId, input.resourceId))
			.orderBy(asc(resourceCreators.orderIndex)),
	]);
	const metadataChanged = !jsonValuesEqual(currentMetadata[0] ?? null, desiredMetadata);
	const creatorsChanged = !jsonValuesEqual(currentCreators, desiredCreators);
	if (metadataChanged) {
		await db
			.insert(bibliographicMetadata)
			.values({ resourceId: input.resourceId, ...desiredMetadata })
			.onConflictDoUpdate({
				target: bibliographicMetadata.resourceId,
				set: { ...desiredMetadata, updatedAt: new Date() },
			});
	}
	if (creatorsChanged) {
		await db.delete(resourceCreators).where(eq(resourceCreators.resourceId, input.resourceId));
		if (desiredCreators.length > 0) {
			await db.insert(resourceCreators).values(
				desiredCreators.map((creator) => ({
					resourceId: input.resourceId,
					...creator,
				})),
			);
		}
	}
	return metadataChanged || creatorsChanged;
}
