/** Restart inspection has no spawn or signal authority. Unproven owners are never adopted. */
import { type ClockPort, instant } from "../../domain/foundation/index.ts";
import { err, ok, type Result } from "../../domain/foundation/result.ts";
import type {
  ProcessTaskHandle,
  ProcessTaskSnapshot,
} from "../../domain/orchestration/process-task.ts";
import type { ProcessTaskStore } from "../../domain/orchestration/process-task-store.ts";
import {
  type ProcessBirthIdentity,
  type ProcessIdentityPort,
  sameProcessBirth,
} from "../../domain/process/process-identity.ts";

export type ProcessTaskRecovery = {
  readonly handle: ProcessTaskHandle;
  readonly supervisor: "live" | "vanished" | "replaced" | "unreachable" | "uncertain" | "sealed";
  readonly process: "matching" | "vanished" | "replaced" | "unreachable" | "not-started";
  readonly reconciled: boolean;
};

async function probe(
  identity: ProcessBirthIdentity | null,
  identities: ProcessIdentityPort,
): Promise<ProcessTaskRecovery["process"]> {
  if (identity === null) return "not-started";
  const found = await identities
    .inspect(identity.pid)
    .catch(() => ({ kind: "unavailable" as const }));
  if (found.kind === "unavailable") return "unreachable";
  if (found.kind === "vanished") return "vanished";
  return sameProcessBirth(identity, found.identity) ? "matching" : "replaced";
}

export async function reconcileProcessTasks(options: {
  readonly store: ProcessTaskStore;
  readonly identities: ProcessIdentityPort;
  now(): number;
  readonly signal?: AbortSignal;
}): Promise<Result<readonly ProcessTaskRecovery[], { readonly code: string }>> {
  const listed = options.store.list();
  if (!listed.ok) return listed;
  const reports: ProcessTaskRecovery[] = [];
  for (const task of listed.value) {
    if (options.signal?.aborted) return err({ code: "cancelled" });
    if (task.state === "terminal") {
      reports.push({
        handle: task.handle,
        supervisor: "sealed",
        process: "not-started",
        reconciled: false,
      });
      continue;
    }
    const supervisor = await probe(task.supervisor.process, options.identities);
    const process = await probe(task.process, options.identities);
    const report = await reconcileOne(task, supervisor, process);
    if (!report.ok) return report;
    reports.push(report.value);
  }
  return ok(reports);

  async function reconcileOne(
    task: ProcessTaskSnapshot,
    supervisor: ProcessTaskRecovery["process"],
    process: ProcessTaskRecovery["process"],
  ): Promise<Result<ProcessTaskRecovery, { readonly code: string }>> {
    const now = options.now();
    const base = { handle: task.handle, process, reconciled: false };
    if (supervisor === "matching")
      return ok({
        ...base,
        supervisor: now < task.supervisor.leaseExpiresAt ? "live" : "uncertain",
      });
    if (supervisor !== "vanished" && supervisor !== "replaced")
      return ok({ ...base, supervisor: "unreachable" });
    if (now < task.supervisor.leaseExpiresAt) return ok({ ...base, supervisor });
    // Probe again before the compare-and-swap; a renewal or terminal transition wins.
    const verified = await probe(task.supervisor.process, options.identities);
    if (verified !== supervisor) return ok({ ...base, supervisor: "uncertain" });
    const sealed = options.store.reconcile(
      task,
      supervisor === "vanished" ? "supervisor-vanished" : "supervisor-replaced",
      options.now(),
      options.signal,
    );
    return sealed.ok ? ok({ ...base, supervisor, reconciled: true }) : sealed;
  }
}

/** Revisit known dead owners once their observed leases expire, without polling live owners. */
export function watchProcessTaskRecovery(options: {
  readonly store: ProcessTaskStore;
  readonly identities: ProcessIdentityPort;
  readonly clock: ClockPort;
  readonly initial: readonly ProcessTaskRecovery[];
  settled(task: ProcessTaskSnapshot): Promise<void>;
}) {
  const stop = new AbortController();
  let reports = options.initial;
  const listed = options.store.list();
  const waiting = new Set(
    options.initial
      .filter(
        (report) =>
          !report.reconciled &&
          (report.supervisor === "vanished" || report.supervisor === "replaced"),
      )
      .map((report) => report.handle.taskId),
  );
  const deadlines = listed.ok
    ? [
        ...new Set(
          listed.value
            .filter((task) => waiting.has(task.handle.taskId))
            .map((task) => task.supervisor.leaseExpiresAt),
        ),
      ].sort((a, b) => a - b)
    : [];
  const done = (async () => {
    if (!listed.ok) return false;
    for (const deadline of deadlines) {
      await options.clock.waitUntil(instant(deadline), stop.signal);
      if (stop.signal.aborted) return true;
      const refreshed = await reconcileProcessTasks({
        ...options,
        now: () => Number(options.clock.now()),
        signal: stop.signal,
      });
      if (!refreshed.ok) return stop.signal.aborted;
      reports = refreshed.value;
      for (const report of reports) {
        if (!report.reconciled) continue;
        const task = options.store.get(report.handle);
        if (!task.ok) return false;
        await options.settled(task.value);
      }
    }
    return true;
  })().catch(() => false);
  return {
    done,
    reports: () => reports,
    async close(): Promise<boolean> {
      stop.abort();
      return done;
    },
  };
}
