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
	/** A pull completed; `count` records were received (across all pages). */
	"pull:success": { count: number };
	/** A push completed; `count` mutations were acknowledged. */
	"push:success": { count: number };
	/** A pull or push failed (after retries). */
	"sync:error": { phase: "pull" | "push"; error: unknown };
	/**
	 * The remote rejected a push because the record changed there since this edit's base;
	 * the remote copy was resolved through the merge strategy.
	 */
	conflict: { id: string; reason: string };
	/**
	 * The remote rejected a push without sending its copy back. The record stays dirty but is
	 * held back from automatic pushes until it's edited again (see `SyncState.rejected`).
	 */
	"push:rejected": { id: string; reason: string };
};
