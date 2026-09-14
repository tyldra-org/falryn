import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProductCheckpointAction } from "../../application/compression/product-checkpoint.ts";
import { createProductResources } from "../../application/orchestration/product-resources.ts";
import { createTurnEventJournal } from "../../application/runtime/turn-event-journal.ts";
import { historyDigest } from "../../application/sessions/session-history.ts";
import { createSqliteEventStore } from "../../data/sessions/event-store.ts";
import { turnId } from "../../domain/foundation/index.ts";
import { createHistoryReader } from "../../domain/sessions/history-reader.ts";
import { openArtifactStore } from "../commands/storage.ts";
import { dispatch } from "../dispatch.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { createCheckpointFixture } from "./history-checkpoint.fixtures.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const value = await createCheckpointFixture();
  cleanups.push(() => value.close());
  return value;
}

test("SQLite producer publishes once, reopens identical projection, and retains exact original text", async () => {
  const f = await fixture();
  const preview = await f.action.run({ action: "preview" }, f.resources);
  expect(preview.kind).toBe("preview");
  if (preview.kind === "refused") throw new Error(preview.reason);
  expect(preview.projection.contents).toEqual([f.text]);
  expect(preview.afterBytes).toBeLessThan(preview.beforeBytes);
  const applied = await f.action.run(
    { action: "apply", candidateId: preview.candidateId },
    f.resources,
  );
  expect(applied.kind).toBe("applied");
  const duplicate = await f.action.run(
    { action: "apply", candidateId: preview.candidateId },
    f.resources,
  );
  expect(duplicate).toMatchObject({
    kind: "applied",
    duplicate: true,
    eventId: applied.kind !== "refused" ? applied.eventId : "",
  });
  await f.durable.close();
  const reopened = await openProductArtifactSession(f.services);
  if (!reopened) throw new Error("reopen failed");
  cleanups.push(() => reopened.close());
  const action = createProductCheckpointAction({
    ...f.ports,
    events: reopened.eventStore,
    artifacts: reopened.artifacts,
    journal: createTurnEventJournal({
      eventStore: reopened.eventStore,
      clock: f.services.clock,
      streamId: f.stream,
      correlation: f.correlation,
    }),
  });
  const inspected = await action.run(
    { action: "inspect", candidateId: preview.candidateId },
    f.resources,
  );
  expect(inspected.kind).toBe("inspected");
  if (inspected.kind === "refused") throw new Error(inspected.reason);
  expect(inspected.projection).toEqual(preview.projection);
});
test("whole request protected overflow and revoked sources cannot publish", async () => {
  const f = await fixture();
  f.authority.contextWindowTokens = 100;
  expect(await f.action.run({ action: "preview" }, f.resources)).toMatchObject({
    kind: "refused",
    reason: "insufficient-budget",
    effect: "none",
  });
  f.authority.contextWindowTokens = 128000;
  const preview = await f.action.run({ action: "preview" }, f.resources);
  if (preview.kind === "refused") throw new Error(preview.reason);
  f.revoke();
  expect(
    await f.action.run({ action: "apply", candidateId: preview.candidateId }, f.resources),
  ).toMatchObject({ kind: "refused", reason: "unauthorized" });
});
test("changed model policy invalidates preview without a second history publication", async () => {
  const f = await fixture();
  const preview = await f.action.run({ action: "preview" }, f.resources);
  if (preview.kind === "refused") throw new Error(preview.reason);
  f.authority.policyGeneration += 1;
  expect(
    await f.action.run({ action: "apply", candidateId: preview.candidateId }, f.resources),
  ).toMatchObject({ kind: "refused", reason: "stale-preview" });
});

