/**
 * Tool-pipeline hook points and lifecycle facts (#53).
 *
 * Built-in hooks observe or influence named capability-invocation points.
 * They never receive a runner, secrets, UI, or an unrestricted container, and
 * they cannot execute tools. Plugin adapters and other hook families remain
 * later owners.
 */

import { freezeMetadata } from "../extensions/canonical.ts";
import { type HookRegistration, hookRegistrationSchema } from "../extensions/hook-handlers.ts";
import {
  HOOK_BUDGETS,
  HOOK_LIMITS,
  HOOK_POINTS,
  type HookEnvelope,
  LIVE_TOOL_HOOK_POINTS,
} from "../extensions/hook-points.ts";
import type { HookDecision } from "../extensions/hook-protocol.ts";
import type { Instant } from "../foundation/clock.ts";
import type { Deadline } from "../foundation/deadline.ts";
import type {
  CapabilityId,
  ConfigurationGeneration,
  InvocationId,
} from "../foundation/identity.ts";
import { assertNever, err, ok, type Result } from "../foundation/result.ts";
import type { DiagnosticLevel } from "../terminal/diagnostics.ts";
import { type HookOrderMetadata, resolveHookOrder } from "./tool-hook-order.ts";
import type { ToolInvocationOutcome } from "./tool-pipeline.ts";

/** Schema version this build writes for tool-hook registries. */
export const TOOL_HOOK_SCHEMA_VERSION = 1;

export const TOOL_HOOK_POINTS = LIVE_TOOL_HOOK_POINTS;

export type ToolHookPoint = (typeof TOOL_HOOK_POINTS)[number];

export function isToolHookPoint(value: unknown): value is ToolHookPoint {
  return typeof value === "string" && (TOOL_HOOK_POINTS as readonly string[]).includes(value);
}

export const TOOL_HOOK_PHASES = ["pre", "post"] as const;

export type ToolHookPhase = (typeof TOOL_HOOK_PHASES)[number];

export function phaseForHookPoint(point: ToolHookPoint): ToolHookPhase {
  return HOOK_POINTS[point].phase as ToolHookPhase;
}

/**
 * Timeout/throw posture is owned by the hook point, not by the hook.
 * Pre-invocation is fail-closed so a hung hook cannot sneak execution through.
 * Post-invocation is fail-open so a hung hook cannot rewrite an observed result.
 */
export type ToolHookFailurePosture = "fail-closed" | "fail-open";

export function failurePostureForHookPoint(point: ToolHookPoint): ToolHookFailurePosture {
  return HOOK_POINTS[point].failurePosture;
}

export const MAX_TOOL_HOOKS_PER_POINT = HOOK_LIMITS.registrationsPerPoint;
export const MAX_TOOL_HOOK_RECURSION_DEPTH = HOOK_LIMITS.recursionDepth;
export const MAX_TOOL_HOOK_ANNOTATION_KEYS = HOOK_LIMITS.annotationKeys;
export const MAX_TOOL_HOOK_ANNOTATION_VALUE_LENGTH = HOOK_LIMITS.annotationValueLength;
export const DEFAULT_TOOL_HOOK_TIMEOUT_MS = HOOK_BUDGETS.local.defaultMs;
export const MAX_TOOL_HOOK_TIMEOUT_MS = HOOK_BUDGETS.local.maximumMs;

export type ToolHookAnnotations = Readonly<Record<string, string>>;

export type ToolHookEnvelope = {
  readonly catalog: HookEnvelope<ToolHookPoint>;
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

export type ToolHookDecision = ToolHookPreDecision | ToolHookPostDecision | HookDecision;

export type ToolHookFn = (
  envelope: ToolHookEnvelope,
  context: ToolHookContext,
) => ToolHookDecision | Promise<ToolHookDecision>;

export type ToolHookContext = {
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  readonly resourceTaskId: string;
};

export type RegisteredToolHook = HookOrderMetadata & {
  readonly id: string;
  readonly point: ToolHookPoint;
  readonly priority: number;
  readonly pointVersion?: 1;
  readonly run: ToolHookFn;
  readonly registration?: HookRegistration;
  /** Explicit revocation only. Replacing a registry does not abort this signal. */
  readonly revoked?: AbortSignal;
};

export type ToolHookRegistryError =
  | {
      readonly code:
        | "unknown-hook-point"
        | "incompatible-hook-version"
        | "hook-publisher-unavailable"
        | "invalid-hook-declaration"
        | "missing-hook-dependency"
        | "hook-dependency-cycle";
      readonly id: string;
    }
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
  return registry.hooks.filter((hook) => hook.point === point);
}

