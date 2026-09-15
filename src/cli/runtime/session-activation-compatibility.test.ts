import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTurnEventJournal } from "../../application/runtime/turn-event-journal.ts";
import { createSessionHistory } from "../../application/sessions/session-history.ts";
import { rootChild } from "../../data/index.ts";
import {
  configurationGeneration,
  sessionId,
  traceId,
  turnId,
} from "../../domain/foundation/index.ts";
import { exportName } from "../../domain/sessions/index.ts";
import { snapshotOf } from "../../tui/composer/index.ts";
import { runExport } from "../commands/export.ts";
import { runImport } from "../commands/import-replay-commands.ts";
import { composeProductShellAttachments } from "./product-shell-attachments.ts";
import { createActivationFixture } from "./session-activation.fixtures.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const fixture = () => createActivationFixture((close) => cleanups.push(close));

test("committed import activates exact history with current policy; collisions and unavailable providers do not substitute identities", async () => {
  const source = await createActivationFixture((close) => cleanups.push(close), undefined, true);
  await source.send("IMPORTED_EXACT_LINEAGE_".repeat(250));
  const id = source.currentId();
  const name = exportName.from("activation-transfer");
  const exported = await runExport(() => source.f.services, {
    selection: { kind: "sessions", sessionIds: [sessionId.from(id)], includeSensitive: false },
    write: true,
    name,
  });
  if (!exported.payload?.bundle) throw new Error(JSON.stringify(exported.errors));
  const target = await createActivationFixture(
    (close) => cleanups.push(close),
    source.f.home,
    true,
  );
  const exports = rootChild(target.f.services.localData.layout, "exports");
  if (!exports) throw new Error("exports unavailable");
  await mkdir(exports, { recursive: true });
  await copyFile(exported.payload.bundle.path, join(exports, name));
  const transfer = await runImport(() => target.f.services, { name });
  expect(transfer.outcome.kind, JSON.stringify(transfer.errors)).toBe("completed");
  const imported = target.f.durable.records.sessions.get(sessionId.from(id));
  if (!imported.ok || !imported.value) throw new Error("committed import missing");
  const before = target.f.durable.eventStore.head?.(imported.value.streamId);
  expect((await runImport(() => target.f.services, { name })).outcome.kind).not.toBe("completed");
  expect(target.f.durable.eventStore.head?.(imported.value.streamId)).toEqual(before);
  // The receiving host explicitly binds the same authorized workspace, with a separate state store.
  const host = await composeProductShellAttachments({
    ...target.ports,
    workspaceSet: source.ports.workspaceSet,
    configurationGeneration: configurationGeneration.from(7),
    memoryRecords: target.f.durable.memoryRecords,
  });
  if (!host) throw new Error("host missing");
  cleanups.push(() => host.close());
  const selected = await host.activation.activate({ kind: "resume", sessionId: id });
  expect(selected.ok, JSON.stringify(selected)).toBe(true);
  if (selected.ok) expect(selected.explanation).toContain("current configuration 7 (recorded 0)");
  expect(target.requests).toHaveLength(0);
  expect((await host.submission.submit(snapshotOf("IMPORTED_NEXT", 1))).kind).toBe("accepted");
  expect(JSON.stringify(target.requests.at(-1))).toContain("IMPORTED_EXACT_LINEAGE_");
  expect(host.controls.activeSessionId).toBe(id);
  const turns = target.f.durable.records.turns.listByParent(sessionId.from(id), 100);
  expect(turns.ok && turns.value.at(-1)?.sessionId).toBe(sessionId.from(id));
  const { provider: _provider, ...withoutProvider } = target.ports;
  const noProvider = await composeProductShellAttachments({
    ...withoutProvider,
    workspaceSet: source.ports.workspaceSet,
  });
  if (!noProvider) throw new Error("inspection host missing");
  cleanups.push(() => noProvider.close());
  const binding = noProvider.submission.binding?.();
  expect(await noProvider.activation.activate({ kind: "resume", sessionId: id })).toMatchObject({
    ok: false,
    code: "provider-unavailable",
  });
  expect(noProvider.submission.binding?.()).toBe(binding);
});

