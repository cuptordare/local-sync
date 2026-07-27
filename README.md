# local-sync

A zero-dependency, local-first, reactive data-sync engine for TypeScript/JavaScript.

Writes apply instantly to an in-memory, reactive store; persist durably to storage you
choose (IndexedDB, memory, or your own adapter); and sync to a remote — if and when you
have one — through a small adapter you implement. Nothing here assumes a framework,
a specific backend, or even a network connection.

- **Zero runtime dependencies.** `package.json` has none — the whole engine is plain TS/JS.
- **ESM only.** `"type": "module"`.
- **Framework-agnostic.** No React/Vue bindings exist yet; the core is proven with a
  vanilla-JS example (see [Quickstart](#quickstart)).
- **Offline-first by construction.** Mutations apply and are queryable before any network
  round-trip happens, and they survive a reload even if you never got online.

## Why

Most "sync" libraries start from the network: fetch, render, maybe cache. This one starts
from local state: every `insert`/`update`/`replace`/`delete` applies synchronously to an
in-memory store (so a live query re-renders in the same tick), is durably persisted in the
background, and is marked "dirty" until a `SyncEngine` you configure manages to push it
somewhere. If you never configure a `SyncEngine`, you have a reactive local database. If you
do, you get optimistic local-first sync with pluggable conflict resolution, retry/backoff,
offline gating, and multi-tab coordination — without the engine ever needing to know what
your backend actually is.

## Install

```sh
npm install @localsync
```

The package ships only `dist/` (compiled from `src/` by `tsc`, targeting ES2025) and has no
runtime dependencies. It works in the browser (IndexedDB, `BroadcastChannel`, `navigator`,
`window`) and in Node (in-memory storage, no browser globals required).

## Core concepts

| Concept | What it is |
|---|---|
| **App** (`createLocalSyncApp`) | The one facade most consumers touch. Owns storage and the collection registry. |
| **Collection** (`app.collection(name)` / `createCollection`) | A typed set of records. The CRUD + live-query surface you use day to day. |
| **RecordEnvelope** | `{ id, data, meta }` — your data, plus sync bookkeeping (`version`, `dirty`, `deleted`, timestamps, `source`) kept separate from it. |
| **ReactiveQuery** | A live, lazily-subscribed derived value (`collection.get(id)`, `collection.query()`). Only computes/subscribes while something is listening. |
| **SyncAdapter** | The contract *you* implement per backend. `pull` is required; `push` is optional — a read-only remote source is first-class. |
| **SyncEngine** (`createSyncEngine`) | Drives pull/push/sync against a `SyncAdapter`: retries, status, offline gating, lifecycle events. |
| **MergeStrategy** | How a local-vs-remote conflict is resolved: `serverWins()` (default), `lastWriteWins()`, or `custom()`. |

## Quickstart

```ts
import { createLocalSyncApp, createNetworkStatus, createSyncEngine } from "@localsync";

const app = createLocalSyncApp();
const notes = app.collection<{ text: string }>("notes");

const network = createNetworkStatus();
const engine = createSyncEngine({ collection: notes, adapter: myRemoteAdapter, network });
engine.start({ pushOnChange: true });

// Live query: excludes soft-deleted records, recomputes only while observed.
const activeNotes = notes.query();
render(activeNotes.getCurrentResult()); // initial paint — subscribe() does NOT fire immediately
const unsubscribe = activeNotes.subscribe(render); // re-render only on real changes

notes.insert({ text: "Buy milk" }); // optimistic — render() fires synchronously, before any network call
notes.delete(id); // soft delete (tombstone); excluded from query() from this point on
```

`myRemoteAdapter` is anything implementing `SyncAdapter` — `{ pull(args) { ... }, push(mutations) { ... } }`.

A complete, runnable "recipe" version of this lives in
[`examples/vanilla-js-notes-app`](examples/vanilla-js-notes-app). It runs **two independent
client panels side by side** (think: two different users/devices) against one shared mock
backend, so it can demonstrate what a minimal quickstart can't: real IndexedDB persistence,
write-time validation, editing an existing record while a concurrent remote update arrives
(the "pending synced state" pattern — see the example's `client.js`), and triggering an
actual conflict and watching a merge strategy resolve it. **Auto-sync (push on change + poll)
is on by default** — the same as most real apps — with the manual Push/Pull/Sync buttons and
an "Auto-sync" toggle available specifically to instrument edge cases like the conflict
walkthrough or an injectable server failure with its retry/error UI, not required for normal
use. It uses **zero build tooling** — just a browser import map pointing at the built library
— so it also doubles as proof the core has no framework dependency. To run it:

```sh
npm run build                          # emits dist/index.js, which the example imports
cd examples/vanilla-js-notes-app
npm start                              # serves the repo root, redirects / to this example
```

## Storage adapters

- **`createMemoryAdapter()`** — the default. A `Map` in memory; data is lost on reload. Good
  for tests, demos, and server-side/ephemeral use.
- **`createIndexedDBAdapter(options?)`** — persists to a single IndexedDB object store
  (`"records"`), keyed by a composite `collection + id`, with an index for per-collection
  reads. Opened lazily on first use.

  ```ts
  createIndexedDBAdapter({ databaseName: "my-app" });
  ```

  > **Always pass an explicit `databaseName`.** It defaults to `"app"` and the version
  > defaults to `1` — two `createLocalSyncApp()` instances that both omit `databaseName`
  > will share (and can collide on) the same IndexedDB database in that origin. See
  > `examples/vanilla-js-notes-app/client.js`, where the two demo clients deliberately use
  > distinct names for exactly this reason.

`createStorageEngine(adapter)` is the coordinator collections use internally (adds
`hydrate()` for populating in-memory state on startup); most consumers never touch it
directly unless they're writing a custom `StorageAdapter`.

## Sync semantics

This is the part worth reading carefully before wiring up a real backend.

- **Optimistic, version-ordered writes.** Every mutation applies to the in-memory store
  synchronously (bumping `meta.version`, setting `meta.dirty = true`), then a durable write
  is enqueued on a serialized queue — so even if the underlying storage's writes resolve out
  of order, they always *land* in version order.
- **The push backlog *is* `meta.dirty`.** `collection.pending()` returns the dirty records;
  there's no separate queue to keep in sync. A change made offline is still "pending" after a
  reload, because dirty is persisted with the record itself.
- **`keepPendingOnPull` (default `true`).** A pull will not overwrite a record that has
  un-pushed local edits — your optimistic change stays visible until *it* gets pushed. Set to
  `false` to resolve conflicts immediately on pull instead (the server may win and discard
  the local edit, per your merge strategy).
- **`purgeDeletedOnPush` (default `false`).** After a successful push, hard-remove tombstones
  the remote has now acknowledged, from both memory and storage. Without it, deleted records
  accumulate as tombstones forever.
- **Merge strategies** resolve genuine conflicts (both sides exist, both changed) — brand-new
  remote records are just inserted, no merge involved:
  - `serverWins()` — remote always wins (**default**).
  - `lastWriteWins()` — compares `meta.version`, then `meta.updatedAt`.
  - `custom((local, remote) => merged)` — you decide.
  - `preferDeletion(strategy)` — wraps any of the above so a tombstone on either side always
    wins outright, instead of falling through to the wrapped strategy.
  > **A delete is just a dirty tombstone, so it goes through this exact same conflict path.**
  > `serverWins()` and a `custom()` merge that only compares `data` (not `meta.deleted`) can
  > both silently *resurrect* a delete that hasn't been pushed yet, if a pull races ahead of
  > the delete's push — easy to hit with `keepPendingOnPull: false`, or with any periodic
  > polling, since the pull can land on any tick. The record then often disappears again on
  > the *next* pull once the delete actually reaches the server — a confusing flicker.
  > `lastWriteWins()` mostly avoids this by luck (a delete bumps `meta.version`), but isn't
  > guaranteed to. If a pending delete should never be silently discarded, wrap your strategy:
  > `merge: preferDeletion(lastWriteWins())`.
- **Push race protection.** Before pushing, the engine snapshots each record's `meta.version`.
  After the adapter resolves, only records whose version is *still unchanged* get the
  server's response applied or get marked synced — so a slow round-trip can't resurrect a
  record you edited or deleted while the push was in flight.
- **Error handling is asymmetric — read this twice:**
  - Calling `engine.pull()`, `engine.push()`, or `engine.sync()` **yourself** rejects (after
    emitting `"sync:error"`) if the adapter throws.
  - Paths the engine triggers **on its own** — `pushOnChange` scheduling, an automatic sync
    on reconnect, and `start()`'s `syncOnStart` — swallow errors and never reject.
  - If you rely only on those automatic paths, you **must** listen for
    `engine.on("sync:error", ...)` or watch `engine.status` to notice failures; nothing will
    throw at you.
- **`onError` (collection-level)** handles background *persistence* failures (the storage
  write, not sync). It defaults to an async throw (`queueMicrotask(() => { throw err })`) —
  easy to miss in a `try/catch` or a test. Pass it explicitly in production.
- **Retry/backoff** is exponential with "equal jitter" (`computeBackoff`/`withRetry`),
  configurable via `retry: { maxAttempts, baseDelayMs, maxDelayMs, factor, jitter }`, with an
  injectable `sleep` for deterministic tests.
- **`delete()` is an intentional no-op** on a missing or already-deleted record (unlike
  `update`/`replace`, which throw if the target doesn't exist). This is standard idempotent-
  delete behavior for offline-first systems — two tabs deleting the same record, or a retried
  delete, shouldn't be an error.
- **`insert()` throws if you pass an `id` that already exists** (live or tombstoned) in the
  collection — it will not silently overwrite an existing record.

## Multi-tab support

`createMultiTabSync()` coordinates multiple tabs of the same app over `BroadcastChannel`: it
elects one **leader** tab (the oldest, by a heartbeat-based presence check — not wall-clock
polling) and gives you `broadcast()`/`onBroadcast()` for cross-tab messages. It is a
**separate, composable primitive** — it is not wired into `SyncEngine` automatically. A
typical use is gating `engine.start()` behind leadership so only one tab talks to the server:

```ts
const multiTab = createMultiTabSync();
if (multiTab.isLeader()) engine.start({ intervalMs: 60_000 });
multiTab.onLeadershipChange((isLeader) => {
  if (isLeader) engine.start({ intervalMs: 60_000 });
  else engine.stop();
});
```

Note `onLeadershipChange` only fires on a *change* — check `isLeader()` once at startup
(as above), matching the rest of the library's subscribe conventions (see `ReactiveStore`).

This coordinates multiple *tabs of one user/device* — it's a different concept from multiple
*users* editing shared data (that's what `MergeStrategy` is for). The vanilla-JS example's two
client panels represent two users, not two tabs, so it deliberately leaves this pattern as a
comment rather than wiring it live; see `test/e2e/fixtures/multi-tab.spec.ts` for a working
example against a real two-tab harness.

## Validation

Collections default to `passthrough()` (no validation). Provide your own `Validator<T>`:

```ts
import { fromGuard } from "@localsync";

const isNote = (d: unknown): d is { text: string } =>
  typeof d === "object" && d !== null && typeof (d as { text?: unknown }).text === "string";

app.collection("notes", { validator: fromGuard(isNote, "Expected { text: string }") });
```

Wrap any schema library's `.parse`/`.safeParse` the same way — nothing here is bundled.

## What's public vs. internal

`src/index.ts` is the only supported entry point. A few things exist in the package but are
**not** re-exported from it, and should be treated as internal implementation details that
may change without notice: `debounce`, `deepEqual`, `createDisposableBag`, `createId`, `now`,
`createCollectionStore`, `buildMutations`, `defaultSleep`, and `EventBus`/`createEventBus`.
If you need one of these capabilities, treat it as something to implement yourself rather
than importing from a subpath.

## Dev workflow

```sh
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm run lint         # biome check --write
npm run test         # node:test unit tests (no build needed, runs against src/ via tsx)
npm run test:e2e     # Playwright, against a real browser (builds dist/ first)
npm run test:all     # both of the above
```

There is no CI configured yet — run `npm run test:all` locally before submitting changes.

## Status

Pre-release (`0.0.0`). No LICENSE file is present in this repository yet.
