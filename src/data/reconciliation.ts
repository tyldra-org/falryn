/**
 * Startup reconciliation of temporary ingest.
 *
 * It reports what is there and concludes nothing about it. Whether a temporary
 * file represents finished work is knowable only by the owner that wrote it —
 * through a completion marker, a manifest, a digest — and no such owner exists
 * yet. Artifact ingest will bring one.
 *
 * Until then, deleting on the theory that a leftover file must be abandoned
 * would destroy work that a crashed run could have resumed, and treating one as
 * complete would invent a result. So this records uncertainty: every entry
 * found is reported, and nothing is removed.
 */

import type {
  EffectCertainty,
  FileSystemPort,
  LocalDataRoot,
  LocalPath,
  MeasurementCompleteness,
  ReconciledEntry,
  ReconciliationReport,
  RootLayout,
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
      entries.push({ path: entry.path, kind: entry.kind, byteLength: entry.byteLength });
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

function emptyReport(root: LocalPath | null): ReconciliationReport {
  return {
    root: (root ?? "/") as LocalPath,
    entries: [],
    completeness: "complete",
    effect: "none",
  };
}
