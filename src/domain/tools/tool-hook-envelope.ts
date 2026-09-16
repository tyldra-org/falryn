import { createHash } from "node:crypto";
import { freezeMetadata } from "../extensions/canonical.ts";
import { HOOK_BUDGETS, type HookEnvelope, parseHookEnvelope } from "../extensions/hook-points.ts";
import type { ToolHookEnvelope, ToolHookPoint } from "./tool-hooks.ts";

/** Safe versioned evidence accompanies the existing built-in envelope. No raw input crosses the wire. */
export function withHookCatalog(
  input: Omit<ToolHookEnvelope, "catalog">,
  context: {
    sessionId?: string;
    turnId?: string;
    attemptId?: string;
    configurationGeneration?: number;
    declaredEffect?: "observation" | "mutation" | "external" | "interactive";
    remainingMs?: number;
  } = {},
): ToolHookEnvelope {
  const outcome = input.observedOutcome;
  const observed =
    outcome === null
      ? null
      : {
          terminal:
            outcome.status === "partial" ||
            outcome.status === "denied" ||
            outcome.status === "unavailable" ||
            outcome.status === "malformed"
              ? "failed"
              : outcome.status,
          effect: outcome.effect,
        };
  if (input.point === "after-capability-invocation" && observed === null)
    throw new Error("hook-terminal-required");
  const catalog = parseHookEnvelope({
    version: 1,
    point: input.point,
    pointVersion: 1,
    factId: `${input.invocationId}:${input.phase}`,
    subjectId: String(input.invocationId),
    ownerGeneration: Number(input.catalogGeneration),
    configurationGeneration: context.configurationGeneration ?? Number(input.catalogGeneration),
    registrationGeneration: Number(input.registrationGeneration),
    sequence: input.phase === "pre" ? 0 : 1,
    correlation: {
      sessionId: context.sessionId ?? null,
      turnId: context.turnId ?? null,
      attemptId: context.attemptId ?? null,
    },
    origin: "system",
    reason: "normal",
    remainingMs: context.remainingMs ?? HOOK_BUDGETS.local.maximumMs,
    recursionDepth: input.recursionDepth,
    payload: {
      capabilityId: String(input.capabilityId),
      inputDigest: createHash("sha256").update(JSON.stringify(input.payload)).digest("hex"),
      declaredEffect: context.declaredEffect ?? "observation",
      ...(observed ?? {}),
    },
  }) as HookEnvelope<ToolHookPoint>;
  return { ...input, catalog: freezeMetadata(catalog) };
}
