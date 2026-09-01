/** Bounded workspace-index evidence preparation for a live product turn (#788). */

import { createHash } from "node:crypto";

import {
  admitEvidenceCandidate,
  type EvidenceCandidate,
  type FileSystemPort,
  type LocalPath,
  type PromptSectionInput,
  type WorkspaceId,
  type WorkspaceIndexPort,
} from "../domain/index.ts";
import { createWorkspaceRetrieval } from "./workspace-retrieval.ts";

export const PRODUCT_CONTEXT_SOURCE_OWNER = "#788";
export const MAX_PRODUCT_CONTEXT_QUERIES = 4;

const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "before",
  "could",
  "from",
  "have",
  "into",
  "please",
  "should",
  "that",
  "their",
  "then",
  "there",
  "these",
  "they",
  "this",
  "through",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
]);

export type ProductContextReceipt = {
  readonly owner: typeof PRODUCT_CONTEXT_SOURCE_OWNER;
  readonly status: "ready" | "empty" | "unavailable" | "cancelled";
  readonly generation: string | null;
  readonly schema: string | null;
  readonly queries: readonly string[];
  readonly candidateCount: number;
  readonly omitted: number;
  readonly staleOmitted: number;
  readonly code: string | null;
};

export type ProductPreparedContext = {
  readonly candidates: readonly EvidenceCandidate[];
  readonly sections: readonly PromptSectionInput[];
  readonly receipt: ProductContextReceipt;
};

export type ProductContextSource = {
  prepare(task: string, signal?: AbortSignal): Promise<ProductPreparedContext>;
};

export type ProductContextSourceOptions = {
  readonly fileSystem: FileSystemPort;
  readonly index: WorkspaceIndexPort;
  readonly workspaceRoot: LocalPath;
  readonly workspaceId: WorkspaceId;
  readonly additionalCandidates?: () => readonly EvidenceCandidate[];
};

/** A typed degraded source for hosts that could not open the durable index. */
export function createUnavailableProductContextSource(
  code: string,
  additionalCandidates?: () => readonly EvidenceCandidate[],
): ProductContextSource {
  return {
    async prepare(_task, signal) {
      const candidates = additionalCandidates?.() ?? [];
      const resolvedCode = signal?.aborted === true ? "cancelled" : code;
      return {
        candidates,
        sections: [unavailableSection(resolvedCode)],
        receipt: receipt({
          status: signal?.aborted === true ? "cancelled" : "unavailable",
          generation: null,
          schema: null,
          queries: [],
          candidateCount: candidates.length,
          omitted: 0,
          staleOmitted: 0,
          code: resolvedCode,
        }),
      };
    },
  };
}

function stableId(values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(value);
    hash.update("\0");
  }
  return `evidence-index-${hash.digest("hex").slice(0, 32)}`;
}

