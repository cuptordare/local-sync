/**
 * WHAT THIS IS — record-envelope
 *
 * Every record the library stores is wrapped in an "envelope": the user's `data`
 * plus the `meta` the sync engine needs (version, timestamps, soft-delete, dirty
 * flag, origin). User data stays clean — all bookkeeping lives in `meta`.
 *
 * All helpers here are PURE and IMMUTABLE: they return a new envelope and never
 * mutate the input. That's what lets the reactivity layer rely on reference
 * identity (an unchanged record keeps its reference).
 *
 * @example
 *   const r = createEnvelope({ title: "Buy milk", done: false });
 *   //   r.meta -> { version: 1, dirty: true, source: "local", deleted: false, ... }
 *   const r2 = patchEnvelope(r, { done: true }); // version 2, new object, dirty
 *   const r3 = deleteEnvelope(r2);               // tombstone (meta.deleted = true)
 *   const r4 = markSynced(r3);                   // dirty -> false after a push
 */
import { createId } from "../utils/ids.js";
import { now as defaultNow } from "../utils/timestamps.js";

/** Where the current version of a record's data came from. */
export type RecordSource = "local" | "remote";

/** A stored record: user `data` + sync `meta`, keyed by `id`. */
export interface RecordEnvelope<T> {
	id: string;
	data: T;
	meta: RecordMeta;
}

/** Sync/bookkeeping metadata attached to every record. */
export interface RecordMeta {
	/** Monotonic per-record counter, bumped on every change. Drives merge + cursors. */
	version: number;
	/** Epoch ms when the record was first created. */
	createdAt: number;
	/** Epoch ms of the most recent change. */
	updatedAt: number;
	/** Soft delete / tombstone — the record is gone but its metadata survives for sync. */
	deleted: boolean;
	/** True when there are local changes not yet acknowledged by the remote. */
	dirty: boolean;
	/** Origin of the current version's data. */
	source: RecordSource;
}

export interface CreateEnvelopeOptions {
	/** Provide an id (e.g. when materializing a remote record); otherwise generated. */
	id?: string;
	/** Override the timestamp (defaults to `now()`). Useful for deterministic tests. */
	now?: number;
	/** Origin of this data. Defaults to `"local"`. */
	source?: RecordSource;
	/** Override the dirty flag. Defaults to `true` for local, `false` for remote. */
	dirty?: boolean;
}

export interface MutateEnvelopeOptions {
	now?: number;
	source?: RecordSource;
	dirty?: boolean;
}

/** Create a brand-new record envelope (version 1). */
export function createEnvelope<T>(
	data: T,
	options: CreateEnvelopeOptions = {},
): RecordEnvelope<T> {
	const timestamp = options.now ?? defaultNow();
	const source = options.source ?? "local";
	return {
		id: options.id ?? createId(),
		data,
		meta: {
			version: 1,
			createdAt: timestamp,
			updatedAt: timestamp,
			deleted: false,
			dirty: options.dirty ?? source === "local",
			source,
		},
	};
}

/** Replace a record's data, bumping version + updatedAt. Returns a new envelope. */
export function updateEnvelope<T>(
	envelope: RecordEnvelope<T>,
	data: T,
	options: MutateEnvelopeOptions = {},
): RecordEnvelope<T> {
	const timestamp = options.now ?? defaultNow();
	const source = options.source ?? "local";
	return {
		id: envelope.id,
		data,
		meta: {
			...envelope.meta,
			version: envelope.meta.version + 1,
			updatedAt: timestamp,
			deleted: false,
			dirty: options.dirty ?? source === "local",
			source,
		},
	};
}

/** Shallow-merge a partial patch into a record's data, then `updateEnvelope`. */
export function patchEnvelope<T extends object>(
	envelope: RecordEnvelope<T>,
	patch: Partial<T>,
	options: MutateEnvelopeOptions = {},
): RecordEnvelope<T> {
	return updateEnvelope(envelope, { ...envelope.data, ...patch }, options);
}

/** Tombstone a record (soft delete). Data is retained for sync; version bumped. */
export function deleteEnvelope<T>(
	envelope: RecordEnvelope<T>,
	options: MutateEnvelopeOptions = {},
): RecordEnvelope<T> {
	const timestamp = options.now ?? defaultNow();
	const source = options.source ?? "local";
	return {
		id: envelope.id,
		data: envelope.data,
		meta: {
			...envelope.meta,
			version: envelope.meta.version + 1,
			updatedAt: timestamp,
			deleted: true,
			dirty: options.dirty ?? source === "local",
			source,
		},
	};
}

/** Mark as synced (dirty -> false). Returns the same reference if already clean. */
export function markSynced<T>(envelope: RecordEnvelope<T>): RecordEnvelope<T> {
	if (!envelope.meta.dirty) return envelope;
	return { ...envelope, meta: { ...envelope.meta, dirty: false } };
}

/** Mark as having local changes (dirty -> true). Same reference if already dirty. */
export function markDirty<T>(envelope: RecordEnvelope<T>): RecordEnvelope<T> {
	if (envelope.meta.dirty) return envelope;
	return { ...envelope, meta: { ...envelope.meta, dirty: true } };
}

/** Whether a record is a tombstone (soft-deleted). */
export function isTombstone(envelope: RecordEnvelope<unknown>): boolean {
	return envelope.meta.deleted;
}