test.each(["restricted", "missing"] as const)(
  "generic history readers withhold a projection after source becomes %s",
  async (change) => {
    const f = await fixture();
    const preview = await f.action.run({ action: "preview" }, f.resources);
    if (preview.kind === "refused") throw new Error(preview.reason);
    const applied = await f.action.run(
      { action: "apply", candidateId: preview.candidateId },
      f.resources,
    );
    if (applied.kind === "refused") throw new Error(applied.reason);
    const evidence = preview.projection.records[0]?.payload.evidence;
    if (evidence?.availability !== "retained") throw new Error("source not retained");
    const opened = await openArtifactStore(() => f.services, undefined);
    if (!opened.ok || opened.kind !== "open") throw new Error("store unavailable");
    try {
      expect(
        opened.store.write((sql) =>
          sql.run(
            change === "restricted"
              ? "UPDATE artifacts SET sensitivity = 'restricted' WHERE artifact_id = $id"
              : "UPDATE artifacts SET availability = 'missing' WHERE artifact_id = $id",
            { id: evidence.artifactId },
          ),
        ).ok,
      ).toBe(true);
      const read = await createHistoryReader({
        events: f.durable.eventStore,
        artifacts: f.durable.artifacts,
        digest: historyDigest,
        authorize: () => true,
      }).page({ streamId: f.stream, afterSequence: null, limit: 32 });
      if (!read.ok) throw new Error(read.code);
      expect(
        read.items.filter((item) => item.text?.includes('"history-projection.v1"')),
      ).toHaveLength(0);
      expect(read.items.at(-1)?.availability).toBe(
        change === "restricted" ? "unauthorized" : "expired",
      );
    } finally {
      await opened.store.close();
    }
  },
);

test("two SQLite connections cannot publish competing previews of one source generation", async () => {
  const f = await fixture();
  const opened = await openArtifactStore(() => f.services, undefined);
  if (!opened.ok || opened.kind !== "open") throw new Error("store unavailable");
  const other = createProductResources(f.services.clock).openTask("0");
  const events = createSqliteEventStore(opened.store);
  let staged = 0;
  const both = Promise.withResolvers<void>();
  const artifacts = {
    ...f.durable.artifacts,
    async ingest(...args: Parameters<typeof f.durable.artifacts.ingest>) {
      const result = await f.durable.artifacts.ingest(...args);
      staged += 1;
      if (staged === 2) both.resolve();
      await both.promise;
      return result;
    },
  };
  const first = createProductCheckpointAction({ ...f.ports, artifacts });
  const second = createProductCheckpointAction({
    ...f.ports,
    artifacts,
    events,
    journal: createTurnEventJournal({
      eventStore: events,
      clock: f.services.clock,
      streamId: f.stream,
      correlation: f.correlation,
    }),
  });
  try {
    const results = await Promise.all([
      first.run({ action: "preview" }, f.resources),
      second.run({ action: "preview" }, other),
    ]);
    expect(results.filter((result) => result.kind === "preview")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "refused")).toHaveLength(1);
    const records = await events.readFrom({ streamId: f.stream, afterSequence: null }, 100);
    expect(
      records.ok &&
        records.value.filter(
          (event) => event.kind === "history.recorded" && event.payload.type === "checkpoint",
        ),
    ).toHaveLength(1);
  } finally {
    other.close();
    await opened.store.close();
  }
});

test("cancellation and policy changes after staging leave no checkpoint references", async () => {
  for (const mode of ["cancel", "policy"] as const) {
    const f = await fixture();
    const controller = new AbortController();
    const action = createProductCheckpointAction({
      ...f.ports,
      artifacts: {
        ...f.durable.artifacts,
        async ingest(...args: Parameters<typeof f.durable.artifacts.ingest>) {
          const result = await f.durable.artifacts.ingest(...args);
          if (mode === "cancel") controller.abort();
          else f.authority.policyGeneration += 1;
          return result;
        },
      },
    });
    expect((await action.run({ action: "preview" }, f.resources, controller.signal)).kind).toBe(
      "refused",
    );
    const events = await f.durable.eventStore.readFrom(
      { streamId: f.stream, afterSequence: null },
      100,
    );
    expect(
      events.ok &&
        events.value.filter(
          (event) => event.kind === "history.recorded" && event.payload.type === "checkpoint",
        ),
    ).toHaveLength(0);
  }
});

