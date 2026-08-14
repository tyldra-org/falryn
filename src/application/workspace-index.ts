/**
 * Bounded structural and derived-index query (#64).
 *
 * Reads one atomic generation from {@link WorkspaceIndexPort}, filters and
 * matches in domain, then verifies each hit against {@link FileSystemPort}
 * so a stale index cannot be presented as current evidence. Index builders,
 * Tree-sitter, embeddings, and product tools remain later work.
 */

import {
  bindWorkspacePath,
  compareIndexHits,
  excerptIndexText,
  type FileSystemPort,
  globMatchesAny,
  indexLifecycleQueryable,
  isExcludedByGlobs,
  isHiddenLogical,
  type LocalPath,
  lifecycleQueryError,
  parseWorkspaceIndexQuery,
  recordMatchesQuery,
  type WorkspaceIndexError,
  type WorkspaceIndexHit,
  type WorkspaceIndexPort,
  type WorkspaceIndexQueryResult,
  type WorkspaceIndexRecord,
} from "../domain/index.ts";

export type WorkspaceIndexQuery = {
  query(
    root: LocalPath,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceIndexQueryResult }
    | { readonly ok: false; readonly error: WorkspaceIndexError }
  >;
};

export type WorkspaceIndexQueryOptions = {
  readonly fileSystem: FileSystemPort;
  readonly index: WorkspaceIndexPort;
};

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function createWorkspaceIndexQuery(
  options: WorkspaceIndexQueryOptions,
): WorkspaceIndexQuery {
  return {
    async query(root, request, signal) {
      const parsed = parseWorkspaceIndexQuery(request);
      if (!parsed.ok) {
        return parsed;
      }
      if (isAborted(signal)) {
        return { ok: false, error: { code: "cancelled" } };
      }
      const snapshot = await options.index.snapshot(root, signal);
      if (!snapshot.ok) {
        return snapshot;
      }
      if (!indexLifecycleQueryable(snapshot.value.lifecycle)) {
        return { ok: false, error: lifecycleQueryError(snapshot.value.lifecycle) };
      }

      const hits: WorkspaceIndexHit[] = [];
      for (const record of snapshot.value.records) {
        if (isAborted(signal)) {
          return { ok: false, error: { code: "cancelled" } };
        }
        if (!parsed.value.includeHidden && isHiddenLogical(record.logical)) {
          continue;
        }
        if (isExcludedByGlobs(record.logical, "file", parsed.value.exclude)) {
          continue;
        }
        if (!globMatchesAny(record.logical, "file", parsed.value.include)) {
          continue;
        }
        if (!recordMatchesQuery(record, parsed.value)) {
          continue;
        }
        const bound = bindWorkspacePath(root, record.logical);
        if (!bound.ok) {
          continue;
        }
        const freshness = await verifyFreshness(
          options.fileSystem,
          bound.value.resolved,
          record,
          signal,
        );
        if (freshness === "cancelled") {
          return { ok: false, error: { code: "cancelled" } };
        }
        hits.push({
          logical: bound.value.logical,
          resolved: bound.value.resolved,
          kind: record.kind,
          name: excerptIndexText(record.name),
          excerpt: excerptIndexText(parsed.value.kind === "structural" ? record.name : record.text),
          startLine: record.startLine,
          endLine: record.endLine,
          freshness,
          generation: snapshot.value.id,
        });
        if (hits.length >= parsed.value.maxMatches) {
          hits.sort(compareIndexHits);
          return {
            ok: true,
            value: {
              generation: snapshot.value.id,
              schema: snapshot.value.schema,
              lifecycle: snapshot.value.lifecycle,
              hits,
              truncated: true,
              truncation: "match-limit",
            },
          };
        }
      }

      hits.sort(compareIndexHits);
      return {
        ok: true,
        value: {
          generation: snapshot.value.id,
          schema: snapshot.value.schema,
          lifecycle: snapshot.value.lifecycle,
          hits,
          truncated: false,
          truncation: null,
        },
      };
    },
  };
}

async function verifyFreshness(
  fileSystem: FileSystemPort,
  resolved: LocalPath,
  record: WorkspaceIndexRecord,
  signal: AbortSignal | undefined,
): Promise<"current" | "stale" | "unverified" | "cancelled"> {
  const stated = await fileSystem.stat(resolved, signal);
  if (!stated.ok) {
    return stated.error.code === "cancelled" ? "cancelled" : "unverified";
  }
  if (stated.value === null || stated.value.kind !== "file") {
    return "stale";
  }
  return stated.value.revision === record.revision ? "current" : "stale";
}
