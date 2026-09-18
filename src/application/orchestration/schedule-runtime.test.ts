import { afterEach, expect, test } from "bun:test";
import {
  openProductStoreOrThrow,
  removeTemporaryRoots,
  temporaryRoot,
} from "../../data/fixtures.ts";
import { createScheduleStore } from "../../data/orchestration/schedule-store.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { ok } from "../../domain/foundation/result.ts";
import {
  type ScheduleBinding,
  type ScheduleTerminal,
  scheduleDefinitionSchema,
} from "../../domain/orchestration/schedule-state.ts";
import { createScheduleActions } from "./schedule-actions.ts";
import { createScheduleRuntime, type ScheduleExecutor } from "./schedule-runtime.ts";

afterEach(removeTemporaryRoots);
const processIdentity = { platform: "darwin" as const, pid: 123, birth: "test-birth" };
const binding: ScheduleBinding = {
  authority: canonicalDigest("authority"),
  descriptor: canonicalDigest("descriptor"),
  configuration: canonicalDigest("config"),
  configurationGeneration: 1,
  timezoneData: "test",
};
async function fixture() {
  const root = await temporaryRoot("falryn-schedules-");
  const db = await openProductStoreOrThrow(root);
  const store = createScheduleStore(db);
  let now = 100_000;
  let effects = 0;
  const executor: ScheduleExecutor = {
    validate: async () => ok(binding),
    async execute() {
      effects++;
      return {
        status: "succeeded",
        effect: "completed",
        reason: "completed",
        result: null,
        at: now,
      };
    },
    reconcile: async () => null,
    notify: async () => true,
  };
  const actions = createScheduleActions({
    store,
    workspace: "workspace",
    now: () => now,
    authority: executor,
  });
  const invoke = (command: unknown, actor: "user" | "model" = "user") =>
    actions.execute(command, actor, new AbortController().signal);
  const runtime = () =>
    createScheduleRuntime({
      store,
      workspace: "workspace",
      executor,
      process: processIdentity,
      identities: { inspect: async () => ({ kind: "vanished" }) },
      now: () => now,
    });
  const definition = scheduleDefinitionSchema.parse({
    version: 1,
    timing: { trigger: { kind: "interval", everyMs: 1000 } },
    target: { kind: "action", capability: "builtin:test/read@1", input: {} },
  });
  return {
    root,
    db,
    store,
    executor,
    invoke,
    runtime,
    definition,
    advance: (ms: number) => {
      now += ms;
    },
    effects: () => effects,
  };
}
test("inert registration, explicit enable, two host occurrence claim, pause and disabled edit", async () => {
  const f = await fixture();
  expect((await f.invoke({ operation: "preview", definition: f.definition })).ok).toBe(true);
  expect((await f.invoke({ operation: "create", id: "test", definition: f.definition })).ok).toBe(
    true,
  );
  expect(
    await f.invoke({ operation: "enable", id: "test", expectedRevision: 1 }, "model"),
  ).toMatchObject({ ok: false, error: { code: "user-action-required" } });
  const a = f.runtime();
  const b = f.runtime();
  await a.wake();
  expect(f.effects()).toBe(0);
  expect((await f.invoke({ operation: "enable", id: "test", expectedRevision: 1 })).ok).toBe(true);
  await Promise.all([a.wake(), b.wake()]);
  expect(f.effects()).toBe(1);
  const read = f.store.get("workspace", "test");
  if (!read.ok) throw new Error("read");
  expect(
    (await f.invoke({ operation: "pause", id: "test", expectedRevision: read.value.revision })).ok,
  ).toBe(true);
  f.advance(5000);
  await a.wake();
  expect(f.effects()).toBe(1);
  const paused = f.store.get("workspace", "test");
  if (!paused.ok) throw new Error("read");
  expect(
    (
      await f.invoke({
        operation: "update",
        id: "test",
        expectedRevision: paused.value.revision,
        definition: f.definition,
      })
    ).ok,
  ).toBe(true);
  expect(f.store.get("workspace", "test")).toMatchObject({
    ok: true,
    value: { state: "disabled", generation: 2, binding: null },
  });
  await a.close();
  await b.close();
  await f.db.close();
});
test("restart does not replay a claimed effect without settlement evidence", async () => {
  const f = await fixture();
  await f.invoke({ operation: "create", id: "test", definition: f.definition });
  await f.invoke({ operation: "enable", id: "test", expectedRevision: 1 });
  let finish!: (value: ScheduleTerminal) => void;
  f.executor.execute = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const a = f.runtime();
  await a.wake();
  const b = f.runtime();
  await b.wake();
  expect(f.store.attempts("workspace")).toMatchObject({
    ok: true,
    value: [{ terminal: { status: "uncertain", reason: "executor-lost-recovery-required" } }],
  });
  finish({
    status: "succeeded",
    effect: "completed",
    reason: "completed",
    result: null,
    at: 100000,
  });
  await a.close();
  await b.close();
  await f.db.close();
  const reopened = await openProductStoreOrThrow(f.root);
  expect(createScheduleStore(reopened).attempts("workspace")).toMatchObject({
    ok: true,
    value: [{ terminal: { status: "uncertain" } }],
  });
  await reopened.close();
});
test("changed authority blocks new admission and imports require adoption", async () => {
  const f = await fixture();
  await f.invoke({ operation: "import", id: "test", definition: f.definition });
  expect(await f.invoke({ operation: "enable", id: "test", expectedRevision: 1 })).toMatchObject({
    ok: false,
    error: { code: "adoption-required" },
  });
  await f.invoke({ operation: "adopt", id: "test", expectedRevision: 1 });
  await f.invoke({ operation: "enable", id: "test", expectedRevision: 2 });
  f.executor.validate = async () => ok({ ...binding, authority: canonicalDigest("changed") });
  const runtime = f.runtime();
  await runtime.wake();
  expect(f.effects()).toBe(0);
  expect(f.store.get("workspace", "test")).toMatchObject({
    ok: true,
    value: { blocker: "authority-changed" },
  });
  await runtime.close();
  await f.db.close();
});

