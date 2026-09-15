import { afterEach, expect, test } from "bun:test";
import { sessionId } from "../../domain/foundation/index.ts";
import { snapshotOf } from "../../tui/composer/index.ts";
import { createCheckpointFixture } from "./history-checkpoint.fixtures.ts";
import { composeProductShellAttachments } from "./product-shell-attachments.ts";
import { createActivationFixture } from "./session-activation.fixtures.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const fixture = () => createActivationFixture((close) => cleanups.push(close));

test("navigation binds resume, fork and rewind to actual provider, transcript and durable next turns", async () => {
  const t = await fixture();
  await t.send("SESSION_A_CANARY");
  const a = t.currentId();
  const firstTurn = t.attached.transcriptFeed.events().find((e) => e.kind === "turn.started");
  if (firstTurn?.kind !== "turn.started") throw new Error("missing first turn");
  await t.send("A_LATER_CORRECTION");
  const created = await t.attached.sessionCreation.create();
  expect(created.ok).toBe(true);
  await t.send("SESSION_B_CANARY");
  const b = t.currentId();
  await t.nav.listSessions();
  const resumed = await t.nav.resume(a);
  expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
  expect(t.currentId()).toBe(a);
  const resumedRequest = await t.send("RESUME_A_NEXT");
  expect(JSON.stringify(resumedRequest)).toContain("SESSION_A_CANARY");
  expect(JSON.stringify(resumedRequest)).not.toContain("SESSION_B_CANARY");
  expect(t.currentId()).toBe(a);
  await t.nav.listSessions();
  const fork = await t.nav.fork(a);
  expect(fork.ok, JSON.stringify(fork)).toBe(true);
  if (!fork.ok) throw new Error("fork failed");
  const forkRequest = await t.send("FORK_NEXT");
  expect(JSON.stringify(forkRequest)).toContain("A_LATER_CORRECTION");
  expect(t.currentId()).toBe(fork.value.sessionId);
  await t.nav.listSessions();
  const rewind = await t.nav.rewind(a, String(firstTurn.correlation.turnId));
  expect(rewind.ok, JSON.stringify(rewind)).toBe(true);
  const rewindRequest = await t.send("REWIND_NEXT");
  expect(JSON.stringify(rewindRequest)).toContain("SESSION_A_CANARY");
  expect(JSON.stringify(rewindRequest)).not.toContain("A_LATER_CORRECTION");
  expect(JSON.stringify(rewindRequest)).not.toContain("FORK_NEXT");
  const source = t.f.durable.records.sessions.get(sessionId.from(a));
  if (!source.ok || !source.value) throw new Error("source missing");
  const events = await t.f.durable.eventStore.readFrom(
    { streamId: source.value.streamId, afterSequence: null },
    1000,
  );
  expect(events.ok).toBe(true);
  if (!events.ok) throw new Error("events missing");
  expect(events.value.filter((e) => e.kind === "session.started")).toHaveLength(1);
  expect(JSON.stringify(events.value)).not.toContain("FORK_NEXT");
  expect(a).not.toBe(b);
});

test("new-session preparation acquires admission before awaiting and preserves refused input", async () => {
  const t = await fixture();
  await t.send("OLD_SESSION");
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const host = await composeProductShellAttachments({
    ...t.ports,
    async rehydrateExtensions(signal) {
      if (++calls > 1) {
        entered();
        await barrier;
      }
      return t.f.durable.rehydrateExtensions(signal);
    },
  });
  if (!host) throw new Error("host missing");
  const create = host.sessionCreation.create();
  await waiting;
  const draft = snapshotOf("MUST_NOT_REDIRECT", 1);
  expect(await host.submission.submit(draft)).toMatchObject({
    kind: "unavailable",
    snapshot: draft,
  });
  expect(await host.activation.activate({ kind: "new" })).toMatchObject({
    ok: false,
    code: "busy",
  });
  release();
  expect((await create).ok).toBe(true);
  expect(t.requests).toHaveLength(1);
});

