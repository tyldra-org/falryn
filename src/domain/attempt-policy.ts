/**
 * Attempt classification for retry, fallback, refusal, partial, and terminal
 * settlement.
 *
 * Provider-neutral facts only. Application maps stream/tool/routing outcomes
 * onto {@link AttemptFact}, then uses {@link classifyAttempt} and
 * {@link decideAttemptAction} with {@link evaluateRetry} and routing fallback.
 *
 * Rules (UNIFIED-RUNTIME / PROVIDERS-AND-MODELS):
 * - refusal is a typed terminal, never silent success;
 * - partial retains observed facts and does not authorize blind retry;
 * - tool proposals already emitted block automatic same-route retry;
 * - retry and fallback are bounded; fallback never revisits a route.
 */

import type { DurationMs } from "./clock.ts";
import type { ModelAttemptId } from "./identity.ts";
import type { EffectCertainty, TerminalOutcome } from "./outcome.ts";
import { assertNever } from "./result.ts";
import type { RetryDecision, RetryRefusal } from "./retry.ts";

/** Provider-neutral failure categories the policy distinguishes. */
export const ATTEMPT_FAILURE_CATEGORIES = [
  "transport",
  "rate-limit",
  "authentication",
  "authorization",
  "invalid-request",
  "unsupported",
  "malformed",
  "server",
  "adapter",
  "safety",
  "other",
] as const;

export type AttemptFailureCategory = (typeof ATTEMPT_FAILURE_CATEGORIES)[number];

