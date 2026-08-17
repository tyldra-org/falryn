/**
 * Bounded semantic retrieval and context-pack search contracts (#65).
 *
 * Hybrid fusion keeps lexical, structural, and semantic scores separate.
 * Embeddings are optional behind {@link EmbeddingPort}. Index builders, live
 * providers, persistence, and the context planner remain later work.
 */

import type { LocalPath } from "./filesystem.ts";
import {
  EMBEDDING_DESTINATIONS,
  type EmbeddingDestination,
  qualificationUses,
  qualifyEmbeddings,
  SEMANTIC_BASELINE,
} from "./language-intelligence-qualify.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import {
  type CompiledGlob,
  compileGlobPattern,
  compileGlobPatterns,
  type GlobPatternErrorReason,
  type WorkspaceDiscoveryError,
} from "./workspace-glob.ts";
import type {
  IndexHitFreshness,
  IndexLifecycle,
  IndexRecordKind,
  WorkspaceIndexRecord,
} from "./workspace-index.ts";
import { excerptIndexText } from "./workspace-index.ts";
import type { WorkspaceListingError } from "./workspace-listing.ts";

export type { EmbeddingDestination };
export { EMBEDDING_DESTINATIONS, SEMANTIC_BASELINE };

export const MAX_RETRIEVAL_QUERY_LENGTH = 256;
export const DEFAULT_MAX_RETRIEVAL_MATCHES = 20;
export const HARD_MAX_RETRIEVAL_MATCHES = 100;
export const DEFAULT_MAX_PACK_ITEMS = 8;
export const HARD_MAX_PACK_ITEMS = 32;
export const DEFAULT_MAX_PACK_TOKENS = 2_048;
export const HARD_MAX_PACK_TOKENS = 8_192;
export const MAX_RETRIEVAL_GLOBS = 8;
export const RRF_K = 60;
export const DIVERSITY_LINE_GAP = 8;
export const MAX_HITS_PER_PATH = 2;
export const TOKENS_PER_EXCERPT_CHAR = 4;

export const EMBEDDING_NORMALIZATIONS = ["none", "l2"] as const;
export type EmbeddingNormalization = (typeof EMBEDDING_NORMALIZATIONS)[number];

export const RETRIEVAL_SEMANTIC_STATES = [
  "used",
  "unavailable",
  "denied",
  "below-baseline",
  "dimension-mismatch",
  "corpus-mismatch",
] as const;
export type RetrievalSemanticState = (typeof RETRIEVAL_SEMANTIC_STATES)[number];

export const RETRIEVAL_CONFIDENCES = ["semantic", "structural", "lexical"] as const;
export type RetrievalConfidence = (typeof RETRIEVAL_CONFIDENCES)[number];

export const RETRIEVAL_FIDELITIES = ["exact", "extractive"] as const;
export type RetrievalFidelity = (typeof RETRIEVAL_FIDELITIES)[number];

export const PACK_ITEM_ROLES = ["primary", "support"] as const;
export type ContextPackItemRole = (typeof PACK_ITEM_ROLES)[number];

export type WorkspaceRetrievalLimitName = "maxMatches" | "maxPackItems" | "maxEstimatedTokens";
export type RetrievalHitTruncation = "match-limit";
export type ContextPackTruncation = "pack-item-limit" | "pack-token-limit";

export type WorkspaceRetrievalError =
  | WorkspaceListingError
  | { readonly code: "malformed-glob"; readonly reason: GlobPatternErrorReason }
  | {
      readonly code: "malformed-limit";
      readonly field: WorkspaceRetrievalLimitName;
      readonly reason: "not-safe-integer" | "not-positive" | "above-hard-maximum";
    }
  | {
      readonly code: "malformed-query";
      readonly reason: "empty" | "too-long" | "illegal-character";
    }
  | { readonly code: "malformed-destination" }
  | { readonly code: "malformed-kind" }
  | { readonly code: "malformed-record-kind" }
  | { readonly code: "index-absent" }
  | { readonly code: "index-not-ready"; readonly lifecycle: IndexLifecycle }
  | { readonly code: "index-corrupt" }
  | { readonly code: "unavailable" };