test("reopen and explicit headless continuation preserve identity, history and unique turns", async () => {
  const t = await createActivationFixture((close) => cleanups.push(close), undefined, true);
  await t.send("RESTART_SOURCE");
  const id = t.currentId();
  await t.attached.close();
  await t.f.durable.close();
  const { runCoding } = await import("./coding-run.ts");
  const { createRecordingCliStreams } = await import("../output/streams.ts");
  const { parseInvocation } = await import("../command-tree.ts");
  const parsed = await parseInvocation(["run", "--continue-session", id, "AFTER_RESTART"]);
  expect(parsed.kind).toBe("run");
  if (parsed.kind === "run")
    expect(parsed.runArgs).toEqual({ session: id, promptParts: ["AFTER_RESTART"] });
  await expect(
    runCoding(
      () => t.f.services,
      { promptParts: ["INVALID_SELECTION"], session: "" },
      {
        input: createRecordingCliStreams().input,
        providerAdapter: t.ports.provider?.kind === "ready" ? t.ports.provider.adapter : null,
      },
    ),
  ).rejects.toThrow();
  expect(t.requests).toHaveLength(1);
  const resumed = await runCoding(
    () => t.f.services,
    { promptParts: ["AFTER_RESTART"], session: id },
    {
      input: createRecordingCliStreams().input,
      providerAdapter: t.ports.provider?.kind === "ready" ? t.ports.provider.adapter : null,
    },
  );
  expect(resumed.payload?.stage, JSON.stringify(resumed.errors)).toBe("attempt-completed");
  expect(resumed.payload?.sessionId).toBe(id);
  expect(resumed.payload?.activation).toContain("Unresolved operations: 0");
  expect(JSON.stringify(t.requests.at(-1))).toContain("RESTART_SOURCE");
  const reopened = await createCheckpointFixture(t.f.home);
  cleanups.push(() => reopened.close());
  const record = reopened.durable.records.sessions.get(sessionId.from(id));
  if (!record.ok || !record.value) throw new Error("session missing after reopen");
  const events = await reopened.durable.eventStore.readFrom(
    { streamId: record.value.streamId, afterSequence: null },
    1000,
  );
  if (!events.ok) throw new Error("events missing");
  const starts = events.value.filter((e) => e.kind === "turn.started");
  expect(starts).toHaveLength(2);
  expect(new Set(starts.map((e) => e.correlation.turnId)).size).toBe(2);
  expect(events.value.filter((e) => e.kind === "session.started")).toHaveLength(1);
});

test("compacted A survives B corrections and fork activation without inheriting B history", async () => {
  const t = await fixture();
  await t.send("COMPACT_A_SOURCE");
  const a = t.currentId();
  for (let index = 0; index < 2; index++) {
    const preview = await t.attached.submission.compact?.(null, new AbortController().signal);
    const id = preview?.message.match(/Checkpoint preview: ([a-f0-9-]+)\./u)?.[1];
    expect(id, preview?.message).toBeDefined();
    expect(
      (await t.attached.submission.compact?.(`apply ${id}`, new AbortController().signal))?.message,
    ).toContain("Checkpoint applied:");
    await t.send(`A_CORRECTION_${index}`);
  }
  await t.attached.sessionCreation.create();
  await t.send("B_ONLY_CORRECTION");
  await t.nav.listSessions();
  const resumed = await t.nav.resume(a);
  expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
  if (resumed.ok) expect(resumed.value.explanation).not.toContain("checkpoint none");
  expect(JSON.stringify(await t.send("AFTER_COMPACTED_RESUME"))).toContain("A_CORRECTION_1");
  expect(JSON.stringify(t.requests.at(-1))).not.toContain("B_ONLY_CORRECTION");
  await t.nav.listSessions();
  expect((await t.nav.fork(a)).ok).toBe(true);
  expect(JSON.stringify(await t.send("AFTER_COMPACTED_FORK"))).toContain("COMPACT_A_SOURCE");
  expect(JSON.stringify(t.requests.at(-1))).not.toContain("B_ONLY_CORRECTION");
});

test("missing, foreign, cancelled and stale selections preserve the active executor and delayed draft binding", async () => {
  const t = await fixture();
  await t.send("ACTIVE_A");
  const a = t.currentId();
  await t.nav.listSessions();
  await t.send("MAKE_SELECTION_STALE");
  expect(await t.nav.resume(a)).toMatchObject({ ok: false });
  expect(
    await t.attached.activation.activate({ kind: "resume", sessionId: "missing" }),
  ).toMatchObject({ ok: false, code: "session-not-found" });
  expect(
    await t.attached.activation.activate({ kind: "resume", sessionId: "checkpoint-session" }),
  ).toMatchObject({ ok: false, code: "foreign-workspace" });
  expect(await t.attached.activation.activate({ kind: "new" }, AbortSignal.abort())).toMatchObject({
    ok: false,
  });
  expect(t.currentId()).toBe(a);
  const held = snapshotOf("HELD_INPUT", 5, [], [], t.attached.submission.binding?.());
  expect((await t.attached.sessionCreation.create()).ok).toBe(true);
  expect(await t.attached.submission.submit(held)).toMatchObject({
    kind: "unavailable",
    snapshot: held,
  });
  expect(JSON.stringify(t.requests)).not.toContain("HELD_INPUT");
  await t.send("USABLE_NEW_SESSION");
});

