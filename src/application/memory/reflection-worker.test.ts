import { expect, test } from "bun:test";
import { openProductStoreOrThrow, temporaryRoot } from "../../data/fixtures.ts";
import { createReflectionRepository } from "../../data/memory/reflection-repository.ts";
import { createSqliteEventStore } from "../../data/sessions/event-store.ts";
import { createManualClock, err, instant } from "../../domain/foundation/index.ts";
import type { ReflectionRepository } from "../../domain/memory/reflection.ts";
import {
  type FixtureTurn,
  reflectionTurnEvents,
} from "../../domain/memory/reflection-extraction.fixtures.ts";
import type { EventStorePort } from "../../domain/sessions/event-store.ts";
import {
  reflectionActionsFor,
  reflectionAuthority,
  reflectionBinding,
  reflectionValue,
} from "./reflection.fixtures.ts";
import { createReflectionWorker, REFLECTION_WORKER_LIMITS } from "./reflection-worker.ts";

async function harness(turns: readonly FixtureTurn[]) {
  const root = await temporaryRoot("falryn-reflection-worker-");
  const store = await openProductStoreOrThrow(root);
  const events = createSqliteEventStore(store, { projectStartedRecords: true });
  const all = reflectionTurnEvents(turns);
  for (const event of all) {
    const appended = await events.append(event);
    if (!appended.ok) throw new Error(appended.error.code);
  }
  const clock = createManualClock(instant(Date.now()));
  const now = () => Number(clock.now());
  const actions = (repository?: ReflectionRepository) =>
    reflectionActionsFor(store, reflectionAuthority, now, repository);
  const worker = (
    options: { repository?: ReflectionRepository; events?: Pick<EventStorePort, "readFrom"> } = {},
  ) =>
    createReflectionWorker({
      actions: actions(options.repository),
      events: options.events ?? events,
      binding: () => reflectionBinding,
      clock,
    });
  const records = async () => {
    const page = reflectionValue(
      await actions().execute(JSON.stringify({ action: "list", after: null, limit: 32 })),
    );
    if (page.kind !== "page") throw new Error(page.kind);
    return Promise.all(
      page.items.map(async (item) => {
        const found = reflectionValue(
          await actions().execute(JSON.stringify({ action: "inspect", id: item.id })),
        );
        if (found.kind !== "record") throw new Error(found.kind);
        return found.record;
      }),
    );
  };
  const terminal = all
    .filter((event) => event.kind === "turn.completed")
    .map((e) => Number(e.sequence));
  return { store, events, all, clock, worker, records, terminal };
}
/** An event reader that holds each read until released, to interrupt extraction. */
function gated(events: Pick<EventStorePort, "readFrom">) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    reached,
    release: () => open(),
    events: {
      async readFrom(...args: Parameters<EventStorePort["readFrom"]>) {
        entered();
        await gate;
        return events.readFrom(...args);
      },
    },
  };
}
const turns: FixtureTurn[] = [
  { id: "turn-1", messages: ["Always run the linter before committing."] },
  { id: "turn-2", messages: ["We decided to keep the monorepo."] },
];

test("a settled turn creates one request for its committed range and publishes once", async () => {
  const h = await harness(turns);
  const worker = h.worker();
  const through = h.terminal.at(-1) ?? 0;
  expect(worker.wake({ throughSequence: through })).toBe("accepted");
  await worker.idle();
  expect(worker.status()).toMatchObject({
    state: "idle",
    receipts: [{ outcome: "completed", candidates: 2, range: { first: 1, last: through } }],
  });
  // Repeated and overlapping wakes find nothing due and create nothing.
  worker.wake({ throughSequence: through });
  worker.wake({ throughSequence: through - 1 });
  await worker.idle();
  expect(worker.status().receipts).toHaveLength(1);
  const [record] = await h.records();
  expect(record).toMatchObject({ state: "completed", reason: "turn-end", epoch: 1, lease: null });
  expect(record?.candidates.map((c) => [c.kind, c.decision, c.authority])).toEqual([
    ["user-preference", "pending", "derived"],
    ["decision", "pending", "derived"],
  ]);
  await worker.close();
});

test("each wake covers only newly committed turns, and an uncommitted tail waits", async () => {
  const h = await harness([
    ...turns,
    { id: "turn-3", messages: ["Always tag releases."], unfinished: true },
  ]);
  const worker = h.worker();
  worker.wake({ throughSequence: h.terminal[0] ?? 0 });
  await worker.idle();
  worker.wake({ throughSequence: h.terminal[1] ?? 0 });
  await worker.idle();
  const ranges = (await h.records()).map((r) => r.range).sort((a, b) => a.first - b.first);
  expect(ranges).toEqual([
    { first: 1, last: h.terminal[0] ?? 0 },
    { first: (h.terminal[0] ?? 0) + 1, last: h.terminal[1] ?? 0 },
  ]);
  // Startup reconciliation stops at the last committed turn: turn-3 is not requested.
  const restarted = h.worker();
  restarted.reconcile();
  await restarted.idle();
  expect(await h.records()).toHaveLength(2);
  await worker.close();
  await restarted.close();
});

