/**
 * What the scheduler is asked to run.
 *
 * A work unit describes scheduling-relevant facts only: what it does to the
 * world, what it contends for, how urgent it is, and what it depends on. It
 * says nothing about *how* the work happens — the scheduler never learns what a
 * tool, a provider stream, or a background job is.
 *
 * The rule this module exists to protect: **independence is declared, never
 * inferred.** A mutation that names no conflict key is treated as contending
 * with everything, because the alternative is guessing that two writes do not
 * touch the same thing.
 */

import type { Deadline } from "./deadline.ts";
import type { ScopeId } from "./identity.ts";
import { err, ok, type Result } from "./result.ts";

declare const brand: unique symbol;

type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type WorkUnitId = Brand<string, "WorkUnitId">;

/**
 * A normalized name for something two units can contend over.
 *
 * Normalization is the point: `./a/b`, `a//b`, and `a/b/` are the same file, and
 * a scheduler that treated them as three keys would run three writers against
 * one path concurrently.
 */
export type ConflictKey = Brand<string, "ConflictKey">;

/**
 * What a unit does to the world.
 *
 * Only `observation` is ever parallelized without a declared key. The rest are
 * serialized on their keys, and a keyless mutation or external effect is
 * serialized globally.
 */
export const EFFECT_CLASSES = ["observation", "mutation", "external", "interactive"] as const;

export type EffectClass = (typeof EFFECT_CLASSES)[number];

/**
 * Queue order, highest first.
 *
 * Priority affects order only. It never grants a larger budget, a looser
 * deadline, or an exemption from a conflict key — a maintenance task and an
 * interactive one contending for the same file still run one at a time.
 */
export const PRIORITY_CLASSES = [
  "interactive",
  "active-turn",
  "user-visible-background",
  "maintenance",
] as const;

export type PriorityClass = (typeof PRIORITY_CLASSES)[number];

const PRIORITY_RANK: Readonly<Record<PriorityClass, number>> = {
  interactive: 0,
  "active-turn": 1,
  "user-visible-background": 2,
  maintenance: 3,
};

export function priorityRank(priority: PriorityClass): number {
  return PRIORITY_RANK[priority];
}

export function isPriorityClass(value: unknown): value is PriorityClass {
  return typeof value === "string" && (PRIORITY_CLASSES as readonly string[]).includes(value);
}

export function isEffectClass(value: unknown): value is EffectClass {
  return typeof value === "string" && (EFFECT_CLASSES as readonly string[]).includes(value);
}

export type RetryPolicy = {
  /** Total attempts, including the first. `1` means no retry. */
  readonly maxAttempts: number;
  /**
   * Whether a failure may be retried at all.
   *
   * Separate from `maxAttempts` because retryability is a property of the
   * operation's contract, while the attempt count is a budget.
   */
  readonly retryable: boolean;
};

export const NO_RETRY: RetryPolicy = { maxAttempts: 1, retryable: false };

export type WorkUnit = {
  readonly id: WorkUnitId;
  readonly effect: EffectClass;
  readonly priority: PriorityClass;
  /** Normalized keys this unit contends for. Empty means "declares nothing". */
  readonly conflictKeys: readonly ConflictKey[];
  /** Units that must reach a terminal state before this one may start. */
  readonly dependencies: readonly WorkUnitId[];
  /** Capped by the scope it runs under; it can never enlarge an inherited limit. */
  readonly deadline: Deadline | null;
  /** Used to reserve queue byte budget before the work runs. */
  readonly expectedOutputBytes: number;
  readonly retry: RetryPolicy;
  /** The cancellation scope this unit runs under, when it has one. */
  readonly scopeId: ScopeId | null;
};

export type WorkUnitError = {
  readonly kind: "work-unit";
  readonly code:
    | "identifier-empty"
    | "identifier-too-long"
    | "negative-output-bytes"
    | "invalid-attempt-count";
  readonly unitId: string;
};

/** Maximum length of a work-unit identifier or conflict key. */
export const MAX_WORK_IDENTIFIER_LENGTH = 512;

export function parseWorkUnitId(value: unknown): Result<WorkUnitId, WorkUnitError> {
  if (typeof value !== "string" || value.length === 0) {
    return err({ kind: "work-unit", code: "identifier-empty", unitId: "" });
  }
  if (value.length > MAX_WORK_IDENTIFIER_LENGTH) {
    return err({ kind: "work-unit", code: "identifier-too-long", unitId: "" });
  }
  return ok(value as WorkUnitId);
}

export function workUnitId(value: string): WorkUnitId {
  const parsed = parseWorkUnitId(value);
  if (!parsed.ok) {
    throw new Error(`invalid work unit id: ${parsed.error.code}`);
  }
  return parsed.value;
}

/**
 * Builds a normalized conflict key.
 *
 * `kind` names the resource family — `file`, `git`, `document`, `pty`,
 * `browser-page`, `account` — and `target` identifies one member of it.
 * Normalization collapses the spellings of a path that mean the same thing, so
 * equivalent targets produce one key and therefore one lock.
 */
export function conflictKey(kind: string, target: string): ConflictKey {
  const family = kind.trim().toLowerCase();
  const normalized = normalizeTarget(target);
  return `${family}:${normalized}` as ConflictKey;
}

function normalizeTarget(target: string): string {
  const collapsed = target
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  const segments: string[] = [];
  const absolute = collapsed.startsWith("/");

  for (const segment of collapsed.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      // Popping past the root would escape it, so an over-long `..` chain is
      // clamped rather than producing a key outside the resource family.
      if (segments.length > 0) {
        segments.pop();
      }
      continue;
    }
    segments.push(segment);
  }

  const joined = segments.join("/");
  return absolute ? `/${joined}` : joined;
}

/**
 * The keys a unit is serialized on.
 *
 * An observation with no declared key is genuinely independent and runs
 * concurrently. Anything else with no declared key gets the global key, because
 * an undeclared mutation is not evidence of independence — it is missing
 * metadata, and treating it as parallelizable is how two writers end up on one
 * file.
 */
export const GLOBAL_CONFLICT_KEY = "global:*" as ConflictKey;

export function effectiveConflictKeys(unit: WorkUnit): readonly ConflictKey[] {
  if (unit.conflictKeys.length > 0) {
    return unit.conflictKeys;
  }
  return unit.effect === "observation" ? [] : [GLOBAL_CONFLICT_KEY];
}

/** Whether a unit may run alongside others without any lock. */
export function isFreelyParallel(unit: WorkUnit): boolean {
  return effectiveConflictKeys(unit).length === 0;
}
