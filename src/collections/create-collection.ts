/**
 * A collection ties the lower layers together: it holds an in-memory store
 * (collection-store), persists through a StorageEngine, validates writes, and
 * hands out live ReactiveQuery objects.
 *
 * Mutation flow (optimistic, local-first):
 *   1. validate the data
 *   2. build a new immutable envelope (version bumped, dirty=true) around a private,
 *      deep-frozen copy of the data -- so neither the caller's object nor a read result
 *      can later change the stored record behind the collection's back
 *   3. apply to the in-memory store synchronously -> queries update immediately
 *   4. enqueue a durable write to storage (serialized to preserve order)
 *
 * Reads: `query`/`get` return live queries (tombstones filtered out); `peek` is a one-shot
 * read. `get(id)` is cached/shared by id so multiple consumers share one subscription.
 * Everything a read returns is frozen.
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
import {
	passthrough,
	ValidationError,
	validateOrThrow,
} from "../records/record-validation.js";
import { loadDeviceId } from "../storage/device-id.js";
import { deepEqual } from "../utils/deep-equal.js";
import { deepFreeze } from "../utils/freeze.js";
import { logBackgroundError } from "../utils/log-error.js";
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
	const handleError = options.onError ?? logBackgroundError;

	const sharedStorage = options.sharedStorage ?? false;

	const store = createCollectionStore<T>();
	const cache = createReactiveCache();
	let disposed = false;
	let hydrated = false;
	let loadFailed = false;
	/** This device's id (see device-id.ts), known once loading has finished. */
	let deviceId: string | undefined;

	// Serialize persistence so later version never lands before an earlier version. (Writes
	// are only allowed once loading has succeeded, so none can land before the stored state
	// has been read.)
	let writeChain: Promise<void> = Promise.resolve();
	/**
	 * Queue a storage write; once it has landed, report which records it touched (`ids`, or the
	 * ids the task returns if it skipped some).
	 */
	const enqueueWrite = (
		ids: readonly string[],
		// biome-ignore lint/suspicious/noConfusingVoidType: plain storage writes resolve to void
		task: () => Promise<readonly string[] | void>,
	): void => {
		writeChain = writeChain
			.then(async () => {
				const written = (await task()) ?? ids;
				if (written.length > 0) options.onPersist?.(written);
			})
			.catch((err) =>
				handleError(err, { source: "storage", collection: name }),
			);
	};

	const assertActive = () => {
		if (disposed) throw new Error(`Collection "${name}" has been disposed`);
	};

	/**
	 * Local writes need the stored records loaded first: otherwise a write couldn't tell
	 * whether a record exists, and could overwrite a stored copy it never saw.
	 */
	const assertWritable = (verb: string): void => {
		assertActive();
		if (hydrated) return;
		if (loadFailed) {
			throw new Error(
				`Cannot ${verb} in collection "${name}": loading from storage failed (see the ` +
					"reported storage error). Loading is retried on the next sync, or by calling " +
					"collection.load().",
			);
		}
		throw new Error(
			`Cannot ${verb} in collection "${name}" yet: it's still loading from storage -- ` +
				"await app.ready() (or collection.ready) before changing data.",
		);
	};

	const missingRecordError = (verb: string, id: string): Error =>
		new Error(`Cannot ${verb} missing record "${id}" in collection "${name}"`);

	const subscribeToStore = (onChange: () => void): Unsubscribe => {
		return store.subscribe(() => onChange());
	};

	const visible = (
		record: RecordEnvelope<T> | undefined,
	): RecordEnvelope<T> | undefined => {
		return record && !record.meta.deleted ? record : undefined;
	};

	/**
	 * How many times this tab itself changed each record (local edits and sync bookkeeping --
	 * not copies taken from storage), so a refresh can tell whether it would undo one.
	 */
	const ownChanges = new Map<string, number>();
	const noteOwnChange = (id: string): void => {
		ownChanges.set(id, (ownChanges.get(id) ?? 0) + 1);
	};

	/** Store a locally-written record (its data must already be a private copy). */
	const commitLocal = (edit: RecordEnvelope<T>): void => {
		const base = store.get(edit.id); // the copy this edit was made from
		// Stamped with this device, so it can later recognise this save on the remote.
		const record =
			deviceId === undefined
				? edit
				: { ...edit, meta: { ...edit.meta, writer: deviceId } };
		const frozen = deepFreeze(record);
		store.set(frozen);
		noteOwnChange(frozen.id);
		if (!sharedStorage || base === undefined) {
			enqueueWrite([frozen.id], () => storage.write(name, frozen));
			return;
		}
		// Another tab may have stored `base` as accepted by the remote meanwhile (it pushed it):
		// then this edit builds on that accepted version. Checked and written atomically.
		enqueueWrite([frozen.id], async () => {
			let rebased: RecordEnvelope<T> | undefined;
			await storage.update(name, [frozen.id], ([stored]) => {
				rebased = acceptedBaseOf(stored as RecordEnvelope<T> | undefined, base)
					? withRemoteVersion(frozen, stored?.meta.remoteVersion)
					: undefined;
				return { write: [rebased ?? frozen], remove: [] };
			});
			if (
				rebased !== undefined &&
				!disposed &&
				store.get(frozen.id) === frozen
			) {
				store.set(deepFreeze(rebased));
				noteOwnChange(frozen.id);
			}
		});
	};

	/** Whether `stored` is `base` itself, since marked as accepted at a newer remote version. */
	const acceptedBaseOf = (
		stored: RecordEnvelope<T> | undefined,
		base: RecordEnvelope<T>,
	): boolean =>
		stored !== undefined &&
		stored.meta.remoteVersion !== undefined &&
		stored.meta.remoteVersion > (base.meta.remoteVersion ?? -1) &&
		stored.meta.version === base.meta.version &&
		stored.meta.deleted === base.meta.deleted &&
		deepEqual(stored.data, base.data);

	const withRemoteVersion = (
		record: RecordEnvelope<T>,
		remoteVersion: number | undefined,
	): RecordEnvelope<T> | undefined =>
		remoteVersion === undefined ||
		remoteVersion <= (record.meta.remoteVersion ?? -1)
			? undefined
			: { ...record, meta: { ...record.meta, remoteVersion } };

	interface SyncChange {
		id: string;
		base: RecordEnvelope<T> | undefined;
		next: RecordEnvelope<T> | undefined;
		/**
		 * If another tab stored a newer copy meanwhile, what to store instead (e.g. that copy,
		 * updated with what this change learned); undefined = leave the stored copy as it is.
		 */
		ifSuperseded?: (stored: RecordEnvelope<T>) => RecordEnvelope<T> | undefined;
	}

	/**
	 * Store bookkeeping changes made on the strength of this tab's in-memory copy (sync results:
	 * acks, remote data, compaction). `base` is the copy each change was made from; `next` the
	 * result (undefined = remove). With shared storage, another tab may have stored a newer
	 * write since this tab read `base`: that record is left as stored (and taken back into
	 * memory) instead of being overwritten with a change based on an outdated copy. The check
	 * and the write are one atomic storage update, so no other tab can write in between.
	 */
	const persistSyncChanges = (changes: readonly SyncChange[]): void => {
		if (changes.length === 0) return;
		const ids = changes.map((c) => c.id);
		for (const id of ids) noteOwnChange(id);
		const toStore = (list: readonly SyncChange[]) => ({
			write: list.flatMap((c) => (c.next === undefined ? [] : [c.next])),
			remove: list.flatMap((c) => (c.next === undefined ? [c.id] : [])),
		});
		enqueueWrite(ids, async () => {
			if (!sharedStorage) {
				const { write, remove } = toStore(changes);
				if (write.length > 0) await storage.writeMany(name, write);
				await storage.removeMany(name, remove);
				return ids;
			}
			let written: string[] = [];
			let superseded: Array<{
				change: SyncChange;
				stored: RecordEnvelope<T> | undefined;
			}> = [];
			await storage.update(name, ids, (stored) => {
				const unchanged: SyncChange[] = [];
				const replacements: RecordEnvelope<T>[] = [];
				superseded = [];
				changes.forEach((c, i) => {
					const fresh = stored[i] as RecordEnvelope<T> | undefined;
					if (deepEqual(fresh, c.base)) {
						unchanged.push(c);
						return;
					}
					const replacement =
						fresh === undefined ? undefined : c.ifSuperseded?.(fresh);
					if (replacement !== undefined) replacements.push(replacement);
					superseded.push({ change: c, stored: replacement ?? fresh });
				});
				written = [...unchanged, ...replacements].map((c) => c.id);
				const { write, remove } = toStore(unchanged);
				return { write: [...write, ...replacements], remove };
			});
			// Stored copy changed since: keep it, and adopt it unless edited here meanwhile.
			const adopt: RecordEnvelope<T>[] = [];
			const drop: string[] = [];
			for (const { change, stored } of superseded) {
				if (disposed || store.get(change.id) !== change.next) continue;
				if (stored === undefined) drop.push(change.id);
				else adopt.push(deepFreeze(withSameDataAs(change.next, stored)));
			}
			if (adopt.length > 0) store.setMany(adopt);
			if (drop.length > 0) store.removeMany(drop);
			return written;
		});
	};

	/** Validate, then take a private copy the caller can't mutate afterwards. */
	const ownValue = (data: unknown): T =>
		structuredClone(validateOrThrow(validate, data));

	const finishLoading = (map: Map<string, unknown>): void => {
		if (disposed) return;
		// Storage is type-erased as RecordEnvelope<unknown>; the collection owns its T.
		store.setMany(
			[...(map.values() as Iterable<RecordEnvelope<T>>)].map((r) =>
				deepFreeze(r),
			),
		);
		hydrated = true;
	};

	let loadAttempt: Promise<void> | undefined;
	/** Load from storage, unless loaded or loading already. A failed load is tried again. */
	const load = (): Promise<void> => {
		if (loadAttempt !== undefined && !loadFailed) return loadAttempt;
		loadFailed = false;
		const attempt = Promise.all([
			storage.hydrate(name),
			loadDeviceId(storage),
		]).then(([map, id]) => {
			deviceId = id;
			finishLoading(map);
		});
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

	const insert = (data: T, opts: InsertOptions = {}): string => {
		assertWritable("insert");
		if (opts.id !== undefined && store.get(opts.id) !== undefined) {
			throw new Error(
				`Cannot insert: record "${opts.id}" already exists in collection "${name}"`,
			);
		}
		const record = createEnvelope(ownValue(data), {
			...(opts.id !== undefined ? { id: opts.id } : {}),
			now: opts.now ?? clock(),
		});
		commitLocal(record);
		return record.id;
	};

	const replace = (id: string, data: T, opts: MutateOptions = {}): void => {
		assertWritable("replace");
		const current = store.get(id);
		if (current === undefined) throw missingRecordError("replace", id);
		commitLocal(
			updateEnvelope(current, ownValue(data), { now: opts.now ?? clock() }),
		);
	};

	const update = (
		id: string,
		patch: Partial<T>,
		opts: MutateOptions = {},
	): void => {
		assertWritable("update");
		const current = store.get(id);
		if (current === undefined) throw missingRecordError("update", id);
		commitLocal(
			updateEnvelope(current, ownValue({ ...current.data, ...patch }), {
				now: opts.now ?? clock(),
			}),
		);
	};

	const upsert = (id: string, data: T, opts: MutateOptions = {}): void => {
		assertWritable("upsert");
		const current = store.get(id);
		const value = ownValue(data);
		if (
			current !== undefined &&
			!current.meta.deleted &&
			deepEqual(current.data, value)
		) {
			return; // no-op write: nothing to version, persist, or push
		}
		const now = opts.now ?? clock();
		commitLocal(
			current === undefined
				? createEnvelope(value, { id, now })
				: updateEnvelope(current, value, { now }),
		);
	};

	const remove = (id: string, opts: MutateOptions = {}): void => {
		assertWritable("delete");
		const current = store.get(id);
		if (current === undefined || current.meta.deleted) return;
		commitLocal(deleteEnvelope(current, { now: opts.now ?? clock() }));
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

	/**
	 * When only metadata changed (e.g. a newer remote version with identical content), keep the
	 * existing data object: readers then see the same reference, so watchers and queries
	 * comparing values treat it as "no change" cheaply.
	 */
	const withSameDataAs = (
		current: RecordEnvelope<T> | undefined,
		next: RecordEnvelope<T>,
	): RecordEnvelope<T> =>
		current !== undefined &&
		current.data !== next.data &&
		deepEqual(current.data, next.data)
			? { ...next, data: current.data }
			: next;

	/** Whether `local` already matches what the remote is sending (nothing to apply). */
	const matchesRemote = (
		local: RecordEnvelope<T>,
		remote: RecordEnvelope<T>,
	): boolean =>
		local.meta.version === remote.meta.version &&
		local.meta.remoteVersion === remote.meta.version &&
		local.meta.deleted === remote.meta.deleted &&
		deepEqual(local.data, remote.data);

	/**
	 * Take a private copy of an incoming remote record, validate it, and normalize its meta:
	 * whatever the adapter sent, remote data is clean, remote-sourced, and is its own
	 * remoteVersion. Returns undefined (after reporting) if validation fails.
	 */
	const prepareRemote = (
		incoming: RecordEnvelope<T>,
	): RecordEnvelope<T> | undefined => {
		const copy = structuredClone(incoming);
		let data = copy.data;
		if (!copy.meta.deleted) {
			const result = validate(copy.data);
			if (!result.ok) {
				handleError(new ValidationError(result.issues), {
					source: "remote-validation",
					collection: name,
					id: copy.id,
				});
				return undefined;
			}
			data = result.value;
		}
		return {
			id: copy.id,
			data,
			meta: {
				...copy.meta,
				source: "remote",
				dirty: false,
				remoteVersion: copy.meta.version,
			},
		};
	};

	/** Resolve a dirty local record against the remote via the merge strategy. */
	/**
	 * Whether `remote` is this device's own earlier save that `local` was edited from: saved by
	 * this device, and older than `local` (on one device, versions only grow along a record's
	 * history). An older local copy -- e.g. a tab that hasn't heard of the save yet -- isn't.
	 */
	const isOwnSaveBefore = (
		local: RecordEnvelope<T>,
		remote: RecordEnvelope<T>,
	): boolean =>
		deviceId !== undefined &&
		remote.meta.writer === deviceId &&
		local.meta.version > remote.meta.version;

	const settleConflict = (
		local: RecordEnvelope<T>,
		remote: RecordEnvelope<T>,
	): RecordEnvelope<T> => {
		// The remote's copy is this device's own earlier save (e.g. its reply was lost): no
		// other device has saved since, so the local edit simply builds on it -- no conflict.
		const merged = isOwnSaveBefore(local, remote)
			? local
			: merge.merge(local, remote);
		// Whatever the strategy decided, this copy has now seen the remote's version. Without
		// this, a strategy that keeps the local edit as-is (e.g. lastWriteWins returning
		// `local`) would be rejected as stale on every push, forever.
		const meta = { ...merged.meta, remoteVersion: remote.meta.version };
		// A kept local edit must supersede the remote's version, so it isn't mistaken for (or
		// stalled behind) the very version it was just merged against.
		if (meta.dirty && meta.version <= remote.meta.version) {
			meta.version = remote.meta.version + 1;
		}
		return { ...merged, meta };
	};

	const applyRemote = (
		records: readonly RecordEnvelope<T>[],
		opts: ApplyRemoteOptions = {},
	): void => {
		assertActive();
		if (records.length === 0) return;
		const next: RecordEnvelope<T>[] = [];
		const bases = new Map<string, RecordEnvelope<T> | undefined>();
		for (const incoming of records) {
			if (!bases.has(incoming.id))
				bases.set(incoming.id, store.get(incoming.id));
			const local = store.get(incoming.id);
			if (local?.meta.dirty) {
				// Local has un-pushed edits.
				if (opts.keepPending) continue; // optimistic: keep the local edit until it is pushed
				const remote = prepareRemote(incoming);
				if (remote !== undefined) next.push(settleConflict(local, remote)); // resolve now
				continue;
			}
			// Local is clean or missing, so remote wins -- unless nothing actually changed.
			if (local !== undefined && matchesRemote(local, incoming)) continue;
			const remote = prepareRemote(incoming);
			if (remote === undefined) continue;
			if (local !== undefined && matchesRemote(local, remote)) continue;
			next.push(withSameDataAs(local, remote));
		}
		if (next.length === 0) return;
		const frozen = next.map((record) => deepFreeze(record));
		store.setMany(frozen);
		persistSyncChanges(
			[...new Map(frozen.map((r) => [r.id, r])).values()].map((r) => ({
				id: r.id,
				base: bases.get(r.id),
				next: r,
			})),
		);
	};

	/** Apply `change` to each dirty record named (skipping unchanged results), then persist. */
	const updateDirty = (
		ids: Iterable<string>,
		change: (current: RecordEnvelope<T>) => RecordEnvelope<T>,
		ifSuperseded?: SyncChange["ifSuperseded"],
	): void => {
		const changes: Array<SyncChange & { next: RecordEnvelope<T> }> = [];
		for (const id of new Set(ids)) {
			const current = store.get(id);
			if (current === undefined || !current.meta.dirty) continue;
			const next = change(current);
			if (next !== current) {
				changes.push({
					id,
					base: current,
					next: deepFreeze(next),
					...(ifSuperseded !== undefined ? { ifSuperseded } : {}),
				});
			}
		}
		if (changes.length === 0) return;
		store.setMany(changes.map((c) => c.next));
		persistSyncChanges(changes);
	};

	const markSynced = (ids: readonly string[]): void => {
		assertActive();
		updateDirty(ids, markRecordSynced);
	};

	/**
	 * A local edit made after `sent` was pushed, now that the remote has accepted `sent`: it
	 * still needs pushing, but it builds on the accepted version -- not the older one it
	 * started from, which would make its push look like a conflict with this device's own save.
	 */
	const onAcceptedVersion = (
		edit: RecordEnvelope<T>,
		sent: RecordEnvelope<T>,
	): RecordEnvelope<T> => {
		const base = edit.meta.remoteVersion;
		if (!edit.meta.dirty || (base !== undefined && base >= sent.meta.version)) {
			return edit;
		}
		return {
			...edit,
			meta: { ...edit.meta, remoteVersion: sent.meta.version },
		};
	};

	const acknowledge = (pushed: readonly RecordEnvelope<T>[]): void => {
		assertActive();
		const byId = new Map(pushed.map((r) => [r.id, r]));
		const sentFor = (id: string) => byId.get(id) as RecordEnvelope<T>;
		updateDirty(
			byId.keys(),
			(current) => {
				const sent = sentFor(current.id);
				return current === sent
					? markRecordSynced(current)
					: onAcceptedVersion(current, sent);
			},
			// Another tab stored a newer edit meanwhile: the same applies to it.
			(stored) => {
				const next = onAcceptedVersion(stored, sentFor(stored.id));
				return next === stored ? undefined : next;
			},
		);
	};

	const hardRemove = (ids: string[]): void => {
		if (ids.length === 0) return;
		const bases = ids.map((id) => ({
			id,
			base: store.get(id),
			next: undefined,
		}));
		store.removeMany(ids);
		persistSyncChanges(bases);
	};

	const purgeDeleted = (): string[] => {
		assertActive();
		// Only drop tombstones that the remote already knows about (synced).
		const purged = store
			.getAll()
			.filter((r) => r.meta.deleted && !r.meta.dirty)
			.map((r) => r.id);
		hardRemove(purged);
		return purged;
	};

	const removeUnseen = (seenIds: ReadonlySet<string>): string[] => {
		assertActive();
		const removed = store
			.getAll()
			.filter((r) => !r.meta.dirty && !seenIds.has(r.id))
			.map((r) => r.id);
		hardRemove(removed);
		return removed;
	};

	const refreshFromStorage = (ids: readonly string[]): Promise<void> => {
		if (disposed || ids.length === 0) return Promise.resolve();
		// Not loaded yet: refresh once loading has finished (its read may predate this change).
		if (!hydrated) {
			return load().then(
				() => refreshFromStorage(ids),
				() => {},
			);
		}
		// Queued behind this collection's own pending writes, so it can never read (and revert
		// to) a stored copy older than a write this tab has already made. A record this tab
		// changes from now until the refresh applies is left alone: that change is newer, and
		// its own write (queued after this read) will be stored and announced.
		const before = ids.map((id) => ownChanges.get(id));
		const refresh = writeChain.then(async () => {
			const stored = (await storage.readMany(name, ids)) as Array<
				RecordEnvelope<T> | undefined
			>;
			if (disposed) return;
			const changed: RecordEnvelope<T>[] = [];
			const removed: string[] = [];
			ids.forEach((id, i) => {
				if (ownChanges.get(id) !== before[i]) return;
				const current = store.get(id);
				const fresh = stored[i];
				if (fresh === undefined) {
					if (current !== undefined) removed.push(id);
				} else if (current === undefined || !deepEqual(current, fresh)) {
					changed.push(deepFreeze(withSameDataAs(current, fresh)));
				}
			});
			if (changed.length > 0) store.setMany(changed);
			if (removed.length > 0) store.removeMany(removed);
		});
		writeChain = refresh.catch((err) =>
			handleError(err, { source: "storage", collection: name }),
		);
		return writeChain;
	};

	const whenPersisted = async (): Promise<void> => {
		// Writes can queue more writes (or more can be made meanwhile): wait until it settles.
		let chain: Promise<void>;
		do {
			chain = writeChain;
			await chain;
		} while (chain !== writeChain);
	};

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		cache.clear();
	};

	return {
		name,
		get ready() {
			return loadAttempt ?? load();
		},
		load,
		get deviceId() {
			return deviceId;
		},
		get hydrated() {
			return hydrated;
		},
		insert,
		update,
		replace,
		upsert,
		delete: remove,
		peek,
		get,
		query,
		subscribe,
		dispose,
		pending,
		applyRemote,
		markSynced,
		acknowledge,
		removeUnseen,
		purgeDeleted,
		refreshFromStorage,
		whenPersisted,
	};
}