test("startup reconciliation requests and processes committed work a crash left behind", async () => {
  const h = await harness(turns);
  // Nothing woke before the process stopped.
  expect(await h.records()).toEqual([]);
  const worker = h.worker();
  expect(worker.reconcile()).toBe("accepted");
  await worker.idle();
  expect(worker.status().receipts).toMatchObject([{ outcome: "completed", candidates: 2 }]);
  await worker.close();
});

test("shutdown mid-extraction releases the lease; the next start publishes exactly once", async () => {
  const h = await harness(turns);
  const held = gated(h.events);
  const first = h.worker({ events: held.events });
  first.wake({ throughSequence: h.terminal.at(-1) ?? 0 });
  await held.reached;
  const closing = first.close();
  // Close is idempotent and wakes after it are refused.
  expect(first.close()).toBe(closing);
  expect(first.wake({ throughSequence: 99 })).toBe("closed");
  held.release();
  await closing;
  expect(first.status()).toMatchObject({ state: "closed", receipts: [{ outcome: "cancelled" }] });
  const [released] = await h.records();
  // Not settled: still leased, but only for a millisecond, and nothing published.
  expect(released).toMatchObject({ state: "leased", publications: [], candidates: [] });
  await h.clock.advance(5 as never);
  const second = h.worker();
  second.reconcile();
  await second.idle();
  const [record] = await h.records();
  expect(record).toMatchObject({ state: "completed", epoch: 2 });
  expect(record?.publications).toHaveLength(1);
  expect(record?.candidates).toHaveLength(2);
  await second.close();
});

test("an interrupted acknowledgement is resolved from canonical identity, never republished", async () => {
  const h = await harness(turns);
  const real = createReflectionRepository(h.store);
  let interrupted = false;
  const flaky: ReflectionRepository = {
    transaction(work, signal) {
      const result = real.transaction(work, signal);
      const value = result.ok
        ? (result.value as { kind?: string; record?: { publications?: unknown[] } })
        : null;
      // The candidate transaction commits, then its acknowledgement is lost.
      if (
        !interrupted &&
        value?.kind === "record" &&
        (value.record?.publications?.length ?? 0) > 0
      ) {
        interrupted = true;
        return err({ kind: "reflection", code: "uncertain" });
      }
      return result;
    },
  };
  const first = h.worker({ repository: flaky });
  first.wake({ throughSequence: h.terminal.at(-1) ?? 0 });
  await first.idle();
  expect(first.status().receipts).toMatchObject([{ outcome: "uncertain", code: "uncertain" }]);
  await first.close();
  await h.clock.advance((REFLECTION_WORKER_LIMITS.leaseMs + 1) as never);
  const second = h.worker();
  second.reconcile();
  await second.idle();
  // The committed publication stands; nothing was due, so nothing ran again.
  expect(second.status().receipts).toEqual([]);
  const [record] = await h.records();
  expect(record).toMatchObject({ state: "completed" });
  expect(record?.publications).toHaveLength(1);
  expect(record?.candidates).toHaveLength(2);
  await second.close();
});

test("a stale owner adds nothing after another owner takes over its expired lease", async () => {
  const h = await harness(turns);
  const held = gated(h.events);
  const slow = h.worker({ events: held.events });
  slow.wake({ throughSequence: h.terminal.at(-1) ?? 0 });
  await held.reached;
  await h.clock.advance((REFLECTION_WORKER_LIMITS.leaseMs + 1) as never);
  const fresh = h.worker();
  fresh.reconcile();
  await fresh.idle();
  expect(fresh.status().receipts).toMatchObject([{ outcome: "completed" }]);
  held.release();
  await slow.idle();
  // Its identical deterministic publication is recognized as already committed: no write.
  expect(slow.status().receipts).toMatchObject([{ outcome: "completed" }]);
  const [record] = await h.records();
  expect(record).toMatchObject({ state: "completed", epoch: 2 });
  expect(record?.publications).toHaveLength(1);
  expect(record?.candidates).toHaveLength(2);
  await slow.close();
  await fresh.close();
});

test("a failed turn is never learned; an empty range settles empty", async () => {
  const h = await harness([
    {
      id: "turn-1",
      messages: ["Always deploy on Fridays."],
      outcome: { kind: "failed", effect: "none" },
    },
    { id: "turn-2", messages: ["Thanks, that works."] },
  ]);
  const worker = h.worker();
  worker.wake({ throughSequence: h.terminal.at(-1) ?? 0 });
  await worker.idle();
  expect(worker.status().receipts).toMatchObject([{ outcome: "empty", candidates: 0 }]);
  const [record] = await h.records();
  expect(record).toMatchObject({ state: "empty", candidates: [] });
  await worker.close();
});
