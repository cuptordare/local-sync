/**
 * A last-writer-wins map: the data model everything else is built on.
 *
 * Each key holds one entry: its value (or a delete), plus the stamp (see hlc.ts) and device of
 * the write that set it. Merging two maps keeps, for each key, the entry with the greater
 * `(stamp, device)`. That merge is commutative, associative and idempotent, so copies that
 * have seen the same writes hold the same data -- in whatever order, and however often, they
 * were merged. Deletes are entries too ("tombstones"), so a delete wins over older writes the
 * same way.
 *
 * Every write has its own `(stamp, device)` (each tab writes as its own device, and a clock
 * never repeats a stamp). The content tie-break below only keeps merge deterministic for
 * entries that break that rule (e.g. imported ones).
 */
import type { Stamp } from "./hlc.js";
import { isStamp } from "./hlc.js";

export interface Entry<T = unknown> {
	/** The value written; `null` for a delete. */
	value: T | null;
	deleted: boolean;
	stamp: Stamp;
	/** The device (and tab) that wrote it. */
	device: string;
}

export type Entries<T = unknown> = ReadonlyMap<string, Entry<T>>;

/** Which write an entry is. */
export interface Mark {
	stamp: Stamp;
	device: string;
}

const compareStrings = (a: string, b: string): number =>
	a === b ? 0 : a < b ? -1 : 1;

export function compareMarks(a: Mark, b: Mark): number {
	if (a.stamp !== b.stamp) return a.stamp < b.stamp ? -1 : 1;
	return compareStrings(a.device, b.device);
}

/** JSON with object keys sorted, so equal values give equal strings. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const keys = Object.keys(value).sort();
		const record = value as Record<string, unknown>;
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** Orders entries: by stamp, then device, then content. 0 only for identical writes. */
export function compareEntries(a: Entry, b: Entry): number {
	return (
		compareMarks(a, b) ||
		compareStrings(
			canonical([a.deleted, a.value]),
			canonical([b.deleted, b.value]),
		)
	);
}

/** The winning entry of two (`a` if they're the same write). */
export function newerEntry<T>(
	a: Entry<T> | undefined,
	b: Entry<T> | undefined,
): Entry<T> | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return compareEntries(b, a) > 0 ? b : a;
}

/** The later of two marks (`a` if equal). */
export function laterMark(
	a: Mark | undefined,
	b: Mark | undefined,
): Mark | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return compareMarks(b, a) > 0 ? b : a;
}

/** Merge two maps into a new one. Keeps `a`'s entry objects where they win or tie. */
export function mergeEntries<T>(
	a: Entries<T>,
	b: Entries<T>,
): Map<string, Entry<T>> {
	const merged = new Map(a);
	for (const [key, entry] of b) {
		merged.set(key, newerEntry(merged.get(key), entry) as Entry<T>);
	}
	return merged;
}

/** The keys whose entry in `a` beats the one in `b` (or that `b` lacks). */
export function keysNewerIn<T>(a: Entries<T>, b: Entries<T>): string[] {
	const keys: string[] = [];
	for (const [key, entry] of a) {
		const other = b.get(key);
		if (other === undefined || compareEntries(entry, other) > 0) keys.push(key);
	}
	return keys;
}

/** Whether `value` is a well-formed entry (e.g. one read from a remote). */
export function isEntry(value: unknown): value is Entry {
	if (typeof value !== "object" || value === null) return false;
	const e = value as Partial<Entry>;
	return (
		isStamp(e.stamp) &&
		typeof e.device === "string" &&
		typeof e.deleted === "boolean" &&
		"value" in e &&
		(!e.deleted || e.value === null)
	);
}
