/**
 * Startup reconciliation of temporary ingest.
 *
 * It reports what is there and concludes nothing about whether it finished.
 * Artifact ingest writes under a name the domain declares, so an entry can now
 * say *who* wrote it; it still cannot say whether that write completed, because
 * that is knowable only from the record beside it, and reconstructing it here
 * would be inventing a result.
 *
 * Deleting on the theory that a leftover file must be abandoned would destroy
 * work a crashed run could have resumed. So this records uncertainty: every
 * entry found is reported with its owner, and nothing is removed. Discarding a
 * temporary blob is something only the run that allocated it does, at shutdown,
 * because only that run knows it abandoned one.
 */

import {
  baseName,
  type EffectCertainty,
  type FileSystemPort,
  isTemporaryArtifactName,
  type LocalDataRoot,
  type LocalPath,
  type MeasurementCompleteness,
  type ReconciledEntry,
  type ReconciliationReport,
  type RootLayout,
  type TemporaryIngestOwner,
} from "../domain/index.ts";

/** Entries one reconciliation will report before saying it saw only part. */
export const MAX_RECONCILED_ENTRIES = 10_000;

const TEMPORARY_INGEST: LocalDataRoot = "temporaryIngest";

export async function reconcileTemporaryIngest(
  fileSystem: FileSystemPort,
  layout: RootLayout,
  signal?: AbortSignal,
): Promise<ReconciliationReport> {
  const resolved = layout.roots.find((candidate) => candidate.root === TEMPORARY_INGEST);
  if (resolved === undefined) {
    return emptyReport(null);
  }

  const stat = await fileSystem.stat(resolved.path, signal);
  if (!stat.ok) {
    return { ...emptyReport(resolved.path), completeness: "partial" };
  }
  // A root that was never created holds nothing, and that is a complete answer
  // rather than a failure to look.
  if (stat.value === null) {
    return emptyReport(resolved.path);
  }
  if (stat.value.kind !== "directory") {
    return { ...emptyReport(resolved.path), completeness: "partial" };
  }

  const entries: ReconciledEntry[] = [];
  let completeness: MeasurementCompleteness = "complete";

  const walk = async (path: LocalPath, depth: number): Promise<void> => {
    if (signal?.aborted === true || entries.length >= MAX_RECONCILED_ENTRIES || depth > 8) {
      completeness = "partial";
      return;
    }
    const listed = await fileSystem.list(path, signal);
    if (!listed.ok) {
      completeness = "partial";
      return;
    }
    for (const entry of listed.value) {
      if (entries.length >= MAX_RECONCILED_ENTRIES) {
        completeness = "partial";
        return;
      }
      entries.push({
        path: entry.path,
        kind: entry.kind,
        byteLength: entry.byteLength,
        owner: ownerOf(entry.path),
      });
      if (entry.kind === "directory") {
        await walk(entry.path, depth + 1);
      }
    }
  };

  await walk(resolved.path, 0);

  return {
    root: resolved.path,
    entries,
    completeness,
    // Anything left here was being written when something stopped. Whether it
    // finished is exactly what cannot be established from the outside.
    effect: (entries.length === 0 ? "none" : "uncertain") satisfies EffectCertainty,
  };
}

/**
 * Who wrote an entry, read from its name alone.
 *
 * The name is the only evidence available at startup, and it is enough to route
 * an entry to an owner. It is deliberately not enough to conclude the write
 * finished: a half-written blob and a complete one are named identically, which
 * is exactly why nothing here removes either.
 */
function ownerOf(path: LocalPath): TemporaryIngestOwner {
  return isTemporaryArtifactName(baseName(path)) ? "artifact-ingest" : "unknown";
}

function emptyReport(root: LocalPath | null): ReconciliationReport {
  return {
    root: (root ?? "/") as LocalPath,
    entries: [],
    completeness: "complete",
    effect: "none",
  };
}