export function isAttemptFailureCategory(value: unknown): value is AttemptFailureCategory {
  return (
    typeof value === "string" && (ATTEMPT_FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Finish reasons that are model/policy refusals, not ordinary completion. */
export const REFUSAL_FINISH_REASONS = ["refusal", "content_filter", "safety"] as const;

export type RefusalFinishReason = (typeof REFUSAL_FINISH_REASONS)[number];

export function isRefusalFinishReason(value: string): value is RefusalFinishReason {
  return (REFUSAL_FINISH_REASONS as readonly string[]).includes(value);
}

export type RefusalSource = "model" | "policy" | "provider-safety";

/**
 * Observable facts from one model attempt. Effect certainty is carried
 * explicitly so partial/uncertain never collapse into bare failure.
 */
export type AttemptFact =
  | {
      readonly kind: "completed";
      readonly finishReason: string;
      readonly observedContent: boolean;
      readonly emittedToolProposal: boolean;
    }
  | {
      readonly kind: "failed";
      readonly category: AttemptFailureCategory;
      readonly retryable: boolean;
      readonly effect: EffectCertainty;
      readonly observedContent: boolean;
      readonly emittedToolProposal: boolean;
      readonly message: string;
    }
  | {
      readonly kind: "partial";
      readonly reason: string;
      readonly effect: EffectCertainty;
      readonly observedContent: boolean;
      readonly emittedToolProposal: boolean;
    }
  | {
      readonly kind: "cancelled";
      readonly effect: EffectCertainty;
    }
  | {
      readonly kind: "timed-out";
      readonly effect: EffectCertainty;
      readonly retryable: boolean;
    }
  | {
      readonly kind: "refusal";
      readonly source: RefusalSource;
      readonly reason: string;
      readonly effect: EffectCertainty;
    }
  | {
      readonly kind: "routing-refused";
      readonly code: string;
      readonly detail: string;
    };

export type AttemptIdentity = {
  /** 1-based attempt index across the whole turn policy run. */
  readonly attemptNumber: number;
  readonly modelAttemptId: ModelAttemptId;
  /** 0-based position in the role's ordered primary+fallback list. */
  readonly fallbackPosition: number;
  readonly providerKey: string;
  readonly modelKey: string;
};

export type AttemptClassification =
  | { readonly kind: "completed" }
  | {
      readonly kind: "refusal";
      readonly source: RefusalSource;
      readonly reason: string;
      readonly effect: EffectCertainty;
    }
  | {
      readonly kind: "partial";
      readonly reason: string;
      readonly effect: EffectCertainty;
    }
  | {
      readonly kind: "cancelled";
      readonly effect: EffectCertainty;
    }
  | {
      readonly kind: "timed-out";
      readonly effect: EffectCertainty;
    }
  | {
      readonly kind: "uncertain";
      readonly effect: "uncertain";
    }
  | {
      readonly kind: "failed";
      readonly effect: EffectCertainty;
      readonly message: string;
    }
  | {
      readonly kind: "may-retry-same";
      readonly effect: EffectCertainty;
      readonly message: string;
    }
  | {
      readonly kind: "may-fallback";
      readonly effect: EffectCertainty;
      readonly message: string;
    };

/**
 * Map one attempt's facts onto a classification. Does not apply attempt
 * budgets or fallback availability — {@link decideAttemptAction} does that.
 */
export function classifyAttempt(fact: AttemptFact): AttemptClassification {
  switch (fact.kind) {
    case "completed": {
      if (isRefusalFinishReason(fact.finishReason)) {
        return {
          kind: "refusal",
          source: "model",
          reason: fact.finishReason,
          effect: fact.observedContent ? "partial" : "none",
        };
      }
      if (fact.finishReason === "length") {
        return {
          kind: "partial",
          reason: "finish-reason-length",
          effect: fact.observedContent || fact.emittedToolProposal ? "partial" : "none",
        };
      }
      return { kind: "completed" };
    }
    case "refusal":
      return {
        kind: "refusal",
        source: fact.source,
        reason: fact.reason,
        effect: fact.effect,
      };
    case "routing-refused":
      return {
        kind: "refusal",
        source: "policy",
        reason: fact.code,
        effect: "none",
      };
    case "partial":
      return {
        kind: "partial",
        reason: fact.reason,
        effect: fact.effect,
      };
    case "cancelled":
      return { kind: "cancelled", effect: fact.effect };
    case "timed-out": {
      if (fact.effect === "uncertain") {
        return { kind: "uncertain", effect: "uncertain" };
      }
      if (fact.retryable && fact.effect === "none") {
        return {
          kind: "may-retry-same",
          effect: fact.effect,
          message: "attempt timed out before observed output",
        };
      }
      return { kind: "timed-out", effect: fact.effect };
    }
    case "failed": {
      if (fact.category === "safety") {
        return {
          kind: "refusal",
          source: "provider-safety",
          reason: fact.message,
          effect: fact.effect,
        };
      }
      if (fact.effect === "uncertain") {
        return { kind: "uncertain", effect: "uncertain" };
      }
      // A tool proposal may have influenced the model loop — never blind-retry.
      if (fact.emittedToolProposal) {
        return {
          kind: "failed",
          effect: fact.effect === "none" ? "partial" : fact.effect,
          message: fact.message,
        };
      }
      if (fact.effect === "partial") {
        return {
          kind: "partial",
          reason: fact.message,
          effect: "partial",
        };
      }
      if (fact.retryable && fact.effect === "none") {
        return {
          kind: "may-retry-same",
          effect: "none",
          message: fact.message,
        };
      }
      // Non-retryable transport/auth/etc. may still walk the fallback list.
      if (fact.effect === "none") {
        return {
          kind: "may-fallback",
          effect: "none",
          message: fact.message,
        };
      }
      return { kind: "failed", effect: fact.effect, message: fact.message };
    }
    default:
      return assertNever(fact, "unhandled attempt fact");
  }
}

export type AttemptAction =
  | {
      readonly kind: "retry-same";
      readonly attempt: number;
      readonly delayMs: DurationMs;
    }
  | { readonly kind: "fallback" }
  | {
      readonly kind: "settle";
      readonly classification: Exclude<
        AttemptClassification,
        { readonly kind: "may-retry-same" } | { readonly kind: "may-fallback" }
      >;
    }
  | {
      readonly kind: "exhausted";
      readonly reason: RetryRefusal | "fallback-exhausted";
      readonly classification: AttemptClassification;
    };

export type DecideAttemptActionInput = {
  readonly classification: AttemptClassification;
  /** Result of {@link evaluateRetry} when classification is `may-retry-same`. */
  readonly retryDecision: RetryDecision | null;
  /** Whether {@link resolveNextFallback} still has an unvisited candidate. */
  readonly fallbackAvailable: boolean;
};

/**
 * Choose the next policy action after classification and budget checks.
 *
 * Order: settle terminals first; same-route retry when authorized; otherwise
 * fallback when available; otherwise exhaust with a typed reason.
 */
export function decideAttemptAction(input: DecideAttemptActionInput): AttemptAction {
  const { classification } = input;

  switch (classification.kind) {
    case "completed":
    case "refusal":
    case "partial":
    case "cancelled":
    case "timed-out":
    case "uncertain":
    case "failed":
      return { kind: "settle", classification };
    case "may-retry-same": {
      const decision = input.retryDecision;
      if (decision !== null && decision.kind === "retry") {
        return {
          kind: "retry-same",
          attempt: decision.attempt,
          delayMs: decision.delayMs,
        };
      }
      if (input.fallbackAvailable) {
        return { kind: "fallback" };
      }
      return {
        kind: "exhausted",
        reason: decision?.kind === "do-not-retry" ? decision.reason : "attempts-exhausted",
        classification,
      };
    }
    case "may-fallback": {
      if (input.fallbackAvailable) {
        return { kind: "fallback" };
      }
      return {
        kind: "exhausted",
        reason: "fallback-exhausted",
        classification,
      };
    }
    default:
      return assertNever(classification, "unhandled attempt classification");
  }
}

/** Map a settling classification onto the turn-machine terminal vocabulary. */
export function terminalOutcomeForClassification(
  classification: Exclude<
    AttemptClassification,
    | { readonly kind: "may-retry-same" }
    | { readonly kind: "may-fallback" }
    | { readonly kind: "completed" }
  >,
): TerminalOutcome {
  switch (classification.kind) {
    case "refusal":
    case "partial":
    case "failed":
      return { kind: "failed", effect: classification.effect };
    case "cancelled":
      return { kind: "cancelled", effect: classification.effect };
    case "timed-out":
      return { kind: "timed-out", effect: classification.effect };
    case "uncertain":
      return { kind: "uncertain", effect: "uncertain" };
    default:
      return assertNever(classification, "unhandled settlement classification");
  }
}
