/** Real-process durable cut points; imported only by the adjacent restart test. */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { openProductStoreOrThrow } from "../../data/fixtures.ts";
import { createScheduleStore } from "../../data/orchestration/schedule-store.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { ok } from "../../domain/foundation/result.ts";
import { scheduleSlotId } from "../../domain/orchestration/schedule-state.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { createHostProcessIdentityPort } from "../../integrations/process/host-process-identity.ts";
import { createScheduleActions } from "./schedule-actions.ts";
import { createScheduleRuntime, type ScheduleExecutor } from "./schedule-runtime.ts";

export async function crashHost(root: string, phase: string, recovering = false) {
  const db = await openProductStoreOrThrow(localPath(root));
  const store = createScheduleStore(db);
  const identities = createHostProcessIdentityPort();
  const processIdentity = await identities.inspect(process.pid);
  if (processIdentity.kind !== "present") throw new Error("process-identity-unavailable");
  const announce = () => {
    if (!recovering) process.stdout.write("ready\n");
  };
  const wait = () => new Promise<never>(() => {});
  const executor: ScheduleExecutor = {
    validate: async () =>
      ok({
        descriptor: canonicalDigest("descriptor"),
        authority: canonicalDigest("authority"),
        configuration: canonicalDigest("config"),
        configurationGeneration: 1,
        timezoneData: "test",
      }),
    execute: async () => {
      if (!recovering && phase === "admission") {
        announce();
        return wait();
      }
      await appendFile(join(root, "effects"), "effect\n");
      if (!recovering && phase === "effect") {
        announce();
        return wait();
      }
      return {
        status: "succeeded",
        effect: "completed",
        reason: "completed",
        result: null,
        at: 1000,
      };
    },
    reconcile: async () => null,
    notify: async () => {
      if (!recovering && phase === "notification") {
        announce();
        return wait();
      }
      return recovering;
    },
  };
  if (!recovering) {
    const actions = createScheduleActions({
      store,
      workspace: "workspace",
      now: () => 1000,
      authority: executor,
    });
    const signal = new AbortController().signal;
    await actions.execute(
      {
        operation: "create",
        id: "test",
        definition: {
          version: 1,
          timing: { trigger: { kind: "once", at: "1970-01-01T00:00:01Z" } },
          target: { kind: "action", capability: "builtin:test/read@1", input: {} },
        },
      },
      "user",
      signal,
    );
    await actions.execute({ operation: "enable", id: "test", expectedRevision: 1 }, "user", signal);
    if (phase === "slot") {
      const record = store.get("workspace", "test");
      if (!record.ok) throw new Error(record.error.code);
      const saved = store.decide(record.value, 1000, [
        {
          id: scheduleSlotId("test", 1, 1000),
          schedule: "test",
          generation: 1,
          kind: "nominal",
          nominal: 1000,
          eligible: 1000,
          disposition: "pending",
          through: null,
        },
      ]);
      if (!saved.ok) throw new Error(saved.error.code);
      announce();
      return wait();
    }
  }
  const host = createScheduleRuntime({
    store,
    workspace: "workspace",
    executor,
    identities,
    process: processIdentity.identity,
    now: () => 1000,
  });
  await host.wake();
  for (let i = 0; i < 100 && host.inspect().active; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (!recovering && phase === "terminal") {
    announce();
    return wait();
  }
  await host.wake();
  if (!recovering) return wait();
  const attempts = store.attempts("workspace");
  const notices = store.notifications("workspace");
  await host.close();
  await db.close();
  return { attempts, notices };
}
if (import.meta.main) {
  // Keep the OS process alive at a cut point so the parent kills it without cleanup.
  setInterval(() => {}, 1000);
  await crashHost(process.argv[2] ?? "", process.argv[3] ?? "");
}