test("repeated checkpoints keep original content and restore selects lineage without rewriting", async () => {
  const f = await fixture();
  const first = await f.action.run({ action: "preview" }, f.resources);
  if (first.kind === "refused") throw new Error(first.reason);
  await f.action.run({ action: "apply", candidateId: first.candidateId }, f.resources);
  const unchanged = await f.action.run({ action: "preview" }, f.resources);
  expect(unchanged).toMatchObject({
    kind: "applied",
    duplicate: true,
    checkpointId: first.checkpointId,
  });
  expect(unchanged.kind !== "refused" && unchanged.projection).toEqual(first.projection);
  await f.history.record(
    f.turn,
    {
      version: 1,
      type: "message",
      id: "third",
      messageId: "third",
      generation: 0,
      part: 0,
      role: "user",
      attemptId: null,
      completion: "complete",
      relations: [],
    },
    "Correction: preserve the completed effect and unresolved task.",
    f.resources,
  );
  const second = await f.action.run({ action: "preview" }, f.resources);
  if (second.kind === "refused") throw new Error(second.reason);
  expect(second.projection.parentCheckpointId).toBe(first.checkpointId);
  expect(second.projection.contents).toEqual([
    ...first.projection.contents,
    "Correction: preserve the completed effect and unresolved task.",
  ]);
  await f.action.run({ action: "apply", candidateId: second.candidateId }, f.resources);
  expect(
    await f.action.run({ action: "restore", candidateId: first.candidateId }, f.resources),
  ).toMatchObject({ kind: "selected", checkpointId: first.checkpointId });
  expect(
    await f.action.run({ action: "apply", candidateId: first.candidateId }, f.resources),
  ).toMatchObject({ kind: "applied", duplicate: true });
  const inspected = await f.action.run(
    { action: "inspect", candidateId: first.candidateId },
    f.resources,
  );
  expect(inspected.kind !== "refused" && inspected.projection).toEqual(first.projection);
});

test("real headless CLI previews, applies, and reopens the producer codec over SQLite", async () => {
  const f = await fixture();
  const input = join(f.home, "compact.json");
  const reservation = {
    protectedRequest: "Keep the active instructions and task.",
    contextGeneration: "cli-request-1",
    freshToolsTokens: 0,
    freshResultsTokens: 0,
    modalityTokens: 0,
    reservedOutputTokens: 4096,
    reservedContinuationTokens: 2048,
  };
  const invoke = async (request: { action: string; candidateId?: string }) => {
    await writeFile(input, JSON.stringify({ request, reservation }));
    const streams = createRecordingCliStreams();
    const code = await dispatch({
      argv: [
        "compact",
        request.action,
        f.correlation.sessionId,
        "--input",
        input,
        "--format",
        "json",
      ],
      streams,
      services: () => () => f.services,
    });
    const output = JSON.parse(streams.resultWrites().join(""));
    expect({ code, reason: output.payload?.reason }).toEqual({ code: 0, reason: undefined });
    return output;
  };
  const preview = await invoke({ action: "preview" });
  expect(preview.payload.kind).toBe("preview");
  const applied = await invoke({ action: "apply", candidateId: preview.payload.candidateId });
  expect(applied.payload.kind).toBe("applied");
  expect(applied.payload.projection).toEqual(preview.payload.projection);
  const inspected = await invoke({ action: "inspect", candidateId: preview.payload.candidateId });
  expect(inspected.payload.projection).toEqual(preview.payload.projection);
});

