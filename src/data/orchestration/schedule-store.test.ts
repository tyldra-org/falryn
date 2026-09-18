import { afterEach, expect, test } from "bun:test";
import { createScheduleActions } from "../../application/orchestration/schedule-actions.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { ok } from "../../domain/foundation/result.ts";
import {
  type ScheduleAttempt,
  type ScheduleSlotRecord,
  scheduleDefinitionSchema,
} from "../../domain/orchestration/schedule-state.ts";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "../fixtures.ts";
import { createScheduleStore } from "./schedule-store.ts";

afterEach(removeTemporaryRoots);
async function fixture(
  overlap: { kind: "skip" | "queue-latest" } | { kind: "parallel"; limit: number } = {
    kind: "skip",
  },
) {
  const root = await temporaryRoot("schedule-storage-");
  const a = await openProductStoreOrThrow(root);
  const b = await openProductStoreOrThrow(root);
  const first = createScheduleStore(a);
  const second = createScheduleStore(b);
  const definition = scheduleDefinitionSchema.parse({
    version: 1,
    timing: { trigger: { kind: "interval", everyMs: 1000 } },
    target: {
      kind: "action",
      capability: "builtin:test/read@1",
      input: { secret: "input-canary" },
    },
    overlap,
  });
  const actions = createScheduleActions({
    store: first,
    workspace: "workspace",
    now: () => 1000,
    authority: {
      validate: async () =>
        ok({
          descriptor: canonicalDigest("target"),
          authority: canonicalDigest("authority"),
          configuration: canonicalDigest("config"),
          configurationGeneration: 1,
          timezoneData: "test",
        }),
    },
  });
  const invoke = (command: unknown) =>
    actions.execute(command, "user", new AbortController().signal);
  await invoke({ operation: "create", id: "sample", definition });
  await invoke({ operation: "enable", id: "sample", expectedRevision: 1 });
  const record = () => {
    const read = first.get("workspace", "sample");
    if (!read.ok) throw new Error(read.error.code);
    return read.value;
  };
  const slot = (id: string, nominal: number): ScheduleSlotRecord => ({
    id,
    schedule: "sample",
    generation: 1,
    kind: "manual",
    nominal,
    eligible: nominal,
    through: null,
    disposition: "pending",
  });
  const attempt = (id: string, slot: ScheduleSlotRecord): ScheduleAttempt => ({
    id,
    slot: slot.id,
    schedule: slot.schedule,
    generation: slot.generation,
    revision: 1,
    host: id,
    process: { platform: "darwin", pid: 123, birth: id },
    admittedAt: slot.eligible,
    deadline: slot.eligible + 1000,
    task: null,
    workflow: null,
    cancelRequestedAt: null,
    cancelAcknowledgedAt: null,
    terminal: null,
  });
  return {
    first,
    second,
    a,
    b,
    record,
    slot,
    attempt,
    invoke,
    close: async () => {
      await b.close();
      await a.close();
    },
  };
}

test("independent connections fence claims, stale edits and lost admission/settlement replies", async () => {
  const f = await fixture();
  const slot = f.slot("slot", 1000);
  expect(f.first.decide(f.record(), 1000, [slot]).ok).toBe(true);
  const record = f.record();
  const attempt = f.attempt("attempt", slot);
  expect(f.first.claim(record, slot, attempt)).toEqual(ok(attempt));
  expect(f.second.claim(record, slot, f.attempt("competitor", slot))).toEqual(ok(null));
  expect(f.second.claim(record, slot, attempt)).toEqual(ok(null));
  expect(await f.invoke({ operation: "pause", id: "sample", expectedRevision: 1 })).toMatchObject({
    ok: false,
    error: { code: "stale-revision" },
  });
  const terminal = {
    status: "succeeded" as const,
    effect: "completed" as const,
    reason: "completed",
    result: null,
    at: 1001,
  };
  expect(
    f.first.changeAttempt("workspace", attempt.id, 1, (p) => ok({ ...p, revision: 2, terminal }))
      .ok,
  ).toBe(true);
  expect(
    f.second.changeAttempt("workspace", attempt.id, 2, (p) =>
      ok({ ...p, revision: 3, terminal: { ...terminal, status: "failed" } }),
    ),
  ).toMatchObject({ ok: true, value: { terminal } });
  expect(f.second.notifications("workspace")).toMatchObject({
    ok: true,
    value: [{ id: attempt.id }],
  });
  expect(f.first.acknowledge("workspace", attempt.id).ok).toBe(true);
  expect(f.second.notifications("workspace")).toEqual(ok([]));
  const history = await f.invoke({ operation: "history", id: "sample" });
  expect(JSON.stringify(history)).not.toContain("input-canary");
  expect(await f.invoke({ operation: "delete-preview", id: "sample" })).toMatchObject({
    ok: true,
    value: { retainsHistory: true, cancelsActiveRuns: false, references: [{ attempt: "attempt" }] },
  });
  await f.invoke({ operation: "delete", id: "sample", expectedRevision: f.record().revision });
  expect(f.second.attempt("workspace", attempt.id)).toMatchObject({
    ok: true,
    value: { terminal },
  });
  await f.close();
});

