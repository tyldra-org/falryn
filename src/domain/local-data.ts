/**
 * Where Falryn's local data lives, who owns each part of it, and what removing
 * any part of it means.
 *
 * Three rules the types carry rather than document:
 *
 * - **A class is registered by its owner, never declared on its behalf.** The
 *   vocabulary below is the documented set of ownership classes; membership in
 *   it is not registration. A class no owner registered is refused by removal
 *   rather than guessed at, because guessing means deleting bytes whose
 *   lifecycle nobody claimed.
 * - **Removal is a plan first and an effect second.** A plan names every class,
 *   its exact paths, its counts, and what stays out of scope. Execution is
 *   bound to that exact plan, so a confirmation can never authorize a different
 *   deletion than the one that was shown.
 * - **Deleted, retained, and failed are three separate facts.** Collapsing them
 *   into a success flag is how a partial deletion gets reported as a clean one.
 */

import type { LocalPath } from "./filesystem.ts";
import type { Brand } from "./identity.ts";
import type { EffectCertainty } from "./outcome.ts";

/**
 * The separate roots Falryn resolves.
 *
 * Durable user data and rebuildable caches never share a root, because they
 * must never share deletion semantics.
 */
export const LOCAL_DATA_ROOTS = [
  "configuration",
  "state",
  "cache",
  "logs",
  "temporaryIngest",
  "artifacts",
  "exports",
] as const;

export type LocalDataRoot = (typeof LOCAL_DATA_ROOTS)[number];

export function isLocalDataRoot(value: unknown): value is LocalDataRoot {
  return typeof value === "string" && (LOCAL_DATA_ROOTS as readonly string[]).includes(value);
}

/**
 * The documented ownership classes.
 *
 * This is a vocabulary, not an inventory. Which of these exist on a machine is
 * decided by which owners registered them.
 */
export const OWNERSHIP_CLASSES = [
  "configuration",
  "credentials",
  "sqliteState",
  "artifacts",
  "memory",
  "cache",
  "logs",
  "temporaryIngest",
  "extensions",
  "exports",
] as const;

export type OwnershipClass = (typeof OWNERSHIP_CLASSES)[number];

export function isOwnershipClass(value: unknown): value is OwnershipClass {
  return typeof value === "string" && (OWNERSHIP_CLASSES as readonly string[]).includes(value);
}

/** How long content is meant to survive, and who authored it. */
export const DURABILITY_CLASSES = [
  "user-authored",
  "external-secure",
  "app-owned",
  "app-owned-reviewable",
  "rebuildable",
  "rotating",
  "recoverable",
  "user-created",
] as const;

export type DurabilityClass = (typeof DURABILITY_CLASSES)[number];

/** What removing this class is allowed to mean. */
export const REMOVAL_POSTURES = [
  "preserve-unless-selected",
  "separate-action",
  "export-before-reset",
  "scoped-reset",
  "inspect-correct-forget",
  "safe-cleanup",
  "retention-cleanup",
  "startup-reconciliation",
  "lifecycle-aware",
  "never-implicit",
] as const;

export type RemovalPosture = (typeof REMOVAL_POSTURES)[number];

/**
 * One owner's claim on one class.
 *
 * `roots` may be empty, and `external` says why: a credential lives in an
 * operating-system keychain, so the class is real, has a removal posture, and
 * owns no bytes inside these roots. Removal names it and does not touch it.
 */
export type OwnershipRegistration = {
  readonly ownershipClass: OwnershipClass;
  /** The owner that registered it, named in every plan. */
  readonly owner: string;
  readonly durability: DurabilityClass;
  readonly removalPosture: RemovalPosture;
  readonly roots: readonly LocalDataRoot[];
  /** Whether the bytes live outside Falryn's roots entirely. */
  readonly external: boolean;
};

export type RegistrationErrorCode =
  | "class-already-registered"
  | "unknown-ownership-class"
  | "external-class-declares-roots"
  | "owned-class-declares-no-root";

export type RegistrationError = {
  readonly kind: "ownership-registration";
  readonly code: RegistrationErrorCode;
  readonly ownershipClass: string;
};

/** Which platform's layout was used. */
export const LOCAL_DATA_PLATFORMS = ["darwin", "linux", "win32"] as const;

export type LocalDataPlatform = (typeof LOCAL_DATA_PLATFORMS)[number];

export type RootProvenance = "platform-default" | "environment-override";

export type ResolvedRoot = {
  readonly root: LocalDataRoot;
  readonly path: LocalPath;
  readonly provenance: RootProvenance;
  /** The variable that overrides this root, whether or not it was set. */
  readonly environmentVariable: string;
};

export type RootLayout = {
  readonly platform: LocalDataPlatform;
  /**
   * Whether this platform's layout has been verified on the actual target.
   *
   * An unqualified layout still resolves; it simply carries no claim that it
   * was tested there. Declaring it is what keeps the layout from being
   * accidentally shaped by one operating system.
   */
  readonly qualified: boolean;
  readonly roots: readonly ResolvedRoot[];
};

