/** Health belongs to one validated binding. Replacement never clears an older binding's facts. */
import { z } from "zod";
import { digestSchema } from "../extensions/identity.ts";
import { err, ok, type Result } from "../foundation/result.ts";

export const HOOK_FAILURE_LIMIT = 3;
export const hookHealthStateSchema = z.strictObject({
  failures: z.int().min(0).max(HOOK_FAILURE_LIMIT),
  uncertain: z.boolean(),
});
export type HookHealthState = z.infer<typeof hookHealthStateSchema>;
export type HookHealthOutcome = "success" | "failure" | "uncertain";
export interface HookHealth {
  readonly generation: string;
  read(): Result<HookHealthState, { code: string }>;
  /** Called once by the invocation owner, never by a handler callback or replay. */
  settle(outcome: HookHealthOutcome): Result<HookHealthState, { code: string }>;
}
export function nextHookHealth(
  state: HookHealthState,
  outcome: HookHealthOutcome,
): HookHealthState {
  return {
    failures:
      state.failures >= HOOK_FAILURE_LIMIT
        ? HOOK_FAILURE_LIMIT
        : outcome === "success"
          ? 0
          : Math.min(HOOK_FAILURE_LIMIT, state.failures + 1),
    uncertain: state.uncertain || outcome === "uncertain",
  };
}
export function createMemoryHookHealth(generation: string): HookHealth {
  let state: HookHealthState = { failures: 0, uncertain: false };
  return {
    generation,
    read: () => ok({ ...state }),
    settle(outcome) {
      state = nextHookHealth(state, outcome);
      return ok({ ...state });
    },
  };
}
export const hookHealthSnapshotSchema = z.strictObject({
  generation: digestSchema,
  status: z.enum(["healthy", "degraded", "quarantined", "cleanup-uncertain", "unavailable"]),
  failures: z.int().min(0).max(HOOK_FAILURE_LIMIT).nullable(),
});
export function inspectHookHealth(health: HookHealth): z.infer<typeof hookHealthSnapshotSchema> {
  let read: Result<HookHealthState, { code: string }>;
  try {
    read = health.read();
  } catch {
    read = err({ code: "hook-health-unavailable" });
  }
  return {
    generation: health.generation,
    status: !read.ok
      ? "unavailable"
      : read.value.uncertain
        ? "cleanup-uncertain"
        : read.value.failures >= HOOK_FAILURE_LIMIT
          ? "quarantined"
          : read.value.failures
            ? "degraded"
            : "healthy",
    failures: read.ok ? read.value.failures : null,
  };
}
