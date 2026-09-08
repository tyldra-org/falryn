import { afterEach, describe, expect, test } from "bun:test";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { processTaskChanged } from "../../domain/fixtures.ts";
import { configurationGeneration, invocationId, streamId } from "../../domain/foundation/index.ts";
import { processTaskReceiptSchema } from "../../domain/orchestration/process-task.ts";
import type { ToolInvocationOutcome } from "../../domain/tools/index.ts";
import { createToolHookRegistry } from "../../domain/tools/index.ts";
import { createHostProcessCapturePort } from "../../integrations/process/host-process-capture.ts";
import { createProcessTaskFixture, taskValue } from "../orchestration/process-task.fixtures.ts";
import { createProcessTaskSupervisor } from "../orchestration/process-task-supervisor.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import { createTurnEventJournal } from "../runtime/turn-event-journal.ts";
import { createProductToolGateway } from "./product-tool-gateway.ts";
import { composeProductProcessTools } from "./product-tools-process.ts";

afterEach(removeTemporaryRoots);
const nativeTest = process.platform === "linux" || process.platform === "darwin" ? test : test.skip;
const execution = {
  version: 1,
  attachment: "background",
  foregroundWaitMs: 1,
  onSettle: "notify",
  shutdown: "drain",
};

function projected(outcome: ToolInvocationOutcome) {
  if (outcome.status !== "completed") throw new Error(`tool failed: ${JSON.stringify(outcome)}`);
  return outcome.output.value;
}

