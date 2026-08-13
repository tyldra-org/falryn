/**
 * Tool-pipeline hook points and lifecycle facts (#53).
 *
 * Built-in hooks observe or influence named capability-invocation points.
 * They never receive a runner, secrets, UI, or an unrestricted container, and
 * they cannot execute tools. Plugin adapters and other hook families remain
 * later owners.
 */

import type { Instant } from "./clock.ts";
import type { Deadline } from "./deadline.ts";
import type { DiagnosticLevel } from "./diagnostics.ts";
import type { CapabilityId, ConfigurationGeneration, InvocationId } from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import type { ToolInvocationOutcome } from "./tool-pipeline.ts";

/** Schema version this build writes for tool-hook registries. */
export const TOOL_HOOK_SCHEMA_VERSION = 1;

export const TOOL_HOOK_POINTS = [
  "before-capability-invocation",
  "after-capability-invocation",
] as const;

export type ToolHookPoint = (typeof TOOL_HOOK_POINTS)[number];

export function isToolHookPoint(value: unknown): value is ToolHookPoint {
  return typeof value === "string" && (TOOL_HOOK_POINTS as readonly string[]).includes(value);
}

export const TOOL_HOOK_PHASES = ["pre", "post"] as const;

export type ToolHookPhase = (typeof TOOL_HOOK_PHASES)[number];

export function phaseForHookPoint(point: ToolHookPoint): ToolHookPhase {
  switch (point) {
    case "before-capability-invocation":
      return "pre";
    case "after-capability-invocation":
      return "post";
    default:
      return assertNever(point, "unhandled tool hook point");
  }
}

/**
 * Timeout/throw posture is owned by the hook point, not by the hook.
 * Pre-invocation is fail-closed so a hung hook cannot sneak execution through.
 * Post-invocation is fail-open so a hung hook cannot rewrite an observed result.
 */
export type ToolHookFailurePosture = "fail-closed" | "fail-open";

export function failurePostureForHookPoint(point: ToolHookPoint): ToolHookFailurePosture {
  switch (point) {
    case "before-capability-invocation":
      return "fail-closed";
    case "after-capability-invocation":
      return "fail-open";
    default:
      return assertNever(point, "unhandled tool hook point for posture");
  }
}

export const MAX_TOOL_HOOKS_PER_POINT = 32;
export const MAX_TOOL_HOOK_RECURSION_DEPTH = 1;
export const MAX_TOOL_HOOK_ANNOTATION_KEYS = 8;
export const MAX_TOOL_HOOK_ANNOTATION_VALUE_LENGTH = 120;
export const DEFAULT_TOOL_HOOK_TIMEOUT_MS = 50;
export const MAX_TOOL_HOOK_TIMEOUT_MS = 1_000;

export type ToolHookAnnotations = Readonly<Record<string, string>>;

