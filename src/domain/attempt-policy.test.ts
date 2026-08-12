import { describe, expect, test } from "bun:test";

import {
  type AttemptFact,
  classifyAttempt,
  decideAttemptAction,
  duration,
  isRefusalFinishReason,
  modelAttemptId,
  terminalOutcomeForClassification,
} from "./index.ts";

describe("attempt policy classification", () => {
  test("maps refusal finish reasons to typed refusal, not success", () => {
    expect(isRefusalFinishReason("refusal")).toBe(true);
    expect(isRefusalFinishReason("content_filter")).toBe(true);
    expect(isRefusalFinishReason("stop")).toBe(false);

    const classification = classifyAttempt({
      kind: "completed",
      finishReason: "refusal",
      observedContent: false,
      emittedToolProposal: false,
    });
    expect(classification).toEqual({
      kind: "refusal",
      source: "model",
      reason: "refusal",
      effect: "none",
    });
  });

  test("treats length finish as partial when content was observed", () => {
    expect(
      classifyAttempt({
        kind: "completed",
        finishReason: "length",
        observedContent: true,
        emittedToolProposal: false,
      }),
    ).toEqual({
      kind: "partial",
      reason: "finish-reason-length",
      effect: "partial",
    });
  });

  test("ordinary stop completes", () => {
    expect(
      classifyAttempt({
        kind: "completed",
        finishReason: "stop",
        observedContent: true,
        emittedToolProposal: false,
      }),
    ).toEqual({ kind: "completed" });
  });

  test("provider-safety and routing refusals stay typed refusals", () => {
    expect(
      classifyAttempt({
        kind: "refusal",
        source: "provider-safety",
        reason: "safety filter",
        effect: "none",
      }).kind,
    ).toBe("refusal");
    expect(
      classifyAttempt({
        kind: "routing-refused",
        code: "role-disabled",
        detail: "role-disabled",
      }),
    ).toMatchObject({ kind: "refusal", source: "policy", reason: "role-disabled" });
  });

  test("retryable transport failure before output may retry", () => {
    expect(
      classifyAttempt({
        kind: "failed",
        category: "transport",
        retryable: true,
        effect: "none",
        observedContent: false,
        emittedToolProposal: false,
        message: "connection reset",
      }).kind,
    ).toBe("may-retry-same");
  });

  test("emitted tool proposal blocks blind retry", () => {
    expect(
      classifyAttempt({
        kind: "failed",
        category: "transport",
        retryable: true,
        effect: "none",
        observedContent: false,
        emittedToolProposal: true,
        message: "connection reset after tools",
      }),
    ).toEqual({
      kind: "failed",
      effect: "partial",
      message: "connection reset after tools",
    });
  });

  test("partial stream facts settle as partial", () => {
    expect(
      classifyAttempt({
        kind: "partial",
        reason: "missing-terminal",
        effect: "partial",
        observedContent: true,
        emittedToolProposal: false,
      }).kind,
    ).toBe("partial");
  });

  test("safety category becomes provider-safety refusal", () => {
    expect(
      classifyAttempt({
        kind: "failed",
        category: "safety",
        retryable: false,
        effect: "none",
        observedContent: false,
        emittedToolProposal: false,
        message: "blocked",
      }),
    ).toMatchObject({ kind: "refusal", source: "provider-safety" });
  });

  test("non-retryable clean failure may fall back", () => {
    expect(
      classifyAttempt({
        kind: "failed",
        category: "authentication",
        retryable: false,
        effect: "none",
        observedContent: false,
        emittedToolProposal: false,
        message: "bad credentials",
      }).kind,
    ).toBe("may-fallback");
  });

  test("uncertain effect settles uncertain", () => {
    expect(
      classifyAttempt({
        kind: "failed",
        category: "server",
        retryable: true,
        effect: "uncertain",
        observedContent: true,
        emittedToolProposal: false,
        message: "lost mid-flight",
      }),
    ).toEqual({ kind: "uncertain", effect: "uncertain" });
  });
});

describe("attempt policy action", () => {
  test("settles terminal classifications immediately", () => {
    expect(
      decideAttemptAction({
        classification: { kind: "completed" },
        retryDecision: null,
        fallbackAvailable: true,
      }),
    ).toEqual({ kind: "settle", classification: { kind: "completed" } });
  });

  test("retries when evaluateRetry authorizes another attempt", () => {
    expect(
      decideAttemptAction({
        classification: {
          kind: "may-retry-same",
          effect: "none",
          message: "rate limited",
        },
        retryDecision: { kind: "retry", attempt: 2, delayMs: duration(100) },
        fallbackAvailable: true,
      }),
    ).toEqual({ kind: "retry-same", attempt: 2, delayMs: duration(100) });
  });

  test("falls back when same-route retry is refused but a route remains", () => {
    expect(
      decideAttemptAction({
        classification: {
          kind: "may-retry-same",
          effect: "none",
          message: "rate limited",
        },
        retryDecision: { kind: "do-not-retry", reason: "attempts-exhausted" },
        fallbackAvailable: true,
      }),
    ).toEqual({ kind: "fallback" });
  });

  test("exhausts with a typed reason when neither retry nor fallback remains", () => {
    expect(
      decideAttemptAction({
        classification: {
          kind: "may-fallback",
          effect: "none",
          message: "auth failed",
        },
        retryDecision: null,
        fallbackAvailable: false,
      }),
    ).toMatchObject({ kind: "exhausted", reason: "fallback-exhausted" });
  });

  test("maps settlement classifications onto turn terminals", () => {
    expect(
      terminalOutcomeForClassification({
        kind: "refusal",
        source: "model",
        reason: "refusal",
        effect: "none",
      }),
    ).toEqual({ kind: "failed", effect: "none" });
    expect(
      terminalOutcomeForClassification({
        kind: "partial",
        reason: "missing-terminal",
        effect: "partial",
      }),
    ).toEqual({ kind: "failed", effect: "partial" });
    expect(
      terminalOutcomeForClassification({
        kind: "cancelled",
        effect: "none",
      }),
    ).toEqual({ kind: "cancelled", effect: "none" });
  });

  test("attempt identity carries visible attempt numbers", () => {
    const fact: AttemptFact = {
      kind: "completed",
      finishReason: "stop",
      observedContent: true,
      emittedToolProposal: false,
    };
    expect(classifyAttempt(fact).kind).toBe("completed");
    expect(modelAttemptId.from("attempt-1")).toBe(modelAttemptId.from("attempt-1"));
  });
});
