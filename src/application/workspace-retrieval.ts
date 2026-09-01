/**
 * Bounded semantic retrieval and context-pack search (#65).
 *
 * Reads one atomic index generation, optionally scores an injectable embedding
 * corpus, and assembles a bounded pack. Live embedding providers, persistence,
 * and the context planner remain later work.
 */

import {
  assembleContextPack,
  assertNever,
  bindWorkspacePath,
  compareRetrievalHits,
  diversifyHits,
  type EmbeddingCorpusPort,
  type EmbeddingDestination,
  type EmbeddingPort,
  type EmbeddingRecord,
  type EmbeddingVector,
  embeddingRecordKey,
  embeddingUsable,
  excerptIndexText,
  type FileSystemPort,
  globMatchesAny,
  indexLifecycleQueryable,
  isExcludedByGlobs,
  isHiddenLogical,
  type LocalPath,
  lifecycleQueryError,
  parseWorkspaceRetrievalQuery,
  type RetrievalHit,
  type RetrievalSemanticState,
  scoreIndexRecords,
  type WorkspaceIndexPort,
  type WorkspaceIndexRecord,
  type WorkspaceRetrievalError,
  type WorkspaceRetrievalResult,
} from "../domain/index.ts";
import { createWorkspaceReader, type WorkspaceReader } from "./workspace-read.ts";

export type WorkspaceRetrieval = {
  retrieve(
    root: LocalPath,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceRetrievalResult }
    | { readonly ok: false; readonly error: WorkspaceRetrievalError }
  >;
};

export type WorkspaceRetrievalOptions = {
  readonly fileSystem: FileSystemPort;
  readonly index: WorkspaceIndexPort;
  readonly embeddings?: EmbeddingPort;
  readonly corpus?: EmbeddingCorpusPort;
};

type SemanticPlan =
  | {
      readonly kind: "ready";
      readonly vector: EmbeddingVector;
      readonly embeddings: ReadonlyMap<string, EmbeddingRecord>;
      readonly destination: EmbeddingDestination;
    }
  | {
      readonly kind: "fallback";
      readonly reason: Exclude<RetrievalSemanticState, "used" | "below-baseline">;
    }
  | { readonly kind: "cancelled" };

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function createWorkspaceRetrieval(options: WorkspaceRetrievalOptions): WorkspaceRetrieval {
  const reader = createWorkspaceReader(options.fileSystem);
  return {
    async retrieve(root, request, signal) {
      const parsed = parseWorkspaceRetrievalQuery(request);
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

      const admitted: WorkspaceIndexRecord[] = [];
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
        admitted.push(record);
      }

      const semanticPlan = await planSemantic(
        options,
        root,
        parsed.value.query,
        parsed.value.destination,
        parsed.value.allowRemote,
        snapshot.value.id,
        signal,
      );
      if (semanticPlan.kind === "cancelled") {
        return { ok: false, error: { code: "cancelled" } };
      }

      const scored = scoreIndexRecords(
        admitted,
        parsed.value,
        semanticPlan.kind === "ready" ? semanticPlan.vector : null,
        semanticPlan.kind === "ready" ? semanticPlan.embeddings : new Map(),
      );

      const semantic: RetrievalSemanticState =
        semanticPlan.kind === "fallback"
          ? semanticPlan.reason
          : scored.attempt === "skipped"
            ? "unavailable"
            : scored.attempt;

      const ranked: RetrievalHit[] = [];
      const freshnessByPath = new Map<
        string,
        Promise<"current" | "stale" | "unverified" | "cancelled">
      >();
      for (const row of scored.scored) {
        if (isAborted(signal)) {
          return { ok: false, error: { code: "cancelled" } };
        }
        const bound = bindWorkspacePath(root, row.record.logical);
        if (!bound.ok) {
          continue;
        }
        let freshnessPromise = freshnessByPath.get(row.record.logical);
        if (freshnessPromise === undefined) {
          freshnessPromise = verifyFreshness(
            reader,
            root,
            row.record.logical,
            row.record.revision,
            signal,
          );
          freshnessByPath.set(row.record.logical, freshnessPromise);
        }
        const freshness = await freshnessPromise;
        if (freshness === "cancelled") {
          return { ok: false, error: { code: "cancelled" } };
        }
        ranked.push({
          logical: bound.value.logical,
          resolved: bound.value.resolved,
          kind: row.record.kind,
          name: excerptIndexText(row.record.name),
          excerpt: excerptIndexText(row.record.text),
          startLine: row.record.startLine,
          endLine: row.record.endLine,
          freshness,
          scores: row.scores,
          generation: snapshot.value.id,
        });
      }

      ranked.sort(compareRetrievalHits);
      const diversified = diversifyHits(ranked);
      const truncated = diversified.length > parsed.value.maxMatches;
      const hits = truncated ? diversified.slice(0, parsed.value.maxMatches) : diversified;
      const pack = assembleContextPack(
        hits,
        parsed.value.maxPackItems,
        parsed.value.maxEstimatedTokens,
      );

      return {
        ok: true,
        value: {
          generation: snapshot.value.id,
          schema: snapshot.value.schema,
          lifecycle: snapshot.value.lifecycle,
          semantic,
          destination: semanticPlan.kind === "ready" ? semanticPlan.destination : null,
          hits,
          pack,
          truncated,
          truncation: truncated ? "match-limit" : null,
        },
      };
    },
  };
}

