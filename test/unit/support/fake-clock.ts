/** A deterministic, manually-advanced clock for tests that assert on timestamps/versions. */
export interface FakeClock {
	now(): number;
	advance(ms: number): void;
	set(ms: number): void;
}

export function createFakeClock(start = 0): FakeClock {
	let current = start;
	return {
		now: () => current,
		advance: (ms) => {
			current += ms;
		},
		set: (ms) => {
			current = ms;
		},
	};
}

/** An injectable Sleep that resolves immediately (or after a queued microtask) instead of waiting. */
export function createInstantSleep(): (ms: number) => Promise<void> {
	return () => Promise.resolve();
}
