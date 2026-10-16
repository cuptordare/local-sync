/**
 * A hybrid logical clock (HLC): stamps that follow the wall clock, but never go backwards and
 * always move past every stamp this clock has seen. So a write made after seeing another
 * write always gets a later stamp, even if this device's wall clock is behind.
 *
 * A stamp is one number: wall-clock milliseconds * 1000 + a counter (0-999) for writes within
 * the same millisecond. If the counter runs out, the stamp moves into the next millisecond.
 * (Safe as a JavaScript number until the year 2255.)
 *
 * @example
 *   const clock = createHybridClock();
 *   const a = clock.now();  // e.g. 1760616000000000
 *   clock.receive(b);       // b came from another device
 *   clock.now() > b;        // true
 */

/** An HLC timestamp: wall-clock ms * 1000 + a counter. */
export type Stamp = number;

const COUNTER_RANGE = 1000;

export interface HybridClock {
	/** A new stamp, later than every stamp this clock has made or received. */
	now(): Stamp;
	/** Note a stamp seen elsewhere, so later `now()` stamps come after it. */
	receive(stamp: Stamp): void;
}

/** `wallClock` returns epoch milliseconds (defaults to `Date.now`). */
export function createHybridClock(
	wallClock: () => number = Date.now,
): HybridClock {
	let last = 0;
	return {
		now() {
			last = Math.max(last + 1, Math.floor(wallClock()) * COUNTER_RANGE);
			return last;
		},
		receive(stamp) {
			if (isStamp(stamp) && stamp > last) last = stamp;
		},
	};
}

/** The stamp for a wall-clock time (counter 0, or `counter`). */
export function stampAt(ms: number, counter = 0): Stamp {
	return Math.floor(ms) * COUNTER_RANGE + counter;
}

/** The wall-clock milliseconds a stamp was made at. */
export function stampTime(stamp: Stamp): number {
	return Math.floor(stamp / COUNTER_RANGE);
}

export function isStamp(value: unknown): value is Stamp {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}
