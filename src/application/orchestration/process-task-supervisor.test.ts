import { afterEach, describe, expect, test } from "bun:test";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { capabilityInvocationStarted } from "../../domain/fixtures.ts";
import { duration, invocationId } from "../../domain/foundation/index.ts";
import { err } from "../../domain/foundation/result.ts";
import {
  type ProcessTaskExecution,
  processTaskReceiptSchema,
} from "../../domain/orchestration/process-task.ts";
import { NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import type { ToolInvocationOutcome } from "../../domain/tools/index.ts";
import { createHostProcessCapturePort } from "../../integrations/process/host-process-capture.ts";
import type { ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import { createProcessTaskFixture, taskValue } from "./process-task.fixtures.ts";
import {
  createProcessTaskSupervisor,
  type ProcessTaskNotification,
  type ProcessTaskSupervisorOptions,
} from "./process-task-supervisor.ts";
import { createProductResources } from "./product-resources.ts";

afterEach(removeTemporaryRoots);
const ownedTest = process.platform === "linux" || process.platform === "darwin" ? test : test.skip;
const execution: ProcessTaskExecution = {
  version: 1,
  attachment: "background",
  foregroundWaitMs: 10,
  onSettle: "notify",
  shutdown: "drain",
};

async function harness(
  decorate?: (options: ProcessTaskSupervisorOptions) => ProcessTaskSupervisorOptions,
) {
  const f = await createProcessTaskFixture();
  const notices: ProcessTaskNotification[] = [];
  const resourceOwner = createProductResources(f.clock);
  const parent = resourceOwner.openTask("0");
  const supervisorOptions: ProcessTaskSupervisorOptions = {
    store: f.tasks,
    artifacts: f.artifacts,
    clock: f.clock,
    runId: "run-supervisor",
    process: f.snapshot.supervisor.process,
    async notify(notice) {
      expect(taskValue(f.tasks.get(notice.task.handle)).state).toBe("terminal");
      expect(taskValue(f.tasks.wake(notice.task.handle)).terminalEventId).toBe(
        notice.wake.terminalEventId,
      );
      notices.push(notice);
      return true;
    },
  };
  const supervisor = createProcessTaskSupervisor(
    decorate?.(supervisorOptions) ?? supervisorOptions,
  );
  const request: ToolRunnerRequest = {
    invocationId: invocationId.from("invocation-fixture"),
    toolCallId: "call-fixture",
    toolName: "run_process",
    capabilityId: capabilityInvocationStarted().capabilityId,
    version: 1,
    effect: "external",
    input: {},
    signal: new AbortController().signal,
    taskResources: parent,
    processTask: {
      owner: { ...f.snapshot.owner, resourceTaskId: parent.id },
      publishReceipt: () => false,
    },
  };
  const started = Promise.withResolvers<void>();
  let launches = 0;
  const capture = createHostProcessCapturePort({ artifacts: f.artifacts, clock: f.clock });
  const launch = (script: string, mode = execution) =>
    parent.execute<ToolInvocationOutcome>({
      operation: "invocation-fixture",
      attempt: "attempt-fixture",
      generation: "0",
      inputBytes: script.length,
      amounts: {},
      unit: {
        id: workUnitId("process-fixture"),
        effect: "external",
        priority: "active-turn",
        conflictKeys: [],
        dependencies: [],
        deadline: null,
        expectedOutputBytes: 65_536,
        retry: NO_RETRY,
        scopeId: null,
      },
      signal: request.signal,
      async run(signal, publishReceipt) {
        const value = await supervisor.run({
          request: {
            ...request,
            signal,
            processTask: { owner: request.processTask?.owner ?? f.snapshot.owner, publishReceipt },
          },
          execution: mode,
          timeoutMs: 5_000,
          outputMode: "raw",
          async run(ownership, signal) {
            launches++;
            const result = await capture.run({
              executable: "/bin/sh",
              argv: ["-c", script],
              environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
              timeoutMs: duration(5_000),
              maxOutputBytes: 65_536,
              invocationId: request.invocationId,
              retainChunkEvents: false,
              signal,
              ownership: {
                ...ownership,
                async started(native) {
                  await ownership.started(native);
                  started.resolve();
                },
              },
            });
            return result.ok
              ? {
                  capture: result.value,
                  outcome: {
                    status: "completed" as const,
                    effect: "completed" as const,
                    output: {
                      stdout: result.value.stdout.inlineText?.slice(0, 1_024),
                      exitCode: result.value.exit.exitCode,
                    },
                  },
                }
              : {
                  capture: null,
                  outcome: {
                    status: "unavailable" as const,
                    effect: "none" as const,
                    reason: result.error.code,
                  },
                };
          },
        });
        // This fixture's native capture promise has joined the actual child, even on cancellation.
        return { value, terminated: true };
      },
    });
  return {
    ...f,
    parent,
    resourceOwner,
    request,
    supervisor,
    launch,
    notices,
    started: started.promise,
    launches: () => launches,
    async close() {
      supervisor.interrupt();
      await supervisor.drain();
      parent.close();
      await f.close();
    },
  };
}

function receipt(outcome: ToolInvocationOutcome) {
  if (outcome.status !== "completed")
    throw new Error(`expected receipt: ${JSON.stringify(outcome)}`);
  return processTaskReceiptSchema.parse(outcome.output);
}

describe("captured task supervisor", () => {
  ownedTest(
    "cancelled capture with failed pending ingest seals incomplete uncertainty",
    async () => {
      const pending = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let first = true;
      const f = await harness((options) => ({
        ...options,
        artifacts: {
          ...options.artifacts,
          async ingest(request, signal) {
            if (!first) return options.artifacts.ingest(request, signal);
            first = false;
            pending.resolve();
            await release.promise;
            return err({ kind: "artifact", code: "cancelled", artifactId: request.artifactId });
          },
        },
      }));
      try {
        const admitted = await f.launch(
          "dd if=/dev/zero bs=65536 count=1 2>/dev/null; exec sleep 30",
        );
        if (admitted.kind !== "completed") throw new Error("admission failed");
        await pending.promise;
        f.supervisor.interrupt();
        release.resolve();
        await f.supervisor.drain();
        expect(taskValue(f.tasks.get(receipt(admitted.value).handle)).terminal).toMatchObject({
          outcome: "uncertain",
          effect: "uncertain",
          outputComplete: false,
        });
      } finally {
        release.resolve();
        await f.close();
      }
    },
  );

  ownedTest("inline overflow does not mark fully retained task logs incomplete", async () => {
    const f = await harness();
    try {
      const admitted = await f.launch(
        "i=0; while [ $i -lt 10000 ]; do printf '1234567890\\n'; i=$((i+1)); done",
      );
      if (admitted.kind !== "completed") throw new Error("admission failed");
      await f.supervisor.drain();
      const handle = receipt(admitted.value).handle;
      expect(taskValue(f.tasks.get(handle)).terminal).toMatchObject({
        outcome: "completed",
        outputComplete: true,
      });
      const last = await f.supervisor.control(f.request, {
        ...handle,
        operation: "logs",
        stream: "stdout",
        offset: 109989,
        limit: 11,
      });
      expect(last).toMatchObject({
        status: "completed",
        output: { data: "1234567890\n", complete: true },
      });
    } finally {
      await f.close();
    }
  });
  ownedTest("failed reattachment preserves the original cancellation owner", async () => {
    const f = await harness((options) => ({
      ...options,
      store: {
        ...options.store,
        transition: (fence, change, now, signal) =>
          change.kind === "attachment"
            ? err({ code: "storage-unavailable" })
            : options.store.transition(fence, change, now, signal),
      },
    }));
    const replacement = f.resourceOwner.openTask("0");
    try {
      const admitted = await f.launch("printf ready; exec sleep 30", {
        ...execution,
        attachment: "foreground",
      });
      if (admitted.kind !== "completed") throw new Error("admission failed");
      await f.started;
      const task = taskValue(f.tasks.get(receipt(admitted.value).handle));
      const result = await f.supervisor.control(
        { ...f.request, taskResources: replacement },
        {
          ...task.handle,
          operation: "reattach",
          expectedRevision: task.revision,
        },
      );
      expect(result).toMatchObject({
        status: "unavailable",
        effect: "none",
        reason: "process-task-storage-unavailable",
      });
      expect(taskValue(f.tasks.get(task.handle)).attachment).toBe("foreground");
      f.parent.close();
      await f.supervisor.drain();
      expect(taskValue(f.tasks.get(task.handle)).terminal?.outcome).toBe("cancelled");
    } finally {
      replacement.close();
      await f.close();
    }
  });

  ownedTest("failed launch commit starts no capture and issues no receipt", async () => {
    const f = await harness((options) => ({
      ...options,
      store: { ...options.store, create: () => err({ code: "storage-unavailable" }) },
    }));
    try {
      const result = await f.launch("printf ready");
      if (result.kind !== "completed") throw new Error("admission failed");
      expect(result.value).toMatchObject({ status: "unavailable", effect: "none" });
      expect(f.launches()).toBe(0);
      expect(f.supervisor.report().active).toBe(0);
      expect(f.notices).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  ownedTest("failed terminal commit wakes waiters without a success or notification", async () => {
    const f = await harness((options) => ({
      ...options,
      store: {
        ...options.store,
        transition: (fence, change, now, signal) =>
          change.kind === "sealed"
            ? err({ code: "storage-unavailable" })
            : options.store.transition(fence, change, now, signal),
      },
    }));
    try {
      const result = await f.launch("printf ready; sleep 0.05");
      if (result.kind !== "completed") throw new Error("admission failed");
      const handle = receipt(result.value).handle;
      const waiting = f.supervisor.control(f.request, {
        ...handle,
        operation: "wait",
        waitMs: 1000,
      });
      expect((await f.supervisor.drain()).ok).toBe(false);
      expect(receipt(await waiting).state).toBe("settling");
      expect(f.notices).toHaveLength(0);
      expect(f.supervisor.report()).toEqual({ active: 0, waits: 0, failures: 1 });
    } finally {
      await f.close();
    }
  });
  ownedTest(
    "commits a receipt before returning and drains detached capture after its parent closes",
    async () => {
      const f = await harness();
      try {
        const admitted = await f.launch("printf ready; sleep 0.1; printf done");
        expect(admitted.kind).toBe("completed");
        if (admitted.kind !== "completed") throw new Error("admission failed");
        const control = receipt(admitted.value);
        expect(taskValue(f.tasks.get(control.handle)).handle).toEqual(control.handle);
        expect(control.state).not.toBe("terminal");
        await f.started;
        f.parent.close();
        expect(f.resourceOwner.report().tasks).toBe(1);
        const settled = await f.supervisor.control(f.request, {
          ...control.handle,
          operation: "wait",
          waitMs: 2_000,
        });
        expect(receipt(settled).terminal?.outcome).toBe("completed");
        expect((await f.supervisor.drain()).ok).toBe(true);
        expect(f.notices).toHaveLength(1);
        expect(taskValue(f.tasks.wake(control.handle)).state).toBe("acknowledged");
        expect(f.launches()).toBe(1);
        const logs = await f.supervisor.control(f.request, {
          ...control.handle,
          operation: "logs",
          stream: "stdout",
          offset: 0,
          limit: 32_768,
        });
        expect(logs.status).toBe("completed");
        if (logs.status === "completed")
          expect(logs.output).toMatchObject({ data: "readydone", exact: true, complete: true });
        expect(f.supervisor.report()).toEqual({ active: 0, waits: 0, failures: 0 });
      } finally {
        await f.close();
      }
    },
  );

  ownedTest(
    "foreground receipts do not authorize detachment; ending the parent cancels",
    async () => {
      const f = await harness();
      try {
        const admitted = await f.launch("printf ready; exec sleep 30", {
          ...execution,
          attachment: "foreground",
        });
        if (admitted.kind !== "completed") throw new Error("admission failed");
        const original = receipt(admitted.value);
        await f.started;
        f.parent.close();
        const detach = await f.supervisor.control(f.request, {
          ...original.handle,
          operation: "detach",
          expectedRevision: original.revision,
        });
        expect(detach.status).toBe("unavailable");
        await f.supervisor.drain();
        const task = taskValue(f.tasks.get(original.handle));
        expect(task.terminal?.outcome).toBe("cancelled");
        expect(task.terminal?.exitCode).not.toBe(0);
        expect(f.launches()).toBe(1);
      } finally {
        await f.close();
      }
    },
  );

  ownedTest(
    "detach and reattach keep the same task and native process without resetting its deadline",
    async () => {
      const f = await harness();
      try {
        const admitted = await f.launch("printf ready; exec sleep 30", {
          ...execution,
          attachment: "foreground",
        });
        if (admitted.kind !== "completed") throw new Error("admission failed");
        await f.started;
        const initial = taskValue(f.tasks.get(receipt(admitted.value).handle));
        const detached = receipt(
          await f.supervisor.control(f.request, {
            ...initial.handle,
            operation: "detach",
            expectedRevision: initial.revision,
          }),
        );
        f.parent.close();
        const nextParent = f.resourceOwner.openTask("0");
        const attached = await f.supervisor.control(
          { ...f.request, taskResources: nextParent },
          { ...initial.handle, operation: "reattach", expectedRevision: detached.revision },
        );
        expect(receipt(attached).attachment).toBe("foreground");
        expect(taskValue(f.tasks.get(initial.handle)).process).toEqual(initial.process);
        expect(receipt(attached).deadline).toBe(initial.deadline);
        nextParent.close();
        await f.supervisor.drain();
        expect(taskValue(f.tasks.get(initial.handle)).terminal?.outcome).toBe("cancelled");
        expect(f.launches()).toBe(1);
      } finally {
        await f.close();
      }
    },
  );

  ownedTest(
    "foreign handles and stale revisions never gain control; cancelled waits do not cancel capture",
    async () => {
      const f = await harness();
      try {
        const admitted = await f.launch("printf ready; exec sleep 30");
        if (admitted.kind !== "completed") throw new Error("admission failed");
        await f.started;
        const task = taskValue(f.tasks.get(receipt(admitted.value).handle));
        const foreign = {
          ...f.request,
          processTask: {
            owner: { ...task.owner, sessionId: "foreign" },
            publishReceipt: () => false,
          },
        };
        expect(
          (
            await f.supervisor.control(foreign, {
              ...task.handle,
              operation: "kill",
              expectedRevision: task.revision,
            })
          ).status,
        ).toBe("unavailable");
        expect(
          (
            await f.supervisor.control(f.request, {
              ...task.handle,
              operation: "kill",
              expectedRevision: task.revision - 1,
            })
          ).status,
        ).toBe("unavailable");
        const abort = new AbortController();
        const waiting = f.supervisor.control(
          { ...f.request, signal: abort.signal },
          { ...task.handle, operation: "wait", waitMs: 30_000 },
        );
        abort.abort();
        expect((await waiting).status).toBe("unavailable");
        expect(f.supervisor.report().waits).toBe(0);
        expect(taskValue(f.tasks.get(task.handle)).state).toBe("running");
        expect(
          (
            await f.supervisor.control(f.request, {
              ...task.handle,
              operation: "kill",
              expectedRevision: task.revision,
            })
          ).status,
        ).toBe("completed");
        await f.supervisor.drain();
        expect(taskValue(f.tasks.get(task.handle)).terminal?.signal).toBe("SIGKILL");
      } finally {
        await f.close();
      }
    },
  );

  ownedTest(
    "notification retries preserve one durable identity and stop at three attempts",
    async () => {
      const ids: string[] = [];
      const f = await harness((options) => ({
        ...options,
        async notify(notice) {
          ids.push(notice.wake.notificationId);
          return false;
        },
      }));
      try {
        const admitted = await f.launch("printf ready");
        if (admitted.kind !== "completed") throw new Error("admission failed");
        const handle = receipt(admitted.value).handle;
        await f.supervisor.drain();
        expect(ids).toHaveLength(3);
        expect(new Set(ids).size).toBe(1);
        expect(taskValue(f.tasks.wake(handle))).toMatchObject({
          attempts: 3,
          state: "unavailable",
        });
        await f.supervisor.deliver(taskValue(f.tasks.get(handle)));
        expect(ids).toHaveLength(3);
        const inspected = receipt(
          await f.supervisor.control(f.request, { ...handle, operation: "inspect" }),
        );
        expect(inspected.notification).toMatchObject({
          state: "unavailable",
          attempts: 3,
          notificationId: ids[0],
        });
      } finally {
        await f.close();
      }
    },
  );

  ownedTest("renewal failure stops the producer and seals uncertainty", async () => {
    const f = await harness((options) => ({
      ...options,
      store: { ...options.store, renew: () => err({ code: "storage-unavailable" }) },
    }));
    try {
      const admitted = await f.launch("printf ready; exec sleep 30");
      if (admitted.kind !== "completed") throw new Error("admission failed");
      await f.started;
      await f.clock.advance(duration(5_000));
      await f.supervisor.drain();
      expect(taskValue(f.tasks.get(receipt(admitted.value).handle)).terminal).toMatchObject({
        outcome: "uncertain",
        reason: "persistence-unavailable",
      });
    } finally {
      await f.close();
    }
  });
});
