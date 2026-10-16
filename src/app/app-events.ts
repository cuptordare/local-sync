/**
 * Runtime-level events emitted by an app instance.
 */

/** A background problem the app noticed. Nothing is thrown at you for these -- listen for them. */
export interface LocalSyncErrorEvent {
	/**
	 * `"storage"`: reading or saving local storage failed.
	 * `"remote-validation"`: a value from elsewhere (the remote, or another tab) failed the
	 * collection's validator. It's hidden: reads treat its key as missing until a valid value
	 * replaces it.
	 * `"merge"`: combining two concurrent edits failed (the `merge` function threw, or its
	 * result failed the validator). The later of the two edits is kept instead.
	 * `"sync"`: a pull or push for an app-managed remote failed (after retries).
	 */
	source: "storage" | "remote-validation" | "merge" | "sync";
	collection: string;
	/** The record involved, when known. */
	id?: string;
	error: unknown;
}

export interface LocalSyncMergeEvent {
	collection: string;
	id: string;
	mine: unknown;
	theirs: unknown;
	result: unknown;
}

export type LocalSyncAppEventMap = {
	/** A collection was registered (first `app.collection(name)` call for that name). */
	"collection:created": { name: string };
	/**
	 * A background error. If nothing listens for this event (and no `onError` option was
	 * given), it is logged with `console.error` so it's never silently lost.
	 */
	error: LocalSyncErrorEvent;
	/**
	 * An edit made here and one someone else saved meanwhile were combined (see the `merge`
	 * option); the result is saved. `mine` is this device's edit, to offer e.g. "Keep mine"
	 * (`store.set(id, mine)`) where the later edit won a change both made.
	 */
	merged: LocalSyncMergeEvent;
	/** The app was closed. */
	disposed: undefined;
};
