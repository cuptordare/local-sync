/**
 * Importing data written by earlier versions of this library, which stored "records":
 * `{ id, data, meta: { updatedAt, deleted, ... } }`, both on the device and in remote blobs
 * (`{ records: [...] }`).
 *
 * Each record becomes an entry stamped from its `meta.updatedAt`, written by the fixed device
 * `"legacy"`. The conversion depends only on the record, so every device that imports the
 * same record gets the same entry, and they converge. Any write made with the new version is
 * stamped later than the data it was made from, so it wins over imported entries.
 */
import { stampAt } from "../crdt/hlc.js";
import type { Entry } from "../crdt/lww-map.js";
import { canonical, newerEntry } from "../crdt/lww-map.js";

/** The `device` of every imported entry. */
export const LEGACY_DEVICE = "legacy";

interface LegacyRecord {
	id: string;
	data?: unknown;
	meta: { updatedAt?: unknown; deleted?: unknown };
}

function isLegacyRecord(value: unknown): value is LegacyRecord {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Partial<LegacyRecord>;
	return (
		typeof r.id === "string" && typeof r.meta === "object" && r.meta !== null
	);
}

/** A small deterministic hash (FNV-1a, 32-bit). */
function hash(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Convert one record (or `undefined` if it isn't one). */
export function fromLegacyRecord(value: unknown): [string, Entry] | undefined {
	if (!isLegacyRecord(value)) return undefined;
	const { updatedAt } = value.meta;
	const time =
		typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt > 0
			? updatedAt
			: 0;
	const deleted = value.meta.deleted === true;
	const content = deleted ? null : (value.data ?? null);
	return [
		value.id,
		{
			value: content,
			deleted,
			// The counter part comes from the content, so two different records with the same
			// `updatedAt` get different stamps.
			stamp: stampAt(time, hash(canonical([deleted, content])) % 1000),
			device: LEGACY_DEVICE,
		},
	];
}

/** Convert records into entries (skipping anything that isn't a record). */
export function fromLegacyRecords(
	records: readonly unknown[],
): Map<string, Entry> {
	const entries = new Map<string, Entry>();
	for (const record of records) {
		const converted = fromLegacyRecord(record);
		if (converted === undefined) continue;
		const [id, entry] = converted;
		entries.set(id, newerEntry(entries.get(id), entry) as Entry);
	}
	return entries;
}

/** The records of an old-format remote blob (`{ records }` or a bare array), or undefined. */
export function legacyBlobRecords(blob: unknown): unknown[] | undefined {
	if (Array.isArray(blob)) return blob;
	if (typeof blob !== "object" || blob === null) return undefined;
	const records = (blob as { records?: unknown }).records;
	return Array.isArray(records) ? records : undefined;
}
