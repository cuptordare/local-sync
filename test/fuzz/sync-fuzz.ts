/**
 * Randomized end-to-end test: several devices (each with several tabs sharing one storage)
 * edit a shared set of keys while syncing through one server, with random latency, outages,
 * lost replies (saved, but the answer never arrives), offline periods, storage load failures,
 * and tab reloads. After everything settles, it checks
 * the invariants the library promises:
 *
 *   1. Convergence: every tab shows exactly what the server holds, and nothing is pending.
 *   2. Durability: each device's storage matches what its tabs show.
 *   3. No invented data: every value shown was written by someone.
 *   4. No lost edits: a key ends with its last write -- or, if that write was made without
 *      seeing some earlier ones (concurrently), possibly one of those.
 *
 * Each run is driven by a seed. On failure, the message names the seed and the operations.
 * Run it with `npm run test:fuzz` (quick) or `npm run test:fuzz:long`. Environment variables:
 *   FUZZ_SEED=<n>     run only that seed (to reproduce a failure)
 *   FUZZ_TRACE=<key>  log every change to that key, in every tab and on the server
 *   FUZZ_SEEDS=<n>    how many seeds (overrides the entry file's default)
 *   FUZZ_STEPS=<n>    operations per scenario (default 60)
 * Timing is part of each scenario, so a failure may need a few reruns to reproduce.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LocalSyncApp } from "../../src/app/create-local-sync-app.js";
import { createLocalSyncApp } from "../../src/app/create-local-sync-app.js";
import type { KeyValueStore } from "../../src/app/key-value-store.js";
import type { TabChannel } from "../../src/network/tab-channel.js";
import { createInMemoryChannelHub } from "../../src/network/tab-channel.js";
import { createMemoryAdapter } from "../../src/storage/memory-adapter.js";
import type { StorageAdapter } from "../../src/storage/storage-adapter.js";
import { createBlobSyncAdapter } from "../../src/sync/adapters/blob-sync-adapter.js";
import type { SyncAdapter } from "../../src/sync/sync-adapter.js";
import { createFakeBlobServer } from "../unit/support/fake-blob-server.js";
import { createFakeLockManager } from "../unit/support/fake-lock-manager.js";
import { createFakeNetworkStatus } from "../unit/support/fake-network-status.js";

interface Item {
	v: string;
}

const DEVICES = 2;
const TABS_PER_DEVICE = 2;
const KEYS = ["a", "b", "c", "d"];
const STEPS = Number(process.env.FUZZ_STEPS ?? 60);
/** Log every change to this key (in every tab, and on the server) with the operations. */
const TRACE = process.env.FUZZ_TRACE;

