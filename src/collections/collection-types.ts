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
	/** Resolves once initial hydration from the storage completes. */
	readonly ready: Promise<void>;

	/** Insert a new record. Returns the record id. Applies immediately. Throws if a record already exists at `options.id`. */
	insert(data: T, options?: InsertOptions): string;
	/** Shallow-merge a partial patch into an existing record. Throws if missing. */
	update(id: string, data: Partial<T>, options?: MutateOptions): void;
	/** Replace an existing record's data entirely. Throws if missing. */
	replace(id: string, data: T, options?: MutateOptions): void;
	/** Soft-delete (tombstone) a record. No-op if missing or already deleted. */
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

	// --- Sync Integration (used by the sync engine) ---

	/** Records with unsynced local changes (`meta.dirty`) -- the push backlog. */
	pending(): RecordEnvelope<T>[];
	/**
	 * Apply authoritative records arriving from a remote (a pull, or a push response).
	 * If a local copy has unsynced changes, behavior depends on `options.keepPending`:
	 * when set (pulls), the optimistic local edit is preserved; otherwise the merge
	 * strategy resolves the conflict. Clean records always take the remote value.
	 */
	applyRemote(
		records: readonly RecordEnvelope<T>[],
		options?: ApplyRemoteOptions,
	): void;
	/** Clear the dirty flag on records after a successful push. */
	markSynced(ids: readonly string[]): void;
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
	/** Called with background persistence errors. Defaults to surfacing as an async throw. */
	onError?: (error: unknown) => void;
}
