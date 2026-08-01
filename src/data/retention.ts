/**
 * What the roots hold, and whether that fits.
 *
 * Reporting only. This module measures bytes and item counts per ownership
 * class and compares them against the budgets configuration supplies; it
 * deletes nothing. Retention pressure is a fact the owner of the bytes acts on,
 * and a measurement that quietly enforced would make every inspection command
 * destructive.
 *
 * The walk is bounded. A traversal that ran until it finished would be
 * unbounded work over a directory the user controls, so it stops at a declared
 * entry count and says the measurement is partial rather than reporting a total
 * it did not reach.
 */

import {
  type ClassPressure,
  type ClassUsage,
  type FileSystemPort,
  isInside,
  type LocalDataRoot,
  type LocalPath,
  type MeasurementCompleteness,
  type OwnershipClass,
  type OwnershipRegistration,
  type PathEntry,
  type QuotaPressure,
  type RetentionPolicy,
  type RetentionReport,
  type RootLayout,
} from "../domain/index.ts";

/** Entries one measurement will visit before reporting a partial result. */
export const MAX_MEASURED_ENTRIES = 50_000;

/** Directory depth one measurement will descend. */
export const MAX_MEASURED_DEPTH = 32;

export type UsageMeasurement = {
  readonly byteCount: number;
  readonly itemCount: number;
  readonly completeness: MeasurementCompleteness;
};

/**
 * Sums one subtree.
 *
 * A symlink is counted as one item and never followed. Following it would
 * measure bytes that live somewhere else and, worse, would let a link cycle
 * turn a measurement into an infinite walk.
 */
export async function measureSubtree(
  fileSystem: FileSystemPort,
  root: LocalPath,
  budget: { remaining: number },
  signal?: AbortSignal,
): Promise<UsageMeasurement> {
  let byteCount = 0;
  let itemCount = 0;
  let completeness: MeasurementCompleteness = "complete";

  const walk = async (path: LocalPath, depth: number): Promise<void> => {
    if (signal?.aborted === true || budget.remaining <= 0) {
      completeness = "partial";
      return;
    }
    if (depth > MAX_MEASURED_DEPTH) {
      completeness = "partial";
      return;
    }

    const listed = await fileSystem.list(path, signal);
    if (!listed.ok) {
      // A directory that vanished or refused a read is not a total; saying so
      // is better than reporting a smaller number as if it were complete.
      completeness = "partial";
      return;
    }

    for (const entry of listed.value) {
      if (budget.remaining <= 0) {
        completeness = "partial";
        return;
      }
      budget.remaining -= 1;
      itemCount += 1;
      byteCount += entry.byteLength;
      if (entry.kind === "directory") {
        await walk(entry.path, depth + 1);
      }
    }
  };

  const start = await fileSystem.stat(root, signal);
  if (!start.ok) {
    return { byteCount: 0, itemCount: 0, completeness: "partial" };
  }
  if (start.value === null) {
    // A root that was never created holds nothing. That is a complete answer.
    return { byteCount: 0, itemCount: 0, completeness: "complete" };
  }
  if (start.value.kind !== "directory") {
    return { byteCount: 0, itemCount: 0, completeness: "partial" };
  }

  await walk(root, 0);
  return { byteCount, itemCount, completeness };
}

/** Every path an entry occupies, for plans and for measurement. */
export function pathsForClass(
  layout: RootLayout,
  registration: OwnershipRegistration,
): readonly LocalPath[] {
  const paths: LocalPath[] = [];
  for (const root of registration.roots) {
    const resolved = layout.roots.find((candidate) => candidate.root === root);
    if (resolved !== undefined) {
      paths.push(resolved.path);
    }
  }
  return paths;
}

export async function measureClass(
  fileSystem: FileSystemPort,
  layout: RootLayout,
  registration: OwnershipRegistration,
  budget: { remaining: number },
  signal?: AbortSignal,
): Promise<ClassUsage> {
  let byteCount = 0;
  let itemCount = 0;
  let completeness: MeasurementCompleteness = "complete";

  for (const path of pathsForClass(layout, registration)) {
    const measured = await measureSubtree(fileSystem, path, budget, signal);
    byteCount += measured.byteCount;
    itemCount += measured.itemCount;
    if (measured.completeness === "partial") {
      completeness = "partial";
    }
  }

  return {
    ownershipClass: registration.ownershipClass,
    owner: registration.owner,
    byteCount,
    itemCount,
    roots: registration.roots,
    completeness,
  };
}

function pressureFor(
  used: number,
  limit: number | null,
  completeness: MeasurementCompleteness,
): QuotaPressure {
  if (completeness === "partial") {
    // A partial measurement has no verdict. Reporting `within` from a number
    // known to be too small would be an invented fact.
    return "unmeasured";
  }
  if (limit === null) {
    return "within";
  }
  if (used > limit) {
    return "over";
  }
  return used === limit ? "at" : "within";
}

export type RetentionInputs = {
  readonly fileSystem: FileSystemPort;
  readonly layout: RootLayout;
  readonly registrations: readonly OwnershipRegistration[];
  readonly unregistered: readonly OwnershipClass[];
  readonly policy: RetentionPolicy;
};

/** Measures every registered class and reports pressure without acting on it. */
export async function reportRetention(
  inputs: RetentionInputs,
  signal?: AbortSignal,
): Promise<RetentionReport> {
  const budget = { remaining: MAX_MEASURED_ENTRIES };
  const classes: ClassUsage[] = [];

  for (const registration of inputs.registrations) {
    if (registration.external) {
      // The bytes are in a keychain. Measuring them here would mean reaching
      // into a store this area has no business opening.
      classes.push({
        ownershipClass: registration.ownershipClass,
        owner: registration.owner,
        byteCount: 0,
        itemCount: 0,
        roots: [],
        completeness: "complete",
      });
      continue;
    }
    classes.push(
      await measureClass(inputs.fileSystem, inputs.layout, registration, budget, signal),
    );
  }

  const pressure: ClassPressure[] = classes.map((usage) => {
    const declared = inputs.policy.byClass[usage.ownershipClass] ?? {
      maxBytes: null,
      maxItems: null,
    };
    return {
      ownershipClass: usage.ownershipClass,
      bytes: pressureFor(usage.byteCount, declared.maxBytes, usage.completeness),
      items: pressureFor(usage.itemCount, declared.maxItems, usage.completeness),
    };
  });

  const totalBytes = classes.reduce((sum, usage) => sum + usage.byteCount, 0);
  const totalItems = classes.reduce((sum, usage) => sum + usage.itemCount, 0);
  const anyPartial = classes.some((usage) => usage.completeness === "partial");

  return {
    classes,
    totalBytes,
    totalItems,
    pressure,
    totalPressure: pressureFor(
      totalBytes,
      inputs.policy.totalMaxBytes,
      anyPartial ? "partial" : "complete",
    ),
    unregistered: inputs.unregistered,
  };
}

/** Which registered roots a path belongs to, for the removal guard. */
export function owningRoot(
  layout: RootLayout,
  path: LocalPath,
): { readonly root: LocalDataRoot; readonly path: LocalPath } | null {
  for (const resolved of layout.roots) {
    if (isInside(resolved.path, path)) {
      return { root: resolved.root, path: resolved.path };
    }
  }
  return null;
}

/** Sorts entries deepest-first, so a directory is removed after its children. */
export function deepestFirst(entries: readonly PathEntry[]): readonly PathEntry[] {
  return [...entries].sort((left, right) => right.path.length - left.path.length);
}
