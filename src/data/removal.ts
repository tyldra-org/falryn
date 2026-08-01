/**
 * Reset and uninstall: a plan, then a confirmed and bounded executor.
 *
 * Nothing here deletes without first having produced a plan that names every
 * class, its exact paths, its counts, what is preserved, and what is out of
 * scope — and without a confirmation carrying that exact plan's identity. A
 * confirmation that cannot be bound to a specific plan is a confirmation of
 * whatever the code decides to do next, which is not consent.
 *
 * Four rules the executor holds regardless of what the plan says:
 *
 * - **It stays inside registered roots.** Every path is re-checked against the
 *   layout at delete time, not only at plan time.
 * - **It does not follow a symlink out.** A link is removed as a link; a link
 *   whose target lies outside its root is never descended into, so a link
 *   planted in a cache cannot turn a reset into a deletion of someone's home
 *   directory.
 * - **It is idempotent.** A path already gone is not a failure, so re-running a
 *   partially completed reset converges instead of reporting phantom errors.
 * - **It reports deleted, retained, and failed separately.** A partial removal
 *   that reported success would leave a user believing bytes are gone that are
 *   still on disk.
 */

import {
  type EffectCertainty,
  err,
  type FailedPath,
  type FileSystemPort,
  isInside,
  type LocalPath,
  type MeasurementCompleteness,
  OUT_OF_SCOPE_CATEGORIES,
  type OwnershipClass,
  type OwnershipRegistration,
  ok,
  type PlanId,
  type PlannedClass,
  type RemovalConfirmation,
  type RemovalKind,
  type RemovalOutcome,
  type RemovalPlan,
  type RemovalRefusal,
  type Result,
  type RetainedPath,
  type RootLayout,
} from "../domain/index.ts";
import { MAX_MEASURED_ENTRIES, measureClass, owningRoot, pathsForClass } from "./retention.ts";

/**
 * Re-reads the abort flag without letting the compiler narrow it away.
 *
 * `AbortSignal.aborted` is a mutable getter, but it is typed as a readonly
 * property, so a direct `signal?.aborted === true` early in a function narrows
 * every later read of it to `false` and TypeScript rejects the re-check as
 * unreachable. Reading it through a call is what keeps the second and third
 * checks — the ones that catch an abort arriving mid-run — real.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Entries one execution will visit. Bounds the work a plan can authorize. */
export const MAX_REMOVED_ENTRIES = 200_000;

/** Directory depth one execution will descend. */
export const MAX_REMOVAL_DEPTH = 32;

/**
 * A plan's identity, derived from its content.
 *
 * FNV-1a over the plan's canonical rendering. It exists to detect a plan that
 * changed between being shown and being confirmed; it is not a security control
 * and resists nothing adversarial. Anything that could forge it could call the
 * executor directly.
 */
export function computePlanId(kind: RemovalKind, classes: readonly PlannedClass[]): PlanId {
  const canonical = [
    kind,
    ...classes.map((entry) =>
      [
        entry.ownershipClass,
        entry.action,
        entry.reason,
        entry.byteCount,
        entry.itemCount,
        ...entry.paths,
      ].join(":"),
    ),
  ].join("|");

  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `plan-${kind}-${hash.toString(16).padStart(8, "0")}-${canonical.length}` as PlanId;
}

export type PlanInputs = {
  readonly fileSystem: FileSystemPort;
  readonly layout: RootLayout;
  readonly registrations: readonly OwnershipRegistration[];
  readonly unregistered: readonly OwnershipClass[];
};

/**
 * Which classes a reset was asked to remove.
 *
 * Reset is explicitly selective. Uninstall selects every registered class that
 * owns bytes here, which is why it takes no selection.
 */
export type ResetSelection = {
  readonly classes: readonly OwnershipClass[];
};

type PlannedClasses = {
  readonly classes: readonly PlannedClass[];
  readonly completeness: MeasurementCompleteness;
};

