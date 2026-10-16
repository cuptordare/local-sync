/**
 * This device's id: random, created the first time it's needed and kept in storage, so every
 * tab of the app (they share storage) and every later session use the same one. Local edits
 * are stamped with it (`meta.writer`), which lets a device recognise its own earlier save on
 * the remote -- e.g. one whose reply was lost -- instead of mistaking it for someone else's.
 */
import { createId } from "../utils/ids.js";
import type { StorageEngine } from "./storage-engine.js";

/** Where the id is kept: a reserved collection no app data uses. */
const COLLECTION = "__localsync";
const KEY = "device";

const loaded = new WeakMap<StorageEngine, Promise<string>>();

/** Read this device's id from storage, creating it if there is none yet (atomically). */
export function loadDeviceId(storage: StorageEngine): Promise<string> {
	let pending = loaded.get(storage);
	if (pending === undefined) {
		pending = readOrCreate(storage);
		loaded.set(storage, pending);
		// A failed read is retried by the next caller.
		pending.catch(() => loaded.delete(storage));
	}
	return pending;
}

async function readOrCreate(storage: StorageEngine): Promise<string> {
	let id = "";
	await storage.update(COLLECTION, [KEY], ([stored]) => {
		const existing = (stored?.data as { id?: unknown } | undefined)?.id;
		if (typeof existing === "string") {
			id = existing;
			return { write: [], remove: [] };
		}
		id = createId("device");
		return {
			write: [
				{
					id: KEY,
					data: { id },
					meta: {
						version: 1,
						createdAt: Date.now(),
						updatedAt: Date.now(),
						deleted: false,
						dirty: false,
						source: "local",
					},
				},
			],
			remove: [],
		};
	});
	return id;
}
