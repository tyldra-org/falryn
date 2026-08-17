/**
 * Qualification for optional embeddings and structural parsing (#94).
 *
 * Expensive optional backends run only when available and justified against
 * cheaper lexical/symbol baselines. Live Tree-sitter and embedding providers
 * remain injectable; this module owns the admit/skip decision.
 */

import { assertNever } from "./result.ts";

/** Cosine floor: semantic must clear this before beating lexical/symbol tiers. */
export const SEMANTIC_BASELINE = 0.2;

export const EMBEDDING_DESTINATIONS = ["local", "remote"] as const;
export type EmbeddingDestination = (typeof EMBEDDING_DESTINATIONS)[number];

export const STRUCTURAL_PARSE_MIN_FILE_BYTES = 64;
export const STRUCTURAL_PARSE_LANGUAGES = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "csharp",
] as const;

export type OptionalIntelligenceCapability = "embeddings" | "structural-parsing";

export type QualificationSkipReason =
  | "unavailable"
  | "denied"
  | "below-baseline"
  | "not-justified"
  | "disabled";

export type QualificationDecision =
  | {
      readonly capability: OptionalIntelligenceCapability;
      readonly decision: "use";
      readonly reason: "justified";
    }
  | {
      readonly capability: OptionalIntelligenceCapability;
      readonly decision: "skip";
      readonly reason: QualificationSkipReason;
    };

export type EmbeddingsQualificationInput = {
  /** Embedding port / corpus is wired. */
  readonly available: boolean;
  readonly destination: EmbeddingDestination;
  readonly allowRemote: boolean;
  /** Best cosine similarity observed for the query, or null if not scored. */
  readonly maxSimilarity: number | null;
  readonly lexicalHitCount: number;
  readonly structuralHitCount: number;
  /** When true, refuse embeddings even if otherwise justified. */
  readonly disabled?: boolean | undefined;
};

export type StructuralParsingQualificationInput = {
  readonly parserAvailable: boolean;
  readonly languageId: string | null;
  readonly regexSymbolCount: number;
  readonly fileBytes: number;
  readonly disabled?: boolean | undefined;
  /** Explicit opt-in when the caller already knows parsing is required. */
  readonly force?: boolean | undefined;
};

function languageSupportsStructuralParsing(languageId: string | null): boolean {
  if (languageId === null) {
    return false;
  }
  const normalized = languageId.trim().toLowerCase();
  return (STRUCTURAL_PARSE_LANGUAGES as readonly string[]).includes(normalized);
}

/**
 * Admit embeddings only when they are usable and beat the lexical/symbol floor.
 *
 * Similarity must meet {@link SEMANTIC_BASELINE}. When lexical and structural
 * hits already exist, embeddings must still clear that floor (quality bar);
 * when they do not, embeddings may still be used to recover candidates.
 */
export function qualifyEmbeddings(input: EmbeddingsQualificationInput): QualificationDecision {
  if (input.disabled === true) {
    return { capability: "embeddings", decision: "skip", reason: "disabled" };
  }
  if (!input.available) {
    return { capability: "embeddings", decision: "skip", reason: "unavailable" };
  }
  if (input.destination === "remote" && !input.allowRemote) {
    return { capability: "embeddings", decision: "skip", reason: "denied" };
  }
  if (input.maxSimilarity === null) {
    return { capability: "embeddings", decision: "skip", reason: "unavailable" };
  }
  if (input.maxSimilarity < SEMANTIC_BASELINE) {
    return { capability: "embeddings", decision: "skip", reason: "below-baseline" };
  }
  // Similarity cleared the baseline — justified relative to cheaper tiers.
  return { capability: "embeddings", decision: "use", reason: "justified" };
}

/**
 * Admit structural parsing only when a parser exists and regex/lexical
 * extractors are insufficient for a supported language (or the caller forces).
 */
export function qualifyStructuralParsing(
  input: StructuralParsingQualificationInput,
): QualificationDecision {
  if (input.disabled === true) {
    return { capability: "structural-parsing", decision: "skip", reason: "disabled" };
  }
  if (!input.parserAvailable) {
    return { capability: "structural-parsing", decision: "skip", reason: "unavailable" };
  }
  if (input.force === true) {
    return { capability: "structural-parsing", decision: "use", reason: "justified" };
  }
  if (!languageSupportsStructuralParsing(input.languageId)) {
    return { capability: "structural-parsing", decision: "skip", reason: "not-justified" };
  }
  if (input.fileBytes < STRUCTURAL_PARSE_MIN_FILE_BYTES) {
    return { capability: "structural-parsing", decision: "skip", reason: "not-justified" };
  }
  if (input.regexSymbolCount > 0) {
    // Regex already found symbols; Tree-sitter is not justified by default.
    return { capability: "structural-parsing", decision: "skip", reason: "not-justified" };
  }
  return { capability: "structural-parsing", decision: "use", reason: "justified" };
}

export function qualificationUses(decision: QualificationDecision): boolean {
  switch (decision.decision) {
    case "use":
      return true;
    case "skip":
      return false;
    default:
      return assertNever(decision, "unhandled qualification decision");
  }
}
