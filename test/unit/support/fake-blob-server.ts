import type { Entry } from "../../../src/crdt/lww-map.js";
import type {
	BlobSnapshot,
	BlobWriteOptions,
	BlobWriteResult,
	LwwBlob,
} from "../../../src/sync/adapters/blob-sync-adapter.js";

/**
 * An in-memory "one JSON blob" backend (like a Sheets cell behind Apps Script), shared by
 * any number of simulated clients. With `cas: true` it supports etag compare-and-swap.
 */
export interface FakeBlobServer<T> {
	read(): Promise<BlobSnapshot<T> | null>;
	write(blob: LwwBlob<T>, options: BlobWriteOptions): Promise<BlobWriteResult>;
	/** The stored entries (deletes included). */
	readonly entries: Record<string, Entry<T>>;
	/** The stored live values, by key. */
	values(): Map<string, T>;
	readonly writes: number;
	/** Run `fn` once, just before the next write lands (simulates a concurrent writer). */
	beforeNextWrite(fn: () => void): void;
	/** Overwrite the blob directly (as another client would). */
	put(blob: unknown): void;
}

export function createFakeBlobServer<T>(
	options: { cas?: boolean } = {},
): FakeBlobServer<T> {
	let blob: unknown = null;
	let etag = 0;
	let writes = 0;
	let hook: (() => void) | undefined;
	const entries = () =>
		((blob as LwwBlob<T> | null)?.entries ?? {}) as Record<string, Entry<T>>;

	return {
		async read() {
			if (blob === null) return options.cas ? { etag: String(etag) } : null;
			return {
				...(structuredClone(blob) as BlobSnapshot<T>),
				...(options.cas ? { etag: String(etag) } : {}),
			};
		},
		async write(next, { ifMatch }) {
			const pending = hook;
			hook = undefined;
			pending?.();
			if (options.cas && ifMatch !== String(etag)) return { conflict: true };
			blob = structuredClone(next);
			etag++;
			writes++;
		},
		get entries() {
			return entries();
		},
		values() {
			return new Map(
				Object.entries(entries()).flatMap(([key, entry]) =>
					entry.deleted ? [] : [[key, entry.value as T]],
				),
			);
		},
		get writes() {
			return writes;
		},
		beforeNextWrite(fn) {
			hook = fn;
		},
		put(next) {
			blob = structuredClone(next);
			etag++;
		},
	};
}
