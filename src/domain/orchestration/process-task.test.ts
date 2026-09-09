import { describe, expect, test } from "bun:test";
import { sameProcessBirth } from "../process/process-identity.ts";
import {
  MAX_PROCESS_TASK_LOG_BYTES,
  type ProcessTaskFence,
  type ProcessTaskSnapshot,
  type ProcessTaskTerminal,
  processTaskControlSchema,
  processTaskExecutionSchema,
  processTaskSnapshotSchema,
  transitionProcessTask,
} from "./process-task.ts";

function queued(): ProcessTaskSnapshot & {
  supervisor: { process: NonNullable<ProcessTaskSnapshot["supervisor"]["process"]> };
} {
  return {
    handle: { version: 1, taskId: "task-1", generation: "generation-1" },
    revision: 1,
    owner: {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      turnId: "turn-1",
      invocationId: "invocation-1",
      attemptId: "attempt-1",
      configurationGeneration: 1,
      resourceTaskId: "resource-1",
    },
    supervisor: {
      runId: "run-1",
      process: { platform: "linux", pid: 100, birth: "boot-1:1000" },
      leaseExpiresAt: 15_000,
    },
    attachment: "foreground",
    createdAt: 0,
    deadline: 30_000,
    inputDigest: "a".repeat(64),
    outputMode: "raw",
    state: "queued",
    process: null,
    terminal: null,
  };
}
function fence(task: ProcessTaskSnapshot): ProcessTaskFence {
  return {
    handle: task.handle,
    supervisorRunId: task.supervisor.runId,
    expectedRevision: task.revision,
  };
}
const terminal: ProcessTaskTerminal = {
  outcome: "completed",
  effect: "completed",
  reason: "exited",
  exitCode: 0,
  signal: null,
  sealedAt: 100,
  result: { artifactId: "result-1", digest: `sha-256:${"b".repeat(64)}`, byteLength: 100 },
};

describe("process task request boundaries", () => {
  test("explicit attachment defaults only its wait budget and never authorizes continuation", () => {
    const input = { version: 1, attachment: "background", onSettle: "notify", shutdown: "drain" };
    expect(processTaskExecutionSchema.parse(input).foregroundWaitMs).toBe(1_000);
    for (const invalid of [
      { ...input, version: 2 },
      { ...input, attachment: "auto" },
      { ...input, onSettle: "resume-parent" },
      { ...input, shutdown: "daemon" },
      { ...input, foregroundWaitMs: 0 },
      { ...input, foregroundWaitMs: 30_001 },
      { ...input, foregroundWaitMs: 0.5 },
      { ...input, resources: {} },
    ])
      expect(processTaskExecutionSchema.safeParse(invalid).success).toBe(false);
  });

  test("controls require exact versioned handles, mutation fences, and bounded reads", () => {
    const handle = queued().handle;
    for (const operation of ["inspect", "result"])
      expect(processTaskControlSchema.safeParse({ ...handle, operation }).success).toBe(true);
    for (const operation of ["detach", "reattach", "cancel", "kill", "cleanup"]) {
      expect(
        processTaskControlSchema.safeParse({ ...handle, operation, expectedRevision: 1 }).success,
      ).toBe(true);
      expect(processTaskControlSchema.safeParse({ ...handle, operation }).success).toBe(false);
    }
    const read = {
      ...handle,
      operation: "logs",
      stream: "stdout",
      offset: 0,
      limit: MAX_PROCESS_TASK_LOG_BYTES,
    };
    expect(processTaskControlSchema.safeParse(read).success).toBe(true);
    for (const invalid of [
      { ...read, limit: MAX_PROCESS_TASK_LOG_BYTES + 1 },
      { ...read, offset: -1 },
      { ...read, stream: "both" },
      { ...read, generation: "" },
      { ...read, version: 2 },
      { ...read, argv: [] },
      { ...handle, operation: "launch" },
      { ...handle, operation: "wait", waitMs: 30_001 },
    ])
      expect(processTaskControlSchema.safeParse(invalid).success).toBe(false);
  });

  test("snapshots exclude raw inputs and require process identity for running state", () => {
    const task = queued();
    expect(processTaskSnapshotSchema.safeParse(task).success).toBe(true);
    expect(processTaskSnapshotSchema.safeParse({ ...task, argv: ["secret"] }).success).toBe(false);
    expect(processTaskSnapshotSchema.safeParse({ ...task, state: "running" }).success).toBe(false);
    expect(processTaskSnapshotSchema.safeParse({ ...task, state: "terminal" }).success).toBe(false);
    expect(
      processTaskSnapshotSchema.safeParse({
        ...task,
        supervisor: { ...task.supervisor, environment: {} },
      }).success,
    ).toBe(false);
  });
});