export type EmbeddingQueryError =
  | { readonly code: "cancelled" }
  | { readonly code: "unavailable" }
  | { readonly code: "denied" };

export type EmbeddingVector = readonly number[];

export type EmbeddingQueryResult = {
  readonly vector: EmbeddingVector;
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly destination: EmbeddingDestination;
};

export type EmbeddingPort = {
  embedQuery(
    query: string,
    destination: EmbeddingDestination,
    signal?: AbortSignal,
  ): Promise<Result<EmbeddingQueryResult, EmbeddingQueryError>>;
};

export type EmbeddingRecord = {
  readonly logical: string;
  readonly kind: IndexRecordKind;
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly digest: string;
  readonly chunkerVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly normalization: EmbeddingNormalization;
  readonly destination: EmbeddingDestination;
  readonly vector: EmbeddingVector;
};

export type EmbeddingCorpusGeneration = {
  readonly id: string;
  readonly records: readonly EmbeddingRecord[];
};

export type EmbeddingCorpusPort = {
  snapshot(
    root: LocalPath,
    signal?: AbortSignal,
  ): Promise<Result<EmbeddingCorpusGeneration, WorkspaceRetrievalError>>;
};

export type RetrievalScores = {
  readonly lexical: number;
  readonly structural: number;
  readonly semantic: number;
  readonly fused: number;
};

export type RetrievalHit = {
  readonly logical: string;
  readonly resolved: LocalPath;
  readonly kind: IndexRecordKind;
  readonly name: string;
  readonly excerpt: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly freshness: IndexHitFreshness;
  readonly scores: RetrievalScores;
  readonly generation: string;
};

export type ContextPackExpansion = {
  readonly kind: "read-range";
  readonly logical: string;
  readonly startLine: number;
  readonly endLine: number;
};

export type ContextPackItem = {
  readonly logical: string;
  readonly resolved: LocalPath;
  readonly kind: IndexRecordKind;
  readonly name: string;
  readonly excerpt: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly freshness: IndexHitFreshness;
  readonly role: ContextPackItemRole;
  readonly reason: RetrievalConfidence;
  readonly confidence: RetrievalConfidence;
  readonly fidelity: RetrievalFidelity;
  readonly estimatedTokens: number;
  readonly expansion: ContextPackExpansion;
  readonly scores: RetrievalScores;
};

export type ContextPack = {
  readonly items: readonly ContextPackItem[];
  readonly estimatedTokens: number;
  readonly omitted: number;
  readonly truncated: boolean;
  readonly truncation: ContextPackTruncation | null;
};

export type ParsedWorkspaceRetrievalQuery = {
  readonly query: string;
  readonly include: readonly CompiledGlob[];
  readonly exclude: readonly CompiledGlob[];
  readonly maxMatches: number;
  readonly maxPackItems: number;
  readonly maxEstimatedTokens: number;
  readonly includeHidden: boolean;
  readonly caseSensitive: boolean;
  readonly allowRemote: boolean;
  readonly destination: EmbeddingDestination;
};

export type WorkspaceRetrievalResult = {
  readonly generation: string;
  readonly schema: string;
  readonly lifecycle: IndexLifecycle;
  readonly semantic: RetrievalSemanticState;
  readonly destination: EmbeddingDestination | null;
  readonly hits: readonly RetrievalHit[];
  readonly pack: ContextPack;
  readonly truncated: boolean;
  readonly truncation: RetrievalHitTruncation | null;
};

