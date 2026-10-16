/**
 * Runtime-level events emitted by an app instance.
 */

/** A background problem the app noticed. Nothing is thrown at you for these -- listen for them. */
export interface LocalSyncErrorEvent {
	/**
	 * `"storage"`: saving to local storage failed.
	 * `"remote-validation"`: a record from the remote failed the collection's validator and
	 * was skipped (not applied).
	 * `"sync"`: a pull or push for an app-managed remote failed (after retries).
	 */
	source: "storage" | "remote-validation" | "sync";
	collection: string;
	/** The record involved, when known. */
	id?: string;
	error: unknown;
}

export interface LocalSyncConflictEvent {
	collection: string;
	id: string;
	reason: string;
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
	 * A push was rejected because someone else changed the record first; the merge strategy
	 * resolved it (with the default `serverWins()`, the local edit was replaced).
	 */
	conflict: LocalSyncConflictEvent;
	/** The app was closed. */
	disposed: undefined;
};
