/**
 * Runs an async job one pass at a time, coalescing calls that arrive meanwhile.
 *
 * A call while a pass is running doesn't start a second, overlapping pass: it joins the
 * running one and asks for ONE more pass afterwards (however many calls asked), so its
 * caller's request is still served by a pass that started after it. Everyone waiting
 * settles together when the passes stop.
 *
 * Failures: if a pass fails while another pass is queued, the queued pass runs instead (its
 * outcome is the one the callers are now waiting for). Otherwise `onFailure` sees the error
 * and the call rejects with it.
 *
 * @example
 *   const pull = createSerialTask(async () => { await fetchAndApply(); });
 *   void pull.run(); void pull.run(); // second call: one more pass after the first
 */
export interface SerialTask {
	/** Run a pass now, or (if one is running) once more after it. */
	run(): Promise<void>;
	/** Queue one more pass if a pass is running; otherwise do nothing. */
	rerunIfRunning(): void;
	readonly running: boolean;
}

export interface SerialTaskOptions {
	/** Called with a pass's error when nothing else is queued, before `run()` rejects with it. */
	onFailure?: (error: unknown) => void;
}

/**
 * `pass` returns `true` to ask for another pass itself (e.g. its own work queued more work).
 */
export function createSerialTask(
	// biome-ignore lint/suspicious/noConfusingVoidType: most passes are plain `async () => {}`
	pass: () => Promise<boolean | void>,
	options: SerialTaskOptions = {},
): SerialTask {
	let inFlight: Promise<void> | undefined;
	let rerunRequested = false;

	const loop = async (): Promise<void> => {
		try {
			do {
				rerunRequested = false;
				try {
					if ((await pass()) === true) rerunRequested = true;
				} catch (error) {
					if (rerunRequested) continue;
					options.onFailure?.(error);
					throw error;
				}
			} while (rerunRequested);
		} finally {
			// Cleared the moment the last pass ends (in the same step as the final check), so a
			// call that comes after it starts a new pass instead of joining one that's over.
			inFlight = undefined;
		}
	};

	return {
		run() {
			if (inFlight !== undefined) {
				rerunRequested = true;
				return inFlight;
			}
			inFlight = loop();
			return inFlight;
		},
		rerunIfRunning() {
			if (inFlight !== undefined) rerunRequested = true;
		},
		get running() {
			return inFlight !== undefined;
		},
	};
}
