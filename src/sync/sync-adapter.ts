/**
 * The remote contract you implement.
 *
 * A `SyncAdapter` is the only thing standing between the local-first core and any
 * particular backend. Implement it and the sync engine can talk to your backend.
 *
 * Crucially, `push` is OPTIONAL. A read-only external source is a first-class adapter.
 * A normal CRUD backend implements BOTH `pull` and `push`. A read-only source implements
 * only `pull`.
 *
 * The adapter is responsible for MAPPING external API shapes into `RecordEnvelope`s
 * (stable id, a version, `source: "remote"`, etc.). That mapping is the per-backend glue;
 * the engine stays backend-agnostic.
 */
import type { RecordEnvelope } from "../records/record-envelope.js";

export interface Mutation<T> {
	/** Unique id for this push (lets the remote ack/deduplicate). */
	mutationId: string;
	collection: string;
	recordId: string;
	/** The local record to push (a tombstone, i.e. `meta.deleted`, represents a delete). */
	record: RecordEnvelope<T>;
}

export interface PullArgs<Filter, Cursor> {
	/** Backend-specific filter (e.g. a JQL string, a repo + label set, etc.). */
	filter?: Filter;
	/** Opaque position from the previous pull, for incremental fetches. */
	cursor?: Cursor;
}

export interface PullResult<T, Cursor> {
	/**
	 * Records to merge locally. The engine normalizes them as remote data (`source: "remote"`,
	 * `dirty: false`), so the adapter only needs a stable `id`, the `data`, and a `version`
	 * that increases whenever the remote record changes.
	 */
	records: RecordEnvelope<T>[];
	/** Cursor to pass to the next pull (e.g. a timestamp or page token). */
	cursor?: Cursor;
	/**
	 * More pages remain: the engine immediately pulls again with `cursor`, within the same
	 * `pull()`. The returned `cursor` must change from page to page.
	 */
	hasMore?: boolean;
	/**
	 * Set on the LAST page of a full snapshot (every record the remote has for this filter).
	 * Local clean records that weren't in any page of this pull are then removed -- that's how
	 * remote deletions reach a source that can't report them. Dirty local records are kept.
	 * Nothing is removed if any page fails. The cursor resets so the next pull starts over.
	 */
	complete?: boolean;
}

export interface PushRejection<T> {
	mutationId: string;
	reason: string;
	/**
	 * The remote's current copy of the record, if the rejection was a conflict (the remote
	 * changed since the local edit's `meta.remoteVersion`). The engine resolves it with the
	 * collection's merge strategy and emits `"conflict"`. Without it, the record is held back
	 * from automatic pushes until it's edited again.
	 */
	record?: RecordEnvelope<T>;
}

export interface PushResult<T> {
	/** `mutationId`s the remote accepted. */
	acked: string[];
	/** Authoritative server records to merge back (optional). */
	records?: RecordEnvelope<T>[];
	/** Mutations the remote rejected (optional). */
	rejected?: PushRejection<T>[];
}

export interface SyncAdapter<T, Filter = unknown, Cursor = unknown> {
	/** Fetch remote records (optionally filtered / incremental via cursor). */
	pull(args: PullArgs<Filter, Cursor>): Promise<PullResult<T, Cursor>>;
	/** Send local changes to the remote. OMIT for a read-only (pull-only) source. */
	push?(mutations: Mutation<T>[]): Promise<PushResult<T>>;
}
