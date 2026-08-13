/**
 * Tool-call pipeline contracts: proposal binding, effect class, and typed
 * invocation outcomes.
 *
 * Providers and UI never execute tools. A proposal is resolved against an
 * immutable catalog generation, validated, then handed to an application
 * runner. Validation failures have no effect. Cancellation during a mutation
 * reports uncertainty separately from a bare cancel.
 *
 * Iterative scheduling, concurrency caps, and turn coordination live in the
 * application tool-call loop (#44). Full manifests, stable identities, and the
 * capability registry live in `tool-registry.ts` (#48). Registry-backed
 * validate/normalize before dispatch lives in `tool-invocation.ts` (#49).
 * Policy and focused confirmation live in `tool-policy.ts` (#50). Scheduling,
 * cancel, timeout, and join live in `tool-schedule.ts` (#51). Typed results
 * live in `tool-result.ts` (#52). Lifecycle hook points live in `tool-hooks.ts`
 * (#53).
 */

import type { ZodType } from "zod";

import type { CapabilityId, ConfigurationGeneration, InvocationId } from "./identity.ts";
import type { EffectCertainty } from "./outcome.ts";
import { assertNever } from "./result.ts";
import type { ConflictKey, EffectClass } from "./work.ts";
import { isEffectClass } from "./work.ts";

/** Schema version this build writes for bound tool invocations. */
export const TOOL_PIPELINE_SCHEMA_VERSION = 1;

/** Default max tool proposals admitted in one iteration. */
export const DEFAULT_MAX_TOOL_CALLS_PER_ITERATION = 16;

/** Hard cap on tool proposals in one iteration (fail closed above this). */
export const MAX_TOOL_CALLS_PER_ITERATION = 64;

/** Default concurrent tool executions within one iteration. */
export const DEFAULT_MAX_CONCURRENT_TOOLS = 4;

/** Hard cap on concurrent tool executions. */
export const MAX_CONCURRENT_TOOLS = 16;

/** Default max model→tool cycles for one loop run. */
export const DEFAULT_MAX_TOOL_LOOP_ITERATIONS = 8;

/** Hard cap on model→tool cycles. */
export const MAX_TOOL_LOOP_ITERATIONS = 32;

/**
 * Provider-neutral tool proposal after stream assembly.
 *
 * Argument objects are already JSON-parsed; catalog validation happens here.
 */
export type ToolProposal = {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
};

/**
 * Immutable descriptor for one catalog generation.
 *
 * Updating configuration or extensions creates a new generation rather than
 * mutating an in-flight descriptor.
 */
export type ToolDescriptor = {
  readonly id: CapabilityId;
  readonly version: number;
  readonly name: string;
  readonly effect: EffectClass;
  readonly inputSchema: ZodType<Readonly<Record<string, unknown>>>;
  /** Optional conflict keys derived from validated input. */
  readonly conflictKeysFor?: (input: Readonly<Record<string, unknown>>) => readonly ConflictKey[];
  readonly expectedOutputBytes?: number;
};

export type ToolCatalog = {
  readonly generation: ConfigurationGeneration;
  resolve(name: string): ToolDescriptor | null;
};

export type BoundToolInvocation = {
  readonly schemaVersion: typeof TOOL_PIPELINE_SCHEMA_VERSION;
  readonly invocationId: InvocationId;
  readonly proposal: ToolProposal;
  readonly descriptor: ToolDescriptor;
  readonly input: Readonly<Record<string, unknown>>;
  readonly conflictKeys: readonly ConflictKey[];
};

export type ToolBindError =
  | {
      readonly code: "unknown-tool";
      readonly toolCallId: string;
      readonly name: string;
    }
  | {
      readonly code: "malformed-input";
      readonly toolCallId: string;
      readonly name: string;
      /** Structural Zod issue codes only — never rejected values. */
      readonly issues: readonly string[];
    }
  | { readonly code: "duplicate-tool-call-id"; readonly toolCallId: string }
  | { readonly code: "invalid-tool-call-id"; readonly toolCallId: string }
  | {
      readonly code: "queue-bound-exceeded";
      readonly maximum: number;
      readonly attempted: number;
    }
  | {
      readonly code: "invalid-descriptor";
      readonly name: string;
      readonly reason: "empty-name" | "invalid-version" | "invalid-effect";
    };

/**
 * Exhaustive per-invocation outcome after the runner returns (or binding fails
 * before execution).
 *
 * Pre-execution outcomes (`denied`, `unavailable`, `malformed`) always carry
 * `effect: "none"`.
 */
export type ToolInvocationOutcome =
  | {
      readonly status: "completed";
      readonly output: Readonly<Record<string, unknown>>;
      readonly effect: "completed";
    }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly effect: EffectCertainty;
    }
  | {
      readonly status: "cancelled";
      readonly effect: EffectCertainty;
    }
  | {
      readonly status: "timed-out";
      readonly effect: EffectCertainty;
    }
  | {
      readonly status: "uncertain";
      readonly effect: "uncertain";
      readonly recoveryHint: string;
    }
  | {
      readonly status: "denied";
      readonly reason: string;
      readonly effect: "none";
    }
  | {
      readonly status: "unavailable";
      readonly reason: string;
      readonly effect: "none";
    }
  | {
      readonly status: "malformed";
      readonly reason: string;
      readonly effect: "none";
    }
  | {
      readonly status: "partial";
      readonly output: Readonly<Record<string, unknown>>;
      readonly effect: EffectCertainty;
    };

export type ToolInvocationRecord = {
  readonly invocationId: InvocationId;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly capabilityId: CapabilityId | null;
  readonly effectClass: EffectClass | null;
  readonly outcome: ToolInvocationOutcome;
};