async function planClasses(
  inputs: PlanInputs,
  selected: (registration: OwnershipRegistration) => boolean,
  signal?: AbortSignal,
): Promise<PlannedClasses> {
  const budget = { remaining: MAX_MEASURED_ENTRIES };
  const planned: PlannedClass[] = [];
  let completeness: MeasurementCompleteness = "complete";

  for (const registration of inputs.registrations) {
    if (registration.external) {
      // Named, never touched. Removing a local reference, deleting the secret,
      // and revoking it remotely are three different actions, and none of them
      // is a side effect of clearing local data.
      planned.push({
        ownershipClass: registration.ownershipClass,
        owner: registration.owner,
        removalPosture: registration.removalPosture,
        action: "out-of-scope",
        reason: "external-store",
        paths: [],
        byteCount: 0,
        itemCount: 0,
      });
      continue;
    }

    const usage = await measureClass(
      inputs.fileSystem,
      inputs.layout,
      registration,
      budget,
      signal,
    );
    const paths = pathsForClass(inputs.layout, registration);
    if (usage.completeness === "partial") {
      completeness = "partial";
    }

    if (registration.durability === "user-created") {
      // A user's own exports are never removed implicitly, by either action.
      planned.push({
        ownershipClass: registration.ownershipClass,
        owner: registration.owner,
        removalPosture: registration.removalPosture,
        action: "out-of-scope",
        reason: "user-created",
        paths,
        byteCount: usage.byteCount,
        itemCount: usage.itemCount,
      });
      continue;
    }

    const chosen = selected(registration);
    planned.push({
      ownershipClass: registration.ownershipClass,
      owner: registration.owner,
      removalPosture: registration.removalPosture,
      action: chosen ? "delete" : "preserve",
      reason: chosen ? "selected" : "not-selected",
      paths,
      byteCount: usage.byteCount,
      itemCount: usage.itemCount,
    });
  }

  for (const ownershipClass of inputs.unregistered) {
    // Present in the vocabulary, claimed by nobody. It appears in the plan as
    // untouchable so the gap is visible rather than silently absent.
    planned.push({
      ownershipClass,
      owner: null,
      removalPosture: null,
      action: "out-of-scope",
      reason: "no-owner-registered",
      paths: [],
      byteCount: 0,
      itemCount: 0,
    });
  }

  return { classes: planned, completeness };
}

function assemble(kind: RemovalKind, planned: PlannedClasses): RemovalPlan {
  const deleting = planned.classes.filter((entry) => entry.action === "delete");
  return {
    kind,
    planId: computePlanId(kind, planned.classes),
    classes: planned.classes,
    outOfScope: [...OUT_OF_SCOPE_CATEGORIES],
    totalBytes: deleting.reduce((sum, entry) => sum + entry.byteCount, 0),
    totalItems: deleting.reduce((sum, entry) => sum + entry.itemCount, 0),
    // A plan built on a partial measurement says so, so a caller is never shown
    // a total that the walk did not actually reach.
    completeness: planned.completeness,
  };
}

/** Plans a reset over exactly the classes the caller selected. */
export async function planReset(
  inputs: PlanInputs,
  selection: ResetSelection,
  signal?: AbortSignal,
): Promise<RemovalPlan> {
  const planned = await planClasses(
    inputs,
    (registration) => selection.classes.includes(registration.ownershipClass),
    signal,
  );
  return assemble("reset", planned);
}

/**
 * Plans an uninstall over every registered class that owns bytes here.
 *
 * Its blast radius is bounded by what owners registered, not by what the
 * traversal happens to reach. Projects, unrelated repositories, shell startup
 * files, package-manager resources, user exports, and the installed executable
 * are outside every root and are named in `outOfScope` so their absence is a
 * statement rather than an omission.
 */
export async function planUninstall(
  inputs: PlanInputs,
  signal?: AbortSignal,
): Promise<RemovalPlan> {
  const planned = await planClasses(inputs, () => true, signal);
  return assemble("uninstall", planned);
}

type Collected = {
  readonly deleted: LocalPath[];
  readonly retained: RetainedPath[];
  readonly failed: FailedPath[];
  /** Set when a cancellation or a bound stopped the walk before it finished. */
  stoppedEarly: boolean;
};

/**
 * Applies a plan, bound to that plan's identity.
 *
 * The plan is re-derived from its own classes before anything is touched, so a
 * caller cannot hand over a plan whose `planId` was edited to match a
 * confirmation for something else.
 *
 * Cancellation after the first deletion returns an outcome rather than a
 * refusal. A refusal would say the operation did not happen, and by then some
 * bytes are already gone — so the run reports what it deleted, marks itself
 * `partial`, and records everything it never reached as `not-reached` rather
 * than as a path the plan chose to keep.
 */
