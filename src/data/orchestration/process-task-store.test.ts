import { afterEach, describe, expect, test } from "bun:test";
import {
  capabilityInvocationStarted,
  processTaskChanged,
  sessionStarted,
  turnStarted,
} from "../../domain/fixtures.ts";
import { type Result, streamId } from "../../domain/foundation/index.ts";
import type {
  ProcessTaskFence,
  ProcessTaskSnapshot,
  ProcessTaskTerminal,
} from "../../domain/orchestration/process-task.ts";
import type {
  ProcessTaskStore,
  ProcessTaskWrite,
} from "../../domain/orchestration/process-task-store.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "../fixtures.ts";
import { createSqliteEventStore } from "../sessions/event-store.ts";
import { taskStream } from "./process-task-records.ts";
import { createSqliteProcessTaskStore } from "./process-task-store.ts";

afterEach(removeTemporaryRoots);
function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
  return result.value;
}
function written<T>(result: Result<ProcessTaskWrite<T>, unknown>): T {
  return value(result).value;
}
function fence(task: ProcessTaskSnapshot): ProcessTaskFence {
  return {
    handle: task.handle,
    supervisorRunId: task.supervisor.runId,
    expectedRevision: task.revision,
  };
}
function task(): ProcessTaskSnapshot {
  return processTaskChanged().payload.task;
}
async function open() {
  const root = await temporaryRoot("falryn-process-tasks-");
  const store = await openProductStoreOrThrow(root);
  return { root, store, tasks: createSqliteProcessTaskStore(store) };
}
const spawnFailure: ProcessTaskTerminal = {
  outcome: "failed",
  effect: "none",
  reason: "spawn-failed",
  exitCode: null,
  signal: null,
  sealedAt: 100,
  result: null,
};
function settle(tasks: ProcessTaskStore, current: ProcessTaskSnapshot) {
  const settling = written(tasks.transition(fence(current), { kind: "settling" }, 99));
  return written(
    tasks.transition(fence(settling), { kind: "sealed", terminal: spawnFailure }, 100),
  );
}
async function seedArtifact(store: SqliteStorePort) {
  const events = createSqliteEventStore(store, { projectStartedRecords: true });
  for (const event of [
    sessionStarted(1),
    turnStarted(2),
    {
      ...capabilityInvocationStarted(3),
      payload: { capabilityVersion: 1, inputDigest: "a".repeat(64) },
    },
  ])
    value(await events.append(event));
  const artifact = {
    artifactId: "task-output",
    digest: `sha-256:${"b".repeat(64)}`,
    byteLength: 4,
  };
  value(
    store.write((sql) =>
      sql.run(
        "INSERT INTO artifacts (artifact_id, digest, media_type, encoding, byte_length, sensitivity, origin, invocation_id, created_at, finalized_at, availability) VALUES ($id, $digest, 'application/octet-stream', 'identity', 4, 'user-content', 'capture', 'invocation-fixture', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'available')",
        { id: artifact.artifactId, digest: artifact.digest },
      ),
    ),
  );
  value(
    store.write((sql) =>
      sql.run(
        "INSERT INTO process_task_artifacts (artifact_id, task_id, generation) VALUES ($artifactId, 'task-fixture', 'generation-fixture')",
        { artifactId: artifact.artifactId },
      ),
    ),
  );
  return artifact;
}

