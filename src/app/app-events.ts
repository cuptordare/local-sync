/**
 * Runtime-level events emitted by an app instance.
 */
export type LocalSyncAppEventMap = {
	/** A collection was registered (first `app.collection(name)` call for that name). */
	"collection:created": { name: string };
	/** The app was closed. */
	disposed: undefined;
};