test("missed policies, long live-host sleep and rollback retain decisions without replay", async () => {
  for (const missed of [
    { kind: "none" },
    { kind: "latest" },
    { kind: "bounded-all", maxCatchUpRuns: 2 },
  ] as const) {
    const f = await fixture();
    const runtime = f.runtime();
    await f.invoke({
      operation: "create",
      id: "test",
      definition: { ...f.definition, missed, overlap: { kind: "parallel", limit: 4 } },
    });
    await f.invoke({ operation: "enable", id: "test", expectedRevision: 1 });
    await runtime.wake();
    f.advance(5000);
    await runtime.wake();
    await runtime.wake();
    expect(f.effects()).toBe(missed.kind === "none" ? 2 : missed.kind === "latest" ? 3 : 4);
    const slots = f.store.slots("workspace", "test");
    expect(slots.ok).toBe(true);
    if (slots.ok) {
      expect(slots.value).toHaveLength(6);
      expect(
        slots.value.filter(
          (slot) =>
            slot.disposition ===
            (missed.kind === "none"
              ? "missed"
              : missed.kind === "latest"
                ? "coalesced"
                : "over-limit"),
        ),
      ).toHaveLength(missed.kind === "none" ? 4 : missed.kind === "latest" ? 3 : 2);
    }
    const effects = f.effects();
    f.advance(-4000);
    await runtime.wake();
    expect(f.effects()).toBe(effects);
    await runtime.close();
    await f.db.close();
  }
});

test("exact cancellation acknowledgement and failed notification survive retry without repeating effects", async () => {
  const f = await fixture();
  await f.invoke({ operation: "create", id: "test", definition: f.definition });
  await f.invoke({ operation: "enable", id: "test", expectedRevision: 1 });
  let executions = 0;
  f.executor.execute = async (_record, _attempt, signal) => {
    executions++;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return { status: "cancelled", reason: "cancelled", effect: "none", result: null, at: 100000 };
  };
  f.executor.notify = async () => false;
  const runtime = f.runtime();
  await runtime.wake();
  const attempts = f.store.attempts("workspace");
  if (!attempts.ok || !attempts.value[0]) throw new Error("missing attempt");
  expect(
    await f.invoke({ operation: "cancel", attempt: attempts.value[0].id, expectedRevision: 1 }),
  ).toMatchObject({ ok: true });
  await runtime.wake();
  await runtime.wake();
  expect(f.store.attempt("workspace", attempts.value[0].id)).toMatchObject({
    ok: true,
    value: {
      cancelRequestedAt: 100000,
      cancelAcknowledgedAt: 100000,
      terminal: { status: "cancelled" },
    },
  });
  expect(f.store.notifications("workspace")).toMatchObject({
    ok: true,
    value: [{ id: attempts.value[0].id }],
  });
  f.executor.notify = async () => true;
  await runtime.wake();
  expect(f.store.notifications("workspace")).toEqual(ok([]));
  expect(executions).toBe(1);
  await runtime.close();
  await f.db.close();
});