describe("durable process tasks", () => {
  test("creation commits its event and survives a second connection without duplicate admission", async () => {
    const { root, store, tasks } = await open();
    const original = task();
    expect(written(tasks.create(original))).toEqual(original);
    const second = await openProductStoreOrThrow(root);
    expect(value(createSqliteProcessTaskStore(second).get(original.handle))).toEqual(original);
    expect(tasks.create(original)).toEqual({ ok: false, error: { code: "stale-generation" } });
    const events = createSqliteEventStore(store);
    const history = value(
      await events.readFrom(
        { streamId: streamId.from(taskStream(original.handle)), afterSequence: null },
        100,
      ),
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.kind).toBe("process.task.changed");
    expect(JSON.stringify(history)).not.toContain("argv");
    await second.close();
    await store.close();
  });

  test("a task insertion failure rolls back the already appended event", async () => {
    const { store, tasks } = await open();
    value(
      store.write((sql) =>
        sql.run(
          "CREATE TRIGGER fail_task BEFORE INSERT ON process_tasks BEGIN SELECT RAISE(ABORT, 'fixture-failure'); END",
        ),
      ),
    );
    expect(tasks.create(task()).ok).toBe(false);
    expect(value(store.read("SELECT * FROM process_tasks"))).toHaveLength(0);
    expect(value(store.read("SELECT * FROM events"))).toHaveLength(0);
    await store.close();
  });

  test("cancellation before commit prevents creation; cancellation during commit reports ownership", async () => {
    const { store, tasks } = await open();
    const before = new AbortController();
    before.abort();
    expect(tasks.create(task(), before.signal)).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(value(tasks.list())).toHaveLength(0);
    const after = new AbortController();
    const decorated: SqliteStorePort = {
      ...store,
      write(work, signal) {
        return store.write((sql) => {
          const result = work(sql);
          after.abort();
          return result;
        }, signal);
      },
    };
    const receipt = value(createSqliteProcessTaskStore(decorated).create(task(), after.signal));
    expect(receipt.cancelledAfterCommit).toBe(true);
    expect(value(tasks.get(task().handle))).toEqual(task());
    await store.close();
  });

  test("concurrent attachment changes fence revisions without resetting process identity or budgets", async () => {
    const { root, store, tasks } = await open();
    const original = written(tasks.create(task()));
    const running = written(
      tasks.transition(
        fence(original),
        { kind: "started", process: { platform: "linux", pid: 101, birth: "boot-fixture:2000" } },
        1,
      ),
    );
    const second = await openProductStoreOrThrow(root);
    const changed = written(
      tasks.transition(fence(running), { kind: "attachment", attachment: "foreground" }, 2),
    );
    expect(
      createSqliteProcessTaskStore(second).transition(
        fence(running),
        { kind: "attachment", attachment: "background" },
        2,
      ),
    ).toEqual({ ok: false, error: { code: "stale-revision" } });
    expect(changed.process).toEqual(running.process);
    expect(changed.owner).toEqual(original.owner);
    expect(changed.deadline).toBe(original.deadline);
    expect(
      tasks.transition({ ...fence(changed), supervisorRunId: "foreign" }, { kind: "settling" }, 3)
        .ok,
    ).toBe(false);
    await second.close();
    await store.close();
  });

  test("lease renewal is bounded and cannot resurrect an expired supervisor", async () => {
    const { store, tasks } = await open();
    const original = written(tasks.create(task()));
    expect(written(tasks.renew(fence(original), 4_999))).toEqual(original);
    const renewed = written(tasks.renew(fence(original), 5_000));
    expect(renewed.supervisor.leaseExpiresAt).toBe(20_000);
    expect(renewed.revision).toBe(original.revision);
    expect(tasks.renew(fence(renewed), 20_000)).toEqual({
      ok: false,
      error: { code: "ownership-unavailable" },
    });
    await store.close();
  });

  test("terminal state, its event, and its wake commit atomically and remain immutable", async () => {
    const { store, tasks } = await open();
    const original = written(tasks.create(task()));
    const settling = written(tasks.transition(fence(original), { kind: "settling" }, 99));
    expect(tasks.wake(original.handle).ok).toBe(false);
    value(
      store.write((sql) =>
        sql.run(
          "CREATE TRIGGER fail_wake BEFORE INSERT ON process_task_wakes BEGIN SELECT RAISE(ABORT, 'fixture-failure'); END",
        ),
      ),
    );
    expect(
      tasks.transition(fence(settling), { kind: "sealed", terminal: spawnFailure }, 100).ok,
    ).toBe(false);
    expect(value(tasks.get(original.handle))).toEqual(settling);
    expect(value(store.read("SELECT * FROM events"))).toHaveLength(2);
    value(store.write((sql) => sql.run("DROP TRIGGER fail_wake")));
    const sealed = written(
      tasks.transition(fence(settling), { kind: "sealed", terminal: spawnFailure }, 100),
    );
    const wake = value(tasks.wake(original.handle));
    expect(wake.state).toBe("pending");
    expect(wake.attempts).toBe(0);
    expect(
      value(
        store.read("SELECT event_id FROM events WHERE event_id = $id", {
          id: wake.terminalEventId,
        }),
      ),
    ).toHaveLength(1);
    expect(
      tasks.transition(
        fence(sealed),
        { kind: "sealed", terminal: { ...spawnFailure, outcome: "cancelled" } },
        100,
      ),
    ).toEqual({ ok: false, error: { code: "sealed" } });
    expect(value(tasks.get(original.handle))).toEqual(sealed);
    await store.close();
  });

  test("wake attempts persist across restart, acknowledgment deduplicates, and cleanup leaves a tombstone", async () => {
    const { root, store, tasks } = await open();
    const original = written(tasks.create(task()));
    const sealed = settle(tasks, original);
    expect(tasks.cleanup(original.handle, sealed.revision, 100)).toEqual({
      ok: false,
      error: { code: "busy" },
    });
    const first = written(tasks.claimWake(original.handle));
    expect(first.attempts).toBe(1);
    await store.close();
    const reopened = await openProductStoreOrThrow(root);
    const resumed = createSqliteProcessTaskStore(reopened);
    const second = written(resumed.claimWake(original.handle));
    expect(second.notificationId).toBe(first.notificationId);
    expect(second.attempts).toBe(2);
    expect(written(resumed.claimWake(original.handle)).attempts).toBe(3);
    expect(resumed.claimWake(original.handle).ok).toBe(false);
    expect(value(resumed.wake(original.handle)).state).toBe("unavailable");
    expect(resumed.acknowledgeWake(original.handle, "foreign").ok).toBe(false);
    expect(written(resumed.acknowledgeWake(original.handle, first.notificationId)).state).toBe(
      "acknowledged",
    );
    expect(written(resumed.acknowledgeWake(original.handle, first.notificationId)).attempts).toBe(
      3,
    );
    expect(written(resumed.cleanup(original.handle, sealed.revision, 100))).toBeNull();
    expect(written(resumed.cleanup(original.handle, sealed.revision, 100))).toBeNull();
    expect(resumed.create(original).ok).toBe(false);
    expect(value(resumed.list())).toHaveLength(0);
    await reopened.close();
  });

  test("capacity is refused rather than evicting another task", async () => {
    const { store, tasks } = await open();
    const original = task();
    for (let index = 0; index < 256; index++)
      written(
        tasks.create({ ...original, handle: { ...original.handle, taskId: `task-${index}` } }),
      );
    expect(tasks.create(original)).toEqual({ ok: false, error: { code: "capacity" } });
    expect(value(tasks.list())).toHaveLength(256);
    await store.close();
  });

  test("artifact references are contiguous, exact, lineage-bound, and sealed against late output", async () => {
    const { store, tasks } = await open();
    const artifact = await seedArtifact(store);
    const original = written(tasks.create(task()));
    const running = written(
      tasks.transition(
        fence(original),
        { kind: "started", process: { platform: "linux", pid: 101, birth: "boot-fixture:2000" } },
        1,
      ),
    );
    const chunk = { handle: original.handle, stream: "stdout" as const, offset: 0, artifact };
    expect(tasks.appendChunk(fence(running), { ...chunk, offset: 1 }, 2).ok).toBe(false);
    expect(
      tasks.appendChunk(fence(running), { ...chunk, artifact: { ...artifact, byteLength: 3 } }, 2)
        .ok,
    ).toBe(false);
    expect(written(tasks.appendChunk(fence(running), chunk, 2))).toBeNull();
    expect(written(tasks.appendChunk(fence(running), chunk, 2))).toBeNull();
    expect(value(tasks.chunks(original.handle, "stdout"))).toEqual([chunk]);
    const settling = written(tasks.transition(fence(running), { kind: "settling" }, 99));
    const terminal: ProcessTaskTerminal = {
      outcome: "completed",
      effect: "completed",
      reason: "exited",
      exitCode: 0,
      signal: null,
      sealedAt: 100,
      result: artifact,
    };
    const sealed = written(tasks.transition(fence(settling), { kind: "sealed", terminal }, 100));
    expect(tasks.appendChunk(fence(sealed), { ...chunk, offset: 4 }, 101)).toEqual({
      ok: false,
      error: { code: "sealed" },
    });
    await store.close();
  });

  test("malformed and foreign-generation rows fail closed", async () => {
    const { store, tasks } = await open();
    const original = written(tasks.create(task()));
    expect(tasks.get({ ...original.handle, generation: "foreign" })).toEqual({
      ok: false,
      error: { code: "stale-generation" },
    });
    value(store.write((sql) => sql.run("UPDATE process_tasks SET snapshot = '{}'")));
    expect(tasks.get(original.handle)).toEqual({ ok: false, error: { code: "invalid-record" } });
    expect(tasks.list().ok).toBe(false);
    await store.close();
  });
});