export function orderToolHooks(
  hooks: readonly RegisteredToolHook[],
): readonly RegisteredToolHook[] {
  return resolveHookOrder(hooks).hooks;
}

export function createToolHookRegistry(
  generation: ConfigurationGeneration,
  hooks: readonly RegisteredToolHook[],
): Result<ToolHookRegistry, ToolHookRegistryError> {
  const seen = new Set<string>();
  const perPoint = new Map<ToolHookPoint, number>();
  for (const hook of hooks) {
    if (!isToolHookPoint(hook.point))
      return err({
        code:
          typeof hook.point === "string" && Object.hasOwn(HOOK_POINTS, hook.point)
            ? "hook-publisher-unavailable"
            : "unknown-hook-point",
        id: hook.id,
      });
    if (
      Object.keys(hook).some(
        (key) =>
          ![
            "id",
            "point",
            "pointVersion",
            "priority",
            "run",
            "owner",
            "source",
            "after",
            "registration",
            "revoked",
          ].includes(key),
      ) ||
      typeof hook.run !== "function"
    )
      return err({ code: "invalid-hook-declaration", id: hook.id });
    if (hook.pointVersion !== undefined && hook.pointVersion !== TOOL_HOOK_SCHEMA_VERSION)
      return err({ code: "incompatible-hook-version", id: hook.id });
    if (!LEGAL_HOOK_ID.test(hook.id)) {
      return err({ code: "invalid-hook-id", id: hook.id });
    }
    if (!Number.isSafeInteger(hook.priority)) {
      return err({ code: "invalid-priority", id: hook.id });
    }
    const identity = `${hook.owner ?? "builtin"}/${hook.id}`;
    if (seen.has(identity)) {
      return err({ code: "duplicate-hook", id: hook.id });
    }
    seen.add(identity);
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
  const checkedOrder = resolveHookOrder(hooks);
  if (checkedOrder.error) return err(checkedOrder.error);
  const prepared: RegisteredToolHook[] = [];
  for (const hook of hooks) {
    const parsed = hookRegistrationSchema.safeParse(
      hook.registration ?? {
        version: 1,
        point: hook.point,
        pointVersion: 1,
        handler: { kind: "builtin", id: hook.id },
        mode: "sync",
      },
    );
    if (
      !parsed.success ||
      parsed.data.point !== hook.point ||
      (hook.revoked !== undefined && !(hook.revoked instanceof AbortSignal))
    )
      return err({ code: "invalid-hook-declaration", id: hook.id });
    prepared.push(
      Object.freeze({
        ...hook,
        pointVersion: TOOL_HOOK_SCHEMA_VERSION,
        after: Object.freeze([...(hook.after ?? [])]),
        registration: freezeMetadata(parsed.data),
      }),
    );
  }
  const ordered = resolveHookOrder(prepared);
  if (ordered.error) return err(ordered.error);
  return ok(
    Object.freeze({
      schemaVersion: TOOL_HOOK_SCHEMA_VERSION,
      generation,
      hooks: Object.freeze(ordered.hooks),
    }),
  );
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
      readonly input?: Readonly<Record<string, unknown>>;
      readonly reason: string;
      readonly hookId: string;
      readonly annotations: readonly BoundAnnotation[];
    }
  | {
      readonly kind: "allowed";
      readonly annotations: readonly BoundAnnotation[];
      readonly input?: Readonly<Record<string, unknown>>;
    };

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
  readonly execution?: {
    readonly position: number;
    readonly state: "settled" | "skipped" | "not-started" | "queued" | "dropped";
    readonly cleanup: "complete" | "uncertain" | "not-started";
    readonly elapsedMs: number;
  };
};

/**
 * Fold pre-hook decisions. Deny and fail-closed win. Confirmation is sticky.
 * Annotation/transform keys that disagree fail as a visible conflict.
 */
