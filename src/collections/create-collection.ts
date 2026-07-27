/**
 * A collection ties the lower layers together: it holds an in-memory store
 * (collection-store), persists through a StorageEngine, validates writes, and
 * hands out live ReactiveQuery objects.
 *
 * Mutation flow (optimistic, local-first):
 *   1. validate the data
 *   2. build a new immutable envelope (version bumped, dirty=true)
 *   3. apply to the in-memory store synchronously -> queries update immediately
 *   4. enqueue a durable write to storage (serialized to preserve order)
 *
 * Reads: `query`/`get` return live queries (tombstones filtered out); `peek` is a one-shot
 * read. `get(id)` is cached/shared by id so multiple consumers share one subscription.
 *
 * @example
 *   const todos = createCollection<{ title: string; done: boolean }>({
 *     name: "todos",
 *     storage: createStorageEngine(createMemoryAdapter()),
 *   });
 *   const id = todos.insert({ title: "Buy milk", done: false }); // optimistic
 *   const active = todos.query((data) => !data.done); // live query
 *   const off = active.subscribe((rows) => render(rows));
 *   todos.update(id, { done: true }); // `active` recomputes; the row drops out
 */
import type { Listener, Unsubscribe } from "../events/event-types.js";
import { createReactiveCache } from "../reactivity/reactive-cache.js";
import type { ReactiveQuery } from "../reactivity/reactive-query.js";
import { createReactiveQuery } from "../reactivity/reactive-query.js";
import type { RecordEnvelope } from "../records/record-envelope.js";
import {
	createEnvelope,
	deleteEnvelope,
	markSynced as markRecordSynced,
	updateEnvelope,
} from "../records/record-envelope.js";
import { serverWins } from "../records/record-merge.js";
import { passthrough, validateOrThrow } from "../records/record-validation.js";
import { now as defaultNow } from "../utils/timestamps.js";
import type { CollectionChange } from "./collection-events.js";
import { createCollectionStore } from "./collection-store.js";
import type {
	ApplyRemoteOptions,
	Collection,
	CreateCollectionOptions,
	InsertOptions,
	MutateOptions,
	QueryPredicate,
} from "./collection-types.js";