export const DEFAULT_RETRIEVAL_LIMITS = {
  maxMatches: DEFAULT_MAX_RETRIEVAL_MATCHES,
  maxPackItems: DEFAULT_MAX_PACK_ITEMS,
  maxEstimatedTokens: DEFAULT_MAX_PACK_TOKENS,
  includeHidden: false,
  caseSensitive: true,
  allowRemote: false,
  destination: "local",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRetrievalGlobError(error: WorkspaceDiscoveryError): WorkspaceRetrievalError {
  switch (error.code) {
    case "malformed-kinds":
      return { code: "malformed-glob", reason: "not-an-array" };
    case "malformed-limit":
      return { code: "malformed-glob", reason: "too-many" };
    case "malformed-glob":
    case "malformed":
    case "escaped":
    case "absolute-unscoped":
    case "symlink-escape":
    case "not-found":
    case "not-a-directory":
    case "cancelled":
    case "filesystem":
      return error;
    default:
      return assertNever(error, "unhandled glob compile error");
  }
}

function parseLimit(
  value: unknown,
  fallback: number,
  field: WorkspaceRetrievalLimitName,
  hardMaximum: number,
): Result<number, WorkspaceRetrievalError> {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved)) {
    return err({ code: "malformed-limit", field, reason: "not-safe-integer" });
  }
  if (resolved < 1) {
    return err({ code: "malformed-limit", field, reason: "not-positive" });
  }
  if (resolved > hardMaximum) {
    return err({ code: "malformed-limit", field, reason: "above-hard-maximum" });
  }
  return ok(resolved);
}

