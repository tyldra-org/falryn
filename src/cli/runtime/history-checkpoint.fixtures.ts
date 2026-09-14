/** Real durable producer fixture shared with continuation acceptance (#952). */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductCheckpointAction } from "../../application/compression/product-checkpoint.ts";
import { createProductResources } from "../../application/orchestration/product-resources.ts";
import { createTurnEventJournal } from "../../application/runtime/turn-event-journal.ts";
import { createSessionHistory, historyDigest } from "../../application/sessions/session-history.ts";
import type { CheckpointAuthority } from "../../domain/compression/history-projection.ts";
import {
  configurationGeneration,
  createStaticEnvironment,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { createServiceProvider } from "./services.ts";

export async function createCheckpointFixture(existingHome?: string) {
  const cleanups: (() => Promise<unknown>)[] = [];
  const home = existingHome ?? (await mkdtemp(join(tmpdir(), "falryn-checkpoint-")));
  if (!existingHome) cleanups.push(() => rm(home, { recursive: true, force: true }));
  const services = createServiceProvider(
    {
      color: "never",
      format: "json",
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
      currentDirectory: localPath(home),
      environment: createStaticEnvironment({
        FALRYN_STATE_DIR: join(home, "state"),
        FALRYN_CONFIG_DIR: join(home, "config"),
      }),
    },
  )();
  const durable = await openProductArtifactSession(services);
  if (!durable) throw new Error("durable store missing");
  cleanups.push(() => durable.close());
  const correlation = {
    sessionId: sessionId.from("checkpoint-session"),
    workspaceId: workspaceId.from("checkpoint-workspace"),
    traceId: traceId.from("checkpoint-trace"),
    configurationGeneration: configurationGeneration.from(0),
  };
  const stream = streamId.from("checkpoint-stream");
  const turn = turnId.from("checkpoint-turn");
  const journal = createTurnEventJournal({
    eventStore: durable.eventStore,
    clock: services.clock,
    streamId: stream,
    correlation,
  });
  if (!existingHome)
    await journal.persist([
      { kind: "session.started", correlation },
      { kind: "turn.started", correlation: { ...correlation, turnId: turn } },
    ]);
  const resources = createProductResources(services.clock).openTask("0");
  cleanups.push(async () => resources.close());
  const history = createSessionHistory({ journal, correlation, artifacts: durable.artifacts });
  const text =
    "Keep correction α, active skill, open task, uncertain effect, and unconsumed result.\n".repeat(
      80,
    );
  if (!existingHome)
    for (const id of ["first", "second"])
      await history.record(
        turn,
        {
          version: 1,
          type: "message",
          id,
          messageId: id,
          generation: 0,
          part: 0,
          role: "user",
          attemptId: null,
          completion: "complete",
          relations: [],
        },
        text,
        resources,
      );
  if (!existingHome) {
    const settled = await journal.persist([
      {
        kind: "turn.completed",
        correlation: { ...correlation, turnId: turn },
        outcome: { kind: "completed" },
      },
    ]);
    if (settled.kind !== "persisted") throw new Error("fixture settlement failed");
  }
  const authority: CheckpointAuthority = {
    model: "fixture/main",
    configurationGeneration: 0,
    policyGeneration: 0,
    instructionDigest: historyDigest("instructions"),
    protectedRequest: "instructions",
    contextGeneration: "0",
    contextWindowTokens: 128000,
    systemAndSkillsTokens: 1000,
    freshToolsTokens: 1000,
    freshResultsTokens: 1000,
    modalityTokens: 0,
    reservedOutputTokens: 8192,
    reservedContinuationTokens: 8192,
  };
  let authorized = true;
  const ports = {
    events: durable.eventStore,
    artifacts: durable.artifacts,
    streamId: stream,
    correlation,
    journal,
    clock: services.clock,
    authority: () => authority,
    settled: () => true,
    durable: true,
    authorize: () => authorized,
  };
  return {
    async close() {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    },
    home,
    services,
    durable,
    correlation,
    stream,
    turn,
    journal,
    resources,
    history,
    text,
    authority,
    ports,
    revoke() {
      authorized = false;
    },
    action: createProductCheckpointAction(ports),
  };
}
