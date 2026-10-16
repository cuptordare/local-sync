import type { RecordEnvelope } from "../../../src/records/record-envelope.js";
import type {
	BlobSnapshot,
	BlobWriteOptions,
	BlobWriteResult,
} from "../../../src/sync/adapters/blob-sync-adapter.js";

/**
 * An in-memory "one JSON blob" backend (like a Sheets cell behind Apps Script), shared by
 * any number of simulated clients. With `cas: true` it supports etag compare-and-swap.
 */
export interface FakeBlobServer<T> {
	read(): Promise<BlobSnapshot<T> | null>;
	write(
		blob: { records: RecordEnvelope<T>[] },
		options: BlobWriteOptions,
	): Promise<BlobWriteResult>;
	readonly records: RecordEnvelope<T>[];
	readonly writes: number;
	/** Run `fn` once, just before the next write lands (simulates a concurrent writer). */
	beforeNextWrite(fn: () => void): void;
	/** Overwrite the blob directly (as another client would). */
	put(records: RecordEnvelope<T>[]): void;
}

export function createFakeBlobServer<T>(
	options: { cas?: boolean } = {},
): FakeBlobServer<T> {
	let blob: { records: RecordEnvelope<T>[] } | null = null;
	let etag = 0;
	let writes = 0;
	let hook: (() => void) | undefined;

	return {
		async read() {
			if (blob === null) return null;
			return {
				records: structuredClone(blob.records),
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
		get records() {
			return blob?.records ?? [];
		},
		get writes() {
			return writes;
		},
		beforeNextWrite(fn) {
			hook = fn;
		},
		put(records) {
			blob = { records: structuredClone(records) };
			etag++;
		},
	};
}