async function planSemantic(
  options: WorkspaceRetrievalOptions,
  root: LocalPath,
  query: string,
  destination: EmbeddingDestination,
  allowRemote: boolean,
  generationId: string,
  signal: AbortSignal | undefined,
): Promise<SemanticPlan> {
  if (options.embeddings === undefined || options.corpus === undefined) {
    return { kind: "fallback", reason: "unavailable" };
  }
  if (destination === "remote" && !allowRemote) {
    return { kind: "fallback", reason: "denied" };
  }
  if (isAborted(signal)) {
    return { kind: "cancelled" };
  }
  const corpus = await options.corpus.snapshot(root, signal);
  if (!corpus.ok) {
    return corpus.error.code === "cancelled"
      ? { kind: "cancelled" }
      : { kind: "fallback", reason: "unavailable" };
  }
  if (corpus.value.id !== generationId) {
    return { kind: "fallback", reason: "corpus-mismatch" };
  }

  const usable = new Map<string, EmbeddingRecord>();
  let deniedOnly = false;
  for (const record of corpus.value.records) {
    if (!embeddingUsable(record, allowRemote)) {
      deniedOnly = true;
      continue;
    }
    usable.set(embeddingRecordKey(record), record);
  }
  if (usable.size === 0) {
    return { kind: "fallback", reason: deniedOnly ? "denied" : "unavailable" };
  }

  const embedded = await options.embeddings.embedQuery(query, destination, signal);
  if (!embedded.ok) {
    switch (embedded.error.code) {
      case "cancelled":
        return { kind: "cancelled" };
      case "denied":
        return { kind: "fallback", reason: "denied" };
      case "unavailable":
        return { kind: "fallback", reason: "unavailable" };
      default:
        return assertNever(embedded.error, "unhandled embedding query error");
    }
  }

  return {
    kind: "ready",
    vector: embedded.value.vector,
    embeddings: usable,
    destination: embedded.value.destination,
  };
}

async function verifyFreshness(
  reader: WorkspaceReader,
  root: LocalPath,
  logical: string,
  expectedDigest: string,
  signal: AbortSignal | undefined,
): Promise<"current" | "stale" | "unverified" | "cancelled"> {
  const read = await reader.read(root, logical, undefined, undefined, signal);
  if (!read.ok) {
    return read.error.code === "cancelled" ? "cancelled" : "unverified";
  }
  return String(read.value.digest) === expectedDigest ? "current" : "stale";
}