test("same-session selection is a no-op; unfinished durable work refuses a switch without inference", async () => {
  const t = await fixture();
  await t.send("COMPLETE_A");
  const id = t.currentId();
  const binding = t.attached.submission.binding?.();
  const noop = await t.attached.activation.activate({ kind: "resume", sessionId: id });
  expect(noop).toMatchObject({ ok: true, changed: false });
  expect(t.attached.submission.binding?.()).toBe(binding);
  const record = t.f.durable.records.sessions.get(sessionId.from(id));
  if (!record.ok || !record.value) throw new Error("session missing");
  const correlation = {
    workspaceId: record.value.workspaceId,
    sessionId: record.value.sessionId,
    traceId: traceId.from("interrupted-activation"),
    configurationGeneration: record.value.configurationGeneration,
  };
  const journal = createTurnEventJournal({
    eventStore: t.f.durable.eventStore,
    clock: t.f.services.clock,
    streamId: record.value.streamId,
    correlation,
  });
  const turn = turnId.from("interrupted-before-terminal");
  expect(
    (
      await journal.persist([
        { kind: "turn.started", correlation: { ...correlation, turnId: turn } },
      ])
    ).kind,
  ).toBe("persisted");
  const history = createSessionHistory({ journal, correlation, artifacts: t.f.durable.artifacts });
  expect(
    (
      await history.record(
        turn,
        {
          version: 1,
          type: "message",
          id: "interrupted-input",
          messageId: "interrupted-input",
          generation: 0,
          part: 0,
          role: "user",
          attemptId: null,
          completion: "complete",
          relations: [],
        },
        "DO_NOT_RELAUNCH",
        t.f.resources,
      )
    ).committed,
  ).toBe(true);
  expect((await t.attached.sessionCreation.create()).ok).toBe(true);
  const nextBinding = t.attached.submission.binding?.();
  expect(await t.attached.activation.activate({ kind: "resume", sessionId: id })).toMatchObject({
    ok: false,
    code: "unfinished-operations",
  });
  expect(
    (
      await journal.persist([
        {
          kind: "turn.completed",
          correlation: { ...correlation, turnId: turn },
          outcome: { kind: "cancelled", effect: "uncertain" },
        },
      ])
    ).kind,
  ).toBe("persisted");
  expect(await t.attached.activation.activate({ kind: "resume", sessionId: id })).toMatchObject({
    ok: false,
    code: "unfinished-operations",
  });
  expect(t.attached.submission.binding?.()).toBe(nextBinding);
  expect(t.requests).toHaveLength(1);
  await t.send("CURRENT_STILL_USABLE");
  expect(JSON.stringify(t.requests.at(-1))).not.toContain("DO_NOT_RELAUNCH");
});

test("compacted native sessions rebuild against current configuration and memory authority", async () => {
  const t = await fixture();
  const { createMemoryLifecycle } = await import("../../application/memory/memory-lifecycle.ts");
  const lifecycle = createMemoryLifecycle(t.f.durable.memoryRecords);
  await writeFile(join(t.f.home, "AGENTS.md"), "INITIAL_INSTRUCTION_BINDING");
  expect((await t.f.services.workspaceTrust.resolve(async () => "proceed")).status).toBe(
    "accepted",
  );
  const record = {
    memoryId: "remembered-before-resume",
    scope: { kind: "workspace", workspaceId: "root-1" },
    kind: "project-fact",
    subject: "quasar deployment",
    content: "QUASAR_OLD_MEMORY",
    confidence: 90,
    provenance: [{ origin: "user-request", locator: "explicit-memory" }],
    createdAt: new Date().toISOString(),
  };
  expect(t.f.durable.memoryRecords.define(record).ok).toBe(true);
  let generation = configurationGeneration.from(0);
  const host = await composeProductShellAttachments({
    ...t.ports,
    modelConfigurationGeneration: () => generation,
    memoryRecords: { ...t.f.durable.memoryRecords, list: () => lifecycle.listActive() },
    publishNativePackages: t.f.durable.publishNativePackages,
    rehydrateExtensions: t.f.durable.rehydrateExtensions,
  });
  if (!host) throw new Error("native host missing");
  cleanups.push(() => host.close());
  const send = async (text: string) => {
    const result = await host.submission.submit(snapshotOf(text, t.requests.length + 1));
    expect(result.kind, JSON.stringify(result)).toBe("accepted");
    return t.requests.at(-1);
  };
  expect(JSON.stringify(await send("quasar deployment first turn"))).toContain("QUASAR_OLD_MEMORY");
  const a = String(host.controls.activeSessionId);
  const preview = await host.submission.compact?.(null, new AbortController().signal);
  const candidate = preview?.message.match(/Checkpoint preview: ([a-f0-9-]+)\./u)?.[1];
  expect(candidate).toBeDefined();
  expect(
    (await host.submission.compact?.(`apply ${candidate}`, new AbortController().signal))?.message,
  ).toContain("Checkpoint applied:");
  expect(
    lifecycle.correct(record.memoryId, {
      ...record,
      memoryId: "corrected-memory",
      generation: 2,
      content: "QUASAR_CURRENT_MEMORY",
      supersedes: [record.memoryId],
    }).ok,
  ).toBe(true);
  expect(lifecycle.delete(record.memoryId, new Date().toISOString()).ok).toBe(true);
  await host.sessionCreation.create();
  await writeFile(join(t.f.home, "AGENTS.md"), "CHANGED_INSTRUCTION_BINDING");
  expect((await t.f.services.workspaceTrust.resolve()).status).toBe("stale");
  generation = configurationGeneration.from(1);
  const result = await host.activation.activate({ kind: "resume", sessionId: a });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) expect(result.explanation).toContain("current configuration 1 (recorded 0)");
  const next = JSON.stringify(await send("quasar deployment after resume"));
  expect(next).toContain("QUASAR_CURRENT_MEMORY");
  expect(next).not.toContain("QUASAR_OLD_MEMORY");
  expect(next).not.toContain("INITIAL_INSTRUCTION_BINDING");
  expect(next).not.toContain("CHANGED_INSTRUCTION_BINDING");
  expect(lifecycle.delete("corrected-memory", new Date().toISOString()).ok).toBe(true);
  await host.sessionCreation.create();
  expect((await host.activation.activate({ kind: "resume", sessionId: a })).ok).toBe(true);
  expect(JSON.stringify(await send("quasar deployment after forgetting"))).not.toContain(
    "QUASAR_CURRENT_MEMORY",
  );
});
