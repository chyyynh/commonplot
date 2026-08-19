// Field-level parsing primitives shared by the resource domain stores.

import { isResourceSourceSnapshotHash } from '@core-shared/resource-types';

export function cleanString(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string') throw new Error(`Invalid resource field: expected string`);
	const trimmed = value.trim();
	return trimmed.length ? trimmed : null;
}

export function requiredString(value: unknown, field: string): string {
	const text = cleanString(value);
	if (!text) throw new Error(`Invalid ${field}: expected non-empty string`);
	return text;
}

export function stringArrayValue(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
		throw new Error(`Invalid ${field}: expected string[]`);
	}
	return value;
}

export function dateValue(value: unknown, field: string): Date {
	const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
	if (!date || Number.isNaN(date.getTime())) throw new Error(`Invalid ${field}: expected date`);
	return date;
}

export function storedResourceSourceRevision(value: unknown, resourceId: string): string {
	if (!isResourceSourceSnapshotHash(value)) {
		throw new Error(`Invalid source_revision for ${resourceId}`);
	}
	return value;
}
