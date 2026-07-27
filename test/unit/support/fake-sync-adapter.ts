import type {
	Mutation,
	PullArgs,
	PullResult,
	PushResult,
	SyncAdapter,
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
 * A SyncAdapter whose pull/push are controlled externally via deferred promises,
 * so tests can simulate in-flight races (e.g. a push that's still pending while
 * the collection changes underneath it).
 */
export interface FakeSyncAdapter<T> extends SyncAdapter<T> {
	pullCalls: number;
	pushCalls: number;
	pushMutationsHistory: Mutation<T>[][];
	pullArgsHistory: PullArgs<unknown, unknown>[];
	/** Resolve the next pending pull() call. */
	resolvePull(result: PullResult<T, unknown>): void;
	rejectPull(error: unknown): void;
	/** Resolve the next pending push() call. */
	resolvePush(result: PushResult<T>): void;
	rejectPush(error: unknown): void;
}

export function createFakeSyncAdapter<T>(
	options: { readOnly?: boolean } = {},
): FakeSyncAdapter<T> {
	let pullDeferred: Deferred<PullResult<T, unknown>> | undefined;
	let pushDeferred: Deferred<PushResult<T>> | undefined;

	const adapter: FakeSyncAdapter<T> = {
		pullCalls: 0,
		pushCalls: 0,
		pushMutationsHistory: [],
		pullArgsHistory: [],

		pull(args) {
			adapter.pullCalls += 1;
			adapter.pullArgsHistory.push(args);
			pullDeferred = createDeferred<PullResult<T, unknown>>();
			return pullDeferred.promise;
		},

		resolvePull(result) {
			pullDeferred?.resolve(result);
		},

		rejectPull(error) {
			pullDeferred?.reject(error);
		},

		resolvePush(result) {
			pushDeferred?.resolve(result);
		},

		rejectPush(error) {
			pushDeferred?.reject(error);
		},
	};

	if (!options.readOnly) {
		adapter.push = (mutations: Mutation<T>[]) => {
			adapter.pushCalls += 1;
			adapter.pushMutationsHistory.push(mutations);
			pushDeferred = createDeferred<PushResult<T>>();
			return pushDeferred.promise;
		};
	}

	return adapter;
}