export function settlePreHookDecisions(
  recorded: readonly RecordedHookDecision[],
): PreHookSettlement | { readonly kind: "transform-conflict"; readonly key: string } {
  let annotations: readonly BoundAnnotation[] = [];
  const input: Record<string, unknown> = {};
  const transformed = new Set<string>();
  let confirmation: { readonly reason: string; readonly hookId: string } | null = null;
  for (const item of recorded) {
    if (item.execution?.state === "skipped" || item.execution?.state === "queued") continue;
    if (item.failed !== undefined) {
      return {
        kind: "failed-closed",
        reason: item.failed.reason,
        hookId: item.hookId,
      };
    }
    const decision = item.decision;
    switch (decision.kind) {
      case "veto":
      case "deny":
        return { kind: "denied", reason: decision.reason, hookId: item.hookId };
      case "external-effect-request":
        if (decision.request.kind === "confirmation")
          confirmation = { reason: decision.request.reason, hookId: item.hookId };
        break;
      case "request-confirmation":
        confirmation = { reason: decision.reason, hookId: item.hookId };
        break;
      case "allow":
        break;
      case "observe":
      case "annotate":
      case "transform": {
        if (decision.kind === "transform") {
          for (const key of Object.keys(decision.annotations ?? {})) {
            if (transformed.has(`annotations.${key}`)) return { kind: "transform-conflict", key };
            transformed.add(`annotations.${key}`);
          }
          if ("input" in decision && decision.input) {
            for (const [key, value] of Object.entries(decision.input)) {
              if (transformed.has(`input.${key}`))
                return { kind: "transform-conflict", key: `input.${key}` };
              transformed.add(`input.${key}`);
              input[key] = value;
              if (Object.keys(input).length > 8)
                return { kind: "failed-closed", reason: "input-patch-bound", hookId: item.hookId };
            }
          }
        }
        const bound = boundAnnotations(item.hookId, decision.annotations ?? {});
        if (!bound.ok) {
          return { kind: "failed-closed", reason: bound.error.code, hookId: item.hookId };
        }
        const merged = mergeAnnotations(annotations, bound.value);
        if (!merged.ok) {
          return { kind: "transform-conflict", key: merged.error.key };
        }
        if (merged.value.length > MAX_TOOL_HOOK_ANNOTATION_KEYS)
          return { kind: "failed-closed", reason: "annotation-bound", hookId: item.hookId };
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
      ...(Object.keys(input).length ? { input } : {}),
    };
  }
  return { kind: "allowed", annotations, ...(Object.keys(input).length ? { input } : {}) };
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
    if (item.execution?.state === "skipped" || item.execution?.state === "queued") continue;
    if (item.failed !== undefined) {
      failures.push({ hookId: item.hookId, reason: item.failed.reason });
      continue;
    }
    const decision = item.decision;
    switch (decision.kind) {
      case "observe":
      case "annotate": {
        const bound = boundAnnotations(item.hookId, decision.annotations ?? {});
        if (!bound.ok) {
          failures.push({ hookId: item.hookId, reason: bound.error.code });
          break;
        }
        const merged = mergeAnnotations(annotations, bound.value);
        if (!merged.ok) {
          failures.push({ hookId: item.hookId, reason: `transform-conflict:${merged.error.key}` });
          break;
        }
        if (merged.value.length > MAX_TOOL_HOOK_ANNOTATION_KEYS) {
          failures.push({ hookId: item.hookId, reason: "annotation-bound" });
          break;
        }
        annotations.splice(0, annotations.length, ...merged.value);
        break;
      }
      case "diagnostic":
        diagnostics.push({ code: decision.code, level: decision.level, hookId: item.hookId });
        break;
      case "external-effect-request":
        if (decision.request.kind === "follow-up")
          followUps.push({ ...decision.request, hookId: item.hookId });
        break;
      case "propose-follow-up":
        followUps.push({ ...decision.followUp, hookId: item.hookId });
        break;
      case "veto":
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

export function isRecursionDenied(envelope: Pick<ToolHookEnvelope, "recursionDepth">): boolean {
  return envelope.recursionDepth > MAX_TOOL_HOOK_RECURSION_DEPTH;
}