describe("process task transitions", () => {
  test("detach and reattach preserve the same process, owner, allowance, and deadline", () => {
    const original = queued();
    const process = { platform: "linux", pid: 101, birth: "boot-1:2000" } as const;
    const started = transitionProcessTask(
      original,
      fence(original),
      { kind: "started", process },
      1,
    );
    if (!started.ok) throw new Error(started.code);
    let current = started.value;
    for (const attachment of ["background", "foreground"] as const) {
      const changed = transitionProcessTask(
        current,
        fence(current),
        { kind: "attachment", attachment },
        2,
      );
      if (!changed.ok) throw new Error(changed.code);
      expect(changed.value.revision).toBe(current.revision + 1);
      expect(changed.value.process).toEqual(process);
      expect(changed.value.owner).toEqual(original.owner);
      expect(changed.value.handle).toEqual(original.handle);
      expect(changed.value.deadline).toBe(original.deadline);
      current = changed.value;
    }
    expect(original.state).toBe("queued");
    expect(original.revision).toBe(1);
  });

  test("terminal sealing requires settling and cannot be repeated or rewritten", () => {
    const original = queued();
    const started = transitionProcessTask(
      original,
      fence(original),
      { kind: "started", process: { platform: "linux", pid: 101, birth: "boot-1:2000" } },
      1,
    );
    if (!started.ok) throw new Error(started.code);
    const task = started.value;
    expect(transitionProcessTask(task, fence(task), { kind: "sealed", terminal }, 100)).toEqual({
      ok: false,
      code: "invalid-transition",
    });
    const settling = transitionProcessTask(task, fence(task), { kind: "settling" }, 99);
    if (!settling.ok) throw new Error(settling.code);
    expect(
      transitionProcessTask(
        settling.value,
        fence(settling.value),
        { kind: "attachment", attachment: "background" },
        100,
      ).ok,
    ).toBe(false);
    const sealed = transitionProcessTask(
      settling.value,
      fence(settling.value),
      { kind: "sealed", terminal },
      100,
    );
    if (!sealed.ok) throw new Error(sealed.code);
    expect(processTaskSnapshotSchema.safeParse(sealed.value).success).toBe(true);
    expect(
      transitionProcessTask(sealed.value, fence(sealed.value), { kind: "sealed", terminal }, 100),
    ).toEqual({ ok: false, code: "sealed" });
  });

  test("signal death, absent results, and a never-started process cannot become success", () => {
    const original = queued();
    const settling = transitionProcessTask(original, fence(original), { kind: "settling" }, 99);
    if (!settling.ok) throw new Error(settling.code);
    expect(
      transitionProcessTask(
        settling.value,
        fence(settling.value),
        { kind: "sealed", terminal },
        100,
      ).ok,
    ).toBe(false);
    const snapshot = {
      ...settling.value,
      state: "terminal",
      process: { platform: "linux", pid: 101, birth: "boot-1:2000" },
      terminal,
    };
    for (const invalid of [
      { ...terminal, signal: "SIGTERM" },
      { ...terminal, exitCode: 1 },
      { ...terminal, exitCode: null },
      { ...terminal, result: null },
      { ...terminal, effect: "none" },
      { ...terminal, outcome: "uncertain", effect: "none" },
    ])
      expect(processTaskSnapshotSchema.safeParse({ ...snapshot, terminal: invalid }).success).toBe(
        false,
      );
  });

  test("foreign generation, revision, supervisor, and expired lease fail closed", () => {
    const task = queued();
    const change = { kind: "settling" } as const;
    const mutations = [
      { ...fence(task), handle: { ...task.handle, generation: "old" } },
      { ...fence(task), handle: { ...task.handle, taskId: "another-task" } },
      { ...fence(task), expectedRevision: 2 },
      { ...fence(task), supervisorRunId: "another-run" },
    ];
    for (const stale of mutations)
      expect(transitionProcessTask(task, stale, change, 1).ok).toBe(false);
    expect(transitionProcessTask(task, fence(task), change, 15_000)).toEqual({
      ok: false,
      code: "ownership-unavailable",
    });
    const expired = { ...task, deadline: 1 };
    expect(
      transitionProcessTask(
        expired,
        fence(expired),
        { kind: "started", process: task.supervisor.process },
        1,
      ).ok,
    ).toBe(false);
    expect(transitionProcessTask(expired, fence(expired), change, 1).ok).toBe(true);
  });

  test("equal PIDs on a different boot or with a different start counter are not the same process", () => {
    const process = queued().supervisor.process;
    expect(sameProcessBirth(process, { ...process })).toBe(true);
    expect(sameProcessBirth(process, { ...process, birth: "boot-2:1000" })).toBe(false);
    expect(sameProcessBirth(process, { ...process, birth: "boot-1:1001" })).toBe(false);
    expect(sameProcessBirth(process, { ...process, platform: "darwin" })).toBe(false);
  });
});