describe("process tasks through the product gateway", () => {
  nativeTest(
    "returns a nonterminal launch result while retaining effects, and admits controls in reserved capacity",
    async () => {
      const f = await createProcessTaskFixture(false);
      const generation = configurationGeneration.from(0);
      const correlation = processTaskChanged().correlation;
      const resources = createProductResources(f.clock, { maxConcurrent: 2 });
      const parent = resources.openTask("0");
      const controlParent = resources.openTask("0");
      const native = createHostProcessCapturePort({ artifacts: f.artifacts, clock: f.clock });
      const started = Promise.withResolvers<void>();
      const notifications: string[] = [];
      let launches = 0;
      const supervisor = createProcessTaskSupervisor({
        store: f.tasks,
        artifacts: f.artifacts,
        clock: f.clock,
        runId: "gateway-task-run",
        process: f.snapshot.supervisor.process,
        async notify(notice) {
          notifications.push(JSON.stringify(notice));
          return true;
        },
      });
      const tools = composeProductProcessTools({
        generation,
        tasks: supervisor,
        artifacts: f.artifacts,
        sessionId: f.snapshot.owner.sessionId,
        workspaceId: f.snapshot.owner.workspaceId,
        capture: {
          supportsOwnership: true,
          run(request, listener) {
            launches++;
            const ownership = request.ownership;
            return native.run(
              {
                ...request,
                ...(ownership === undefined
                  ? {}
                  : {
                      ownership: {
                        ...ownership,
                        async started(handle) {
                          await ownership.started(handle);
                          started.resolve();
                        },
                      },
                    }),
              },
              listener,
            );
          },
        },
      });
      const journal = createTurnEventJournal({
        eventStore: f.events,
        clock: f.clock,
        correlation,
        streamId: streamId.from("gateway-process-tasks"),
      });
      const hooks = taskValue(createToolHookRegistry(generation, []));
      const base = {
        clock: f.clock,
        resources,
        registry: tools.registry,
        runner: tools.runner,
        hooks,
        journal,
        correlation,
        turnId: correlation.turnId,
        disclosedToolNames: new Set(tools.toolNames),
        confirmation: {
          resolve: async (request: { confirmationId: string }) => ({
            kind: "confirmed" as const,
            confirmationId: request.confirmationId,
          }),
        },
      };
      const launchGateway = createProductToolGateway({
        ...base,
        taskResources: parent,
        attemptId: "attempt-launch",
        effectLedger: new Map(),
      });
      const controls = createProductToolGateway({
        ...base,
        taskResources: controlParent,
        attemptId: "attempt-control",
        effectLedger: new Map(),
      });
      const runEntry = tools.registry.resolveByName("run_process");
      const controlEntry = tools.registry.resolveByName("process_task");
      if (runEntry === null || controlEntry === null) throw new Error("process tools absent");
      let sequence = 0;
      const control = (input: Readonly<Record<string, unknown>>) =>
        controls.execute({
          invocationId: invocationId.from(`control-${++sequence}`),
          toolCallId: `call-control-${sequence}`,
          toolName: "process_task",
          capabilityId: controlEntry.manifest.capabilityId,
          version: 1,
          effect: "mutation",
          input,
          signal: new AbortController().signal,
        });
      try {
        const launch = await launchGateway.execute({
          invocationId: invocationId.from("invocation-fixture"),
          toolCallId: "call-launch",
          toolName: "run_process",
          capabilityId: runEntry.manifest.capabilityId,
          version: 1,
          effect: "mutation",
          input: {
            executable: "/bin/sh",
            argv: ["-c", "printf ready; exec sleep 30"],
            environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
            outputMode: "raw",
            execution,
          },
          signal: new AbortController().signal,
        });
        const initial = processTaskReceiptSchema.parse(projected(launch));
        expect(initial.state).not.toBe("terminal");
        expect(initial.owner.attemptId).toBe("attempt-launch");
        await started.promise;
        parent.close();
        expect(resources.report().scheduler.running).toBe(1);
        const inspected = processTaskReceiptSchema.parse(
          projected(await control({ ...initial.handle, operation: "inspect" })),
        );
        expect(inspected.state).toBe("running");
        expect(resources.report().scheduler.running).toBe(1);
        const stopped = projected(
          await control({
            ...initial.handle,
            operation: "kill",
            expectedRevision: inspected.revision,
          }),
        );
        expect(stopped).toMatchObject({ kind: "process-task-stop-requested", operation: "kill" });
        expect((await supervisor.drain()).ok).toBe(true);
        const task = taskValue(f.tasks.get(initial.handle));
        expect(task.terminal).toMatchObject({ outcome: "cancelled", signal: "SIGKILL" });
        expect(launches).toBe(1);
        expect(resources.report().uncertain).toBe(0);
        expect(notifications).toHaveLength(1);
        expect(notifications[0]).not.toContain("ready");
        expect(notifications[0]).not.toContain("sleep");
        const completions = taskValue(
          f.database.read(
            "SELECT event_id FROM events WHERE kind = 'capability.invocation.completed'",
          ),
        );
        expect(completions).toHaveLength(3);
      } finally {
        supervisor.interrupt();
        await supervisor.drain();
        parent.close();
        controlParent.close();
        await f.close();
      }
    },
  );

  test("unqualified detached ownership is refused before capture without hiding the control declaration", async () => {
    const f = await createProcessTaskFixture();
    let launches = 0;
    const supervisor = createProcessTaskSupervisor({
      store: f.tasks,
      artifacts: f.artifacts,
      clock: f.clock,
      runId: "unsupported-host",
      process: null,
    });
    const native = createHostProcessCapturePort();
    const tools = composeProductProcessTools({
      generation: configurationGeneration.from(0),
      tasks: supervisor,
      capture: {
        supportsOwnership: false,
        run(request) {
          launches++;
          return native.run(request);
        },
      },
    });
    const entry = tools.registry.resolveByName("run_process");
    if (entry === null) throw new Error("process tool absent");
    try {
      const result = await tools.runner.execute({
        invocationId: invocationId.from("invocation-fixture"),
        toolCallId: "unsupported",
        toolName: "run_process",
        capabilityId: entry.manifest.capabilityId,
        version: 1,
        effect: "mutation",
        input: { executable: "/bin/echo", argv: ["must-not-spawn"], execution },
        signal: new AbortController().signal,
      });
      expect(result.status).toBe("unavailable");
      expect(launches).toBe(0);
      expect(tools.registry.resolveByName("process_task")).not.toBeNull();
      expect(taskValue(f.tasks.list())).toEqual([]);
    } finally {
      await supervisor.drain();
      await f.close();
    }
  });
});