export function createCollection<T extends object>(
	options: CreateCollectionOptions<T>,
): Collection<T> {
	const { name, storage } = options;
	const validate = options.validator ?? passthrough<T>();
	const merge = options.merge ?? serverWins<T>();
	const clock = options.now ?? defaultNow;
	const handleError =
		options.onError ??
		((err) =>
			queueMicrotask(() => {
				throw err;
			}));

	const store = createCollectionStore<T>();
	const cache = createReactiveCache();
	let disposed = false;

	// Serialize persistence so later version never lands before an earlier version.
	let writeChain: Promise<void> = Promise.resolve();
	const enqueueWrite = (task: () => Promise<void>): void => {
		writeChain = writeChain.then(task).catch(handleError);
	};

	const assertActive = () => {
		if (disposed) throw new Error(`Collection "${name}" has been disposed`);
	};

	const subscribeToStore = (onChange: () => void): Unsubscribe => {
		return store.subscribe(() => onChange());
	};

	const visible = (
		record: RecordEnvelope<T> | undefined,
	): RecordEnvelope<T> | undefined => {
		return record && !record.meta.deleted ? record : undefined;
	};

	// Hydrate from durable storage. Queries start empty and fill in when this resolves.
	const ready = storage.hydrate(name).then((map) => {
		if (disposed) return;
		// Storage is type-erased as RecordEnvelope<T>; the collection owns its T.
		store.setMany([...map.values()] as RecordEnvelope<T>[]);
	});

	const insert = (data: T, opts: InsertOptions = {}): string => {
		assertActive();
		if (opts.id !== undefined && store.get(opts.id) !== undefined) {
			throw new Error(
				`Cannot insert: record "${opts.id}" already exists in collection "${name}"`,
			);
		}
		const value = validateOrThrow(validate, data);
		const record = createEnvelope(value, {
			...(opts.id !== undefined ? { id: opts.id } : {}),
			now: opts.now ?? clock(),
		});
		store.set(record);
		enqueueWrite(() => storage.write(name, record));
		return record.id;
	};

	const replace = (id: string, data: T, opts: MutateOptions = {}): void => {
		assertActive();
		const current = store.get(id);
		if (current === undefined) {
			throw new Error(
				`Cannot replace missing record "${id}" in collection "${name}"`,
			);
		}
		const value = validateOrThrow(validate, data);
		const record = updateEnvelope(current, value, { now: opts.now ?? clock() });
		store.set(record);
		enqueueWrite(() => storage.write(name, record));
	};

	const update = (
		id: string,
		patch: Partial<T>,
		opts: MutateOptions = {},
	): void => {
		assertActive();
		const current = store.get(id);
		if (current === undefined) {
			throw new Error(
				`Cannot update missing record "${id}" in collection "${name}"`,
			);
		}
		const value = validateOrThrow(validate, { ...current.data, ...patch });
		const record = updateEnvelope(current, value, { now: opts.now ?? clock() });
		store.set(record);
		enqueueWrite(() => storage.write(name, record));
	};

	const remove = (id: string, opts: MutateOptions = {}): void => {
		assertActive();
		const current = store.get(id);
		if (current === undefined || current.meta.deleted) {
			return;
		}
		const record = deleteEnvelope(current, { now: opts.now ?? clock() });
		store.set(record);
		enqueueWrite(() => storage.write(name, record));
	};

	const peek = (id: string): RecordEnvelope<T> | undefined => {
		return visible(store.get(id));
	};

	const get = (id: string): ReactiveQuery<RecordEnvelope<T> | undefined> => {
		return cache.get(`doc:${id}`, () =>
			createReactiveQuery({
				compute: () => visible(store.get(id)),
				subscribeToSources: subscribeToStore,
			}),
		);
	};

	const query = (
		predicate?: QueryPredicate<T>,
	): ReactiveQuery<RecordEnvelope<T>[]> => {
		return createReactiveQuery({
			compute: () =>
				store
					.getAll()
					.filter(
						(r) => !r.meta.deleted && (!predicate || predicate(r.data, r)),
					),
			subscribeToSources: subscribeToStore,
		});
	};

	const subscribe = (listener: Listener<CollectionChange<T>>): Unsubscribe => {
		return store.subscribe((changes) => {
			listener({ collection: name, changes });
		});
	};

	// --- Sync Integration ---

	const pending = (): RecordEnvelope<T>[] => {
		return store.getAll().filter((r) => r.meta.dirty);
	};

	const applyRemote = (
		records: readonly RecordEnvelope<T>[],
		opts: ApplyRemoteOptions = {},
	): void => {
		assertActive();
		if (records.length === 0) return;
		const next: RecordEnvelope<T>[] = [];
		for (const remote of records) {
			const local = store.get(remote.id);
			if (local?.meta.dirty) {
				// Local has un-pushed edits.
				if (opts.keepPending) continue; // optimistic: keep the local edit until it is pushed
				next.push(merge.merge(local, remote)); // resolve the conflict now
			} else {
				next.push(remote); // local is clean or missing, so remote wins
			}
		}
		if (next.length === 0) return;
		store.setMany(next);
		enqueueWrite(() => storage.writeMany(name, next));
	};

	const markSynced = (ids: readonly string[]): void => {
		assertActive();
		const updated: RecordEnvelope<T>[] = [];
		for (const id of ids) {
			const current = store.get(id);
			if (current === undefined || !current.meta.dirty) continue;
			updated.push(markRecordSynced(current));
		}
		if (updated.length === 0) return;
		store.setMany(updated);
		enqueueWrite(() => storage.writeMany(name, updated));
	};

	const purgeDeleted = (): string[] => {
		assertActive();
		const purged: string[] = [];
		for (const record of store.getAll()) {
			// Only drop tombstones that the remote already knows about (synced).
			if (record.meta.deleted && !record.meta.dirty) {
				store.remove(record.id);
				purged.push(record.id);
			}
		}
		if (purged.length > 0) {
			enqueueWrite(async () => {
				for (const id of purged) {
					await storage.remove(name, id);
				}
			});
		}
		return purged;
	};

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		cache.clear();
	};

	return {
		name,
		ready,
		insert,
		update,
		replace,
		delete: remove,
		peek,
		get,
		query,
		subscribe,
		dispose,
		pending,
		applyRemote,
		markSynced,
		purgeDeleted,
	};
}
