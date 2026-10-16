/**
 * Who wrote an entry: this device's id (random, created once and kept in storage, so every
 * tab and session of the app on this device shares it) plus a short random id per tab. Tabs
 * share storage but not a clock, so two tabs could make the same stamp in the same
 * millisecond; the tab part keeps every write's `(stamp, device)` unique.
 */
import type { StorageAdapter } from "./storage-adapter.js";

/** Where the id is kept: a reserved collection no app data uses. */
const COLLECTION = "__localsync";
const KEY = "device";

/** `length` random lowercase letters and digits. */
export function randomId(length: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

const loaded = new WeakMap<StorageAdapter, Promise<string>>();

/** This device's id, read from storage, or created there if there is none yet. */
export function loadDeviceId(storage: StorageAdapter): Promise<string> {
	let pending = loaded.get(storage);
	if (pending === undefined) {
		pending = readOrCreate(storage);
		loaded.set(storage, pending);
		// A failed read is retried by the next caller.
		pending.catch(() => loaded.delete(storage));
	}
	return pending;
}

async function readOrCreate(storage: StorageAdapter): Promise<string> {
	const existing = (await storage.readAll(COLLECTION)).get(KEY)?.entry.value;
	if (isIdRecord(existing)) return existing.id;
	// Two tabs creating one at once: the merge keeps one of them, and both use that one.
	const proposal = {
		entry: {
			value: { id: randomId(10) },
			deleted: false,
			stamp: 0,
			device: "",
		},
	};
	try {
		const stored = await storage.merge(COLLECTION, new Map([[KEY, proposal]]));
		const winner = stored.get(KEY)?.entry.value;
		return isIdRecord(winner) ? winner.id : proposal.entry.value.id;
	} catch {
		// Couldn't save it (the failure shows up with the app's own writes): it only labels
		// writes, so use it for this session anyway rather than refuse to load.
		return proposal.entry.value.id;
	}
}

function isIdRecord(value: unknown): value is { id: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { id?: unknown }).id === "string"
	);
}

/** The `device` this tab writes as: the device's id plus a random id for this tab. */
export async function loadWriterId(storage: StorageAdapter): Promise<string> {
	return `${await loadDeviceId(storage)}.${randomId(4)}`;
}