test("bounded pages make progress through a catalog larger than one wake", async () => {
  const f = await fixture();
  for (let i = 0; i < 40; i++) {
    const id = `schedule-${String(i).padStart(2, "0")}`;
    await f.invoke({ operation: "create", id, definition: f.definition });
    await f.invoke({ operation: "enable", id, expectedRevision: 1 });
  }
  const runtime = f.runtime();
  for (let i = 0; i < 6; i++) await runtime.wake();
  expect(f.effects()).toBe(40);
  await runtime.close();
  await f.db.close();
});

test("pause preserves admitted work; resume applies missed policy rather than launching its backlog", async () => {
  const f = await fixture();
  await f.invoke({ operation: "create", id: "test", definition: f.definition });
  await f.invoke({ operation: "enable", id: "test", expectedRevision: 1 });
  const runtime = f.runtime();
  await runtime.wake();
  const read = f.store.get("workspace", "test");
  if (!read.ok) throw new Error("missing");
  await f.invoke({ operation: "pause", id: "test", expectedRevision: read.value.revision });
  f.advance(5000);
  await runtime.wake();
  const paused = f.store.get("workspace", "test");
  if (!paused.ok) throw new Error("missing");
  await f.invoke({ operation: "resume", id: "test", expectedRevision: paused.value.revision });
  await runtime.wake();
  expect(f.effects()).toBe(2);
  await runtime.close();
  await f.db.close();
});

test("uncooperative shutdown is bounded, holds later admission, and fences late completion", async () => {
  const f = await fixture();
  await f.invoke({ operation: "create", id: "test", definition: f.definition });
  await f.invoke({ operation: "enable", id: "test", expectedRevision: 1 });
  let finish!: (value: ScheduleTerminal) => void;
  f.executor.execute = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const host = f.runtime();
  await host.wake();
  const began = Date.now();
  expect(await host.close()).toBe(false);
  expect(Date.now() - began).toBeLessThan(2000);
  expect(f.store.get("workspace", "test")).toMatchObject({
    ok: true,
    value: { state: "paused", blocker: "uncertain-attempt-inspect-before-resume" },
  });
  const before = f.store.attempts("workspace");
  f.advance(10000);
  const restarted = f.runtime();
  await restarted.wake();
  expect(f.store.attempts("workspace")).toEqual(before);
  finish({ status: "succeeded", effect: "completed", reason: "late", result: null, at: 110000 });
  await host.close();
  expect(f.store.attempts("workspace")).toEqual(before);
  await restarted.close();
  await f.db.close();
});

test("unavailable process identity blocks parallel admission without guessing executor death", async () => {
  const f = await fixture();
  await f.invoke({
    operation: "create",
    id: "test",
    definition: { ...f.definition, overlap: { kind: "parallel", limit: 4 } },
  });
  await f.invoke({ operation: "enable", id: "test", expectedRevision: 1 });
  let finish!: (value: ScheduleTerminal) => void;
  f.executor.execute = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const original = f.runtime();
  await original.wake();
  f.advance(1000);
  const observer = createScheduleRuntime({
    store: f.store,
    workspace: "workspace",
    executor: f.executor,
    process: processIdentity,
    identities: { inspect: async () => ({ kind: "unavailable", reason: "fixture" }) },
    now: () => 101000,
  });
  await observer.wake();
  expect(f.store.attempts("workspace")).toMatchObject({ ok: true, value: [{ terminal: null }] });
  expect(f.store.get("workspace", "test")).toMatchObject({
    ok: true,
    value: { blocker: "executor-identity-unavailable" },
  });
  finish({
    status: "succeeded",
    effect: "completed",
    reason: "completed",
    result: null,
    at: 101000,
  });
  await original.close();
  await observer.close();
  await f.db.close();
});
