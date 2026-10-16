/**
 * What a collection hands out for a stored value: the value (`data`) plus which write set it.
 * Envelopes are frozen and stable: the same write always gives the same envelope object.
 */
import type { Stamp } from "../crdt/hlc.js";

export interface RecordEnvelope<T> {
	id: string;
	data: T;
	meta: RecordMeta;
}

export interface RecordMeta {
	/** The write's hybrid-clock stamp (see crdt/hlc.ts). */
	stamp: Stamp;
	/** The device (and tab) that wrote it. */
	device: string;
	/** Epoch ms of the write (from `stamp`). */
	updatedAt: number;
}
