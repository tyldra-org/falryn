import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { taskStream } from "../../data/orchestration/process-task-records.ts";
import { sqliteDatabasePath } from "../../data/sqlite/sqlite-store.ts";
import {
  configurationGeneration,
  createStaticEnvironment,
  instant,
  providerId,
  streamId,
} from "../../domain/foundation/index.ts";
import {
  type ProcessTaskReceipt,
  processTaskReceiptSchema,
} from "../../domain/orchestration/process-task.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { createOwnedProcessRegistry } from "../../integrations/process/host-owned-process-registry.ts";
import { openBunSqlite } from "../../integrations/storage/bun-sqlite.ts";
import {
  catalogFromAdapterModels,
  createDeterministicProviderAdapter,
  type ModelRequest,
} from "../../providers/index.ts";
import { snapshotOf } from "../../tui/composer/index.ts";
import { LIVE_TURN_MATRIX_CONFIRMATION } from "../live-turn-matrix.test-support.ts";
import type { GlobalOptions } from "../options.ts";
import { resultEvents } from "../output/result-events.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { runCoding } from "./coding-run.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { composeProductShellAttachments } from "./product-shell-attachments.ts";
import { createServiceProvider } from "./services.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const nativeTest = process.platform === "linux" || process.platform === "darwin" ? test : test.skip;

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "falryn-task-host-"));
  homes.push(home);
  const primary = join(home, "workspace");
  for (const path of [primary, join(home, "state"), join(home, "config")]) {
    await mkdir(path);
    await chmod(path, 0o700);
  }
  const globals: GlobalOptions = {
    format: "human",
    color: "never",
    quiet: false,
    verbose: false,
    nonInteractive: true,
    workspace: primary,
    addDirs: [],
    profile: null,
    timeoutMs: null,
    help: false,
    version: false,
  };
  const services = createServiceProvider(globals, {
    home: localPath(home),
    platform: "darwin",
    currentDirectory: localPath(primary),
    environment: createStaticEnvironment({
      FALRYN_STATE_DIR: join(home, "state"),
      FALRYN_CONFIG_DIR: join(home, "config"),
    }),
  });
  return { home, primary, globals, services };
}

function receipt(request: ModelRequest): ProcessTaskReceipt {
  const part = request.messages
    .findLast((message) => message.role === "tool")
    ?.parts.find((part) => part.kind === "text");
  if (part?.kind !== "text") throw new Error("missing task continuation");
  return z
    .object({ output: z.object({ value: processTaskReceiptSchema }) })
    .parse(JSON.parse(part.text)).output.value;
}

function scripted(gate: string, attachment: "foreground" | "background", timeoutMs = 10_000) {
  const requests: ModelRequest[] = [];
  let handle: ProcessTaskReceipt | null = null;
  const provider = createDeterministicProviderAdapter({
    onRequest: (request) => requests.push(request),
    script(request, index) {
      if (index === 0)
        return {
          kind: "tool",
          toolCallId: "start-background",
          name: "run_process",
          argumentFragments: [
            JSON.stringify({
              executable: "/bin/sh",
              argv: [
                "-c",
                'printf ready; while [ ! -f "$1" ]; do sleep 0.01; done; printf done',
                "sh",
                gate,
              ],
              environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
              outputMode: "raw",
              timeoutMs,
              execution: {
                version: 1,
                attachment,
                foregroundWaitMs: 1,
                onSettle: "notify",
                shutdown: "drain",
              },
            }),
          ],
        };
      if (attachment === "foreground" && index === 1) {
        handle = receipt(request);
        return {
          kind: "tool",
          toolCallId: "detach-background",
          name: "process_task",
          argumentFragments: [
            JSON.stringify({
              ...handle.handle,
              operation: "detach",
              expectedRevision: handle.revision,
            }),
          ],
        };
      }
      handle = receipt(request);
      return {
        kind: "text",
        text: "Task is running; result is not yet available.",
        finishReason: "stop",
      };
    },
  });
  return {
    provider,
    requests,
    get receipt() {
      if (handle === null) throw new Error("missing receipt");
      return handle;
    },
  };
}