export function cosineSimilarity(left: EmbeddingVector, right: EmbeddingVector): number | null {
  if (left.length === 0 || left.length !== right.length) {
    return null;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) {
      return null;
    }
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return null;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function containsQuery(haystack: string, needle: string, caseSensitive: boolean): boolean {
  if (caseSensitive) {
    return haystack.includes(needle);
  }
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function estimatedTokensForExcerpt(excerpt: string): number {
  return Math.max(1, Math.ceil(excerpt.length / TOKENS_PER_EXCERPT_CHAR));
}

export function dominantConfidence(scores: RetrievalScores): RetrievalConfidence {
  if (scores.semantic >= scores.lexical && scores.semantic >= scores.structural) {
    return "semantic";
  }
  if (scores.structural >= scores.lexical) {
    return "structural";
  }
  return "lexical";
}

export function fidelityForFreshness(freshness: IndexHitFreshness): RetrievalFidelity {
  return freshness === "current" ? "exact" : "extractive";
}

function recordKey(record: {
  readonly logical: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly name: string;
}): string {
  return `${record.logical}\0${record.startLine}\0${record.endLine}\0${record.name}`;
}

export function reciprocalRankFusion(ranks: readonly (number | null)[]): number {
  let fused = 0;
  for (const rank of ranks) {
    if (rank === null) {
      continue;
    }
    fused += 1 / (RRF_K + rank);
  }
  return fused;
}

export function compareRetrievalHits(left: RetrievalHit, right: RetrievalHit): number {
  if (right.scores.fused !== left.scores.fused) {
    return right.scores.fused - left.scores.fused;
  }
  const byPath = left.logical.localeCompare(right.logical);
  if (byPath !== 0) {
    return byPath;
  }
  if (left.startLine !== right.startLine) {
    return left.startLine - right.startLine;
  }
  return left.name.localeCompare(right.name);
}

export function diversifyHits(hits: readonly RetrievalHit[]): RetrievalHit[] {
  const kept: RetrievalHit[] = [];
  const perPath: Map<string, RetrievalHit[]> = new Map();
  for (const hit of hits) {
    const existing = perPath.get(hit.logical) ?? [];
    if (existing.length >= MAX_HITS_PER_PATH) {
      continue;
    }
    const tooClose = existing.some(
      (prior) => Math.abs(prior.startLine - hit.startLine) < DIVERSITY_LINE_GAP,
    );
    if (tooClose) {
      continue;
    }
    existing.push(hit);
    perPath.set(hit.logical, existing);
    kept.push(hit);
  }
  return kept;
}

export type ScoredIndexRecord = {
  readonly record: WorkspaceIndexRecord;
  readonly scores: RetrievalScores;
};

export function scoreIndexRecords(
  records: readonly WorkspaceIndexRecord[],
  parsed: ParsedWorkspaceRetrievalQuery,
  queryVector: EmbeddingVector | null,
  embeddingsByKey: ReadonlyMap<string, EmbeddingRecord>,
): {
  readonly scored: ScoredIndexRecord[];
  readonly attempt: "used" | "below-baseline" | "dimension-mismatch" | "skipped";
} {
  const lexicalRanks: { readonly key: string; readonly score: number }[] = [];
  const structuralRanks: { readonly key: string; readonly score: number }[] = [];
  const semanticRanks: { readonly key: string; readonly score: number }[] = [];
  const byKey = new Map<
    string,
    {
      readonly record: WorkspaceIndexRecord;
      lexical: number;
      structural: number;
      semantic: number;
    }
  >();

  let dimensionMismatch = false;
  let maxSemantic = 0;

  for (const record of records) {
    const key = recordKey(record);
    const lexical = containsQuery(record.text, parsed.query, parsed.caseSensitive) ? 1 : 0;
    const structural = containsQuery(record.name, parsed.query, parsed.caseSensitive) ? 1 : 0;
    let semantic = 0;
    if (queryVector !== null) {
      const embedding = embeddingsByKey.get(key);
      if (embedding !== undefined) {
        const similarity = cosineSimilarity(queryVector, embedding.vector);
        if (similarity === null) {
          dimensionMismatch = true;
        } else {
          semantic = Math.max(0, similarity);
          maxSemantic = Math.max(maxSemantic, semantic);
        }
      }
    }
    byKey.set(key, { record, lexical, structural, semantic });
    if (lexical > 0) {
      lexicalRanks.push({ key, score: lexical });
    }
    if (structural > 0) {
      structuralRanks.push({ key, score: structural });
    }
    if (semantic > 0) {
      semanticRanks.push({ key, score: semantic });
    }
  }

  const useSemanticDecision = qualifyEmbeddings({
    available: queryVector !== null,
    destination: "local",
    allowRemote: true,
    maxSimilarity: queryVector === null ? null : maxSemantic,
    lexicalHitCount: lexicalRanks.length,
    structuralHitCount: structuralRanks.length,
  });
  const useSemantic = qualificationUses(useSemanticDecision);
  const attempt =
    queryVector === null
      ? "skipped"
      : dimensionMismatch && semanticRanks.length === 0
        ? "dimension-mismatch"
        : useSemanticDecision.decision === "skip" && useSemanticDecision.reason === "below-baseline"
          ? "below-baseline"
          : useSemantic
            ? "used"
            : "below-baseline";

  const rankMap = (rows: readonly { readonly key: string; readonly score: number }[]) => {
    const sorted = [...rows].sort((left, right) => right.score - left.score);
    const ranks = new Map<string, number>();
    sorted.forEach((row, index) => {
      ranks.set(row.key, index + 1);
    });
    return ranks;
  };

  const lexicalRank = rankMap(lexicalRanks);
  const structuralRank = rankMap(structuralRanks);
  const semanticRank = useSemantic ? rankMap(semanticRanks) : new Map<string, number>();

  const scored: ScoredIndexRecord[] = [];
  for (const [key, row] of byKey) {
    const fused = reciprocalRankFusion([
      lexicalRank.get(key) ?? null,
      structuralRank.get(key) ?? null,
      useSemantic ? (semanticRank.get(key) ?? null) : null,
    ]);
    if (row.lexical === 0 && row.structural === 0 && (!useSemantic || row.semantic === 0)) {
      continue;
    }
    if (fused === 0 && row.lexical === 0 && row.structural === 0 && row.semantic === 0) {
      continue;
    }
    scored.push({
      record: row.record,
      scores: {
        lexical: row.lexical,
        structural: row.structural,
        semantic: useSemantic ? row.semantic : 0,
        fused,
      },
    });
  }
  return { scored, attempt };
}

export function assembleContextPack(
  hits: readonly RetrievalHit[],
  maxPackItems: number,
  maxEstimatedTokens: number,
): ContextPack {
  const items: ContextPackItem[] = [];
  let estimatedTokens = 0;
  let truncation: ContextPackTruncation | null = null;
  let omitted = 0;

  for (const hit of hits) {
    const excerpt = excerptIndexText(hit.excerpt);
    const tokens = estimatedTokensForExcerpt(excerpt);
    if (items.length >= maxPackItems) {
      truncation = "pack-item-limit";
      omitted += 1;
      continue;
    }
    if (estimatedTokens + tokens > maxEstimatedTokens) {
      truncation = "pack-token-limit";
      omitted += 1;
      continue;
    }
    const confidence = dominantConfidence(hit.scores);
    items.push({
      logical: hit.logical,
      resolved: hit.resolved,
      kind: hit.kind,
      name: hit.name,
      excerpt,
      startLine: hit.startLine,
      endLine: hit.endLine,
      freshness: hit.freshness,
      role: items.length === 0 ? "primary" : "support",
      reason: confidence,
      confidence,
      fidelity: fidelityForFreshness(hit.freshness),
      estimatedTokens: tokens,
      expansion: {
        kind: "read-range",
        logical: hit.logical,
        startLine: hit.startLine,
        endLine: hit.endLine,
      },
      scores: hit.scores,
    });
    estimatedTokens += tokens;
  }

  return {
    items,
    estimatedTokens,
    omitted,
    truncated: truncation !== null,
    truncation,
  };
}

export function embeddingRecordKey(record: EmbeddingRecord): string {
  return recordKey(record);
}

export function embeddingUsable(record: EmbeddingRecord, allowRemote: boolean): boolean {
  switch (record.destination) {
    case "local":
      return true;
    case "remote":
      return allowRemote;
    default:
      return assertNever(record.destination, "unhandled embedding destination");
  }
}

export function parseWorkspaceRetrievalQuery(
  value: unknown,
): Result<ParsedWorkspaceRetrievalQuery, WorkspaceRetrievalError> {
  if (!isRecord(value)) {
    return err({ code: "malformed-glob", reason: "not-an-object" });
  }
  if (value.caseSensitive !== undefined && typeof value.caseSensitive !== "boolean") {
    return err({ code: "malformed-glob", reason: "invalid-flag" });
  }
  if (value.includeHidden !== undefined && typeof value.includeHidden !== "boolean") {
    return err({ code: "malformed-glob", reason: "invalid-flag" });
  }
  if (value.allowRemote !== undefined && typeof value.allowRemote !== "boolean") {
    return err({ code: "malformed-glob", reason: "invalid-flag" });
  }
  if (value.destination !== undefined) {
    if (
      typeof value.destination !== "string" ||
      !EMBEDDING_DESTINATIONS.includes(value.destination as EmbeddingDestination)
    ) {
      return err({ code: "malformed-destination" });
    }
  }

  const query = value.query;
  if (typeof query !== "string") {
    return err({ code: "malformed-query", reason: "empty" });
  }
  if (query.length === 0) {
    return err({ code: "malformed-query", reason: "empty" });
  }
  if (query.length > MAX_RETRIEVAL_QUERY_LENGTH) {
    return err({ code: "malformed-query", reason: "too-long" });
  }
  if (query.includes("\0")) {
    return err({ code: "malformed-query", reason: "illegal-character" });
  }

  const include =
    value.include === undefined ? compileGlobPattern("*") : compileGlobPatterns(value.include);
  if (!include.ok) {
    return err(asRetrievalGlobError(include.error));
  }
  const includeGlobs = Array.isArray(include.value) ? include.value : [include.value];
  if (includeGlobs.length === 0) {
    return err({ code: "malformed-glob", reason: "empty-include" });
  }
  const exclude = value.exclude === undefined ? ok([]) : compileGlobPatterns(value.exclude);
  if (!exclude.ok) {
    return err(asRetrievalGlobError(exclude.error));
  }
  if (includeGlobs.length + exclude.value.length > MAX_RETRIEVAL_GLOBS) {
    return err({ code: "malformed-glob", reason: "too-many" });
  }

  const maxMatches = parseLimit(
    value.maxMatches,
    DEFAULT_RETRIEVAL_LIMITS.maxMatches,
    "maxMatches",
    HARD_MAX_RETRIEVAL_MATCHES,
  );
  if (!maxMatches.ok) {
    return maxMatches;
  }
  const maxPackItems = parseLimit(
    value.maxPackItems,
    DEFAULT_RETRIEVAL_LIMITS.maxPackItems,
    "maxPackItems",
    HARD_MAX_PACK_ITEMS,
  );
  if (!maxPackItems.ok) {
    return maxPackItems;
  }
  const maxEstimatedTokens = parseLimit(
    value.maxEstimatedTokens,
    DEFAULT_RETRIEVAL_LIMITS.maxEstimatedTokens,
    "maxEstimatedTokens",
    HARD_MAX_PACK_TOKENS,
  );
  if (!maxEstimatedTokens.ok) {
    return maxEstimatedTokens;
  }

  return ok({
    query,
    include: includeGlobs,
    exclude: exclude.value,
    maxMatches: maxMatches.value,
    maxPackItems: maxPackItems.value,
    maxEstimatedTokens: maxEstimatedTokens.value,
    includeHidden: value.includeHidden ?? DEFAULT_RETRIEVAL_LIMITS.includeHidden,
    caseSensitive: value.caseSensitive ?? DEFAULT_RETRIEVAL_LIMITS.caseSensitive,
    allowRemote: value.allowRemote ?? DEFAULT_RETRIEVAL_LIMITS.allowRemote,
    destination: (value.destination as EmbeddingDestination | undefined) ?? "local",
  });
}

export function createInMemoryEmbeddingPort(
  result: Result<EmbeddingQueryResult, EmbeddingQueryError>,
): EmbeddingPort {
  return {
    async embedQuery(_query, _destination, signal) {
      if (signal?.aborted === true) {
        return err({ code: "cancelled" });
      }
      return result;
    },
  };
}

export function createInMemoryEmbeddingCorpus(
  generation: EmbeddingCorpusGeneration,
): EmbeddingCorpusPort {
  return {
    async snapshot(_root, signal) {
      if (signal?.aborted === true) {
        return err({ code: "cancelled" });
      }
      return ok(generation);
    },
  };
}

export function describeWorkspaceRetrievalError(error: WorkspaceRetrievalError): string {
  switch (error.code) {
    case "malformed":
      return `malformed:${error.reason}`;
    case "escaped":
      return "escaped";
    case "absolute-unscoped":
      return "absolute-unscoped";
    case "symlink-escape":
      return "symlink-escape";
    case "not-found":
      return "not-found";
    case "not-a-directory":
      return "not-a-directory";
    case "cancelled":
      return "cancelled";
    case "filesystem":
      return `filesystem:${error.reason}`;
    case "malformed-glob":
      return `malformed-glob:${error.reason}`;
    case "malformed-limit":
      return `malformed-limit:${error.field}:${error.reason}`;
    case "malformed-query":
      return `malformed-query:${error.reason}`;
    case "malformed-destination":
      return "malformed-destination";
    case "malformed-kind":
      return "malformed-kind";
    case "malformed-record-kind":
      return "malformed-record-kind";
    case "index-absent":
      return "index-absent";
    case "index-not-ready":
      return `index-not-ready:${error.lifecycle}`;
    case "index-corrupt":
      return "index-corrupt";
    case "unavailable":
      return "unavailable";
    default:
      return assertNever(error, "unhandled workspace retrieval error");
  }
}
