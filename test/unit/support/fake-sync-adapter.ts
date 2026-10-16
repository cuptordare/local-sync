import type { Entries } from "../../../src/crdt/lww-map.js";
import type {
	RemoteState,
	SyncAdapter,
	WriteOptions,
	WriteResult,
} from "../../../src/sync/sync-adapter.js";

export interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * A SyncAdapter whose read/write are controlled externally via deferred promises, so tests
 * can hold a request in flight while things change underneath it.
 */
export interface FakeSyncAdapter<T> extends SyncAdapter<T> {
	readCalls: number;
	writes: Array<{ entries: Entries<T>; options: WriteOptions }>;
	/** Resolve the pending read() call. */
	resolveRead(state: RemoteState<T>): void;
	rejectRead(error: unknown): void;
	/** Resolve the pending write() call. */
	resolveWrite(result?: WriteResult): void;
	rejectWrite(error: unknown): void;
}

export function createFakeSyncAdapter<T>(
	options: { readOnly?: boolean } = {},
): FakeSyncAdapter<T> {
	let readDeferred: Deferred<RemoteState<T>> | undefined;
	let writeDeferred: Deferred<WriteResult> | undefined;

	const adapter: FakeSyncAdapter<T> = {
		readCalls: 0,
		writes: [],
		read() {
			adapter.readCalls += 1;
			readDeferred = createDeferred();
			return readDeferred.promise;
		},
		resolveRead: (state) => readDeferred?.resolve(state),
		rejectRead: (error) => readDeferred?.reject(error),
		resolveWrite: (result) => writeDeferred?.resolve(result),
		rejectWrite: (error) => writeDeferred?.reject(error),
	};
	if (!options.readOnly) {
		adapter.write = (entries, writeOptions) => {
			adapter.writes.push({ entries, options: writeOptions });
			writeDeferred = createDeferred();
			return writeDeferred.promise;
		};
	}
	return adapter;
}