/**
 * What preparing a root found.
 *
 * Every code other than `created` and `existed` is a diagnostic, never a
 * repair. Silently widening permissions or replacing a file with a directory
 * would destroy the evidence that something else is using that path.
 */
export const ROOT_STATUS_CODES = [
  "created",
  "existed",
  "not-a-directory",
  "not-writable",
  "insecure-permissions",
  "unavailable",
] as const;

export type RootStatusCode = (typeof ROOT_STATUS_CODES)[number];

export type RootStatus = {
  readonly root: LocalDataRoot;
  readonly path: LocalPath;
  readonly code: RootStatusCode;
  readonly expectedMode: number;
  /** Bits observed on an existing directory, or `null` when there is none. */
  readonly observedMode: number | null;
};

export function isRootUsable(status: RootStatus): boolean {
  return status.code === "created" || status.code === "existed";
}

/**
 * Whether a root can hold data, without creating anything to find out.
 *
 * Four states rather than a boolean, because the two that a boolean would merge
 * are the two a reader most needs apart: a root that does not exist yet is the
 * normal first-run state, and a root that is a regular file is a fault. Calling
 * both "not usable" is how a diagnostic tells someone their machine is fine
 * when it cannot persist anything.
 *
 * `unknown` is its own state for the same reason `EffectCertainty` has one: a
 * probe that did not complete has not established health, and reporting it as
 * `ready` is a claim the probe never made.
 */
export const ROOT_VIABILITIES = ["ready", "absent", "blocked", "unknown"] as const;

export type RootViability = (typeof ROOT_VIABILITIES)[number];

/**
 * Why a root is not ready.
 *
 * `insecure-permissions` appears on a `ready` root rather than a blocked one,
 * matching preparation: it describes a directory that works and should not,
 * not one that cannot hold data.
 */
export const ROOT_VIABILITY_CODES = [
  "not-a-directory",
  "not-writable",
  "parent-not-writable",
  "dangling-symlink",
  "insecure-permissions",
] as const;

export type RootViabilityCode = (typeof ROOT_VIABILITY_CODES)[number];

export type RootInspection = {
  readonly root: LocalDataRoot;
  readonly path: LocalPath;
  readonly viability: RootViability;
  /**
   * Why this root is not `ready`, or the advisory finding on one that is.
   *
   * A {@link RootViabilityCode} for a state this probe diagnosed, and the
   * boundary's own code when the viability is `unknown` — a probe that failed
   * reports what the filesystem said rather than a verdict it did not reach.
   */
  readonly code: string | null;
  /** Bits observed on an existing directory, or `null` when there is none. */
  readonly observedMode: number | null;
};

/**
 * Whether this root's state prevents Falryn from holding data there.
 *
 * `absent` is deliberately not blocking: the first run that needs the root will
 * create it, and reporting a fresh machine as faulty would train a reader to
 * ignore the finding that matters.
 */
export function blocksLocalData(inspection: RootInspection): boolean {
  return inspection.viability === "blocked" || inspection.viability === "unknown";
}

/** Whether a measurement saw everything, or stopped at its bound. */
export type MeasurementCompleteness = "complete" | "partial";

export type ClassUsage = {
  readonly ownershipClass: OwnershipClass;
  readonly owner: string;
  readonly byteCount: number;
  readonly itemCount: number;
  readonly roots: readonly LocalDataRoot[];
  readonly completeness: MeasurementCompleteness;
};

/**
 * Whether a class is inside its budget.
 *
 * `unmeasured` is distinct from `within`: a class whose walk stopped at its
 * bound has no verdict, and reporting one would be an invented fact.
 */
export const QUOTA_PRESSURES = ["within", "at", "over", "unmeasured"] as const;

export type QuotaPressure = (typeof QUOTA_PRESSURES)[number];

/** The bounds a class is weighed against. Supplied by configuration. */
export type ClassBudget = {
  /** Bytes, or `null` for no byte budget. */
  readonly maxBytes: number | null;
  /** Items, or `null` for no item budget. */
  readonly maxItems: number | null;
};

export type RetentionPolicy = {
  readonly byClass: Readonly<Partial<Record<OwnershipClass, ClassBudget>>>;
  readonly totalMaxBytes: number | null;
};

export type ClassPressure = {
  readonly ownershipClass: OwnershipClass;
  readonly bytes: QuotaPressure;
  readonly items: QuotaPressure;
};

/**
 * What the roots currently hold.
 *
 * Reporting only. Retention is described here and enforced by the owner that
 * writes the bytes, so a report can never delete anything as a side effect.
 */
export type RetentionReport = {
  readonly classes: readonly ClassUsage[];
  readonly totalBytes: number;
  readonly totalItems: number;
  readonly pressure: readonly ClassPressure[];
  readonly totalPressure: QuotaPressure;
  /** Classes in the vocabulary that no owner registered. */
  readonly unregistered: readonly OwnershipClass[];
};

export type RemovalKind = "reset" | "uninstall";

/**
 * A plan's identity.
 *
 * Derived from the plan's exact content, so a confirmation carrying it can only
 * authorize the plan that was shown. It detects a changed plan; it is not a
 * security control and defends against nothing adversarial.
 */
export type PlanId = Brand<string, "PlanId">;

