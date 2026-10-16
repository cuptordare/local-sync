/**
 * Sync lifecycle events. Subscribe via `engine.on(...)` to drive logging,
 * toasts, analytics, or to trigger follow-up work when a pull/push completes.
 */
export type SyncDirection = "pull" | "push" | "full";

export type SyncEventMap = {
	/** A sync operation began. */
	"sync:start": { direction: SyncDirection };
	/** A full `sync()` completed successfully. */
	"sync:success": { direction: SyncDirection };
	/** A pull completed. */
	"pull:success": undefined;
	/** A push completed (local changes are saved on the remote). */
	"push:success": undefined;
	/** A pull or push failed (after retries). */
	"sync:error": { phase: "pull" | "push"; error: unknown };
};
