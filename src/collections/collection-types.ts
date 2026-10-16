import type { Listener, Unsubscribe } from "../events/event-types.js";
import type { ReactiveQuery } from "../reactivity/reactive-query.js";
import type { RecordEnvelope } from "../records/record-envelope.js";
import type { MergeStrategy } from "../records/record-merge.js";
import type { Validator } from "../records/record-validation.js";
import type { StorageEngine } from "../storage/storage-engine.js";
import type { CollectionChange } from "./collection-events.js";

/** A query filter: return true to include a record. Receives the data and envelope. */
export type QueryPredicate<T> = (data: T, record: RecordEnvelope<T>) => boolean;

export interface ApplyRemoteOptions {
	/**
	 * When true, records with un-published local changes (`meta.dirty`) are left ALONE so
	 * the optimistic local edit survives until it has been pushed (optimistic-until-acknowledged).
	 * Pulls use this. Defaults to false -- resolve immediately via the merge strategy --
	 * which is what a push response uses to settle a record against the server's truth.
	 */
	keepPending?: boolean;
}

/** Where a background error reported to `onError` came from. */
export interface CollectionErrorInfo {
	/**
	 * `"storage"`: a durable write to the StorageAdapter failed.
	 * `"remote-validation"`: a record arriving from the remote failed the collection's
	 * validator and was skipped (it was NOT applied locally).
	 */
	source: "storage" | "remote-validation";
	collection: string;
	/** The record involved, when known. */
	id?: string;
}

export interface MutateOptions {
	/** Override the change timestamp (defaults to the collection clock). For tests. */
	now?: number;
}

export interface InsertOptions extends MutateOptions {
	/** Provide an explicit id (otherwise one will be generated). */
	id?: string;
}

export interface Collection<T extends object> {
	readonly name: string;
	/** Resolves once hydration from storage completes (the latest attempt, see `load`). */
	readonly ready: Promise<void>;
	/** Whether hydration from storage has completed (see `ready`). */
	readonly hydrated: boolean;
	/**
	 * This device's id, which local edits are stamped with (`meta.writer`). Known once
	 * hydration has completed; shared by every collection and tab using the same storage.
	 */
	readonly deviceId: string | undefined;
	/**
	 * Resolves once hydration from storage completes. If the last attempt failed, tries again
	 * (the sync engine calls this before each pull and push, so a failed load is retried).
	 */
	load(): Promise<void>;

	// Every write below throws until hydration has completed (`await ready` first): until
	// then it couldn't tell whether a record exists, or build on the stored copy.

	/** Insert a new record. Returns the record id. Applies immediately. Throws if a record already exists at `options.id`. */
	insert(data: T, options?: InsertOptions): string;
	/** Shallow-merge a partial patch into an existing record. Throws if missing. */
	update(id: string, data: Partial<T>, options?: MutateOptions): void;
	/** Replace an existing record's data entirely. Throws if missing. */
	replace(id: string, data: T, options?: MutateOptions): void;
	/** Insert-or-replace by id. A soft-deleted record at `id` is restored. */
	upsert(id: string, data: T, options?: MutateOptions): void;
	/** Soft-delete (tombstone) a record. No-op if it is already deleted or doesn't exist. */
	delete(id: string, options?: MutateOptions): void;

	/** One-shot, non-reactive read. Returns undefined if record is missing or deleted`. */
	peek(id: string): RecordEnvelope<T> | undefined;
	/** Live single-record query (shared per id). Resolves to undefined if record is missing or deleted. */
	get(id: string): ReactiveQuery<RecordEnvelope<T> | undefined>;
	/** Live multi-record query. Excludes tombstoned records. Optional predicate filters. */
	query(predicate?: QueryPredicate<T>): ReactiveQuery<RecordEnvelope<T>[]>;

