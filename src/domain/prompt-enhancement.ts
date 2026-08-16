/**
 * Prompt enhancement as a draft proposal, never a submission (#279).
 *
 * Local normalization is mechanical: line endings, trailing spaces, extra
 * blank lines, and edges. It does not invent a target, constraints, or
 * acceptance conditions. A model-backed rewrite is a different path and is
 * not performed here.
 */

export const ENHANCEMENT_PATHS = ["local", "model"] as const;
export type EnhancementPath = (typeof ENHANCEMENT_PATHS)[number];

export const ENHANCEMENT_OUTCOME_KINDS = [
  "proposal",
  "unchanged",
  "empty",
  "stale",
  "unavailable",
  "cancelled",
] as const;
export type EnhancementOutcomeKind = (typeof ENHANCEMENT_OUTCOME_KINDS)[number];

export type EnhancementRequest = {
  readonly text: string;
  readonly revision: number;
  readonly path: EnhancementPath;
  /** Attachment identities only. Local normalization does not read them. */
  readonly attachments: readonly string[];
};

export type EnhancementOutcome =
  | {
      readonly kind: "proposal";
      readonly original: string;
      readonly proposed: string;
      readonly explanation: string;
      readonly revision: number;
    }
  | { readonly kind: "unchanged"; readonly revision: number }
  | { readonly kind: "empty" }
  | { readonly kind: "stale"; readonly revision: number }
  | { readonly kind: "unavailable"; readonly reason: string; readonly owner: string }
  | { readonly kind: "cancelled" };

export type NormalizedPromptDraft = {
  readonly proposed: string;
  readonly changes: readonly string[];
};

/**
 * Deterministic local cleanup of a draft.
 *
 * Order is fold, per-line trailing space, blank-line collapse, then edges, so
 * the explanation names each mechanical step that actually fired.
 */
export function normalizePromptDraft(text: string): NormalizedPromptDraft {
  const changes: string[] = [];
  let proposed = text;

  const folded = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (folded !== proposed) {
    changes.push("folded line endings");
    proposed = folded;
  }

  const withoutTrailing = proposed
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n");
  if (withoutTrailing !== proposed) {
    changes.push("trimmed trailing spaces");
    proposed = withoutTrailing;
  }

  const collapsed = proposed.replace(/\n{3,}/g, "\n\n");
  if (collapsed !== proposed) {
    changes.push("collapsed extra blank lines");
    proposed = collapsed;
  }

  const trimmed = proposed.trim();
  if (trimmed !== proposed) {
    changes.push("trimmed edges");
    proposed = trimmed;
  }

  return { proposed, changes };
}

export function explainNormalization(changes: readonly string[]): string {
  if (changes.length === 0) {
    return "no mechanical changes";
  }
  if (changes.length === 1) {
    return changes[0] ?? "no mechanical changes";
  }
  const rest = changes.slice(0, -1).join(", ");
  const last = changes[changes.length - 1];
  return `${rest}, and ${last}`;
}

export function describeEnhancement(outcome: EnhancementOutcome): string {
  switch (outcome.kind) {
    case "proposal":
      return `Proposal ready: ${outcome.explanation}. Accept or reject.`;
    case "unchanged":
      return "Already clear; nothing to propose.";
    case "empty":
      return "Nothing to enhance: the draft is empty.";
    case "stale":
      return "Proposal is stale: the draft changed. Reject it or enhance again.";
    case "unavailable":
      return `Not enhanced: ${outcome.reason} (${outcome.owner}).`;
    case "cancelled":
      return "Enhancement cancelled. Your draft is unchanged.";
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
