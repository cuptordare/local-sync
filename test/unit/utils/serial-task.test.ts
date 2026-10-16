import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSerialTask } from "../../../src/utils/serial-task.js";
import { createDeferred } from "../support/fake-sync-adapter.js";

describe("createSerialTask", () => {
	it("never overlaps passes; calls during a pass coalesce into one more pass", async () => {
		let running = 0;
		let passes = 0;
		const gate = createDeferred<void>();
		const task = createSerialTask(async () => {
			running++;
			assert.equal(running, 1, "passes overlapped");
			passes++;
			if (passes === 1) await gate.promise;
			running--;
		});
		const first = task.run();
		const joined = [task.run(), task.run(), task.run()];
		assert.equal(task.running, true);
		gate.resolve();
		await Promise.all([first, ...joined]);
		assert.equal(passes, 2);
		assert.equal(task.running, false);
	});

	it("a pass can ask for another pass itself", async () => {
		let passes = 0;
		const task = createSerialTask(async () => ++passes < 3);
		await task.run();
		assert.equal(passes, 3);
	});

	it("rerunIfRunning queues a pass only while one is running", async () => {
		let passes = 0;
		const gate = createDeferred<void>();
		const task = createSerialTask(async () => {
			passes++;
			if (passes === 1) await gate.promise;
		});
		task.rerunIfRunning(); // idle: nothing happens
		assert.equal(passes, 0);
		const running = task.run();
		task.rerunIfRunning();
		gate.resolve();
		await running;
		assert.equal(passes, 2);
	});

	it("a failure with nothing queued is reported and rejects every waiter", async () => {
		const failures: unknown[] = [];
		const gate = createDeferred<void>();
		let passes = 0;
		const task = createSerialTask(
			async () => {
				passes++;
				await gate.promise;
				throw new Error("boom");
			},
			{ onFailure: (e) => failures.push(e) },
		);
		const first = task.run();
		gate.resolve();
		await assert.rejects(first, /boom/);
		assert.equal(failures.length, 1);
		assert.equal(task.running, false);
		await assert.rejects(task.run(), /boom/); // usable again afterwards
		assert.equal(passes, 2);
	});

	it("a failure with a pass queued runs that pass instead of failing", async () => {
		const failures: unknown[] = [];
		const gate = createDeferred<void>();
		let passes = 0;
		const task = createSerialTask(
			async () => {
				passes++;
				if (passes === 1) {
					await gate.promise;
					throw new Error("first pass failed");
				}
			},
			{ onFailure: (e) => failures.push(e) },
		);
		const first = task.run();
		const second = task.run();
		gate.resolve();
		await Promise.all([first, second]);
		assert.equal(passes, 2);
		assert.deepEqual(failures, []);
	});
});
