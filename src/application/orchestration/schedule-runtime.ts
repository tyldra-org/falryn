/** One live host owns wake subscriptions; durable transactions arbitrate competing hosts. */
import { randomUUID } from "node:crypto";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { ok } from "../../domain/foundation/result.ts";
import {
  type ScheduleAttempt,
  type ScheduleRecord,
  type ScheduleSlotRecord,
  type ScheduleStore,
  type ScheduleTerminal,
  scheduleSlotId,
} from "../../domain/orchestration/schedule-state.ts";
import { scheduleWindow } from "../../domain/orchestration/schedule-trigger.ts";
import {
  type ProcessBirthIdentity,
  type ProcessIdentityPort,
  sameProcessBirth,
} from "../../domain/process/process-identity.ts";
import type { ScheduleAuthority } from "./schedule-actions.ts";

export type ScheduleExecutor = ScheduleAuthority & {
  execute(
    record: ScheduleRecord,
    attempt: ScheduleAttempt,
    signal: AbortSignal,
    link: (value: Pick<ScheduleAttempt, "task" | "workflow">) => boolean,
  ): Promise<ScheduleTerminal>;
  reconcile(attempt: ScheduleAttempt): Promise<ScheduleTerminal | null>;
  notify(attempt: ScheduleAttempt, signal: AbortSignal, workspace: string): Promise<boolean>;
};
export function createScheduleRuntime(options: {
  store: ScheduleStore;
  workspace: string;
  executor: ScheduleExecutor;
  process: ProcessBirthIdentity;
  identities: ProcessIdentityPort;
  now(): number;
}) {
  const { store, workspace, executor } = options;
  const host = randomUUID();
  const active = new Map<string, { stop: AbortController; settled: Promise<void> }>();
  const stop = new AbortController();
  let recoveryBoundary = options.now() - 1;
  let previousWake = options.now();
  let definitionsAfter = "";
  let pendingAfter = "";
  let recoveryAfter = "";
  let noticesAfter = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> | null = null;
  let wakeAgain = false;
  let failure: string | null = null;
  const terminal = (
    status: ScheduleTerminal["status"],
    reason: string,
    effect: ScheduleTerminal["effect"] = "none",
  ): ScheduleTerminal => ({ status, reason, effect, result: null, at: options.now() });
  function mutateAttempt(id: string, update: (attempt: ScheduleAttempt) => ScheduleAttempt) {
    const read = store.attempt(workspace, id);
    if (!read.ok) {
      failure = read.error.code;
      return false;
    }
    if (read.value.terminal) return true;
    const changed = store.changeAttempt(workspace, id, read.value.revision, (prior) =>
      ok({ ...update(prior), revision: prior.revision + 1 }),
    );
    if (!changed.ok) failure = changed.error.code;
    return changed.ok;
  }
  async function recover() {
    const page = store.active(workspace, recoveryAfter);
    if (!page.ok) {
      failure = page.error.code;
      return;
    }
    recoveryAfter = page.value.length === 16 ? (page.value.at(-1)?.id ?? "") : "";
    for (const attempt of page.value) {
      if (attempt.terminal) continue;
      const owned = active.get(attempt.id);
      if (owned) {
        if (attempt.cancelRequestedAt !== null) {
          owned.stop.abort();
          mutateAttempt(attempt.id, (prior) => ({
            ...prior,
            cancelAcknowledgedAt: prior.cancelAcknowledgedAt ?? options.now(),
          }));
        }
        continue;
      }
      // Deadline or an old row is not evidence that another executor vanished.
      const observed = await options.identities.inspect(attempt.process.pid);
      const record = store.get(workspace, attempt.schedule);
      if (observed.kind === "unavailable") {
        failure = "executor-identity-unavailable";
        if (record.ok && record.value.blocker !== "executor-identity-unavailable")
          store.change(workspace, record.value.id, record.value.revision, (prior) =>
            ok({
              ...prior,
              revision: prior.revision + 1,
              blocker: "executor-identity-unavailable",
              state: "paused",
            }),
          );
        continue;
      }
      if (record.ok && record.value.blocker === "executor-identity-unavailable")
        store.change(workspace, record.value.id, record.value.revision, (prior) =>
          ok({ ...prior, revision: prior.revision + 1, blocker: null }),
        );
      if (observed.kind === "present" && sameProcessBirth(observed.identity, attempt.process))
        continue;
      const settled = await executor.reconcile(attempt);
      mutateAttempt(attempt.id, (prior) => ({
        ...prior,
        terminal: settled ?? terminal("uncertain", "executor-lost-recovery-required", "uncertain"),
      }));
    }
  }
  async function discover(now: number) {
    const page = store.page(workspace, definitionsAfter);
    if (!page.ok) {
      failure = page.error.code;
      return;
    }
    definitionsAfter = page.value.length === 16 ? (page.value.at(-1)?.id ?? "") : "";
    for (let record of page.value) {
      if (stop.signal.aborted) return;
      if (record.state !== "enabled") continue;
      if (!record.recovery && record.cursor < recoveryBoundary) {
        const changed = store.change(workspace, record.id, record.revision, (prior) =>
          ok({
            ...prior,
            revision: prior.revision + 1,
            recovery: {
              through: recoveryBoundary,
              remaining:
                prior.definition.missed.kind === "bounded-all"
                  ? prior.definition.missed.maxCatchUpRuns
                  : 1,
            },
          }),
        );
        if (!changed.ok) continue;
        record = changed.value;
      }
      const earliest = Math.max(record.anchor - 1, now - record.definition.lookbackMs);
      if (record.cursor < earliest) {
        const decided = store.decide(record, earliest, [
          {
            id: scheduleSlotId(record.id, record.generation, `lookback:${record.cursor}`),
            schedule: record.id,
            generation: record.generation,
            kind: "lookback",
            nominal: Math.max(0, record.cursor),
            eligible: earliest,
            through: earliest,
            disposition: "over-limit",
          },
        ]);
        if (!decided.ok) continue;
        record = decided.value;
      }
      const window = scheduleWindow(record.definition.timing, record, record.cursor, now, 16);
      const slots: ScheduleSlotRecord[] = [];
      let remaining = record.recovery?.remaining ?? 0;
      for (const slot of window.slots) {
        let disposition: ScheduleSlotRecord["disposition"] = "pending";
        if (record.recovery && slot.nominal <= record.recovery.through) {
          const missed = record.definition.missed;
          if (missed.kind === "none") disposition = "missed";
          else if (missed.kind === "bounded-all") {
            disposition = remaining > 0 ? "pending" : "over-limit";
            remaining = Math.max(0, remaining - 1);
          } else {
            const later = scheduleWindow(
              record.definition.timing,
              record,
              slot.nominal,
              record.recovery.through,
              1,
            );
            disposition =
              later.slots.length || later.through < record.recovery.through
                ? "coalesced"
                : "pending";
          }
        }
        slots.push({
          ...slot,
          id: scheduleSlotId(record.id, record.generation, slot.nominal),
          schedule: record.id,
          generation: record.generation,
          kind: "nominal",
          through: null,
          disposition,
        });
      }
      for (const gap of window.gaps)
        slots.push({
          id: scheduleSlotId(record.id, record.generation, `gap:${gap.start}`),
          schedule: record.id,
          generation: record.generation,
          kind: "gap",
          nominal: Date.parse(`${gap.start}:00Z`),
          eligible: now,
          through: Date.parse(`${gap.end}:00Z`),
          count: gap.count,
          disposition: "missed",
        });
      if (window.through <= record.cursor && slots.length === 0) continue;
      // Recovery budget and decisions must commit together. The store validates the same revision.
      const decided = store.decide(
        {
          ...record,
          recovery:
            record.recovery && window.through < record.recovery.through
              ? { ...record.recovery, remaining }
              : null,
        },
        Math.max(record.cursor, window.through),
        slots,
      );
      if (!decided.ok) failure = decided.error.code;
    }
  }
  async function admit() {
    const page = store.pending(workspace, options.now(), pendingAfter);
    if (!page.ok) {
      failure = page.error.code;
      return;
    }
    const last = page.value.at(-1);
    pendingAfter = page.value.length === 16 && last ? `${last.nominal}:${last.id}` : "";
    for (const slot of page.value) {
      if (stop.signal.aborted || active.size >= 16) return;
      const read = store.get(workspace, slot.schedule);
      if (!read.ok) {
        failure = read.error.code;
        continue;
      }
      let record = read.value;
      if (record.blocker === "executor-identity-unavailable") continue;
      const validated = await executor.validate(record, stop.signal);
      const blocker =
        validated.ok && canonicalDigest(validated.value) === canonicalDigest(record.binding)
          ? null
          : validated.ok
            ? "authority-changed"
            : validated.error.code;
      if (blocker) {
        if (record.blocker !== blocker)
          store.change(workspace, record.id, record.revision, (prior) =>
            ok({ ...prior, revision: prior.revision + 1, blocker }),
          );
        continue;
      }
      if (stop.signal.aborted) return;
      if (record.blocker) {
        const cleared = store.change(workspace, record.id, record.revision, (prior) =>
          ok({ ...prior, revision: prior.revision + 1, blocker: null }),
        );
        if (!cleared.ok) continue;
        record = cleared.value;
      }
      const now = options.now();
      const attempt: ScheduleAttempt = {
        id: randomUUID(),
        slot: slot.id,
        schedule: record.id,
        generation: record.generation,
        revision: 1,
        host,
        process: options.process,
        admittedAt: now,
        deadline: now + 1_800_000,
        task: null,
        workflow: null,
        cancelRequestedAt: null,
        cancelAcknowledgedAt: null,
        terminal: null,
      };
      const claimed = store.claim(record, slot, attempt);
      if (!claimed.ok) {
        failure = claimed.error.code;
        continue;
      }
      if (!claimed.value) continue;
      const cancelled = new AbortController();
      const settled = (async () => {
        let outcome: ScheduleTerminal;
        try {
          const fresh = store.get(workspace, record.id);
          const authority = await executor.validate(record, cancelled.signal);
          if (
            !fresh.ok ||
            fresh.value.generation !== record.generation ||
            fresh.value.state !== "enabled" ||
            !authority.ok ||
            canonicalDigest(authority.value) !== canonicalDigest(record.binding)
          )
            outcome = terminal("unavailable", "admission-authority-changed");
          else
            outcome = await executor.execute(record, attempt, cancelled.signal, (link) =>
              mutateAttempt(attempt.id, (prior) => ({ ...prior, ...link })),
            );
        } catch {
          outcome = terminal("uncertain", "executor-interrupted", "uncertain");
        }
        mutateAttempt(attempt.id, (prior) => ({ ...prior, terminal: outcome }));
      })().finally(() => {
        active.delete(attempt.id);
        if (!stop.signal.aborted) void wake();
      });
      active.set(attempt.id, { stop: cancelled, settled });
    }
  }
  async function notices() {
    const page = store.notifications(workspace, noticesAfter);
    if (!page.ok) {
      failure = page.error.code;
      return;
    }
    noticesAfter = page.value.length === 16 ? (page.value.at(-1)?.id ?? "") : "";
    for (const attempt of page.value) {
      if (stop.signal.aborted) return;
      try {
        if (await executor.notify(attempt, stop.signal, workspace))
          store.acknowledge(workspace, attempt.id);
      } catch {
        failure = "notification-unavailable";
      }
    }
  }
  async function tick() {
    if (stop.signal.aborted) return;
    await recover();
    const now = options.now();
    if (now - previousWake > 2000) recoveryBoundary = now - 1;
    previousWake = now;
    const retired = store.retire(workspace);
    if (!retired.ok) failure = retired.error.code;
    if (stop.signal.aborted) return;
    await discover(now);
    if (stop.signal.aborted) return;
    await admit();
    await notices();
  }
  function wake(): Promise<void> {
    if (current) {
      wakeAgain = true;
      return current;
    }
    current = (async () => {
      do {
        wakeAgain = false;
        await tick();
        // Yield between coalesced bounded batches, including immediate settlements.
        if (wakeAgain && !stop.signal.aborted)
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
      } while (wakeAgain && !stop.signal.aborted);
    })()
      .catch(() => {
        failure = "wake-interrupted";
      })
      .finally(() => {
        current = null;
      });
    return current;
  }
  return {
    wake,
    inspect: () => ({ active: active.size, failure, stopped: stop.signal.aborted }),
    start() {
      if (timer !== undefined || stop.signal.aborted) return;
      const run = async () => {
        await wake();
        if (!stop.signal.aborted) timer = setTimeout(run, 1000);
      };
      timer = setTimeout(run, 0);
    },
    async close() {
      stop.abort();
      clearTimeout(timer);
      for (const run of active.values()) run.stop.abort();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([current, ...[...active.values()].map((run) => run.settled)]),
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, 1000);
        }),
      ]);
      clearTimeout(deadline);
      for (const id of active.keys())
        mutateAttempt(id, (prior) => ({
          ...prior,
          terminal: terminal("uncertain", "shutdown-unsettled", "uncertain"),
        }));
      return active.size === 0 && current === null;
    },
  };
}
