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
	/** Records to merge locally. Map external data -> envelopes with `source: "remote"`. */
	records: RecordEnvelope<T>[];
	/** Cursor to pass to the next pull (e.g. a timestamp or page token). */
	cursor?: Cursor;
	/** Whether more pages remain right now. */
	hasMore?: boolean;
}

export interface PushResult<T> {
	/** `mutationId`s the remote accepted. */
	acked: string[];
	/** Authoritative server records to merge back (optional). */
	records?: RecordEnvelope<T>[];
	/** Mutations the remote rejected, with reasons (optional). */
	rejected?: Array<{ mutationId: string; reason: string }>;
}

export interface SyncAdapter<T, Filter = unknown, Cursor = unknown> {
	/** Fetch remote records (optionally filtered / incremental via cursor). */
	pull(args: PullArgs<Filter, Cursor>): Promise<PullResult<T, Cursor>>;
	/** Send local changes to the remote. OMIT for a read-only (pull-only) source. */
	push?(mutations: Mutation<T>[]): Promise<PushResult<T>>;
}
