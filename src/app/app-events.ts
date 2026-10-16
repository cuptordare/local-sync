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
	 * `"sync"`: a pull or push for an app-managed remote failed (after retries).
	 */
	source: "storage" | "remote-validation" | "sync";
	collection: string;
	/** The record involved, when known. */
	id?: string;
	error: unknown;
}

export type LocalSyncAppEventMap = {
	/** A collection was registered (first `app.collection(name)` call for that name). */
	"collection:created": { name: string };
	/**
	 * A background error. If nothing listens for this event (and no `onError` option was
	 * given), it is logged with `console.error` so it's never silently lost.
	 */
	error: LocalSyncErrorEvent;
	/** The app was closed. */
	disposed: undefined;
};