export async function executeRemoval(
  fileSystem: FileSystemPort,
  layout: RootLayout,
  plan: RemovalPlan,
  confirmation: RemovalConfirmation,
  signal?: AbortSignal,
): Promise<Result<RemovalOutcome, RemovalRefusal>> {
  const expected = computePlanId(plan.kind, plan.classes);
  if (expected !== confirmation.planId || expected !== plan.planId) {
    return err({ code: "plan-mismatch", expected, confirmed: confirmation.planId });
  }
  if (isAborted(signal)) {
    return err({ code: "cancelled" });
  }

  const collected: Collected = { deleted: [], retained: [], failed: [], stoppedEarly: false };
  const budget = { remaining: MAX_REMOVED_ENTRIES };

  for (const entry of plan.classes) {
    if (entry.action !== "delete") {
      for (const path of entry.paths) {
        collected.retained.push({
          path,
          reason: entry.reason === "no-owner-registered" ? "unregistered-class" : reasonFor(entry),
        });
      }
      continue;
    }
    for (const path of entry.paths) {
      // Checked per class, not once before the loop. An abort that lands
      // between two classes would otherwise leave the remaining ones silently
      // absent from a report that claimed to be complete.
      if (isAborted(signal)) {
        collected.stoppedEarly = true;
        collected.retained.push({ path, reason: "not-reached" });
        continue;
      }
      await removeTree(fileSystem, layout, path, collected, budget, 0, signal);
    }
  }

  return ok({
    planId: plan.planId,
    kind: plan.kind,
    deleted: collected.deleted,
    retained: collected.retained,
    failed: collected.failed,
    completeness: collected.stoppedEarly ? "partial" : "complete",
    effect: effectFor(collected),
  });
}

function reasonFor(entry: PlannedClass): RetainedPath["reason"] {
  return entry.action === "out-of-scope" ? "out-of-scope" : "preserved-by-plan";
}

/**
 * Deleted, retained, failed, and stopped-early, folded into one certainty.
 *
 * Anything that failed *or was never reached* after something else was deleted
 * is `partial`, never `completed`: some bytes are gone and some are not, and
 * that is precisely the state a caller must not mistake for either extreme. A
 * run that stopped before deleting anything changed nothing, which is `none`.
 */
function effectFor(collected: Collected): EffectCertainty {
  const changedSomething = collected.deleted.length > 0;
  if (collected.failed.length > 0 || collected.stoppedEarly) {
    return changedSomething ? "partial" : "none";
  }
  return changedSomething ? "completed" : "none";
}

async function removeTree(
  fileSystem: FileSystemPort,
  layout: RootLayout,
  path: LocalPath,
  collected: Collected,
  budget: { remaining: number },
  depth: number,
  signal?: AbortSignal,
): Promise<void> {
  // Three different ways to stop short, and none of them is a decision that
  // this path should survive. Reporting them as `out-of-scope` would tell a
  // user their data was deliberately spared when it was merely missed.
  if (isAborted(signal) || budget.remaining <= 0 || depth > MAX_REMOVAL_DEPTH) {
    collected.stoppedEarly = true;
    collected.retained.push({ path, reason: "not-reached" });
    return;
  }

  // Re-checked here, not only at plan time: the layout is the authority on what
  // this code may touch, and a path that is not under a registered root never
  // becomes removable because a plan listed it.
  const owner = owningRoot(layout, path);
  if (owner === null) {
    collected.retained.push({ path, reason: "escapes-registered-root" });
    return;
  }

  const stat = await fileSystem.stat(path, signal);
  if (!stat.ok) {
    collected.failed.push({ path, code: stat.error.code });
    return;
  }
  // Already gone. Idempotent by construction, so a re-run converges rather than
  // reporting failures for work the previous run completed.
  if (stat.value === null) {
    return;
  }

  if (stat.value.kind === "symlink") {
    // The link is removed; its target is not touched and not descended into.
    await removeOne(fileSystem, path, collected, budget, signal);
    return;
  }

  if (stat.value.kind === "directory") {
    const real = await fileSystem.realPath(path, signal);
    if (real.ok && !isInside(owner.path, real.value)) {
      // A directory that resolves outside its root is a link in disguise.
      collected.retained.push({ path, reason: "escapes-registered-root" });
      return;
    }

    const listed = await fileSystem.list(path, signal);
    if (!listed.ok) {
      collected.failed.push({ path, code: listed.error.code });
      return;
    }
    for (const child of listed.value) {
      await removeTree(fileSystem, layout, child.path, collected, budget, depth + 1, signal);
    }
  }

  await removeOne(fileSystem, path, collected, budget, signal);
}

async function removeOne(
  fileSystem: FileSystemPort,
  path: LocalPath,
  collected: Collected,
  budget: { remaining: number },
  signal?: AbortSignal,
): Promise<void> {
  budget.remaining -= 1;
  const removed = await fileSystem.removeEntry(path, signal);
  if (removed.ok) {
    collected.deleted.push(path);
    return;
  }
  if (removed.error.code === "not-found") {
    return;
  }
  collected.failed.push({ path, code: removed.error.code });
}
