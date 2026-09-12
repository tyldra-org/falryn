import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createRuntimeProjectionRedactor } from "../../application/diagnostics/redaction.ts";
import { createProductResources } from "../../application/orchestration/product-resources.ts";
import { createTurnEventJournal } from "../../application/runtime/turn-event-journal.ts";
import { createHistoryReader } from "../../application/sessions/history-reader.ts";
import { recordProviderHistory } from "../../application/sessions/provider-history.ts";
import { createSessionHistory, historyDigest } from "../../application/sessions/session-history.ts";
import { createProductToolGateway } from "../../application/tools/product-tool-gateway.ts";
import { rootChild } from "../../data/index.ts";
import { planReachabilityGc } from "../../data/lifecycle/reachability-gc.ts";
import { createSqliteEventStore } from "../../data/sessions/event-store.ts";
import { createRecordRepositories } from "../../data/sessions/repositories.ts";
import { artifactId } from "../../domain/artifacts/index.ts";
import { createInMemoryPackageWriter } from "../../domain/extensions/index.ts";
import {
  configurationGeneration,
  createStaticEnvironment,
  createSystemClock,
  err,
  invocationId,
  modelAttemptId,
  ok,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { decodeRuntimeEvent, encodeRuntimeEvent, exportName } from "../../domain/sessions/index.ts";
import {
  createToolHookRegistry,
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
} from "../../domain/tools/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { createHostBlobStore, createSha256Hasher } from "../../integrations/index.ts";
import {
  createDeterministicProviderAdapter,
  modelRequestId,
  type NormalizedProviderEvent,
} from "../../providers/index.ts";
import { runExport } from "../commands/export.ts";
import { runImport, runReplay } from "../commands/import-replay-commands.ts";
import { sessionExportControl } from "../commands/session-export-control.ts";
import { openArtifactStore } from "../commands/storage.ts";
import { LIVE_TURN_MATRIX_CONFIRMATION } from "../live-turn-matrix.test-support.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { runCoding } from "./coding-run.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { createServiceProvider } from "./services.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(seed = true) {
  const home = await mkdtemp(join(tmpdir(), "falryn-history-791-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const services = createServiceProvider(
    {
      color: "never",
      format: "human",
      nonInteractive: true,
      profile: null,
      quiet: false,
      timeoutMs: null,
      verbose: false,
      workspace: null,
      addDirs: [],
      help: false,
      version: false,
    },
    {
      home: localPath(home),
      platform: "darwin",
      environment: createStaticEnvironment({
        FALRYN_STATE_DIR: join(home, "state"),
        FALRYN_CONFIG_DIR: join(home, "config"),
      }),
      currentDirectory: localPath(home),
    },
  )();
  const durable = await openProductArtifactSession(services);
  if (!durable) throw new Error("durable store unavailable");
  cleanups.push(() => durable.close());
  const clock = createSystemClock();
  const resources = createProductResources(clock).openTask("0");
  cleanups.push(async () => resources.close());
  const correlation = {
    sessionId: sessionId.from("history-session"),
    workspaceId: workspaceId.from("history-workspace"),
    traceId: traceId.from("history-trace"),
    configurationGeneration: configurationGeneration.from(0),
  };
  const stream = streamId.from("history-stream");
  const turn = turnId.from("history-turn");
  const journal = createTurnEventJournal({
    eventStore: durable.eventStore,
    clock,
    streamId: stream,
    correlation,
  });
  if (seed)
    expect(
      (
        await journal.persist([
          { kind: "session.started", correlation },
          { kind: "turn.started", correlation: { ...correlation, turnId: turn } },
        ])
      ).kind,
    ).toBe("persisted");
  return {
    home,
    services,
    durable,
    resources,
    correlation,
    stream,
    turn,
    journal,
    history: createSessionHistory({ journal, correlation, artifacts: durable.artifacts }),
  };
}
test("exact public content survives SQLite reopen, and scope revocation hides its identity", async () => {
  const f = await fixture();
  const original = "An exact decision α\n".repeat(200);
  const captured = await f.history.record(
    f.turn,
    {
      version: 1,
      type: "message",
      messageId: "assistant-1",
      part: 0,
      id: "assistant-1",
      generation: 0,
      role: "assistant",
      attemptId: "attempt-1",
      completion: "complete",
      relations: [],
    },
    original,
    f.resources,
  );
  expect(captured).toMatchObject({
    committed: true,
    evidence: { availability: "retained", fidelity: "exact" },
  });
  await f.durable.close();
  const reopened = await openProductArtifactSession(f.services);
  if (!reopened) throw new Error("restart failed");
  cleanups.push(() => reopened.close());
  let authorized = true;
  const reader = createHistoryReader({
    events: reopened.eventStore,
    artifacts: reopened.artifacts,
    authorize: (event) => authorized && event.correlation.workspaceId === f.correlation.workspaceId,
  });
  const read = await reader.page({ streamId: f.stream, afterSequence: null });
  expect(read).toMatchObject({ ok: true, partial: false });
  if (!read.ok) throw new Error(read.code);
  expect(read.items.find((i) => i.event?.kind === "history.recorded")?.text).toBe(original);
  authorized = false;
  const denied = await reader.page({ streamId: f.stream, afterSequence: null });
  expect(JSON.stringify(denied)).not.toContain("assistant-1");
  expect(JSON.stringify(denied)).not.toContain("exact decision");
});
test("unsealed bytes, redaction, unknown versions and page bounds never claim exact history", async () => {
  const f = await fixture();
  const history = createSessionHistory({ journal: f.journal, correlation: f.correlation });
  const failed = await history.record(
    f.turn,
    {
      version: 1,
      type: "message",
      messageId: "unsealed",
      part: 0,
      id: "unsealed",
      generation: 0,
      role: "assistant",
      attemptId: "attempt-2",
      completion: "partial",
      relations: [],
    },
    "x".repeat(5000),
    f.resources,
  );
  expect(failed).toMatchObject({
    committed: true,
    evidence: { availability: "unavailable", reason: "storage-failed" },
  });
  const reader = createHistoryReader({
    events: f.durable.eventStore,
    artifacts: f.durable.artifacts,
    authorize: () => true,
  });
  expect(await reader.page({ streamId: f.stream, afterSequence: null })).toMatchObject({
    ok: true,
    partial: true,
  });
  expect(await reader.page({ streamId: f.stream, afterSequence: null, limit: 65 })).toMatchObject({
    ok: false,
    code: "malformed",
  });
  const events = await f.durable.eventStore.readFrom(
    { streamId: f.stream, afterSequence: null },
    10,
  );
  if (!events.ok) throw new Error(events.error.code);
  const event = events.value.find((e) => e.kind === "history.recorded");
  if (!event) throw new Error("missing semantic gap");
  const encoded = encodeRuntimeEvent(event);
  expect(encoded.ok).toBe(true);
  if (encoded.ok) {
    const value = JSON.parse(new TextDecoder().decode(encoded.value));
    value.payload.version = 999;
    expect(decodeRuntimeEvent(JSON.stringify(value)).ok).toBe(false);
  }
});

test("live headless user, assistant and tool content survives restart without executing again", async () => {
  const f = await fixture(false);
  const prompt = "Inspect the file with read_file. User canary α. ".repeat(70);
  const answer = "Assistant canary β: the evidence was observed.\n".repeat(70);
  const original = "Tool content canary γ with exact whitespace.\n".repeat(100);
  await writeFile(join(f.home, "evidence.txt"), original);
  let calls = 0;
  const result = await runCoding(
    () => f.services,
    { promptParts: [prompt] },
    {
      input: createRecordingCliStreams({ stdin: null }).input,
      identities: { sessionId: "live-history", turnId: "live-turn", traceId: "live-trace" },
      providerAdapter: createDeterministicProviderAdapter({
        script: (_request, index) => {
          calls++;
          return index === 0
            ? {
                kind: "tool",
                toolCallId: "read-evidence",
                name: "read_file",
                argumentFragments: ['{"path":"evidence.txt"}'],
              }
            : { kind: "text", text: answer, finishReason: "stop" };
        },
      }),
    },
  );
  expect(result.outcome.kind).toBe("completed");
  expect(calls).toBe(2);
  await f.durable.close();
  const reopened = await openProductArtifactSession(f.services);
  if (!reopened) throw new Error("restart failed");
  cleanups.push(() => reopened.close());
  const heads = reopened.eventStore.streamHeads(8);
  if (!heads.ok) throw new Error(heads.error.code);
  const reader = createHistoryReader({
    events: reopened.eventStore,
    artifacts: reopened.artifacts,
    authorize: (event) => String(event.correlation.sessionId) === "live-history",
  });
  const items = [];
  for (const head of heads.value) {
    const page = await reader.page({ streamId: head.streamId, afterSequence: null });
    if (page.ok) items.push(...page.items);
  }
  expect(items.some((item) => item.text === prompt.trim())).toBe(true);
  expect(items.some((item) => item.text === answer)).toBe(true);
  expect(
    items.some(
      (item) =>
        item.event?.kind === "history.recorded" &&
        item.event.payload.type === "result" &&
        item.text?.includes("Tool content canary"),
    ),
  ).toBe(true);
  expect(calls).toBe(2);
});

test("export preserves event order while omitting currently restricted semantic evidence", async () => {
  const f = await fixture();
  const retained = await f.history.record(
    f.turn,
    {
      version: 1,
      type: "message",
      id: "restricted-message",
      messageId: "restricted-message",
      part: 0,
      role: "assistant",
      attemptId: "attempt",
      generation: 0,
      completion: "complete",
      relations: [],
    },
    "RESTRICTED_CANARY\n".repeat(200),
    f.resources,
  );
  if (retained.evidence.availability !== "retained") throw new Error("retained evidence");
  const retainedId = retained.evidence.artifactId;
  const opened = await openArtifactStore(() => f.services, undefined);
  if (!opened.ok || opened.kind !== "open") throw new Error("artifact store");
  expect(
    opened.store.write((sql) =>
      sql.run("UPDATE artifacts SET sensitivity = 'restricted' WHERE artifact_id = $id", {
        id: retainedId,
      }),
    ).ok,
  ).toBe(true);
  await opened.store.close();
  const exported = await runExport(() => f.services, {
    selection: { kind: "sessions", sessionIds: [f.correlation.sessionId], includeSensitive: true },
    write: true,
    name: exportName.from("restricted-history"),
  });
  expect(exported.outcome.kind).toBe("completed");
  expect(exported.payload?.counts.artifacts).toBe(0);
  expect(exported.payload?.omissions).toHaveLength(1);
  expect(exported.payload?.counts.events).toBe(3);
  if (!exported.payload?.bundle) throw new Error(JSON.stringify(exported.errors));
  expect(await Bun.file(exported.payload.bundle.path).text()).not.toContain("RESTRICTED_CANARY");
});

test("changed duplicate content is refused while an identical append is a receipt", async () => {
  const f = await fixture();
  await f.history.record(
    f.turn,
    {
      version: 1,
      type: "message",
      id: "same",
      messageId: "same",
      part: 0,
      generation: 0,
      role: "user",
      attemptId: null,
      completion: "complete",
      relations: [],
    },
    "first",
    f.resources,
  );
  const read = await f.durable.eventStore.readFrom({ streamId: f.stream, afterSequence: null }, 8);
  if (!read.ok) throw new Error(read.error.code);
  const event = read.value.find((event) => event.kind === "history.recorded");
  if (event?.kind !== "history.recorded") throw new Error("history missing");
  expect(await f.durable.eventStore.append(event)).toMatchObject({
    ok: true,
    value: { kind: "duplicate" },
  });
  const changed = {
    ...event,
    payload: {
      ...event.payload,
      evidence: {
        availability: "inline" as const,
        text: "other",
        digest: historyDigest("other"),
        byteLength: 5,
        sensitivity: "user-content" as const,
        fidelity: "exact" as const,
      },
    },
  };
  expect(await f.durable.eventStore.append(changed)).toMatchObject({
    ok: false,
    error: { code: "sequence", error: { code: "idempotency-conflict" } },
  });
});

test("GC between seal and publication produces a semantic gap instead of a dangling handle", async () => {
  const f = await fixture();
  const opened = await openArtifactStore(() => f.services, undefined);
  if (!opened.ok || opened.kind !== "open") throw new Error("store missing");
  cleanups.push(() => opened.store.close());
  const history = createSessionHistory({
    correlation: f.correlation,
    artifacts: f.durable.artifacts,
    journal: {
      ...f.journal,
      async persist(facts, signal) {
        for (const fact of facts)
          if (
            fact.kind === "history.recorded" &&
            fact.payload.evidence.availability === "retained"
          ) {
            const id = fact.payload.evidence.artifactId;
            expect(
              opened.store.write((sql) =>
                sql.run("DELETE FROM artifacts WHERE artifact_id = $id", { id }),
              ).ok,
            ).toBe(true);
          }
        return f.journal.persist(facts, signal);
      },
    },
  });
  const result = await history.record(
    f.turn,
    {
      version: 1,
      type: "message",
      id: "publication-race",
      messageId: "publication-race",
      part: 0,
      generation: 0,
      role: "assistant",
      attemptId: "attempt",
      completion: "partial",
      relations: [],
    },
    "sealed evidence ".repeat(300),
    f.resources,
  );
  expect(result).toMatchObject({
    committed: true,
    evidence: { availability: "unavailable", reason: "storage-failed" },
  });
});

test("headless export and import preserve semantic content and order across separate stores", async () => {
  const f = await fixture();
  const original = "Exported exact α\n  preserved whitespace\n".repeat(100);
  await f.history.record(
    f.turn,
    {
      version: 1,
      type: "message",
      id: "exported",
      messageId: "exported",
      part: 0,
      generation: 0,
      role: "assistant",
      attemptId: "export-attempt",
      completion: "complete",
      relations: [],
    },
    original,
    f.resources,
  );
  const name = exportName.from("semantic-history");
  const exported = await runExport(() => f.services, {
    selection: { kind: "sessions", sessionIds: [f.correlation.sessionId], includeSensitive: false },
    write: true,
    name,
  });
  expect(exported.outcome.kind).toBe("completed");
  if (!exported.payload?.bundle) throw new Error(JSON.stringify(exported.errors));
  expect(exported.payload.counts.artifacts).toBe(1);
  const target = await fixture(false);
  const exports = rootChild(target.services.localData.layout, "exports");
  if (!exports) throw new Error("export root missing");
  await mkdir(exports, { recursive: true });
  await copyFile(exported.payload.bundle.path, join(exports, name));
  const imported = await runImport(() => target.services, { name });
  expect(imported.outcome.kind).toBe("completed");
  const reader = createHistoryReader({
    events: target.durable.eventStore,
    artifacts: target.durable.artifacts,
    authorize: () => true,
  });
  const page = await reader.page({ streamId: f.stream, afterSequence: null });
  expect(page).toMatchObject({ ok: true, partial: false });
  if (!page.ok) throw new Error(page.code);
  expect(page.items.map((item) => Number(item.event?.sequence))).toEqual([1, 2, 3]);
  expect(page.items[2]?.text).toBe(original);
});

test.each([false, true])(
  "interrupted token streaming (cancelled=%s) retains the last bounded batch without protected reasoning",
  async (cancelled) => {
    const f = await fixture();
    const controller = new AbortController();
    const input: AsyncIterable<NormalizedProviderEvent> = (async function* () {
      for (let sequence = 1; sequence <= 1000; sequence++)
        yield {
          kind: "text-delta" as const,
          text: "α ",
          sequence,
          requestId: modelRequestId.from("stream-request"),
          modelAttemptId: modelAttemptId.from("stream-attempt"),
        };
      yield {
        kind: "reasoning-delta" as const,
        text: "PROTECTED-REASONING-CANARY",
        sequence: 1001,
        requestId: modelRequestId.from("stream-request"),
        modelAttemptId: modelAttemptId.from("stream-attempt"),
      };
      yield {
        kind: "text-delta" as const,
        text: "interrupted tail",
        sequence: 1002,
        requestId: modelRequestId.from("stream-request"),
        modelAttemptId: modelAttemptId.from("stream-attempt"),
      };
      if (cancelled) controller.abort();
      throw new Error("provider-disconnected");
    })();
    const read = async () => {
      for await (const _event of recordProviderHistory({
        events: input,
        ...(cancelled ? { admittedSignal: controller.signal } : {}),
        history: f.history,
        resources: f.resources,
        turnId: f.turn,
        attemptId: "stream-attempt",
        request: 1,
        generation: 0,
        catalogGeneration: 0,
        disclosureDigest: historyDigest("[]"),
      })) {
        /* Drain as the provider consumer does. */
      }
    };
    await expect(read()).rejects.toThrow("provider-disconnected");
    const page = await createHistoryReader({
      events: f.durable.eventStore,
      artifacts: f.durable.artifacts,
      authorize: () => true,
    }).page({ streamId: f.stream, afterSequence: null, limit: 64 });
    if (!page.ok) throw new Error(page.code);
    expect(page.items.map((item) => item.text ?? "").join("")).toBe(
      `${"α ".repeat(1000)}interrupted tail`,
    );
    expect(JSON.stringify(page)).not.toContain("PROTECTED-REASONING-CANARY");
    expect(f.resources.remaining("operations")).toBeGreaterThan(450);
  },
);

test("nested proposal credentials are redacted before history publication", async () => {
  const f = await fixture();
  const body = JSON.stringify({
    argumentsJson: JSON.stringify({ apiKey: "RAW-CREDENTIAL-CANARY", safe: "public" }),
  });
  const captured = await f.history.record(
    f.turn,
    {
      version: 1,
      type: "proposal",
      stage: "assembled",
      inputDigest: historyDigest(body),
      id: "secret-proposal",
      generation: 0,
      attemptId: "attempt",
      proposalId: "proposal",
      invocationId: null,
      name: "inspect",
      catalogGeneration: 0,
      policyGeneration: 0,
      disclosureDigest: historyDigest("[]"),
    },
    body,
    f.resources,
  );
  expect(captured).toMatchObject({
    committed: true,
    evidence: { availability: "inline", fidelity: "redacted" },
  });
  const page = await createHistoryReader({
    events: f.durable.eventStore,
    artifacts: f.durable.artifacts,
    authorize: () => true,
  }).page({ streamId: f.stream, afterSequence: null });
  expect(JSON.stringify(page)).not.toContain("RAW-CREDENTIAL-CANARY");
  expect(JSON.stringify(page)).toContain("public");
});

test("corrupt bytes, retention expiry and authorization changed during a read remain explicit", async () => {
  const f = await fixture();
  const captured = await f.history.record(
    f.turn,
    {
      version: 1,
      type: "message",
      id: "read-faults",
      messageId: "read-faults",
      part: 0,
      generation: 0,
      role: "assistant",
      attemptId: "attempt",
      completion: "complete",
      relations: [],
    },
    "Retained canary ".repeat(300),
    f.resources,
  );
  if (captured.evidence.availability !== "retained") throw new Error("artifact missing");
  const id = captured.evidence.artifactId;
  const corruptReader = createHistoryReader({
    events: f.durable.eventStore,
    authorize: () => true,
    artifacts: {
      ...f.durable.artifacts,
      async readRange(...args) {
        const read = await f.durable.artifacts.readRange(...args);
        if (!read.ok) return read;
        const bytes = new Uint8Array(read.value.bytes);
        bytes[0] = 0;
        return ok({ ...read.value, bytes });
      },
    },
  });
  const corrupted = await corruptReader.page({ streamId: f.stream, afterSequence: null });
  expect(corrupted).toMatchObject({ ok: true, partial: true });
  if (corrupted.ok) expect(corrupted.items.at(-1)?.availability).toBe("corrupt");
  const opened = await openArtifactStore(() => f.services, undefined);
  if (!opened.ok || opened.kind !== "open") throw new Error("store missing");
  cleanups.push(() => opened.store.close());
  const revoked = createHistoryReader({
    events: f.durable.eventStore,
    authorize: () => true,
    artifacts: {
      ...f.durable.artifacts,
      async readRange(...args) {
        const read = await f.durable.artifacts.readRange(...args);
        expect(
          opened.store.write((sql) =>
            sql.run("UPDATE artifacts SET sensitivity = 'restricted' WHERE artifact_id = $id", {
              id,
            }),
          ).ok,
        ).toBe(true);
        return read;
      },
    },
  });
  const denied = await revoked.page({ streamId: f.stream, afterSequence: null });
  if (!denied.ok) throw new Error(denied.code);
  expect(denied.items.at(-1)?.availability).toBe("unauthorized");
  expect(denied.items.at(-1)?.text).toBeNull();
  expect(
    opened.store.write((sql) =>
      sql.run(
        "UPDATE artifacts SET sensitivity = 'user-content', availability = 'missing' WHERE artifact_id = $id",
        { id },
      ),
    ).ok,
  ).toBe(true);
  const expired = await createHistoryReader({
    events: f.durable.eventStore,
    artifacts: f.durable.artifacts,
    authorize: () => true,
  }).page({ streamId: f.stream, afterSequence: null });
  if (!expired.ok) throw new Error(expired.code);
  expect(expired.items.at(-1)?.availability).toBe("expired");
  expect(expired.items.at(-1)?.text).toBeNull();
});

test.each(["artifact seal", "completion append", "partial artifact seal"])(
  "generic result %s failure preserves an observed effect and prevents duplicate execution",
  async (failure) => {
    const f = await fixture();
    const effect =
      failure === "partial artifact seal" ? ("partial" as const) : ("completed" as const);
    const entry = createToolRegistryEntry(
      {
        namespace: "test",
        name: "change",
        version: 1,
        source: "builtin",
        title: "Change",
        description: "Write a test marker",
        effect: "mutation",
        capabilityKind: "filesystem",
        platforms: [],
        limits: defaultToolLimits(),
        concurrency: defaultConcurrencyContract(),
        resultProjection: defaultProjectionContract(),
      },
      {
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({ content: z.string() }).strict(),
      },
    );
    if (!entry.ok) throw new Error(entry.error.code);
    const registry = createToolRegistry(f.correlation.configurationGeneration, [entry.value]);
    const hooks = createToolHookRegistry(f.correlation.configurationGeneration, []);
    if (!registry.ok || !hooks.ok) throw new Error("fixture registry");
    let executions = 0;
    const gateway = createProductToolGateway({
      clock: f.services.clock,
      journal: {
        ...f.journal,
        persist(facts, signal) {
          if (
            failure === "completion append" &&
            facts.some((fact) => fact.kind === "capability.invocation.completed")
          )
            return Promise.resolve({ kind: "cancelled" as const, events: [], receipts: [] });
          return f.journal.persist(facts, signal);
        },
      },
      correlation: f.correlation,
      turnId: f.turn,
      registry: registry.value,
      hooks: hooks.value,
      disclosedToolNames: new Set(["change"]),
      effectLedger: new Map(),
      confirmation: LIVE_TURN_MATRIX_CONFIRMATION,
      historyArtifacts: {
        ...f.durable.artifacts,
        ingest: (...args) =>
          failure !== "completion append" && executions > 0
            ? Promise.resolve(
                err({
                  kind: "artifact" as const,
                  code: "cancelled" as const,
                  artifactId: args[0].artifactId,
                }),
              )
            : f.durable.artifacts.ingest(...args),
      },
      runner: {
        async execute() {
          executions++;
          await writeFile(join(f.home, "observed-effect.txt"), "changed");
          const output = { content: "EXACT_OVERFLOW_CANARY\n".repeat(600) };
          return effect === "partial"
            ? { status: "partial" as const, effect, output }
            : { status: "completed" as const, effect, output };
        },
      },
    });
    const request = {
      invocationId: invocationId.from("observed-change"),
      toolCallId: "observed-change",
      toolName: "change",
      capabilityId: entry.value.manifest.capabilityId,
      version: 1,
      effect: "mutation" as const,
      input: {},
      signal: new AbortController().signal,
    };
    const outcome = await gateway.execute(request);
    expect(outcome).toMatchObject({ status: "failed", effect });
    expect(await gateway.execute(request)).toMatchObject({ status: "failed", effect });
    expect(executions).toBe(1);
    const page = await createHistoryReader({
      events: f.durable.eventStore,
      artifacts: f.durable.artifacts,
      authorize: () => true,
    }).page({ streamId: f.stream, afterSequence: null });
    if (!page.ok) throw new Error(page.code);
    expect(
      page.items.some(
        (item) =>
          item.event?.kind === "history.recorded" &&
          item.event.payload.id === "observed-change:exact-result" &&
          item.event.payload.type === "result" &&
          item.event.payload.effect === effect &&
          item.availability === (failure === "completion append" ? "exact" : "unavailable"),
      ),
    ).toBe(true);
  },
);

test("shell export control and headless preview use the same selection and destination policy", async () => {
  const f = await fixture();
  const selection = {
    kind: "sessions" as const,
    sessionIds: [f.correlation.sessionId],
    includeSensitive: false,
  };
  const headless = await runExport(() => f.services, { selection, write: false, name: null });
  const control = sessionExportControl(() => f.services, f.correlation.sessionId);
  const signal = new AbortController().signal;
  expect((await control(null, signal)).message).toContain(
    `${headless.payload?.counts.events} events`,
  );
  expect((await control("markdown", signal)).message).toContain("versioned JSONL");
  expect((await control("write exported", signal)).message).toContain("Export written");
  expect((await control("write exported", signal)).message).toContain("Export failed");
  const cancelled = new AbortController();
  cancelled.abort();
  expect((await control("write cancelled", cancelled.signal)).message).not.toContain(
    "Export written",
  );
});

test("checkpoint and restore contracts survive reopen as evidence without activating restoration", async () => {
  const f = await fixture();
  const manifest = JSON.stringify({
    files: [
      { path: "overwritten.ts", before: "old α", after: "new" },
      { path: "created.ts", before: null, after: "created" },
      { path: "deleted.ts", before: "deleted", after: null },
    ],
  });
  const restore = {
    version: 1 as const,
    type: "restore-point" as const,
    id: "restore-prepared",
    generation: 0,
    restorePointId: "restore-1",
    restorePointVersion: 1 as const,
    attemptId: "attempt-1",
    scope: {
      kind: "paths" as const,
      pathDigests: [
        historyDigest("overwritten.ts"),
        historyDigest("created.ts"),
        historyDigest("deleted.ts"),
      ],
    },
    capture: { fidelity: "exact" as const, pathCount: 3, artifactCount: 1, omissions: [] },
    operationId: "operation-1",
    rootId: "root-1",
    stage: "prepared" as const,
    effect: "none" as const,
    relations: [],
  };
  expect((await f.history.record(f.turn, restore, manifest, f.resources)).committed).toBe(true);
  expect(
    (
      await f.history.record(
        f.turn,
        {
          version: 1,
          type: "checkpoint",
          id: "checkpoint",
          generation: 0,
          checkpointId: "checkpoint-1",
          parentCheckpointId: null,
          transform: "context-compaction-v1",
          firstSequence: 1,
          lastSequence: 3,
          covered: ["restore-prepared"],
          omitted: [{ id: "uncollected", reason: "not-recorded" }],
        },
        JSON.stringify({ summary: "Recorded three path states" }),
        f.resources,
      )
    ).committed,
  ).toBe(true);
  await f.durable.close();
  const replay = await runReplay(() => f.services, { sessionId: f.correlation.sessionId });
  expect(replay.outcome.kind).toBe("completed");
  expect(replay.payload?.history?.items.some((item) => item.text === manifest)).toBe(true);
  expect(replay.payload?.effectFree).toBe(true);
});

test("credential canaries in public message JSON never survive history or export", async () => {
  const f = await fixture();
  const secret = "CREDENTIAL_CANARY_791";
  const text = `Pasted config: {"apiKey":"${secret}","message":"visible"}`;
  const saved = await f.history.record(
    f.turn,
    {
      version: 1,
      type: "message",
      id: "credential-message",
      messageId: "credential-message",
      part: 0,
      generation: 0,
      role: "user",
      attemptId: null,
      completion: "complete",
      relations: [],
    },
    text,
    f.resources,
  );
  expect(saved.committed).toBe(true);
  const page = await createHistoryReader({
    events: f.durable.eventStore,
    artifacts: f.durable.artifacts,
    authorize: () => true,
  }).page({ streamId: f.stream, afterSequence: null });
  expect(JSON.stringify(page)).not.toContain(secret);
  expect(JSON.stringify(page)).toContain("visible");
});

test("reopened GC retains semantic references and identifies sealed unpublished artifacts as orphans", async () => {
  const f = await fixture();
  const metadata = {
    version: 1 as const,
    type: "message" as const,
    id: "reachable",
    messageId: "reachable",
    part: 0,
    generation: 0,
    role: "assistant" as const,
    attemptId: "attempt",
    completion: "partial" as const,
    relations: [],
  };
  const saved = await f.history.record(f.turn, metadata, "retained α\n".repeat(400), f.resources);
  if (saved.evidence.availability !== "retained") throw new Error("retention fixture");
  const retainedId = saved.evidence.artifactId;
  const bytes = new TextEncoder().encode("sealed but no journal publication");
  expect(
    (
      await f.durable.artifacts.ingest({
        artifactId: artifactId.from("unpublished"),
        mediaType: "text/plain",
        encoding: "identity",
        sensitivity: "user-content",
        origin: "model-output",
        invocationId: null,
        declaredByteLength: bytes.length,
        content: (async function* () {
          yield bytes;
        })(),
      })
    ).ok,
  ).toBe(true);
  await f.durable.close();
  const opened = await openArtifactStore(() => f.services, undefined);
  if (!opened.ok || opened.kind !== "open") throw new Error("reopen");
  cleanups.push(() => opened.store.close());
  const blobs = createHostBlobStore({
    artifactsRoot: localPath(String(rootChild(f.services.localData.layout, "artifacts"))),
    temporaryRoot: localPath(String(rootChild(f.services.localData.layout, "temporaryIngest"))),
  });
  const packages = createInMemoryPackageWriter();
  const repositories = createRecordRepositories(opened.store);
  const exportOptions = {
    store: opened.store,
    repositories,
    events: createSqliteEventStore(opened.store),
    blobs,
    packages,
    hasher: createSha256Hasher(),
    clock: f.services.clock,
    buildIdentity: "history-test",
    redactor: createRuntimeProjectionRedactor(),
  };
  const planned = await planReachabilityGc({
    store: opened.store,
    repositories,
    blobs,
    packages,
    exportOptions,
    pinnedSessionIds: [],
    exportPackageNames: [],
  });
  if (!planned.ok) throw new Error(JSON.stringify(planned.error));
  expect(planned.value.candidates.some((candidate) => candidate.identity === retainedId)).toBe(
    false,
  );
  expect(
    planned.value.candidates.some(
      (candidate) => candidate.kind === "artifact" && candidate.identity === "unpublished",
    ),
  ).toBe(true);
});

test.each(["sealed", "prepared", "mutated", "observed", "settled"])(
  "SIGKILL at %s preserves only committed recovery evidence",
  async (stage) => {
    const f = await fixture();
    const original = "original α\n".repeat(300);
    await writeFile(join(f.home, "overwritten.txt"), original);
    await writeFile(join(f.home, "deleted.txt"), "original deleted δ\n");
    await f.durable.close();
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "semantic-history-crash.fixtures.ts"),
        f.home,
        stage,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const ready = child.stdout.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const chunk = await Promise.race([
        ready.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("crash fixture did not reach boundary")), 3000);
        }),
      ]);
      expect(new TextDecoder().decode(chunk.value)).toContain("READY");
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await child.exited;
      ready.releaseLock();
    }
    const reopened = await openProductArtifactSession(f.services);
    if (!reopened) throw new Error("crash fixture reopen");
    cleanups.push(() => reopened.close());
    const page = await createHistoryReader({
      events: reopened.eventStore,
      artifacts: reopened.artifacts,
      authorize: () => true,
    }).page({ streamId: f.stream, afterSequence: null, limit: 64 });
    if (!page.ok) throw new Error(page.code);
    const points = page.items.filter(
      (item) =>
        item.event?.kind === "history.recorded" && item.event.payload.type === "restore-point",
    );
    expect(points).toHaveLength(
      stage === "sealed" ? 0 : stage === "settled" ? 3 : stage === "observed" ? 2 : 1,
    );
    expect(new Set(page.items.map((item) => item.event?.eventId)).size).toBe(page.items.length);
    if (stage !== "sealed")
      expect(points[0]?.references?.some((reference) => reference.text === original)).toBe(true);
    if (stage === "observed" || stage === "settled")
      expect(
        points[1]?.references?.some((reference) => reference.text === "observed replacement β\n"),
      ).toBe(true);
    if (stage === "mutated")
      expect(
        points.every(
          (item) =>
            item.event?.kind === "history.recorded" &&
            item.event.payload.type === "restore-point" &&
            item.event.payload.effect === "none",
        ),
      ).toBe(true);
    const replay = await runReplay(() => f.services, { sessionId: f.correlation.sessionId });
    expect(replay.outcome.kind).toBe("completed");
    expect(replay.payload?.effectFree).toBe(true);
    if (stage === "settled") {
      const prepared = points[0]?.event;
      if (prepared?.kind !== "history.recorded" || prepared.payload.type !== "restore-point")
        throw new Error("prepared event");
      const encoded = encodeRuntimeEvent(prepared);
      if (!encoded.ok) throw new Error("restore encoding");
      const unknown = JSON.parse(new TextDecoder().decode(encoded.value));
      unknown.payload.restorePointVersion = 99;
      expect(decodeRuntimeEvent(JSON.stringify(unknown)).ok).toBe(false);
      const { evidence: _evidence, ...metadata } = prepared.payload;
      const journal = createTurnEventJournal({
        eventStore: reopened.eventStore,
        clock: f.services.clock,
        streamId: f.stream,
        correlation: f.correlation,
      });
      const history = createSessionHistory({
        journal,
        correlation: f.correlation,
        artifacts: reopened.artifacts,
      });
      expect(
        (
          await history.record(
            f.turn,
            { ...metadata, id: "restore-deleted", stage: "deleted", references: [] },
            "{}",
            f.resources,
          )
        ).committed,
      ).toBe(true);
      const retired = await createHistoryReader({
        events: reopened.eventStore,
        artifacts: reopened.artifacts,
        authorize: () => true,
      }).page({ streamId: f.stream, afterSequence: null, limit: 64 });
      expect(JSON.stringify(retired)).not.toContain(original);
      if (!retired.ok) throw new Error(retired.code);
      expect(
        retired.items
          .filter((item) => item.event?.kind === "history.recorded")
          .every((item) => item.availability === "expired"),
      ).toBe(true);
      const preview = await runExport(() => f.services, {
        selection: {
          kind: "sessions",
          sessionIds: [f.correlation.sessionId],
          includeSensitive: false,
        },
        write: false,
        name: null,
      });
      expect(preview.outcome.kind).toBe("completed");
      expect(preview.payload?.counts.artifacts).toBe(0);
      expect(preview.payload?.omissions).toHaveLength(4);
    }
  },
);

