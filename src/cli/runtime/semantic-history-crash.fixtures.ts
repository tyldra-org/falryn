/** Subprocess fixture for abrupt exits at semantic publication boundaries. */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProductResources } from "../../application/orchestration/product-resources.ts";
import { createTurnEventJournal } from "../../application/runtime/turn-event-journal.ts";
import { createSessionHistory, historyDigest } from "../../application/sessions/session-history.ts";
import { artifactId } from "../../domain/artifacts/index.ts";
import {
  configurationGeneration,
  createStaticEnvironment,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import type { HistoryReference } from "../../domain/sessions/history.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { createServiceProvider } from "./services.ts";

async function run(home: string, stage: string) {
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
  const opened = await openProductArtifactSession(services);
  if (!opened) throw new Error("crash fixture storage");
  const durable = opened;
  const correlation = {
    sessionId: sessionId.from("history-session"),
    workspaceId: workspaceId.from("history-workspace"),
    traceId: traceId.from("history-trace"),
    configurationGeneration: configurationGeneration.from(0),
  };
  const journal = createTurnEventJournal({
    eventStore: durable.eventStore,
    clock: services.clock,
    streamId: streamId.from("history-stream"),
    correlation,
  });
  const history = createSessionHistory({ journal, correlation, artifacts: durable.artifacts });
  const resources = createProductResources(services.clock).openTask("0");
  const references: HistoryReference[] = [];
  async function retain(label: string, path: string) {
    const bytes = new Uint8Array(await readFile(join(home, path)));
    const saved = await durable.artifacts.ingest({
      artifactId: artifactId.from(label),
      mediaType: "text/plain",
      encoding: "identity",
      sensitivity: "user-content",
      origin: "tool-output",
      invocationId: null,
      declaredByteLength: bytes.length,
      content: (async function* () {
        yield bytes;
      })(),
    });
    if (!saved.ok) throw new Error("crash fixture seal");
    const record = saved.value.record;
    references.push({
      availability: "retained",
      artifactId: label,
      digest: String(record.digest),
      byteLength: record.byteLength,
      sensitivity: record.sensitivity,
      fidelity: "exact",
      mediaType: "text/plain",
    });
  }
  const point = {
    version: 1 as const,
    type: "restore-point" as const,
    generation: 0,
    restorePointId: "restore-files",
    restorePointVersion: 1 as const,
    attemptId: "attempt-files",
    scope: {
      kind: "paths" as const,
      pathDigests: ["overwritten.txt", "created.txt", "deleted.txt"].map(historyDigest),
    },
    capture: { fidelity: "exact" as const, pathCount: 3, artifactCount: 2, omissions: [] },
    operationId: "operation-files",
    rootId: "root-files",
    relations: [],
  };
  await retain("before-overwritten", "overwritten.txt");
  await retain("before-deleted", "deleted.txt");
  async function record(
    phase: "prepared" | "running" | "settled",
    effect: "none" | "completed",
    content: unknown,
  ) {
    const result = await history.record(
      turnId.from("history-turn"),
      {
        ...point,
        id: `restore-${phase}`,
        stage: phase,
        effect,
        references: [...references],
        capture: { ...point.capture, artifactCount: references.length },
      },
      JSON.stringify(content),
      resources,
    );
    if (!result.committed) throw new Error("crash fixture publication");
  }
  if (stage !== "sealed") {
    await record("prepared", "none", {
      files: [
        { path: "overwritten.txt", before: "before-overwritten" },
        { path: "created.txt", before: null },
        { path: "deleted.txt", before: "before-deleted" },
      ],
    });
    if (stage !== "prepared") {
      await writeFile(join(home, "overwritten.txt"), "observed replacement β\n");
      await writeFile(join(home, "created.txt"), "observed creation γ\n");
      await rm(join(home, "deleted.txt"));
      if (stage !== "mutated") {
        await retain("after-overwritten", "overwritten.txt");
        await retain("after-created", "created.txt");
        await record("running", "completed", {
          files: [
            { path: "overwritten.txt", after: "after-overwritten" },
            { path: "created.txt", after: "after-created" },
            { path: "deleted.txt", after: null },
          ],
          observation: "filesystem-read",
        });
        if (stage === "settled")
          await record("settled", "completed", { result: "observed three path changes" });
      }
    }
  }
  process.stdout.write("READY\n");
  setInterval(() => {}, 1000);
}
if (import.meta.main) {
  const home = process.argv[2];
  const stage = process.argv[3];
  if (!home || !stage || !["sealed", "prepared", "mutated", "observed", "settled"].includes(stage))
    throw new Error("crash fixture arguments");
  await run(home, stage);
}