describe("durable process tasks in product hosts", () => {
  nativeTest.each(["run-end", "checkpoint"] as const)(
    "host drain reports failed %s",
    async (failure) => {
      const f = await setup();
      const { registry } = createOwnedProcessRegistry();
      const durable = await openProductArtifactSession(f.services(), undefined, registry);
      if (durable === null) throw new Error("durable session unavailable");
      const path = sqliteDatabasePath(localPath(join(f.home, "state")));
      if (path === null) throw new Error("database path unavailable");
      const opened = openBunSqlite({ path, create: false });
      if (!opened.ok) throw new Error("second connection unavailable");
      const db = opened.value;
      try {
        if (failure === "run-end") {
          db.run(
            "CREATE TRIGGER fail_run_end BEFORE UPDATE OF ended_at ON runs BEGIN SELECT RAISE(ABORT, 'test run end failure'); END",
          );
        } else {
          db.run("BEGIN");
          db.all("SELECT * FROM runs");
        }
        expect(await registry.drain()).toBe(false);
        expect(await durable.close()).toBe(false);
      } finally {
        if (failure === "checkpoint") db.run("ROLLBACK");
        await db.close();
        await durable.close();
      }
    },
    20_000,
  );
  for (const attachment of ["background", "foreground"] as const) {
    nativeTest(
      `headless ${attachment} receipt finishes the model response before normal task/store drain`,
      async () => {
        const f = await setup();
        const gate = join(f.home, "release");
        const scriptedTask = scripted(gate, attachment);
        const owned = createOwnedProcessRegistry();
        try {
          const result = await runCoding(
            f.services,
            { promptParts: ["Run a background shell process and detach it. Use process_task."] },
            {
              input: createRecordingCliStreams({ stdin: null }).input,
              globals: f.globals,
              providerAdapter: scriptedTask.provider,
              toolConfirmation: LIVE_TURN_MATRIX_CONFIRMATION,
              ownedProcesses: owned.registry,
            },
          );
          if (result.payload?.stage !== "attempt-completed")
            throw new Error(
              JSON.stringify({
                events: resultEvents(result)
                  ?.filter((event) => event.kind === "capability.invocation.completed")
                  .map((event) => ({ payload: event.payload, capabilityId: event.capabilityId })),
              }),
            );
          expect(result.payload?.stage).toBe("attempt-completed");
          expect(result.payload?.response).toContain("Task is running");
          expect(scriptedTask.receipt.state).not.toBe("terminal");
          expect(scriptedTask.receipt.attachment).toBe("background");
          expect(scriptedTask.requests[0]?.tools.map((tool) => tool.name)).toContain(
            "process_task",
          );
          // A second connection sees the committed, still-running task, without adopting it.
          const observer = await openProductArtifactSession(f.services());
          if (observer === null) throw new Error("observer storage unavailable");
          expect(
            observer.taskRecovery.some(
              (task) =>
                task.handle.taskId === scriptedTask.receipt.handle.taskId &&
                task.supervisor === "live",
            ),
          ).toBe(true);
          await observer.close();
          await writeFile(gate, "release");
          expect(await owned.registry.drain()).toBe(true);
          const reopened = await openProductArtifactSession(f.services());
          if (reopened === null) throw new Error("reopen unavailable");
          expect(
            reopened.taskRecovery.some(
              (task) =>
                task.handle.taskId === scriptedTask.receipt.handle.taskId &&
                task.supervisor === "sealed",
            ),
          ).toBe(true);
          await reopened.close();
          expect(scriptedTask.requests).toHaveLength(attachment === "foreground" ? 3 : 2);
        } finally {
          await writeFile(gate, "release");
          await owned.registry.drain();
        }
      },
    );
  }

  nativeTest(
    "interactive submission returns while detached work lives, then receives its sealed notify-only event",
    async () => {
      const f = await setup();
      const gate = join(f.home, "release");
      const scriptedTask = scripted(gate, "background");
      const graph = f.services();
      const workspace = await graph.ensureWorkspaceSet();
      if (!workspace.ok) throw new Error("workspace unavailable");
      const durable = await openProductArtifactSession(graph);
      if (durable === null) throw new Error("storage unavailable");
      const provider = scriptedTask.provider;
      const catalog = catalogFromAdapterModels(provider.supportedModels, {
        generation: 1,
        fetchedAt: instant(0),
        capabilities: provider.modelCapabilities,
      });
      const model = provider.supportedModels[0];
      if (model === undefined) throw new Error("model unavailable");
      const index = await durable.openWorkspaceIndex(localPath(f.primary));
      if (index === null) throw new Error("index unavailable");
      const attachments = await composeProductShellAttachments({
        eventStore: durable.eventStore,
        clock: graph.clock,
        fileSystem: graph.fileSystem,
        workspaceSet: workspace.value.set,
        configurationGeneration: configurationGeneration.from(0),
        artifacts: durable.artifacts,
        loom: durable.loom,
        scratch: durable.scratch,
        tasks: durable.tasks,
        taskNotices: durable.taskNotices,
        memoryRecords: durable.memoryRecords,
        toolConfirmation: LIVE_TURN_MATRIX_CONFIRMATION,
        index,
        provider: {
          kind: "ready",
          adapter: provider,
          session: {
            kind: "ready",
            catalog,
            connection: {
              account: null,
              updatedAt: graph.clock.now(),
              profile: {
                profileId: provider.identity.profileId,
                providerId: providerId.from("falryn-deterministic"),
                adapterKind: "deterministic",
                displayName: "Tasks",
                endpoint: null,
                credential: null,
                organization: null,
                project: null,
                enabledModels: [model],
                transportCompatibility: null,
                modelCapabilities: [],
                discovery: "static",
                timeouts: { connectMs: 1_000, requestMs: 10_000 },
              },
            },
            auth: {
              profileId: provider.identity.profileId,
              state: "ready",
              consumer: "provider:tasks",
              observedAt: instant(0),
              health: null,
              code: null,
              retryable: false,
            },
          },
        },
      });
      if (attachments === null) throw new Error("attachments unavailable");
      let notifications = 0;
      const unsubscribe = attachments.transcriptFeed.subscribe(() => {
        if (
          attachments.transcriptFeed.events().some((event) => event.kind === "process.task.changed")
        )
          notifications++;
      });
      try {
        const result = await attachments.submission.submit(
          snapshotOf("Run a background shell process and use process_task to inspect it.", 1),
        );
        expect(result.kind).toBe("accepted");
        expect(durable.tasks.report().active).toBe(1);
        expect(notifications).toBe(0);
        await writeFile(gate, "release");
        expect((await durable.tasks.drain()).ok).toBe(true);
        expect(notifications).toBe(1);
        const terminal = attachments.transcriptFeed
          .events()
          .find((event) => event.kind === "process.task.changed");
        expect(terminal?.payload).toMatchObject({
          change: "sealed",
          task: { state: "terminal", terminal: { outcome: "completed" } },
        });
        expect(JSON.stringify(terminal)).not.toContain("readydone");
        expect(scriptedTask.requests).toHaveLength(2);
      } finally {
        unsubscribe();
        await writeFile(gate, "release");
        await durable.close();
      }
    },
  );

  for (const stop of ["interrupt", "deadline"] as const) {
    nativeTest(`headless ${stop} seals the real task before store closure`, async () => {
      const f = await setup();
      const gate = join(f.home, "release");
      const scriptedTask = scripted(gate, "background", stop === "deadline" ? 250 : 10_000);
      const owned = createOwnedProcessRegistry();
      const controller = new AbortController();
      try {
        await runCoding(
          f.services,
          { promptParts: ["Run a background shell process."] },
          {
            input: createRecordingCliStreams({ stdin: null }).input,
            globals: f.globals,
            providerAdapter: scriptedTask.provider,
            toolConfirmation: LIVE_TURN_MATRIX_CONFIRMATION,
            ownedProcesses: owned.registry,
            signal: controller.signal,
          },
        );
        if (stop === "interrupt") controller.abort();
        expect(await owned.registry.drain()).toBe(true);
        const reopened = await openProductArtifactSession(f.services());
        if (reopened === null) throw new Error("reopen unavailable");
        try {
          const events = await reopened.eventStore.readFrom(
            {
              streamId: streamId.from(taskStream(scriptedTask.receipt.handle)),
              afterSequence: null,
            },
            10,
          );
          if (!events.ok) throw new Error("events unavailable");
          const terminal = events.value.findLast(
            (event) =>
              event.kind === "process.task.changed" && event.payload.task.state === "terminal",
          );
          expect(terminal?.payload).toMatchObject({
            task: {
              state: "terminal",
              terminal: { outcome: stop === "interrupt" ? "cancelled" : "timed-out" },
            },
          });
          expect(scriptedTask.requests).toHaveLength(2);
        } finally {
          await reopened.close();
        }
      } finally {
        controller.abort();
        await writeFile(gate, "release");
        await owned.registry.drain();
      }
    });
  }
});