	/** Observe changes to the collection. */
	subscribe(listener: Listener<CollectionChange<T>>): Unsubscribe;
	/** Dispose of the collection and release resources. */
	dispose(): void;
	/**
	 * Resolves once every write made so far has landed in storage (failures are reported to
	 * `onError`; this never rejects). `app.close()` waits for it before closing storage.
	 */
	whenPersisted(): Promise<void>;

	// --- Sync Integration (used by the sync engine) ---

	/** Records with unsynced local changes (`meta.dirty`) -- the push backlog. */
	pending(): RecordEnvelope<T>[];
	/**
	 * Apply authoritative records arriving from a remote (a pull, or a push response).
	 * If a local copy has unsynced changes, behavior depends on `options.keepPending`:
	 * when set (pulls), the optimistic local edit is preserved; otherwise the merge
	 * strategy resolves the conflict. Clean records always take the remote value.
	 *
	 * Incoming records are normalized (`source: "remote"`, `dirty: false`, `remoteVersion`
	 * stamped) so an adapter can't accidentally turn remote data into a local edit; live
	 * records are run through the validator (invalid ones are skipped and reported to
	 * `onError`); and records identical to the local copy are skipped (no write, no notify).
	 */
	applyRemote(
		records: readonly RecordEnvelope<T>[],
		options?: ApplyRemoteOptions,
	): void;
	/** Clear the dirty flag on records after a successful push. */
	markSynced(ids: readonly string[]): void;
	/**
	 * Record that the remote accepted these pushed records. One still exactly as pushed is
	 * marked synced. One edited since keeps its newer edit (still dirty), now based on the
	 * accepted version (`remoteVersion`), so its push isn't mistaken for a conflict.
	 */
	acknowledge(pushed: readonly RecordEnvelope<T>[]): void;
	/**
	 * Snapshot-pull compaction: hard-remove CLEAN records whose id is not in `seenIds` (the
	 * remote no longer has them), from memory and storage. Dirty records are kept so local
	 * edits are never discarded. Returns the ids of the removed records.
	 */
	removeUnseen(seenIds: ReadonlySet<string>): string[];
	/**
	 * Re-read these records from storage into memory (without writing them back) -- for when
	 * something else, such as another tab of the same app, changed them in shared storage.
	 * Runs after this collection's own pending writes; a record edited here meanwhile is left
	 * alone. The app does this automatically between tabs.
	 */
	refreshFromStorage(ids: readonly string[]): Promise<void>;
	/**
	 * Compaction: hard-remove tombstones that have already been synced
	 * (`meta.deleted && !meta.dirty`) from memory and storage. Un-synced deletions are
	 * KEPT so they can still be pushed. Returns the ids of the purged records.
	 */
	purgeDeleted(): string[];
}

export interface CreateCollectionOptions<T extends object> {
	/** Collection name; also the storage namespace. */
	name: string;
	/** Where records are persisted. */
	storage: StorageEngine;
	/** Optional write-time validation. Defaults to passthrough. */
	validator?: Validator<T>;
	/** Conflict-resolution strategy (stored for the sync layer). */
	merge?: MergeStrategy<T>;
	/** Injectable clock (epoch ms). Defaults to the shared `now()`. For tests. */
	now?: () => number;
	/**
	 * Called with background errors: failed storage writes, and remote records rejected by
	 * the validator. Defaults to `console.error`.
	 */
	onError?: (error: unknown, info: CollectionErrorInfo) => void;
	/**
	 * Called after a write has landed in storage, with the ids it touched (written or
	 * removed). The app uses it to tell other tabs to `refreshFromStorage` them.
	 */
	onPersist?: (ids: readonly string[]) => void;
	/**
	 * Other writers (e.g. other tabs of the app) share this storage. Sync bookkeeping writes
	 * (acks, remote data, compaction) then re-check the stored copy first and never overwrite
	 * a newer write stored meanwhile; the app sets this when tabs coordinate. Default false.
	 */
	sharedStorage?: boolean;
}