function queriesForTask(task: string): readonly string[] {
  const candidates = [
    ...task.matchAll(/`([^`\n]{2,128})`/g),
    ...task.matchAll(/\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b/g),
    ...task.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$.-]{2,127}\b/g),
  ]
    .map((match) => match[1] ?? match[0])
    .map((value) => value.trim())
    .filter((value) => value.length >= 3 && !STOP_WORDS.has(value.toLowerCase()));

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
    if (unique.length >= MAX_PRODUCT_CONTEXT_QUERIES) {
      break;
    }
  }
  return unique;
}

function unavailableSection(code: string): PromptSectionInput {
  return {
    id: "workspace-index",
    role: "evidence",
    source: `product:${PRODUCT_CONTEXT_SOURCE_OWNER}`,
    content: `Workspace index unavailable (${code}).`,
    required: false,
    available: false,
  };
}

function receipt(fields: Omit<ProductContextReceipt, "owner">): ProductContextReceipt {
  return { owner: PRODUCT_CONTEXT_SOURCE_OWNER, ...fields };
}

/**
 * Prepare initial indexed evidence before prompt composition.
 *
 * The index nominates bounded excerpts only. Current file bytes and Product
 * Read remain the authority for exact source and expansion.
 */
export function createProductContextSource(
  options: ProductContextSourceOptions,
): ProductContextSource {
  const retrieval = createWorkspaceRetrieval({
    fileSystem: options.fileSystem,
    index: options.index,
  });

  return {
    async prepare(task, signal) {
      const queries = queriesForTask(task);
      const additional = options.additionalCandidates?.() ?? [];
      if (signal?.aborted === true) {
        return {
          candidates: additional,
          sections: [unavailableSection("cancelled")],
          receipt: receipt({
            status: "cancelled",
            generation: null,
            schema: null,
            queries,
            candidateCount: additional.length,
            omitted: 0,
            staleOmitted: 0,
            code: "cancelled",
          }),
        };
      }

      const selected = new Map<string, EvidenceCandidate>();
      for (const candidate of additional) {
        selected.set(String(candidate.id), candidate);
      }
      let generation: string | null = null;
      let schema: string | null = null;
      let omitted = 0;
      let staleOmitted = 0;
      let lastError: string | null = null;
      let successfulQueries = 0;

      for (const query of queries) {
        const found = await retrieval.retrieve(
          options.workspaceRoot,
          {
            query,
            include: ["**/*"],
            exclude: [],
            caseSensitive: false,
            maxMatches: 20,
            maxPackItems: 8,
            maxEstimatedTokens: 2_048,
          },
          signal,
        );
        if (!found.ok) {
          lastError = found.error.code;
          if (found.error.code === "cancelled") {
            return {
              candidates: [...selected.values()],
              sections: [unavailableSection("cancelled")],
              receipt: receipt({
                status: "cancelled",
                generation,
                schema,
                queries,
                candidateCount: selected.size,
                omitted,
                staleOmitted,
                code: "cancelled",
              }),
            };
          }
          continue;
        }
        successfulQueries += 1;
        generation = found.value.generation;
        schema = found.value.schema;
        omitted += found.value.pack.omitted;

        for (const item of found.value.pack.items) {
          if (item.freshness === "stale") {
            staleOmitted += 1;
            continue;
          }
          const body = [
            `path:${item.logical} lines:${item.startLine}-${item.endLine} kind:${item.kind}`,
            item.excerpt,
          ].join("\n");
          const admitted = admitEvidenceCandidate(
            {
              id: stableId([
                String(options.workspaceId),
                found.value.generation,
                item.logical,
                String(item.startLine),
                String(item.endLine),
                item.excerpt,
              ]),
              sourceKind: item.kind === "symbol" ? "symbol" : "file",
              origin: `${item.logical}:${item.startLine}-${item.endLine}`,
              workspaceId: String(options.workspaceId),
              payload: { kind: "inline", text: body },
              estimatedTokens: Math.max(1, Math.ceil(body.length / 4)),
              freshness: "indexed",
              sensitivity: "user-content",
              trust: "adapter-declared",
              fidelity: "bounded-excerpt",
              retrievalCost: 1,
              lineage: [
                `index:${found.value.schema}`,
                `generation:${found.value.generation}`,
                `lane:${item.reason}`,
                `freshness:${item.freshness}`,
              ],
            },
            { expectedWorkspaceId: options.workspaceId },
          );
          if (admitted.ok) {
            selected.set(String(admitted.value.id), admitted.value);
          } else {
            omitted += 1;
          }
        }
      }

      if (queries.length > 0 && successfulQueries === 0) {
        const code = lastError ?? "unavailable";
        return {
          candidates: [...selected.values()],
          sections: [unavailableSection(code)],
          receipt: receipt({
            status: "unavailable",
            generation,
            schema,
            queries,
            candidateCount: selected.size,
            omitted,
            staleOmitted,
            code,
          }),
        };
      }

      return {
        candidates: [...selected.values()],
        sections: [],
        receipt: receipt({
          status: selected.size === 0 ? "empty" : "ready",
          generation,
          schema,
          queries,
          candidateCount: selected.size,
          omitted,
          staleOmitted,
          code: lastError,
        }),
      };
    },
  };
}