test.each(["sealed", "preview", "applied"])(
  "SIGKILL after %s leaves only durable checkpoint receipts",
  async (stage) => {
    const f = await fixture();
    await f.durable.close();
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "history-checkpoint-crash.fixtures.ts"),
        f.home,
        stage,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = child.stdout.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("checkpoint boundary not reached")), 5000);
        }),
      ]);
      expect(new TextDecoder().decode(ready.value)).toContain("READY");
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await child.exited;
      reader.releaseLock();
    }
    const reopened = await createCheckpointFixture(f.home);
    cleanups.push(() => reopened.close());
    const events = await reopened.durable.eventStore.readFrom(
      { streamId: f.stream, afterSequence: null },
      64,
    );
    if (!events.ok) throw new Error(events.error.code);
    const checkpoints = events.value.filter(
      (event) => event.kind === "history.recorded" && event.payload.type === "checkpoint",
    );
    expect(checkpoints).toHaveLength(stage === "sealed" ? 0 : stage === "preview" ? 1 : 2);
    const last = checkpoints.at(-1);
    if (last?.kind === "history.recorded" && last.payload.type === "checkpoint") {
      const inspected = await reopened.action.run(
        { action: "inspect", candidateId: last.payload.checkpointId },
        reopened.resources,
      );
      expect(inspected.kind).toBe("inspected");
      if (inspected.kind === "refused") throw new Error(inspected.reason);
      expect(inspected.projection.contents).toEqual([f.text]);
      expect(inspected.eventId).toBe(last.eventId);
      if (stage === "applied")
        expect(
          await reopened.action.run(
            { action: "apply", candidateId: last.payload.checkpointId },
            reopened.resources,
          ),
        ).toMatchObject({ kind: "applied", duplicate: true, eventId: last.eventId });
    }
  },
);

test("a lost apply response reconciles the committed receipt without publishing again", async () => {
  const f = await fixture();
  const preview = await f.action.run({ action: "preview" }, f.resources);
  if (preview.kind === "refused") throw new Error(preview.reason);
  const action = createProductCheckpointAction({
    ...f.ports,
    journal: {
      async compareAndPersist(...args: Parameters<typeof f.journal.compareAndPersist>) {
        const committed = await f.journal.compareAndPersist(...args);
        if (committed.kind !== "persisted") return committed;
        return {
          kind: "store-error",
          error: {
            code: "storage",
            error: {
              kind: "sqlite-store",
              code: "closed",
              operation: "transaction",
              effect: "uncertain",
            },
          },
          events: [],
          receipts: [],
        } as const;
      },
    },
  });
  expect(
    await action.run({ action: "apply", candidateId: preview.candidateId }, f.resources),
  ).toMatchObject({ kind: "refused", effect: "uncertain" });
  expect(
    await action.run({ action: "apply", candidateId: preview.candidateId }, f.resources),
  ).toMatchObject({ kind: "applied", duplicate: true });
});

test.each(["source", "model", "profile"])(
  "%s changing after seal fences preview publication",
  async (change) => {
    const f = await fixture();
    const writer = createProductResources(f.services.clock).openTask("0");
    cleanups.push(async () => writer.close());
    const action = createProductCheckpointAction({
      ...f.ports,
      artifacts: {
        ...f.durable.artifacts,
        async ingest(...args: Parameters<typeof f.durable.artifacts.ingest>) {
          const result = await f.durable.artifacts.ingest(...args);
          if (change === "model") f.authority.model = "fixture/smaller";
          if (change === "profile") f.authority.configurationGeneration += 1;
          if (change === "source")
            await f.history.record(
              f.turn,
              {
                version: 1,
                type: "message",
                id: "correction",
                messageId: "correction",
                generation: 0,
                part: 0,
                role: "user",
                attemptId: null,
                completion: "complete",
                relations: [],
              },
              "Actually preserve the corrected request.",
              writer,
            );
          return result;
        },
      },
    });
    expect((await action.run({ action: "preview" }, f.resources)).kind).toBe("refused");
    const events = await f.durable.eventStore.readFrom(
      { streamId: f.stream, afterSequence: null },
      64,
    );
    expect(
      events.ok &&
        events.value.filter(
          (event) => event.kind === "history.recorded" && event.payload.type === "checkpoint",
        ),
    ).toHaveLength(0);
  },
);

test("strict ephemeral admission refuses before any durable preparation", async () => {
  const f = await fixture();
  let ingests = 0;
  const action = createProductCheckpointAction({
    ...f.ports,
    durable: false,
    artifacts: {
      ...f.durable.artifacts,
      async ingest(...args: Parameters<typeof f.durable.artifacts.ingest>) {
        ingests += 1;
        return f.durable.artifacts.ingest(...args);
      },
    },
  });
  expect(await action.run({ action: "preview" }, f.resources)).toMatchObject({
    reason: "ephemeral-session",
    effect: "none",
  });
  expect(ingests).toBe(0);
});