test("queue-latest coalesces in the decision commit and preserves all slot evidence", async () => {
  const f = await fixture({ kind: "queue-latest" });
  const initial = f.slot("initial", 1000);
  f.first.decide(f.record(), 1000, [initial]);
  f.first.claim(f.record(), initial, f.attempt("active", initial));
  f.first.decide(f.record(), 2000, [f.slot("older", 1500), f.slot("latest", 2000)]);
  expect(f.second.pending("workspace", 3000)).toMatchObject({
    ok: true,
    value: [{ id: "latest" }],
  });
  f.second.decide(f.record(), 3000, [f.slot("newest", 3000)]);
  expect(f.first.pending("workspace", 3000)).toMatchObject({ ok: true, value: [{ id: "newest" }] });
  expect(f.first.slots("workspace", "sample")).toMatchObject({
    ok: true,
    value: [
      { id: "initial", disposition: "admitted" },
      { id: "latest", disposition: "coalesced" },
      { id: "newest", disposition: "pending" },
      { id: "older", disposition: "coalesced" },
    ],
  });
  expect(
    f.second.claim(
      f.record(),
      f.slot("newest", 3000),
      f.attempt("blocked", f.slot("newest", 3000)),
    ),
  ).toEqual(ok(null));
  await f.close();
});

test("corrupt stored intent fails closed and nominal identities cannot be duplicated", async () => {
  const f = await fixture();
  const slot = { ...f.slot("nominal", 1000), kind: "nominal" as const };
  f.first.decide(f.record(), 1000, [slot]);
  expect(f.second.decide(f.record(), 1001, [{ ...slot, id: "duplicate" }]).ok).toBe(false);
  expect(f.first.pending("workspace", 2000)).toMatchObject({
    ok: true,
    value: [{ id: "nominal" }],
  });
  const record = f.record();
  f.a.write((sql) => sql.run("UPDATE schedule_generations SET record='{}' WHERE id='sample'"));
  expect(f.second.get("workspace", "sample")).toEqual({ ok: false, error: { code: "corrupt" } });
  expect(f.second.claim(record, slot, f.attempt("unavailable", slot)).ok).toBe(false);
  await f.close();
});

test("manual receipt replay does not move recurrence or allocate another slot", async () => {
  const f = await fixture();
  const cursor = f.record().cursor;
  const command = {
    operation: "trigger-now",
    id: "sample",
    expectedRevision: f.record().revision,
    requestId: "request",
  };
  const first = await f.invoke(command);
  const retry = await f.invoke(command);
  expect(first.ok && retry.ok && first.value.slot === retry.value.slot).toBe(true);
  expect(retry).toMatchObject({ ok: true, value: { recovered: true } });
  expect(f.record().cursor).toBe(cursor);
  expect(f.first.pending("workspace", 1000)).toMatchObject({
    ok: true,
    value: [{ kind: "manual" }],
  });
  await f.close();
});

test("storage busy, full and uncertain receipts retain typed failures without a claim", async () => {
  const f = await fixture();
  const record = f.record();
  for (const code of ["busy", "disk-full"] as const) {
    const faulted = createScheduleStore({
      ...f.a,
      write: () => ({
        ok: false,
        error: {
          kind: "sqlite-store",
          code,
          operation: "transaction",
          effect: "none",
          cause: { kind: "sqlite", code, operation: "transaction", driverCode: null, detail: null },
        },
      }),
    });
    expect(faulted.get("workspace", "sample")).toMatchObject({
      ok: false,
      error: { code: `storage-${code}` },
    });
  }
  const uncertain = createScheduleStore({
    ...f.a,
    write: () => ({
      ok: false,
      error: {
        kind: "sqlite-store",
        code: "disk-full",
        cause: {
          kind: "sqlite",
          code: "disk-full",
          operation: "transaction",
          driverCode: null,
          detail: null,
        },
        operation: "transaction",
        effect: "uncertain",
      },
    }),
  });
  expect(uncertain.decide(record, record.cursor, [])).toMatchObject({
    ok: false,
    error: { code: "recovery-required" },
  });
  expect(f.second.attempts("workspace")).toEqual(ok([]));
  await f.close();
});

