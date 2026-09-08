import { afterEach, describe, expect, test } from "bun:test";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { duration } from "../../domain/foundation/index.ts";
import type { ProcessIdentityProbe } from "../../domain/process/process-identity.ts";
import { createProcessTaskFixture, taskValue } from "./process-task.fixtures.ts";
import { reconcileProcessTasks, watchProcessTaskRecovery } from "./process-task-recovery.ts";

afterEach(removeTemporaryRoots);

describe("process task restart reconciliation", () => {
  test.each([false, true])(
    "early restart revisits lease expiry with fresh identity, revived=%s",
    async (revived) => {
      const f = await createProcessTaskFixture();
      taskValue(f.tasks.create(f.snapshot));
      let live = false;
      const identities = {
        async inspect(): Promise<ProcessIdentityProbe> {
          return live
            ? { kind: "present", identity: f.snapshot.supervisor.process }
            : { kind: "vanished" };
        },
      };
      const initial = taskValue(
        await reconcileProcessTasks({
          store: f.tasks,
          identities,
          now: () => Number(f.clock.now()),
        }),
      );
      const notices: string[] = [];
      const recovery = watchProcessTaskRecovery({
        store: f.tasks,
        identities,
        clock: f.clock,
        initial,
        async settled(task) {
          notices.push(task.handle.taskId);
        },
      });
      try {
        expect(taskValue(f.tasks.get(f.snapshot.handle)).state).toBe("queued");
        live = revived;
        await f.clock.advance(duration(15_000));
        expect(await recovery.done).toBe(true);
        expect(taskValue(f.tasks.get(f.snapshot.handle)).state).toBe(
          revived ? "queued" : "terminal",
        );
        expect(notices).toHaveLength(revived ? 0 : 1);
        expect(recovery.reports()[0]?.supervisor).toBe(revived ? "uncertain" : "vanished");
      } finally {
        await recovery.close();
        await f.close();
      }
    },
  );

  test("closing early restart recovery removes its pending wait without taking ownership", async () => {
    const f = await createProcessTaskFixture();
    taskValue(f.tasks.create(f.snapshot));
    const identities = {
      async inspect(): Promise<ProcessIdentityProbe> {
        return { kind: "vanished" };
      },
    };
    const initial = taskValue(
      await reconcileProcessTasks({ store: f.tasks, identities, now: () => 0 }),
    );
    const recovery = watchProcessTaskRecovery({
      store: f.tasks,
      identities,
      clock: f.clock,
      initial,
      async settled() {
        throw new Error("must not notify after close");
      },
    });
    try {
      expect(await recovery.close()).toBe(true);
      await f.clock.advance(duration(20_000));
      expect(taskValue(f.tasks.get(f.snapshot.handle)).state).toBe("queued");
    } finally {
      await f.close();
    }
  });
  test("preserves a matching live supervisor and refuses expired or unreachable ownership without signaling", async () => {
    const f = await createProcessTaskFixture();
    const task = f.snapshot;
    taskValue(f.tasks.create(task));
    try {
      for (const [now, probe, status] of [
        [1, { kind: "present", identity: task.supervisor.process }, "live"],
        [20_000, { kind: "present", identity: task.supervisor.process }, "uncertain"],
        [20_000, { kind: "unavailable" }, "unreachable"],
        [1, { kind: "vanished" }, "vanished"],
      ] as const) {
        const recovered = taskValue(
          await reconcileProcessTasks({
            store: f.tasks,
            now: () => now,
            identities: {
              async inspect() {
                return probe;
              },
            },
          }),
        );
        expect(recovered[0]).toMatchObject({ supervisor: status, reconciled: false });
        expect(taskValue(f.tasks.get(task.handle))).toEqual(task);
      }
    } finally {
      await f.close();
    }
  });

  for (const status of ["vanished", "replaced"] as const) {
    test(`seals ${status} supervisor ownership as uncertain once, retaining budgets and wake identity`, async () => {
      const f = await createProcessTaskFixture();
      const task = f.snapshot;
      taskValue(f.tasks.create(task));
      const inspect = async (): Promise<ProcessIdentityProbe> =>
        status === "vanished"
          ? { kind: "vanished" }
          : { kind: "present", identity: { ...task.supervisor.process, birth: "reused" } };
      try {
        const recovered = taskValue(
          await reconcileProcessTasks({
            store: f.tasks,
            now: () => 20_000,
            identities: { inspect },
          }),
        );
        expect(recovered[0]).toMatchObject({ supervisor: status, reconciled: true });
        const sealed = taskValue(f.tasks.get(task.handle));
        expect(sealed).toMatchObject({
          deadline: task.deadline,
          owner: task.owner,
          terminal: {
            outcome: "uncertain",
            effect: "uncertain",
            reason: `supervisor-${status}`,
            result: null,
            outputComplete: false,
          },
        });
        const wake = taskValue(f.tasks.wake(task.handle));
        expect(wake.attempts).toBe(0);
        expect(
          taskValue(
            await reconcileProcessTasks({
              store: f.tasks,
              now: () => 30_000,
              identities: { inspect },
            }),
          )[0]?.supervisor,
        ).toBe("sealed");
        expect(taskValue(f.tasks.wake(task.handle))).toEqual(wake);
        expect(f.tasks.reconcile(task, "supervisor-vanished", 30_000)).toMatchObject({ ok: false });
      } finally {
        await f.close();
      }
    });
  }

  test("rebuilds semantic state and rejects a valid-looking but uncommitted snapshot", async () => {
    const f = await createProcessTaskFixture();
    taskValue(f.tasks.create(f.snapshot));
    try {
      taskValue(
        f.tasks.renew(
          {
            handle: f.snapshot.handle,
            supervisorRunId: f.snapshot.supervisor.runId,
            expectedRevision: 1,
          },
          5_000,
        ),
      );
      expect(taskValue(f.tasks.list())[0]?.supervisor.leaseExpiresAt).toBe(20_000);
      const changed = { ...taskValue(f.tasks.get(f.snapshot.handle)), attachment: "foreground" };
      taskValue(
        f.database.write((sql) =>
          sql.run("UPDATE process_tasks SET snapshot = $snapshot", {
            snapshot: JSON.stringify(changed),
          }),
        ),
      );
      expect(f.tasks.list()).toMatchObject({ ok: false, error: { code: "invalid-record" } });
    } finally {
      await f.close();
    }
  });

  test("concurrent reconciliation cannot replace a renewed lease or a newer revision", async () => {
    const f = await createProcessTaskFixture();
    taskValue(f.tasks.create(f.snapshot));
    try {
      taskValue(
        f.tasks.renew(
          {
            handle: f.snapshot.handle,
            supervisorRunId: f.snapshot.supervisor.runId,
            expectedRevision: 1,
          },
          5_000,
        ),
      );
      expect(f.tasks.reconcile(f.snapshot, "supervisor-vanished", 20_000)).toMatchObject({
        ok: false,
        error: { code: "stale-revision" },
      });
      expect(taskValue(f.tasks.get(f.snapshot.handle)).state).toBe("queued");
    } finally {
      await f.close();
    }
  });
});