export function isToolInvocationStatus(value: unknown): value is ToolInvocationOutcome["status"] {
  return (
    typeof value === "string" &&
    (value === "completed" ||
      value === "failed" ||
      value === "cancelled" ||
      value === "timed-out" ||
      value === "uncertain" ||
      value === "denied" ||
      value === "unavailable" ||
      value === "malformed" ||
      value === "partial")
  );
}

/** Fold invocation effects; never downgrade uncertainty or partial. */
export function foldToolEffects(effects: readonly EffectCertainty[]): EffectCertainty {
  let worst: EffectCertainty = "none";
  for (const effect of effects) {
    worst = worseEffect(worst, effect);
  }
  return worst;
}

function worseEffect(left: EffectCertainty, right: EffectCertainty): EffectCertainty {
  const rank: Readonly<Record<EffectCertainty, number>> = {
    none: 0,
    completed: 1,
    partial: 2,
    uncertain: 3,
  };
  return rank[right] > rank[left] ? right : left;
}

export function effectOfToolOutcome(outcome: ToolInvocationOutcome): EffectCertainty {
  switch (outcome.status) {
    case "completed":
      return "completed";
    case "failed":
    case "cancelled":
    case "timed-out":
    case "partial":
      return outcome.effect;
    case "uncertain":
      return "uncertain";
    case "denied":
    case "unavailable":
    case "malformed":
      return "none";
    default:
      return assertNever(outcome, "unhandled tool invocation outcome");
  }
}

export type BindToolProposalsOptions = {
  readonly catalog: ToolCatalog;
  readonly proposals: readonly ToolProposal[];
  readonly maxQueued: number;
  /** Stable id factory; one id per successfully bound proposal. */
  readonly nextInvocationId: (proposal: ToolProposal) => InvocationId;
};

export type BindToolProposalsResult =
  | { readonly ok: true; readonly value: readonly BoundToolInvocation[] }
  | { readonly ok: false; readonly error: ToolBindError };

/**
 * Resolve and validate proposals against the catalog. Fail closed on queue
 * bounds, duplicates, unknown tools, or schema failures.
 */
export function bindToolProposals(options: BindToolProposalsOptions): BindToolProposalsResult {
  const { catalog, proposals, maxQueued, nextInvocationId } = options;

  if (proposals.length > maxQueued) {
    return {
      ok: false,
      error: {
        code: "queue-bound-exceeded",
        maximum: maxQueued,
        attempted: proposals.length,
      },
    };
  }

  const seen = new Set<string>();
  const bound: BoundToolInvocation[] = [];

  for (const proposal of proposals) {
    if (proposal.toolCallId.length === 0 || !/^[!-~]+$/.test(proposal.toolCallId)) {
      return {
        ok: false,
        error: { code: "invalid-tool-call-id", toolCallId: proposal.toolCallId },
      };
    }
    if (seen.has(proposal.toolCallId)) {
      return {
        ok: false,
        error: { code: "duplicate-tool-call-id", toolCallId: proposal.toolCallId },
      };
    }
    seen.add(proposal.toolCallId);

    if (proposal.name.length === 0) {
      return {
        ok: false,
        error: {
          code: "unknown-tool",
          toolCallId: proposal.toolCallId,
          name: proposal.name,
        },
      };
    }

    const descriptor = catalog.resolve(proposal.name);
    if (descriptor === null) {
      return {
        ok: false,
        error: {
          code: "unknown-tool",
          toolCallId: proposal.toolCallId,
          name: proposal.name,
        },
      };
    }

    const descriptorError = validateDescriptor(descriptor);
    if (descriptorError !== null) {
      return { ok: false, error: descriptorError };
    }

    const parsed = descriptor.inputSchema.safeParse(proposal.arguments);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "malformed-input",
          toolCallId: proposal.toolCallId,
          name: proposal.name,
          issues: parsed.error.issues.map((issue) => issue.code),
        },
      };
    }

    const input = parsed.data;
    const conflictKeys = descriptor.conflictKeysFor?.(input) ?? [];

    bound.push({
      schemaVersion: TOOL_PIPELINE_SCHEMA_VERSION,
      invocationId: nextInvocationId(proposal),
      proposal,
      descriptor,
      input,
      conflictKeys,
    });
  }

  return { ok: true, value: bound };
}

function validateDescriptor(descriptor: ToolDescriptor): ToolBindError | null {
  if (descriptor.name.length === 0) {
    return {
      code: "invalid-descriptor",
      name: descriptor.name,
      reason: "empty-name",
    };
  }
  if (!Number.isInteger(descriptor.version) || descriptor.version < 1) {
    return {
      code: "invalid-descriptor",
      name: descriptor.name,
      reason: "invalid-version",
    };
  }
  if (!isEffectClass(descriptor.effect)) {
    return {
      code: "invalid-descriptor",
      name: descriptor.name,
      reason: "invalid-effect",
    };
  }
  return null;
}

/** Build a catalog from an immutable descriptor list for one generation. */
export function createToolCatalog(
  generation: ConfigurationGeneration,
  descriptors: readonly ToolDescriptor[],
): ToolCatalog {
  const byName = new Map<string, ToolDescriptor>();
  for (const descriptor of descriptors) {
    if (byName.has(descriptor.name)) {
      throw new Error(`duplicate tool catalog name: ${descriptor.name}`);
    }
    byName.set(descriptor.name, descriptor);
  }
  return {
    generation,
    resolve(name: string): ToolDescriptor | null {
      return byName.get(name) ?? null;
    },
  };
}