test("old checkpoint inspection and duplicate receipt survive later unfinished work", async () => {
  const f = await fixture();
  const preview = await f.action.run({ action: "preview" }, f.resources);
  if (preview.kind === "refused") throw new Error(preview.reason);
  await f.action.run({ action: "apply", candidateId: preview.candidateId }, f.resources);
  await f.journal.persist([
    { kind: "turn.started", correlation: { ...f.correlation, turnId: turnId.from("later-turn") } },
  ]);
  expect(await f.action.run({ action: "preview" }, f.resources)).toMatchObject({ reason: "busy" });
  expect(
    (await f.action.run({ action: "inspect", candidateId: preview.candidateId }, f.resources)).kind,
  ).toBe("inspected");
  expect(
    await f.action.run({ action: "apply", candidateId: preview.candidateId }, f.resources),
  ).toMatchObject({ kind: "applied", duplicate: true });
});

test("expired preview and a smaller restore window give explicit recovery outcomes", async () => {
  const f = await fixture();
  const preview = await f.action.run({ action: "preview" }, f.resources);
  if (preview.kind === "refused") throw new Error(preview.reason);
  const expired = createProductCheckpointAction({
    ...f.ports,
    clock: {
      ...f.services.clock,
      now: () => (preview.expiresAt + 1) as ReturnType<typeof f.services.clock.now>,
    },
  });
  expect(
    await expired.run({ action: "apply", candidateId: preview.candidateId }, f.resources),
  ).toMatchObject({ reason: "stale-preview", effect: "none" });
  expect(
    (await expired.run({ action: "inspect", candidateId: preview.candidateId }, f.resources)).kind,
  ).toBe("inspected");
  expect(
    (await f.action.run({ action: "apply", candidateId: preview.candidateId }, f.resources)).kind,
  ).toBe("applied");
  f.authority.contextWindowTokens = 100;
  expect(
    await f.action.run({ action: "restore", candidateId: preview.candidateId }, f.resources),
  ).toMatchObject({ reason: "insufficient-budget", effect: "none" });
});

test("modality reservations and Unicode are charged before retaining a projection", async () => {
  const f = await fixture();
  f.authority.protectedRequest = "🌍漢字".repeat(200);
  f.authority.instructionDigest = historyDigest(f.authority.protectedRequest);
  f.authority.systemAndSkillsTokens = Math.ceil(
    Buffer.byteLength(f.authority.protectedRequest) / 4,
  );
  const preview = await f.action.run({ action: "preview" }, f.resources);
  if (preview.kind === "refused") throw new Error(preview.reason);
  expect(preview.budget.historyTokens).toBe(Math.ceil(preview.afterBytes / 4));
  expect(preview.projection.authority.protectedRequest).toBe(f.authority.protectedRequest);
  f.authority.modalityTokens = f.authority.contextWindowTokens;
  expect(await f.action.run({ action: "preview" }, f.resources)).toMatchObject({
    reason: "insufficient-budget",
  });
});

test("corrupt retained checkpoint metadata never yields projected source bytes", async () => {
  const f = await fixture();
  const preview = await f.action.run({ action: "preview" }, f.resources);
  if (preview.kind === "refused") throw new Error(preview.reason);
  const opened = await openArtifactStore(() => f.services, undefined);
  if (!opened.ok || opened.kind !== "open") throw new Error("store unavailable");
  try {
    expect(
      opened.store.write((sql) =>
        sql.run("UPDATE artifacts SET digest = $digest WHERE artifact_id = $id", {
          digest: historyDigest("changed bytes"),
          id: `checkpoint-${preview.candidateId}`,
        }),
      ).ok,
    ).toBe(true);
    expect(
      await f.action.run({ action: "inspect", candidateId: preview.candidateId }, f.resources),
    ).toMatchObject({ kind: "refused", reason: "corrupt", effect: "none" });
  } finally {
    await opened.store.close();
  }
});