test("corrupt pending and active records quarantine their schedule without starving healthy work", async () => {
  for (const table of ["schedule_slots", "schedule_attempts"] as const) {
    const f = await fixture();
    const base = f.record();
    const broken = f.slot("broken", 1000);
    f.first.decide(base, 1000, [broken]);
    if (table === "schedule_attempts")
      f.first.claim(f.record(), broken, f.attempt("broken-attempt", broken));
    const healthy = {
      ...base,
      id: "healthy",
      state: "disabled" as const,
      revision: 1,
      binding: null,
    };
    expect(f.first.create(healthy).ok).toBe(true);
    expect(
      f.first.change("workspace", "healthy", 1, (prior) =>
        ok({ ...prior, state: "enabled", binding: base.binding, revision: 2 }),
      ).ok,
    ).toBe(true);
    const loaded = f.first.get("workspace", "healthy");
    if (!loaded.ok) throw new Error(loaded.error.code);
    const good = { ...f.slot("healthy-slot", 1000), schedule: "healthy" };
    f.first.decide(loaded.value, 1000, [good]);
    f.a.write((sql) => sql.run(`UPDATE ${table} SET record='{}' WHERE schedule='sample'`));
    if (table === "schedule_attempts") expect(f.first.active("workspace")).toEqual(ok([]));
    else
      expect(f.first.pending("workspace", 1000)).toMatchObject({
        ok: true,
        value: [{ id: "healthy-slot" }],
      });
    expect(f.first.get("workspace", "sample")).toMatchObject({
      ok: false,
      error: { code: "quarantined" },
    });
    expect(f.first.quarantined("workspace")).toMatchObject({
      ok: true,
      value: [{ id: "sample", reason: "corrupt-history" }],
    });
    expect(f.first.pending("workspace", 1000)).toMatchObject({
      ok: true,
      value: [{ id: "healthy-slot" }],
    });
    await f.close();
  }
});

test("parallel admission stops at four, retirement drains stale generations, and metadata omits private input", async () => {
  const f = await fixture({ kind: "parallel", limit: 4 });
  const slots = Array.from({ length: 32 }, (_, i) => f.slot(`slot-${i}`, 1000 + i));
  expect(f.first.decide(f.record(), 1031, slots).ok).toBe(true);
  const claimed = slots
    .slice(0, 5)
    .map((slot, i) => f.first.claim(f.record(), slot, f.attempt(`attempt-${i}`, slot)));
  expect(claimed.filter((value) => value.ok && value.value !== null)).toHaveLength(4);
  expect(
    f.first.decide(
      f.record(),
      1063,
      Array.from({ length: 32 }, (_, i) => f.slot(`second-${i}`, 1032 + i)),
    ).ok,
  ).toBe(true);
  const old = f.record();
  expect(
    await f.invoke({
      operation: "update",
      id: "sample",
      expectedRevision: old.revision,
      definition: old.definition,
    }),
  ).toMatchObject({ ok: true, value: { state: "disabled", generation: 2 } });
  expect(f.first.retire("workspace")).toEqual(ok(28));
  expect(f.first.pending("workspace", 2000)).toEqual(ok([]));
  const list = await f.invoke({ operation: "list" });
  const history = await f.invoke({ operation: "history", id: "sample" });
  const deletion = await f.invoke({ operation: "delete-preview", id: "sample" });
  expect(JSON.stringify([list, history, deletion])).not.toContain("input-canary");
  expect(deletion).toMatchObject({
    ok: true,
    value: { retainsHistory: true, cancelsActiveRuns: false },
  });
  const latest = f.first.latest("workspace", "sample");
  expect(latest).toMatchObject({ ok: true, value: { id: "attempt-3", terminal: null } });
  await f.close();
});

test("wake progress fences competing cursors without expiring an unchanged user control", async () => {
  const f = await fixture();
  const inspected = f.record();
  expect(f.first.decide(inspected, 1000, []).ok).toBe(true);
  expect(f.second.decide(inspected, 2000, [])).toMatchObject({
    ok: false,
    error: { code: "stale-revision" },
  });
  expect(f.second.decide(f.record(), 2000, []).ok).toBe(true);
  expect(f.record().revision).toBe(inspected.revision);
  expect(
    await f.invoke({ operation: "pause", id: "sample", expectedRevision: inspected.revision }),
  ).toMatchObject({ ok: true, value: { state: "paused" } });
  expect(
    await f.invoke({ operation: "resume", id: "sample", expectedRevision: inspected.revision }),
  ).toMatchObject({ ok: false, error: { code: "stale-revision" } });
  await f.close();
});