test("required artifact loss refuses activation and failed preparation leaves the old session usable", async () => {
  const t = await fixture();
  await t.send("RETAINED_A_".repeat(2000));
  const a = t.currentId();
  const host = await composeProductShellAttachments({
    ...t.ports,
    artifacts: {
      ...t.f.durable.artifacts,
      get(id) {
        const found = t.f.durable.artifacts.get(id);
        return found.ok && found.value
          ? { ok: true, value: { ...found.value, availability: "missing" } }
          : found;
      },
    },
  });
  if (!host) throw new Error("host missing");
  cleanups.push(() => host.close());
  expect(await host.activation.activate({ kind: "resume", sessionId: a })).toMatchObject({
    ok: false,
    code: "history.expired",
  });
  let publications = 0;
  const failed = await composeProductShellAttachments({
    ...t.ports,
    async rehydrateExtensions(signal) {
      if (++publications > 1) return { status: "failed", code: "fixture-unavailable" };
      return t.f.durable.rehydrateExtensions(signal);
    },
  });
  if (!failed) throw new Error("host missing");
  cleanups.push(() => failed.close());
  expect(await failed.activation.activate({ kind: "resume", sessionId: a })).toMatchObject({
    ok: false,
    code: "prepare-failed",
  });
  expect((await failed.submission.submit(snapshotOf("STILL_USABLE", 1))).kind).toBe("accepted");
});

test("prompt-first admission refuses switches and shutdown waits for cancelled work before releasing the host", async () => {
  const t = await fixture();
  if (t.ports.provider?.kind !== "ready") throw new Error("provider missing");
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let ended = false;
  const base = t.ports.provider.adapter;
  const host = await composeProductShellAttachments({
    ...t.ports,
    provider: {
      ...t.ports.provider,
      adapter: {
        ...base,
        async *stream(_request, options) {
          entered();
          await new Promise<void>((resolve) => {
            if (options.signal.aborted) resolve();
            else options.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          ended = true;
        },
      },
    },
  });
  if (!host) throw new Error("host missing");
  const running = host.submission.submit(snapshotOf("HELD_TURN", 1));
  await started;
  expect(await host.activation.activate({ kind: "new" })).toMatchObject({
    ok: false,
    code: "busy",
  });
  expect(await host.activation.activate({ kind: "resume", sessionId: "missing" })).toMatchObject({
    ok: false,
    code: "busy",
  });
  await host.close();
  await running;
  expect(ended).toBe(true);
  expect(await host.submission.submit(snapshotOf("AFTER_SHUTDOWN", 2))).toMatchObject({
    kind: "unavailable",
  });
});

test("cancelled preparation and observer failures preserve a coherent committed binding", async () => {
  const t = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let publications = 0;
  const host = await composeProductShellAttachments({
    ...t.ports,
    async rehydrateExtensions(signal) {
      if (++publications === 2) {
        entered();
        await barrier;
      }
      return t.f.durable.rehydrateExtensions(signal);
    },
  });
  if (!host) throw new Error("host missing");
  cleanups.push(() => host.close());
  await host.submission.submit(snapshotOf("OLD_BINDING", 1));
  const before = host.submission.binding?.();
  const cancel = new AbortController();
  const preparing = host.activation.activate({ kind: "new" }, cancel.signal);
  await started;
  cancel.abort();
  release();
  expect((await preparing).ok).toBe(false);
  expect(host.submission.binding?.()).toBe(before);
  let facts = 0;
  const stopFacts = host.activation.subscribe((fact) => {
    expect(fact.sessionId).toBe(String(host.controls.activeSessionId));
    facts++;
    throw new Error("late hook failed");
  });
  let notices = 0;
  const unsubscribe = host.transcriptFeed.subscribe(() => {
    notices++;
    throw new Error("observer failed");
  });
  const next = await host.activation.activate({ kind: "new" });
  expect(next.ok).toBe(true);
  expect(notices).toBe(1);
  expect(facts).toBe(1);
  stopFacts();
  expect(host.submission.binding?.()).not.toBe(before);
  unsubscribe();
  await host.activation.activate({ kind: "new" });
  expect(notices).toBe(1);
});

test("shutdown aborts pending activation preparation before the durable host can close", async () => {
  const t = await fixture();
  let entered!: () => void;
  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  let settled = false;
  const host = await composeProductShellAttachments({
    ...t.ports,
    async rehydrateExtensions(signal) {
      if (++calls > 1) {
        entered();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        settled = true;
      }
      return t.f.durable.rehydrateExtensions(signal);
    },
  });
  if (!host) throw new Error("host missing");
  const before = host.submission.binding?.();
  const pending = host.activation.activate({ kind: "new" });
  await preparing;
  await host.close();
  expect(settled).toBe(true);
  expect((await pending).ok).toBe(false);
  expect(host.submission.binding?.()).toBe(before);
  expect(t.requests).toHaveLength(0);
});
