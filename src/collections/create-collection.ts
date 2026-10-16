/**
 * A collection is one last-writer-wins map (see crdt/lww-map.ts) with an API for records: it
 * holds the entries in memory, persists them through a StorageAdapter, validates writes, and
 * hands out live ReactiveQuery objects.
 *
 * Every change -- a local write, data from the remote, another tab's write, the stored copy
 * -- goes through one merge: per key, the newer entry wins. Merges can happen in any order,
 * more than once, from any tab, and the result is the same, so there are no special cases
 * for what arrives when. Storage is written the same way (an atomic merge), so it can't be
 * rolled back by an older write either.
 *
 * Writes: validate, stamp with this tab's clock (so it beats every entry this tab has seen),
 * merge into memory (queries update at once), then persist in the background.
 *
 * @example
 *   const todos = createCollection<{ title: string; done: boolean }>({
 *     name: "todos",
 *     storage: createMemoryAdapter(),
 *   });
 *   await todos.ready;
 *   const id = todos.insert({ title: "Buy milk", done: false });
 *   const active = todos.query((data) => !data.done); // live query
 *   const off = active.subscribe((rows) => render(rows));
 *   todos.update(id, { done: true }); // `active` recomputes; the row drops out
 */
import type { HybridClock } from "../crdt/hlc.js";
import { createHybridClock, stampTime } from "../crdt/hlc.js";
import type { Entry, Mark } from "../crdt/lww-map.js";
import {
	compareEntries,
	compareMarks,
	laterMark,
	newerEntry,
} from "../crdt/lww-map.js";
import { mergeValues } from "../crdt/merge-values.js";
import type { Listener, Unsubscribe } from "../events/event-types.js";
import { fromLegacyRecords, LEGACY_DEVICE } from "../migration/legacy.js";
import { createReactiveCache } from "../reactivity/reactive-cache.js";
import type { ReactiveQuery } from "../reactivity/reactive-query.js";
import { createReactiveQuery } from "../reactivity/reactive-query.js";
import type { RecordEnvelope } from "../records/record-envelope.js";
import {
	passthrough,
	ValidationError,
	validateOrThrow,
} from "../records/record-validation.js";
import { loadWriterId } from "../storage/device-id.js";
import type { StoredEntry } from "../storage/storage-adapter.js";
import { deepEqual } from "../utils/deep-equal.js";
import { deepFreeze } from "../utils/freeze.js";
import { createId } from "../utils/ids.js";
import { logBackgroundError } from "../utils/log-error.js";
import type { CollectionChange, RecordChange } from "./collection-events.js";
import type {
	Collection,
	CreateCollectionOptions,
	InsertOptions,
	QueryPredicate,
} from "./collection-types.js";

interface Incoming<T> {
	entry?: Entry<T>;
	synced?: Mark;
	/** The entry `entry` was edited from (for an unsaved local edit). */
	base?: Entry<T>;
}

/** Whether two writer ids are tabs of one device (see device-id.ts). */
const sameDevice = (a: string, b: string): boolean =>
	writerOf(a).split(".")[0] === writerOf(b).split(".")[0];

/** The tab that wrote an entry: for a merge (`<edit's device>~<tab>`), the tab that merged. */
const writerOf = (device: string): string =>
	device.slice(device.lastIndexOf("~") + 1);