export type ToolHookEnvelope = {
  readonly point: ToolHookPoint;
  readonly phase: ToolHookPhase;
  readonly invocationId: InvocationId;
  readonly capabilityId: CapabilityId;
  readonly catalogGeneration: ConfigurationGeneration;
  readonly registrationGeneration: ConfigurationGeneration;
  readonly deadline: Deadline | null;
  readonly recursionDepth: number;
  readonly reentryKey: string;
  /** Validated subject. Hooks cannot replace this object. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly observedOutcome: ToolInvocationOutcome | null;
};

export type ToolHookPreDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "annotate"; readonly annotations: ToolHookAnnotations }
  | { readonly kind: "transform"; readonly annotations: ToolHookAnnotations }
  | { readonly kind: "request-confirmation"; readonly reason: string }
  | { readonly kind: "deny"; readonly reason: string };

export type ToolHookFollowUp = {
  readonly code: string;
  readonly reason: string;
};

export type ToolHookPostDecision =
  | { readonly kind: "annotate"; readonly annotations: ToolHookAnnotations }
  | { readonly kind: "diagnostic"; readonly code: string; readonly level: DiagnosticLevel }
  | { readonly kind: "propose-follow-up"; readonly followUp: ToolHookFollowUp };

export type ToolHookDecision = ToolHookPreDecision | ToolHookPostDecision;

export type ToolHookFn = (
  envelope: ToolHookEnvelope,
) => ToolHookDecision | Promise<ToolHookDecision>;

export type RegisteredToolHook = {
  readonly id: string;
  readonly point: ToolHookPoint;
  readonly priority: number;
  readonly run: ToolHookFn;
};

export type ToolHookRegistryError =
  | { readonly code: "duplicate-hook"; readonly id: string }
  | { readonly code: "too-many-hooks"; readonly point: ToolHookPoint; readonly maximum: number }
  | { readonly code: "invalid-hook-id"; readonly id: string }
  | { readonly code: "invalid-priority"; readonly id: string };

export type ToolHookRegistry = {
  readonly schemaVersion: typeof TOOL_HOOK_SCHEMA_VERSION;
  readonly generation: ConfigurationGeneration;
  readonly hooks: readonly RegisteredToolHook[];
};

const LEGAL_HOOK_ID = /^[a-z][a-z0-9._-]{0,63}$/;

export function hooksForPoint(
  registry: ToolHookRegistry,
  point: ToolHookPoint,
): readonly RegisteredToolHook[] {
  return orderToolHooks(registry.hooks.filter((hook) => hook.point === point));
}

export function orderToolHooks(
  hooks: readonly RegisteredToolHook[],
): readonly RegisteredToolHook[] {
  return [...hooks].sort((left, right) => {
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    if (left.id !== right.id) {
      return left.id < right.id ? -1 : 1;
    }
    return 0;
  });
}

export function createToolHookRegistry(
  generation: ConfigurationGeneration,
  hooks: readonly RegisteredToolHook[],
): Result<ToolHookRegistry, ToolHookRegistryError> {
  const seen = new Set<string>();
  const perPoint = new Map<ToolHookPoint, number>();
  for (const hook of hooks) {
    if (!LEGAL_HOOK_ID.test(hook.id)) {
      return err({ code: "invalid-hook-id", id: hook.id });
    }
    if (!Number.isSafeInteger(hook.priority)) {
      return err({ code: "invalid-priority", id: hook.id });
    }
    if (seen.has(hook.id)) {
      return err({ code: "duplicate-hook", id: hook.id });
    }
    seen.add(hook.id);
    const count = (perPoint.get(hook.point) ?? 0) + 1;
    if (count > MAX_TOOL_HOOKS_PER_POINT) {
      return err({
        code: "too-many-hooks",
        point: hook.point,
        maximum: MAX_TOOL_HOOKS_PER_POINT,
      });
    }
    perPoint.set(hook.point, count);
  }
  return ok({
    schemaVersion: TOOL_HOOK_SCHEMA_VERSION,
    generation,
    hooks: orderToolHooks(hooks),
  });
}

export type BoundAnnotation = {
  readonly key: string;
  readonly value: string;
  readonly hookId: string;
};

export type ToolHookDiagnostic = {
  readonly code: string;
  readonly level: DiagnosticLevel;
  readonly hookId: string;
};

export type PreHookSettlement =
  | { readonly kind: "denied"; readonly reason: string; readonly hookId: string }
  | { readonly kind: "failed-closed"; readonly reason: string; readonly hookId: string }
  | {
      readonly kind: "confirmation-required";
      readonly reason: string;
      readonly hookId: string;
      readonly annotations: readonly BoundAnnotation[];
    }
  | { readonly kind: "allowed"; readonly annotations: readonly BoundAnnotation[] };

export type PostHookSettlement = {
  readonly kind: "recorded";
  readonly annotations: readonly BoundAnnotation[];
  readonly diagnostics: readonly ToolHookDiagnostic[];
  readonly followUps: readonly (ToolHookFollowUp & { readonly hookId: string })[];
  readonly failures: readonly { readonly hookId: string; readonly reason: string }[];
};

function boundAnnotations(
  hookId: string,
  annotations: ToolHookAnnotations,
): Result<
  readonly BoundAnnotation[],
  { readonly code: "annotation-bound"; readonly hookId: string }
> {
  const keys = Object.keys(annotations);
  if (keys.length > MAX_TOOL_HOOK_ANNOTATION_KEYS) {
    return err({ code: "annotation-bound", hookId });
  }
  const bound: BoundAnnotation[] = [];
  for (const key of keys) {
    const value = annotations[key];
    if (value === undefined || value.length > MAX_TOOL_HOOK_ANNOTATION_VALUE_LENGTH) {
      return err({ code: "annotation-bound", hookId });
    }
    bound.push({ key, value, hookId });
  }
  return ok(bound);
}

function mergeAnnotations(
  existing: readonly BoundAnnotation[],
  incoming: readonly BoundAnnotation[],
): Result<
  readonly BoundAnnotation[],
  { readonly code: "transform-conflict"; readonly key: string }
> {
  const byKey = new Map(existing.map((item) => [item.key, item] as const));
  for (const item of incoming) {
    const prior = byKey.get(item.key);
    if (prior !== undefined && prior.value !== item.value) {
      return err({ code: "transform-conflict", key: item.key });
    }
    byKey.set(item.key, item);
  }
  return ok([...byKey.values()]);
}

export type RecordedHookDecision = {
  readonly hookId: string;
  readonly decision: ToolHookDecision;
  readonly failed?: { readonly reason: string };
};

/**
 * Fold pre-hook decisions. Deny and fail-closed win. Confirmation is sticky.
 * Annotation/transform keys that disagree fail as a visible conflict.
 */
export function settlePreHookDecisions(
  recorded: readonly RecordedHookDecision[],
): PreHookSettlement | { readonly kind: "transform-conflict"; readonly key: string } {
  let annotations: readonly BoundAnnotation[] = [];
  let confirmation: { readonly reason: string; readonly hookId: string } | null = null;
  for (const item of recorded) {
    if (item.failed !== undefined) {
      return {
        kind: "failed-closed",
        reason: item.failed.reason,
        hookId: item.hookId,
      };
    }
    const decision = item.decision;
    switch (decision.kind) {
      case "deny":
        return { kind: "denied", reason: decision.reason, hookId: item.hookId };
      case "request-confirmation":
        confirmation = { reason: decision.reason, hookId: item.hookId };
        break;
      case "allow":
        break;
      case "annotate":
      case "transform": {
        const bound = boundAnnotations(item.hookId, decision.annotations);
        if (!bound.ok) {
          return { kind: "failed-closed", reason: bound.error.code, hookId: item.hookId };
        }
        const merged = mergeAnnotations(annotations, bound.value);
        if (!merged.ok) {
          return { kind: "transform-conflict", key: merged.error.key };
        }
        annotations = merged.value;
        break;
      }
      case "diagnostic":
      case "propose-follow-up":
        return {
          kind: "failed-closed",
          reason: "post-decision-on-pre-point",
          hookId: item.hookId,
        };
      default:
        return assertNever(decision, "unhandled pre-hook decision");
    }
  }
  if (confirmation !== null) {
    return {
      kind: "confirmation-required",
      reason: confirmation.reason,
      hookId: confirmation.hookId,
      annotations,
    };
  }
  return { kind: "allowed", annotations };
}

/**
 * Fold post-hook decisions. Observed terminals are not inputs and cannot be
 * rewritten. Failures are recorded; the settlement remains `recorded`.
 */
export function settlePostHookDecisions(
  recorded: readonly RecordedHookDecision[],
): PostHookSettlement | { readonly kind: "illegal-rewrite"; readonly hookId: string } {
  const annotations: BoundAnnotation[] = [];
  const diagnostics: ToolHookDiagnostic[] = [];
  const followUps: (ToolHookFollowUp & { readonly hookId: string })[] = [];
  const failures: { readonly hookId: string; readonly reason: string }[] = [];
  for (const item of recorded) {
    if (item.failed !== undefined) {
      failures.push({ hookId: item.hookId, reason: item.failed.reason });
      continue;
    }
    const decision = item.decision;
    switch (decision.kind) {
      case "annotate": {
        const bound = boundAnnotations(item.hookId, decision.annotations);
        if (!bound.ok) {
          failures.push({ hookId: item.hookId, reason: bound.error.code });
          break;
        }
        const merged = mergeAnnotations(annotations, bound.value);
        if (!merged.ok) {
          failures.push({ hookId: item.hookId, reason: `transform-conflict:${merged.error.key}` });
          break;
        }
        annotations.splice(0, annotations.length, ...merged.value);
        break;
      }
      case "diagnostic":
        diagnostics.push({ code: decision.code, level: decision.level, hookId: item.hookId });
        break;
      case "propose-follow-up":
        followUps.push({ ...decision.followUp, hookId: item.hookId });
        break;
      case "allow":
      case "transform":
      case "request-confirmation":
      case "deny":
        return { kind: "illegal-rewrite", hookId: item.hookId };
      default:
        return assertNever(decision, "unhandled post-hook decision");
    }
  }
  return { kind: "recorded", annotations, diagnostics, followUps, failures };
}

export type ToolLifecycleFact =
  | {
      readonly kind: "hook-point-entered";
      readonly at: Instant;
      readonly point: ToolHookPoint;
      readonly invocationId: InvocationId;
    }
  | {
      readonly kind: "hook-decided";
      readonly at: Instant;
      readonly point: ToolHookPoint;
      readonly invocationId: InvocationId;
      readonly hookId: string;
      readonly decisionKind: ToolHookDecision["kind"] | "failed";
    }
  | {
      readonly kind: "hook-point-settled";
      readonly at: Instant;
      readonly point: ToolHookPoint;
      readonly invocationId: InvocationId;
      readonly settlement:
        | PreHookSettlement["kind"]
        | PostHookSettlement["kind"]
        | "transform-conflict"
        | "illegal-rewrite"
        | "recursion-denied";
    };

export function isRecursionDenied(envelope: ToolHookEnvelope): boolean {
  return envelope.recursionDepth > MAX_TOOL_HOOK_RECURSION_DEPTH;
}
