/**
 * Sync lifecycle events. Subscribe via `engine.on(...)` to drive logging,
 * toasts, analytics, or to trigger follow-up work when a pull/push completes.
 */
export type SyncDirection = "pull" | "push" | "full";

export type SyncEventMap = {
	/** A sync operation began. */
	"sync:start": { direction: SyncDirection };
	/** A full `sync()` (push + pull) completed successfully. */
	"sync:success": { direction: SyncDirection };
	/** A pull completed; `count` records were applied. */
	"pull:success": { count: number };
	/** A push completed; `count` mutations were acknowledged. */
	"push:success": { count: number };
	/** A pull or push failed (after retries). */
	"sync:error": { phase: "pull" | "push"; error: unknown };
};