export function createCollection<T extends object>(
	options: CreateCollectionOptions<T>,
): Collection<T> {
	const { name, storage } = options;
	const validate = options.validator ?? passthrough<T>();
	const clock: HybridClock = options.clock ?? createHybridClock();
	const handleError = options.onError ?? logBackgroundError;
	const writerId = options.writerId ?? (() => loadWriterId(storage));
	const mergeEdits = options.merge ?? mergeValues;

	const entries = new Map<string, Entry<T>>();
	/** Per key, the newest write the remote is known to hold. */
	const synced = new Map<string, Mark>();
	/**
	 * Per key with an unsaved edit: the entry that edit started from, so an edit someone else
	 * saved meanwhile can be merged with it (see `mergeRemote`).
	 */
	const bases = new Map<string, Entry<T>>();
	/** Keys changed in memory that still need writing to storage. */
	const unsaved = new Set<string>();
	/** The envelope each entry is read as; null if its value failed the validator. */
	const views = new WeakMap<Entry<T>, RecordEnvelope<T> | null>();
	const listeners = new Set<Listener<readonly RecordChange<T>[]>>();
	const cache = createReactiveCache();
	let writer: string | undefined;
	let disposed = false;
	let hydrated = false;
	let loadFailed = false;

	const assertActive = () => {
		if (disposed) throw new Error(`Collection "${name}" has been disposed`);
	};

	/**
	 * Local writes need the stored entries loaded first: a write must be stamped later than
	 * every entry it could have seen, and needs to know whether a record exists.
	 */
	const assertWritable = (verb: string): void => {
		assertActive();
		if (hydrated) return;
		if (loadFailed) {
			throw new Error(
				`Cannot ${verb} in collection "${name}": loading from storage failed (see the ` +
					"reported storage error). Loading is retried on the next sync, by " +
					"app.ready(), or by calling collection.load().",
			);
		}
		throw new Error(
			`Cannot ${verb} in collection "${name}" yet: it's still loading from storage -- ` +
				"await app.ready() (or collection.ready) before changing data.",
		);
	};

	// --- reading ---

	/** The record a key reads as: undefined if missing, deleted, or invalid. */
	const visible = (key: string): RecordEnvelope<T> | undefined => {
		const entry = entries.get(key);
		if (entry === undefined || entry.deleted) return undefined;
		let view = views.get(entry);
		if (view === undefined) {
			// A value this tab didn't write: check it (written elsewhere, or by older code).
			const result = validate(entry.value);
			if (result.ok) {
				// The validator's output is copied before freezing: it may reuse its own objects.
				const data =
					result.value === entry.value
						? result.value
						: structuredClone(result.value);
				view = deepFreeze({ id: key, data, meta: metaOf(entry) });
			} else {
				view = null;
				handleError(new ValidationError(result.issues), {
					source: "remote-validation",
					collection: name,
					id: key,
				});
			}
			views.set(entry, view);
		}
		return view ?? undefined;
	};

	const metaOf = (entry: Entry<T>) => ({
		stamp: entry.stamp,
		device: entry.device,
		updatedAt: stampTime(entry.stamp),
	});

	const changeOf = (key: string): RecordChange<T> => {
		const entry = entries.get(key);
		if (entry?.deleted) return { kind: "deleted", id: key };
		const record = visible(key);
		return record === undefined
			? { kind: "removed", id: key }
			: { kind: "set", id: key, record };
	};

	const notify = (keys: readonly string[]): void => {
		if (keys.length === 0 || disposed) return;
		const changes = keys.map(changeOf);
		for (const listener of [...listeners]) listener(changes);
	};

	const subscribeToStore = (onChange: () => void): Unsubscribe => {
		const listener = () => onChange();
		listeners.add(listener);
		return () => listeners.delete(listener);
	};

	// --- merging and persisting ---

	let persistChain: Promise<void> = Promise.resolve();
	let persistQueued = false;

	/** Write the unsaved keys to storage (merged there, so it never undoes a newer write). */
	const persistUnsaved = async (): Promise<void> => {
		persistQueued = false;
		if (unsaved.size === 0) return;
		const keys = [...unsaved];
		unsaved.clear();
		const changes = new Map<string, StoredEntry>();
		for (const key of keys) {
			const entry = entries.get(key);
			if (entry === undefined) continue; // removed meanwhile
			const mark = synced.get(key);
			const base = bases.get(key);
			changes.set(key, {
				entry,
				...(mark !== undefined ? { synced: mark } : {}),
				...(base !== undefined ? { base } : {}),
			});
		}
		try {
			await storage.merge(name, changes);
		} catch (err) {
			// Kept unsaved: written with the next change.
			for (const key of keys) if (entries.has(key)) unsaved.add(key);
			handleError(err, { source: "storage", collection: name });
			return;
		}
		options.onPersist?.(changes, []);
	};

	const schedulePersist = (): void => {
		if (persistQueued) return;
		persistQueued = true;
		// A microtask later, so a burst of changes is one storage write.
		persistChain = persistChain.then(persistUnsaved);
	};

	/** Merge entries and synced marks into memory; returns the keys that changed. */
	const absorb = (
		incoming: ReadonlyMap<string, Incoming<T>>,
		persist: boolean,
	): void => {
		const changed: string[] = [];
		for (const [key, { entry, synced: mark, base }] of incoming) {
			let didChange = false;
			if (entry !== undefined) {
				clock.receive(entry.stamp);
				const current = entries.get(key);
				const winner = newerEntry(current, entry) as Entry<T>;
				if (winner !== current) {
					entries.set(key, deepFreeze(winner));
					// The base belongs to its edit.
					if (base === undefined) bases.delete(key);
					else bases.set(key, deepFreeze(base));
					didChange = true;
				} else if (
					base !== undefined &&
					compareEntries(entry, current) === 0 &&
					laterMark(bases.get(key), base) === base &&
					bases.get(key) !== base
				) {
					bases.set(key, deepFreeze(base)); // the same edit, rebased further
					didChange = true;
				}
			}
			if (mark !== undefined) {
				const current = synced.get(key);
				const later = laterMark(current, mark) as Mark;
				if (later !== current) {
					synced.set(key, later);
					didChange = true;
				}
			}
			if (didChange) {
				changed.push(key);
				if (persist) unsaved.add(key);
			}
		}
		if (persist && changed.length > 0) schedulePersist();
		notify(changed);
	};

	/** The base for a new edit of `key`, replacing `current` (see `commit`). */
	const baseFor = (
		key: string,
		current: Entry<T> | undefined,
	): Entry<T> | undefined => {
		if (current === undefined || !isPending(key, current)) return current;
		// An imported entry is pending (the remote may not hold it yet), but it isn't an edit:
		// an edit made from it is based on it.
		return (
			bases.get(key) ?? (current.device === LEGACY_DEVICE ? current : undefined)
		);
	};

	/**
	 * Write values (null = delete) as new entries from this tab. Each edit's base is the entry
	 * it replaces -- or, if that is itself an unsaved edit, that edit's base -- unless given.
	 * A merge is ordered right after the later of its two edits (`after`), not at the time it
	 * was made: so it beats both, but not an edit made after either of them (e.g. in another
	 * tab, which this tab hasn't heard of yet).
	 */
	const commit = (
		values: ReadonlyMap<string, T | null>,
		merges?: {
			bases: ReadonlyMap<string, Entry<T>>;
			after: ReadonlyMap<string, Mark>;
		},
	): void => {
		const incoming = new Map<string, Incoming<T>>();
		for (const [key, value] of values) {
			const current = entries.get(key);
			const base = merges?.bases.get(key) ?? baseFor(key, current);
			const after = merges?.after.get(key);
			const entry: Entry<T> = deepFreeze({
				value,
				deleted: value === null,
				// The same stamp, and a device that sorts right after the edit's.
				stamp: after?.stamp ?? clock.now(),
				device:
					after === undefined
						? (writer as string)
						: `${after.device}~${writer as string}`,
			});
			if (value !== null) {
				// Already validated: read as is.
				views.set(
					entry,
					deepFreeze({ id: key, data: value, meta: metaOf(entry) }),
				);
			}
			incoming.set(key, base === undefined ? { entry } : { entry, base });
		}
		absorb(incoming, true);
	};

	const removeKeys = (keys: readonly string[]): void => {
		if (keys.length === 0) return;
		for (const key of keys) {
			entries.delete(key);
			synced.delete(key);
			bases.delete(key);
			unsaved.delete(key);
		}
		notify(keys);
		persistChain = persistChain.then(async () => {
			try {
				await storage.remove(name, keys);
				options.onPersist?.(new Map(), keys);
			} catch (err) {
				handleError(err, { source: "storage", collection: name });
			}
		});
	};

	// --- loading ---

	let loadAttempt: Promise<void> | undefined;
	const load = (): Promise<void> => {
		if (loadAttempt !== undefined && !loadFailed) return loadAttempt;
		loadFailed = false;
		const attempt = (async () => {
			const [stored, legacy, id] = await Promise.all([
				storage.readAll(name),
				options.importLegacy !== false && storage.readLegacy !== undefined
					? storage.readLegacy(name)
					: [],
				writerId(),
			]);
			// Records an older version stored on this device: import the ones newer than what's
			// stored. The conversion is deterministic, so this is safe to repeat (and picks up
			// writes an old tab still open made since).
			const imports = new Map<string, StoredEntry>();
			for (const [key, entry] of fromLegacyRecords(legacy)) {
				const current = stored.get(key)?.entry;
				if (newerEntry(current, entry) !== current) imports.set(key, { entry });
			}
			if (imports.size > 0) {
				for (const [key, merged] of await storage.merge(name, imports)) {
					stored.set(key, merged);
				}
			}
			if (disposed) return;
			writer = id;
			absorb(stored as Map<string, Incoming<T>>, false);
			hydrated = true;
		})();
		// A failed load is reported like any other storage error (so it's never silent), and
		// still rejects for anyone awaiting it -- but isn't also an unhandled rejection.
		attempt.catch((err: unknown) => {
			if (attempt === loadAttempt) loadFailed = true;
			handleError(err, { source: "storage", collection: name });
		});
		loadAttempt = attempt;
		return attempt;
	};
	// Read the stored state first. Queries start empty and fill in when this resolves.
	void load();

	// --- writing ---

	/** Validate, then take a private copy the caller can't mutate afterwards. */
	const ownValue = (data: unknown): T =>
		structuredClone(validateOrThrow(validate, data));

	const missingRecordError = (verb: string, id: string): Error =>
		new Error(`Cannot ${verb} missing record "${id}" in collection "${name}"`);

	/** Store `value` unless the key already holds an equal one. */
	const put = (id: string, value: T): void => {
		const current = visible(id);
		if (current !== undefined && deepEqual(current.data, value)) return;
		commit(new Map([[id, value]]));
	};

	const insert = (data: T, opts: InsertOptions = {}): string => {
		assertWritable("insert");
		const id = opts.id ?? createId();
		if (visible(id) !== undefined) {
			throw new Error(
				`Cannot insert: record "${id}" already exists in collection "${name}"`,
			);
		}
		commit(new Map([[id, ownValue(data)]]));
		return id;
	};

	const replace = (id: string, data: T): void => {
		assertWritable("replace");
		if (visible(id) === undefined) throw missingRecordError("replace", id);
		put(id, ownValue(data));
	};

	const update = (id: string, patch: Partial<T>): void => {
		assertWritable("update");
		const current = visible(id);
		if (current === undefined) throw missingRecordError("update", id);
		put(id, ownValue({ ...current.data, ...patch }));
	};

	const upsert = (id: string, data: T): void => {
		assertWritable("upsert");
		put(id, ownValue(data));
	};

	const remove = (id: string): void => {
		assertWritable("delete");
		const entry = entries.get(id);
		if (entry === undefined || entry.deleted) return;
		commit(new Map([[id, null]]));
	};

	// --- queries ---

	const get = (id: string): ReactiveQuery<RecordEnvelope<T> | undefined> =>
		cache.get(`doc:${id}`, () =>
			createReactiveQuery({
				compute: () => visible(id),
				subscribeToSources: subscribeToStore,
			}),
		);

	const query = (
		predicate?: QueryPredicate<T>,
	): ReactiveQuery<RecordEnvelope<T>[]> =>
		createReactiveQuery({
			compute: () =>
				[...entries.keys()].flatMap((key) => {
					const record = visible(key);
					return record !== undefined &&
						(predicate === undefined || predicate(record.data, record))
						? [record]
						: [];
				}),
			subscribeToSources: subscribeToStore,
		});

	const subscribe = (listener: Listener<CollectionChange<T>>): Unsubscribe => {
		const wrapped = (changes: readonly RecordChange<T>[]) =>
			listener({ collection: name, changes });
		listeners.add(wrapped);
		return () => listeners.delete(wrapped);
	};

	// --- sync integration ---

	const isPending = (key: string, entry: Entry<T>): boolean => {
		const mark = synced.get(key);
		return mark === undefined || compareMarks(entry, mark) > 0;
	};

	/**
	 * `theirs` is saved on the remote while `key` has an unsaved edit here. If someone else
	 * saved it since this edit's base, returns the merge of both edits (saved as a new write).
	 * If it's this device's own earlier save (e.g. one whose reply was lost), the edit builds
	 * on it: it becomes the edit's base, and there's nothing to merge.
	 */
	const combine = (
		key: string,
		theirs: Entry<T>,
		rebased: Map<string, Entry<T>>,
	): T | undefined => {
		const mine = entries.get(key);
		if (mine === undefined || !isPending(key, mine)) return undefined;
		if (compareMarks(mine, theirs) === 0) return undefined; // this very edit
		const base = bases.get(key);
		if (base !== undefined && compareMarks(theirs, base) <= 0) return undefined;
		if (sameDevice(theirs.device, writer ?? "")) {
			rebased.set(key, theirs);
			return undefined;
		}
		if (mine.deleted || theirs.deleted) return undefined; // the later write wins
		const mineIsLater = compareEntries(mine, theirs) > 0;
		try {
			const merged = ownValue(
				mergeEdits(
					base === undefined || base.deleted ? undefined : (base.value as T),
					mine.value as T,
					theirs.value as T,
					{ key, mineIsLater },
				),
			);
			options.onMerge?.({
				key,
				mine: mine.value as T,
				theirs: theirs.value as T,
				result: merged,
			});
			return merged;
		} catch (error) {
			// The merge threw, or its result fails the validator: the later write wins instead.
			handleError(error, {
				source: "merge",
				collection: name,
				id: key,
			});
			return undefined;
		}
	};

	const mergeRemote: Collection<T>["mergeRemote"] = (remote, opts = {}) => {
		assertActive();
		const incoming = new Map<string, Incoming<T>>();
		const merged = new Map<string, T>();
		const after = new Map<string, Mark>();
		const rebased = new Map<string, Entry<T>>();
		for (const [key, entry] of remote) {
			if (opts.synced && hydrated) {
				const combined = combine(key, entry, rebased);
				if (combined !== undefined) {
					merged.set(key, combined);
					after.set(key, newerEntry(entries.get(key), entry) as Entry<T>);
				}
			}
			incoming.set(
				key,
				opts.synced
					? { entry, synced: { stamp: entry.stamp, device: entry.device } }
					: { entry },
			);
		}
		absorb(incoming, true);
		for (const [key, base] of rebased) {
			bases.set(key, deepFreeze(base));
			unsaved.add(key);
		}
		if (rebased.size > 0) schedulePersist();
		// Each merge is a new write, built on what the remote holds now.
		if (merged.size > 0)
			commit(merged, {
				bases: new Map(
					[...merged.keys()].map((k) => [k, remote.get(k) as Entry<T>]),
				),
				after,
			});
	};

	const replaceAll = (values: ReadonlyMap<string, unknown>): void => {
		assertWritable("refresh");
		const changed = new Map<string, T>();
		for (const [key, value] of values) {
			const result = validate(value);
			if (!result.ok) {
				handleError(new ValidationError(result.issues), {
					source: "remote-validation",
					collection: name,
					id: key,
				});
				continue;
			}
			const current = visible(key);
			if (current === undefined || !deepEqual(current.data, result.value)) {
				changed.set(key, structuredClone(result.value));
			}
		}
		commit(changed);
		removeKeys([...entries.keys()].filter((key) => !values.has(key)));
	};

	const whenPersisted = async (): Promise<void> => {
		// Writes can queue more writes (or more can be made meanwhile): wait until it settles.
		let chain: Promise<void>;
		do {
			chain = persistChain;
			await chain;
		} while (chain !== persistChain);
	};

	return {
		name,
		get ready() {
			return load();
		},
		load,
		get hydrated() {
			return hydrated;
		},
		insert,
		update,
		replace,
		upsert,
		delete: remove,
		peek: visible,
		get,
		query,
		subscribe,
		dispose() {
			if (disposed) return;
			disposed = true;
			cache.clear();
		},
		whenPersisted,
		pending: () =>
			[...entries].flatMap(([key, entry]) =>
				isPending(key, entry) ? [key] : [],
			),
		snapshot: () => new Map(entries),
		mergeRemote,
		mergeFromTab(changes, removed) {
			if (disposed) return;
			absorb(changes as ReadonlyMap<string, Incoming<T>>, false);
			for (const key of removed) {
				entries.delete(key);
				synced.delete(key);
				bases.delete(key);
			}
			notify(removed);
		},
		replaceAll,
		prune(remote, before) {
			assertActive();
			const gone = [...entries].flatMap(([key, entry]) =>
				!remote.has(key) && entry.stamp < before && !isPending(key, entry)
					? [key]
					: [],
			);
			removeKeys(gone);
			return gone;
		},
	};
}