test("multiple checkpoints retain derived identity while expired original evidence stays unavailable after export/import", async () => {
  const f = await fixture();
  const source = await f.history.record(
    f.turn,
    {
      version: 1,
      type: "message",
      id: "checkpoint-source",
      messageId: "checkpoint-source",
      part: 0,
      role: "assistant",
      attemptId: "attempt",
      generation: 0,
      completion: "complete",
      relations: [],
    },
    "original checkpoint evidence α\n".repeat(150),
    f.resources,
  );
  if (source.evidence.availability !== "retained") throw new Error("source artifact");
  const sourceId = source.evidence.artifactId;
  for (const number of [1, 2])
    expect(
      (
        await f.history.record(
          f.turn,
          {
            version: 1,
            type: "checkpoint",
            id: `checkpoint-${number}`,
            checkpointId: `checkpoint-${number}`,
            parentCheckpointId: number === 1 ? null : "checkpoint-1",
            generation: 0,
            transform: "summary-v1",
            firstSequence: 1,
            lastSequence: 3,
            covered: ["checkpoint-source"],
            omitted: [{ id: "uncollected", reason: "not-recorded" }],
            references: [source.evidence],
          },
          JSON.stringify({ summary: `derived summary ${number}` }),
          f.resources,
        )
      ).committed,
    ).toBe(true);
  const denied = await createHistoryReader({
    events: f.durable.eventStore,
    artifacts: f.durable.artifacts,
    authorize: (_event, artifact) => artifact === null,
  }).page({ streamId: f.stream, afterSequence: null, limit: 64 });
  expect(JSON.stringify(denied)).not.toContain(sourceId);
  expect(JSON.stringify(denied)).not.toContain("derived summary");
  if (!denied.ok) throw new Error(denied.code);
  expect(
    denied.items
      .slice(-3)
      .every((item) => item.availability === "unauthorized" && item.event === null),
  ).toBe(true);
  const opened = await openArtifactStore(() => f.services, undefined);
  if (!opened.ok || opened.kind !== "open") throw new Error("checkpoint store");
  expect(
    opened.store.write((sql) =>
      sql.run("UPDATE artifacts SET availability = 'missing' WHERE artifact_id = $id", {
        id: sourceId,
      }),
    ).ok,
  ).toBe(true);
  await opened.store.close();
  await f.durable.close();
  const replay = await runReplay(() => f.services, { sessionId: f.correlation.sessionId });
  expect(replay.outcome.kind).toBe("completed");
  const points = replay.payload?.history?.items.filter(
    (item) => item.event?.kind === "history.recorded" && item.event.payload.type === "checkpoint",
  );
  expect(points).toHaveLength(2);
  expect(
    points?.every(
      (item) => item.availability === "reduced" && item.references?.[0]?.availability === "expired",
    ),
  ).toBe(true);
  const name = exportName.from("checkpoint-history");
  const exported = await runExport(() => f.services, {
    selection: { kind: "sessions", sessionIds: [f.correlation.sessionId], includeSensitive: false },
    write: true,
    name,
  });
  if (!exported.payload?.bundle) throw new Error(JSON.stringify(exported.errors));
  expect(exported.payload.omissions).toHaveLength(1);
  const target = await fixture(false);
  const exports = rootChild(target.services.localData.layout, "exports");
  if (!exports) throw new Error("checkpoint exports");
  await mkdir(exports, { recursive: true });
  await copyFile(exported.payload.bundle.path, join(exports, name));
  expect((await runImport(() => target.services, { name })).outcome.kind).toBe("completed");
  const imported = await runReplay(() => target.services, { sessionId: f.correlation.sessionId });
  expect(
    imported.payload?.history?.items.some(
      (item) =>
        item.event?.kind === "history.recorded" &&
        item.event.payload.type === "checkpoint" &&
        item.event.payload.parentCheckpointId === "checkpoint-1" &&
        item.references?.[0]?.availability === "missing",
    ),
  ).toBe(true);
});