export const PLANNED_ACTIONS = ["delete", "preserve", "out-of-scope"] as const;

export type PlannedAction = (typeof PLANNED_ACTIONS)[number];

export const PLANNED_REASONS = [
  "selected",
  "not-selected",
  "external-store",
  "user-created",
  "no-owner-registered",
  "root-unavailable",
] as const;

export type PlannedReason = (typeof PLANNED_REASONS)[number];

export type PlannedClass = {
  readonly ownershipClass: OwnershipClass;
  /** `null` when no owner registered the class. */
  readonly owner: string | null;
  readonly removalPosture: RemovalPosture | null;
  readonly action: PlannedAction;
  readonly reason: PlannedReason;
  /** Exact paths this entry covers. Empty for an external or unowned class. */
  readonly paths: readonly LocalPath[];
  readonly byteCount: number;
  readonly itemCount: number;
};

/**
 * What uninstall will never touch.
 *
 * Bounded by contract rather than by whatever the traversal happens to reach.
 * The list appears in every plan so the blast radius is stated rather than
 * inferred from the absence of a path.
 */
export const OUT_OF_SCOPE_CATEGORIES = [
  "projects",
  "unrelated-repositories",
  "shell-startup-files",
  "package-manager-resources",
  "user-exports",
  "installed-executable",
] as const;

export type OutOfScopeCategory = (typeof OUT_OF_SCOPE_CATEGORIES)[number];

export type RemovalPlan = {
  readonly kind: RemovalKind;
  readonly planId: PlanId;
  readonly classes: readonly PlannedClass[];
  readonly outOfScope: readonly OutOfScopeCategory[];
  readonly totalBytes: number;
  readonly totalItems: number;
  /** Whether every class in the plan measured completely. */
  readonly completeness: MeasurementCompleteness;
};

/** Execution is authorized for one exact plan. */
export type RemovalConfirmation = {
  readonly planId: PlanId;
};

export type RemovalRefusal =
  /** The confirmation names a different plan than the one supplied. */
  | {
      readonly code: "plan-mismatch";
      readonly expected: PlanId;
      readonly confirmed: PlanId;
    }
  | { readonly code: "cancelled" };

export const RETENTION_REASONS = [
  "preserved-by-plan",
  "out-of-scope",
  "escapes-registered-root",
  "unregistered-class",
  /**
   * Execution stopped before it got here.
   *
   * Distinct from every reason above, all of which mean the plan decided this
   * path stays. This one means nothing decided anything — the run was cancelled
   * or hit a bound — and reporting it as a deliberate exclusion would tell a
   * user their data was spared on purpose when it was merely missed.
   */
  "not-reached",
] as const;

export type RetentionReason = (typeof RETENTION_REASONS)[number];

export type RetainedPath = {
  readonly path: LocalPath;
  readonly reason: RetentionReason;
};

export type FailedPath = {
  readonly path: LocalPath;
  readonly code: string;
};

/**
 * What execution actually did.
 *
 * `effect` uses the runtime's own certainty vocabulary, so a partially applied
 * removal reports `partial` in the same terms every other Falryn operation
 * does, rather than inventing a second way to say "some of it happened".
 */
export type RemovalOutcome = {
  readonly planId: PlanId;
  readonly kind: RemovalKind;
  readonly deleted: readonly LocalPath[];
  readonly retained: readonly RetainedPath[];
  readonly failed: readonly FailedPath[];
  /**
   * Whether execution reached everything the plan named.
   *
   * `partial` after a cancellation or a bound, even when nothing failed. The
   * plan carries the same field for its measurement; an outcome needs it for
   * the same reason — a run that stopped early has not disproved anything about
   * the paths it never looked at.
   */
  readonly completeness: MeasurementCompleteness;
  readonly effect: EffectCertainty;
};

/**
 * Who wrote a temporary-ingest entry, as far as its name can say.
 *
 * `artifact-ingest` is claimed by the naming convention artifact ingest writes
 * under; anything else is `unknown` rather than guessed at. Naming an owner is
 * not a claim that the write finished — that stays knowable only from the
 * record beside it — it is what makes the entry addressable by the owner that
 * can decide.
 */
export const TEMPORARY_INGEST_OWNERS = ["artifact-ingest", "unknown"] as const;

export type TemporaryIngestOwner = (typeof TEMPORARY_INGEST_OWNERS)[number];

/**
 * What startup found in temporary ingest.
 *
 * Every entry is recorded as uncertain and nothing is removed. Whether a
 * temporary file represents finished work is knowable only by the owner that
 * wrote it, so this reports what is there, names the owner when the entry says
 * who it is, and refuses to conclude anything about its completeness.
 */
export type ReconciledEntry = {
  readonly path: LocalPath;
  readonly kind: string;
  readonly byteLength: number;
  readonly owner: TemporaryIngestOwner;
};

export type ReconciliationReport = {
  readonly root: LocalPath;
  readonly entries: readonly ReconciledEntry[];
  readonly completeness: MeasurementCompleteness;
  /** `uncertain` whenever anything was found, `none` when the root was empty. */
  readonly effect: EffectCertainty;
};