/** Small, fast, seedable PRNG (mulberry32). */
function createRandom(seed: number) {
	let state = seed >>> 0;
	const next = (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		int: (n: number) => Math.floor(next() * n),
		pick: <T>(items: readonly T[]): T =>
			items[Math.floor(next() * items.length)] as T,
		chance: (p: number) => next() < p,
	};
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One local write, as the test saw it happen. */
interface Write {
	tab: string;
	/** The value written, or null for a delete. */
	value: string | null;
	/**
	 * The earlier writes (indexes into the key's writes) this one was made with knowledge of:
	 * the one its tab was showing, and everything that one knew of. The others were
	 * concurrent with it.
	 */
	knows: ReadonlySet<number>;
}

/** What the test knows was written to one key, to check invariants 3 and 4. */
interface KeyHistory {
	values: Set<string>;
	writes: Write[];
}

/** A channel whose messages arrive a little later (in order), as real cross-tab messages do. */
function delayedChannel(channel: TabChannel, delay: () => number): TabChannel {
	return {
		post: (message) => channel.post(message),
		subscribe(listener) {
			// Each message arrives a few ms after it was sent, never before an earlier one --
			// without delays piling up behind each other.
			let lastArrival = 0;
			return channel.subscribe((message) => {
				const arrival = Math.max(lastArrival, performance.now() + delay());
				lastArrival = arrival;
				setTimeout(() => listener(message), arrival - performance.now());
			});
		},
		close: () => channel.close(),
	};
}

/** Storage whose operations each take a few ms (like IndexedDB), so tabs' I/O interleaves. */
function slowStorage(
	inner: StorageAdapter,
	delay: () => number,
): StorageAdapter {
	const slow =
		<A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
		async (...args: A): Promise<R> => {
			await wait(delay());
			return fn(...args);
		};
	return {
		...inner,
		readAll: slow(inner.readAll),
		merge: slow(inner.merge),
		remove: slow(inner.remove),
	};
}

async function runScenario(seed: number, steps: number): Promise<void> {
	const random = createRandom(seed);
	const latency = createRandom(seed ^ 0x9e3779b9);
	// Each device's clock is off by up to 2 seconds, as real devices' clocks are.
	const skews = createRandom(seed ^ 0x5bd1e995);
	const log: string[] = [];
	const errors: unknown[] = [];

	const server = createFakeBlobServer<Item>({ cas: true });
	let serverDown = false;
	let repliesLost = false;
	const remoteFor = (): SyncAdapter<Item> =>
		createBlobSyncAdapter<Item>({
			async read() {
				await wait(latency.int(8));
				if (serverDown) throw new Error("server down");
				// An empty server still has an etag (as the adapter docs ask).
				return server.read();
			},
			async write(next, options) {
				await wait(latency.int(8));
				if (serverDown) throw new Error("server down");
				if (TRACE !== undefined) {
					const e = next.entries[TRACE];
					log.push(
						`    [server write] ${e?.deleted ? "deleted" : (e?.value as Item | undefined)?.v} @${e?.stamp}/${e?.device}`,
					);
				}
				const result = await server.write(next, options);
				// Saved, but the reply never arrives (a dropped connection or a timeout).
				if (repliesLost && result?.conflict !== true && latency.chance(0.5)) {
					throw new Error("reply lost");
				}
				return result;
			},
		});

	const history = new Map<string, KeyHistory>();
	const historyOf = (key: string): KeyHistory => {
		let h = history.get(key);
		if (h === undefined) {
			h = { values: new Set(), writes: [] };
			history.set(key, h);
		}
		return h;
	};
	/**
	 * A key everyone may write; one only this device's tabs write ("d0:x"); or one only this
	 * tab writes ("d0t1:0").
	 */
	const pickKey = (tab: { id: string }): string => {
		const roll = random.next();
		if (roll < 0.4) return random.pick(KEYS);
		if (roll < 0.7) return `${tab.id.slice(0, 2)}:${random.pick(["x", "y"])}`;
		return `${tab.id}:${random.int(2)}`;
	};

	interface Tab {
		id: string;
		app: LocalSyncApp;
		items: KeyValueStore<Item>;
		known: ReadonlyMap<string, string | null>;
	}
	interface Device {
		/** How far this device's clock is off, in ms. */
		skew: number;
		storage: StorageAdapter;
		network: ReturnType<typeof createFakeNetworkStatus>;
		hub: ReturnType<typeof createInMemoryChannelHub>;
		locks: ReturnType<typeof createFakeLockManager>;
		loadFails: { value: boolean };
		tabs: Tab[];
	}

	const openTab = (device: Device, id: string): Tab => {
		const inner = slowStorage(device.storage, () => latency.int(4));
		const storage: StorageAdapter = {
			...inner,
			async readAll(collection) {
				if (device.loadFails.value) throw new Error("storage read failed");
				return inner.readAll(collection);
			},
		};
		const app = createLocalSyncApp({
			now: () => Date.now() + device.skew,
			storage,
			network: device.network,
			multiTab: {
				channel: delayedChannel(device.hub.connect(), () => latency.int(10)),
				locks: device.locks,
			},
			onError: (error) => errors.push(error),
		});
		const items = app.keyValue<Item>("items", {
			remote: remoteFor(),
			pushDebounceMs: random.pick([0, 1, 3]),
			retry: { maxAttempts: 1 },
		});
		// What this tab has received for each key: a value, or null for a delete. A key it
		// has no entry for at all is missing (it hasn't heard of that key).
		const known = new Map<string, string | null>();
		items.collection.subscribe(({ changes }) => {
			for (const c of changes) {
				if (c.kind === "removed") known.delete(c.id);
				else
					known.set(
						c.id,
						c.kind === "deleted" ? null : (c.record?.data.v ?? null),
					);
			}
		});
		if (TRACE !== undefined) {
			items.collection.subscribe(({ changes }) => {
				for (const c of changes) {
					if (c.id !== TRACE) continue;
					const e = items.collection.snapshot().get(c.id);
					const pending = items.collection.pending().includes(c.id);
					log.push(
						`    [${id}] ${c.kind} ${c.record?.data.v ?? ""} @${e?.stamp}/${e?.device}${pending ? " pending" : ""}`,
					);
				}
			});
		}
		return { id, app, items, known };
	};

	const devices: Device[] = Array.from({ length: DEVICES }, (_, d) => {
		const device: Device = {
			skew: skews.int(4001) - 2000,
			storage: createMemoryAdapter(),
			network: createFakeNetworkStatus(true),
			hub: createInMemoryChannelHub(),
			locks: createFakeLockManager(),
			loadFails: { value: false },
			tabs: [],
		};
		device.tabs = Array.from({ length: TABS_PER_DEVICE }, (_, t) =>
			openTab(device, `d${d}t${t}`),
		);
		return device;
	});
	const allTabs = () => devices.flatMap((d) => d.tabs);

	/** Run a local write; one refused because the tab hasn't loaded yet is not a write. */
	const tryWrite = (tab: Tab, key: string, value: string | null): void => {
		// Deleting a key this tab doesn't show (e.g. it hasn't heard of it yet) does nothing.
		if (
			value === null &&
			tab.items.collection.hydrated &&
			!tab.items.has(key)
		) {
			log.push("  (nothing to delete in this tab)");
			return;
		}
		// What this tab has received for the key: values are unique, so this pins down which
		// earlier write it has seen (a tombstone = the latest delete; no record = none).
		const received = tab.known.has(key);
		const shown = tab.known.get(key) ?? null;
		try {
			if (value === null) tab.items.delete(key);
			else tab.items.set(key, { v: value });
		} catch (error) {
			if (/await app\.ready|loading from storage failed/.test(String(error))) {
				log.push(`  (refused: not loaded)`);
				return;
			}
			throw error;
		}
		const h = historyOf(key);
		const seen = received
			? h.writes.map((w) => w.value).lastIndexOf(shown)
			: -1;
		const knows = new Set(
			seen < 0 ? [] : [...(h.writes[seen] as Write).knows, seen],
		);
		if (value !== null) h.values.add(value);
		h.writes.push({ tab: tab.id, value, knows });
	};

	for (let step = 0; step < steps; step++) {
		const device = random.pick(devices);
		const tab = random.pick(device.tabs);
		const roll = random.next();
		if (roll < 0.35) {
			const key = pickKey(tab);
			const value = `${tab.id}#${step}`;
			log.push(`${step}: ${tab.id} set ${key}=${value}`);
			tryWrite(tab, key, value);
		} else if (roll < 0.45) {
			const key = pickKey(tab);
			log.push(`${step}: ${tab.id} delete ${key}`);
			tryWrite(tab, key, null);
		} else if (roll < 0.6) {
			log.push(`${step}: ${tab.id} sync`);
			void tab.app.sync().catch(() => {});
		} else if (roll < 0.67) {
			const online = !device.network.isOnline();
			log.push(`${step}: device of ${tab.id} ${online ? "online" : "offline"}`);
			device.network.set(online);
		} else if (roll < 0.7) {
			serverDown = !serverDown;
			log.push(`${step}: server ${serverDown ? "down" : "up"}`);
		} else if (roll < 0.73) {
			repliesLost = !repliesLost;
			log.push(
				`${step}: server replies ${repliesLost ? "sometimes lost" : "reliable"}`,
			);
		} else if (roll < 0.8) {
			log.push(`${step}: reload ${tab.id}`);
			const index = device.tabs.indexOf(tab);
			device.loadFails.value = random.chance(0.3);
			if (device.loadFails.value) log.push(`  (its next load fails)`);
			await tab.app.close();
			device.tabs[index] = openTab(device, tab.id);
			const reopened = device.tabs[index] as Tab;
			void reopened.app.ready().then(
				() => {},
				() => {},
			);
			// The failure is transient: it clears shortly, and a later sync retries the load.
			setTimeout(() => {
				device.loadFails.value = false;
			}, random.int(5));
		} else {
			const ms = random.int(6);
			log.push(`${step}: wait ${ms}ms`);
		}
		await wait(random.int(3));
	}

	// --- settle: heal everything, then sync until nothing changes ---
	log.push("settle");
	serverDown = false;
	repliesLost = false;
	for (const device of devices) {
		device.loadFails.value = false;
		device.network.set(true);
	}
	const settled = async (): Promise<boolean> => {
		for (const tab of allTabs()) {
			await tab.items.collection.load().catch(() => {});
			await tab.app.sync().catch(() => {});
		}
		await wait(10);
		for (const tab of allTabs()) {
			await tab.items.collection.whenPersisted();
		}
		const serverView = liveServerValues();
		return allTabs().every(
			(tab) =>
				tab.items.collection.hydrated &&
				tab.items.collection.pending().length === 0 &&
				sameEntries(tab.items.entries(), serverView),
		);
	};
	const liveServerValues = (): Map<string, string> =>
		new Map([...server.values()].map(([key, item]) => [key, item.v]));
	const sameEntries = (
		entries: Array<[string, Item]>,
		expected: Map<string, string>,
	): boolean =>
		entries.length === expected.size &&
		entries.every(([k, item]) => expected.get(k) === item.v);

	let converged = false;
	for (let round = 0; round < 8 && !converged; round++) {
		converged = await settled();
	}

	try {
		const serverView = liveServerValues();
		// 1. Convergence.
		for (const tab of allTabs()) {
			assert.equal(
				tab.items.collection.hydrated,
				true,
				`${tab.id} never loaded`,
			);
			assert.deepEqual(
				tab.items.collection.pending(),
				[],
				`${tab.id} still has unpushed changes`,
			);
			assert.deepEqual(
				new Map(tab.items.entries().map(([k, item]) => [k, item.v])),
				serverView,
				`${tab.id} doesn't match the server`,
			);
		}
		// 2. Durability: storage matches memory.
		for (const [d, device] of devices.entries()) {
			const stored = [...(await device.storage.readAll("items"))];
			const storedView = new Map(
				stored.flatMap(([key, { entry }]) =>
					entry.deleted ? [] : [[key, (entry.value as Item).v]],
				),
			);
			assert.deepEqual(
				storedView,
				serverView,
				`device d${d}'s storage differs`,
			);
			assert.ok(
				stored.every(
					([, { entry, synced }]) =>
						synced?.stamp === entry.stamp && synced.device === entry.device,
				),
				`device d${d}'s storage has entries still marked unpushed`,
			);
		}
		// 3. No invented data. 4. No lost edits: the final value is the last write, or one that
		// write didn't know about (a concurrent edit may win a conflict). A last write made
		// with every earlier write in view must win outright.
		for (const [key, h] of history) {
			const final = serverView.get(key) ?? null;
			if (final !== null) {
				assert.ok(
					h.values.has(final),
					`"${key}" holds ${final}, which nobody wrote`,
				);
			}
			const last = h.writes.at(-1) as Write;
			const allowed = h.writes
				.filter((w, i) => w === last || !last.knows.has(i))
				.map((w) => w.value);
			const unknown = h.writes.length - 1 - last.knows.size;
			assert.ok(
				allowed.includes(final),
				`"${key}" ends as ${final ?? "deleted"}, but its last write was ` +
					`${last.value ?? "a delete"} by ${last.tab}, made knowing of ` +
					`${unknown === 0 ? "every earlier write" : `all but ${unknown} earlier writes`}: ` +
					"that edit was lost",
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`seed ${seed}: ${message}\n` +
				`server: ${JSON.stringify(Object.entries(server.entries).map(([k, e]) => [k, e.deleted ? null : e.value?.v, e.stamp, e.device]))}\n` +
				`operations:\n${log.join("\n")}`,
			{ cause: error },
		);
	} finally {
		await Promise.all(allTabs().map((tab) => tab.app.close().catch(() => {})));
	}
}

/**
 * Register one test per seed: seeds 1..`defaultSeeds` (or as the environment says), running
 * `concurrency` at a time. (Scenarios are independent; running several at once also varies
 * their timing, which helps find races.)
 */
export function defineFuzzSuite(defaultSeeds: number, concurrency = 6): void {
	describe("randomized sync scenarios", { concurrency }, () => {
		const only = process.env.FUZZ_SEED;
		const count = Number(process.env.FUZZ_SEEDS ?? defaultSeeds);
		const seeds =
			only !== undefined
				? [Number(only)]
				: Array.from({ length: count }, (_, i) => i + 1);
		for (const seed of seeds) {
			it(`seed ${seed}`, async () => {
				await runScenario(seed, STEPS);
			});
		}
	});
}
