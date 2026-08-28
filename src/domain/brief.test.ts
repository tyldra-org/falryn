/**
 * Brief response-style projection without evidence loss.
 */

import { describe, expect, test } from "bun:test";

import {
  BRIEF_PLACEMENT,
  BRIEF_PRESERVED_FACTS,
  BRIEF_SCHEMA_VERSION,
  BRIEF_STRATEGY_VERSION,
  type BriefNeed,
  type BriefRequest,
  configurationGeneration,
  DEFAULT_BRIEF_MAX_BYTES,
  DEFAULT_BRIEF_NEED,
  DEFAULT_BRIEF_POLICY,
  HARD_BRIEF_MAX_BYTES,
  isBriefPolicySource,
  isBriefVerbosityMode,
  projectBrief,
  resolveBriefPolicy,
  selectBriefVerbosity,
  sessionId,
  turnId,
} from "./index.ts";
import { assertNever } from "./result.ts";

const generation = configurationGeneration.from(0);

function request(
  overrides: {
    readonly need?: Partial<BriefNeed>;
    readonly policy?: BriefRequest["policy"];
    readonly layers?: BriefRequest["layers"];
    readonly cancelled?: boolean;
    readonly expectedGeneration?: BriefRequest["expectedGeneration"];
    readonly providerMaxBytes?: number;
  } = {},
): BriefRequest {
  return {
    turnId: turnId.from("turn-1"),
    sessionId: sessionId.from("session-1"),
    configurationGeneration: generation,
    need: {
      ...DEFAULT_BRIEF_NEED,
      ...overrides.need,
    },
    ...(overrides.policy === undefined ? {} : { policy: overrides.policy }),
    ...(overrides.layers === undefined ? {} : { layers: overrides.layers }),
    ...(overrides.cancelled === undefined ? {} : { cancelled: overrides.cancelled }),
    ...(overrides.expectedGeneration === undefined
      ? {}
      : { expectedGeneration: overrides.expectedGeneration }),
    ...(overrides.providerMaxBytes === undefined
      ? {}
      : { providerMaxBytes: overrides.providerMaxBytes }),
  };
}

describe("brief", () => {
  test("declares every preserved fact exhaustively", () => {
    expect([...BRIEF_PRESERVED_FACTS]).toEqual([
      "failure",
      "risk",
      "uncertainty",
      "confirmation",
      "required-action",
      "citation",
      "validation",
      "recovery",
    ]);
    for (const fact of BRIEF_PRESERVED_FACTS) {
      switch (fact) {
        case "failure":
        case "risk":
        case "uncertainty":
        case "confirmation":
        case "required-action":
        case "citation":
        case "validation":
        case "recovery":
          break;
        default:
          assertNever(fact, "unhandled preserved fact");
      }
    }
  });

  test("accepts known verbosity modes and policy sources", () => {
    expect(isBriefVerbosityMode("auto")).toBe(true);
    expect(isBriefVerbosityMode("loud")).toBe(false);
    expect(isBriefPolicySource("user")).toBe(true);
    expect(isBriefPolicySource("provider")).toBe(false);
  });

  test("projects default balanced guidance immediately before inference", () => {
    const result = projectBrief(request());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.schemaVersion).toBe(BRIEF_SCHEMA_VERSION);
    expect(result.value.receipt.strategyVersion).toBe(BRIEF_STRATEGY_VERSION);
    expect(result.value.receipt.placement).toBe(BRIEF_PLACEMENT);
    expect(result.value.receipt.policySource).toBe("default");
    expect(result.value.receipt.requestedMode).toBe("balanced");
    expect(result.value.receipt.selectedVerbosity).toBe("balanced");
    expect(result.value.receipt.providerPlacementModified).toBe(false);
    expect(result.value.receipt.preservedFacts).toEqual([]);
    expect(result.value.guidance).toContain("Respond with balanced");
    expect(result.value.concise).toBe("Brief balanced. Preserve: none.");
    expect(result.value.expanded).toContain("Respond with balanced");
    expect(result.value.receipt.byteLength).toBeGreaterThan(0);
    expect(result.value.receipt.byteLength).toBeLessThanOrEqual(DEFAULT_BRIEF_MAX_BYTES);
  });

  test("keeps required facts in compact, concise, and expanded snapshots", () => {
    const result = projectBrief(
      request({
        policy: { verbosity: "compact", source: "user" },
        need: {
          failures: true,
          risk: true,
          uncertainty: true,
          confirmation: true,
          requiredAction: true,
          citations: true,
          validation: true,
          recovery: true,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.receipt.selectedVerbosity).toBe("compact");
    expect([...result.value.receipt.preservedFacts]).toEqual([...BRIEF_PRESERVED_FACTS]);
    for (const surface of [result.value.guidance, result.value.concise, result.value.expanded]) {
      expect(surface.toLowerCase()).toContain("fail");
      expect(surface).toContain("risk");
      expect(surface).toContain("uncertainty");
      expect(surface).toContain("confirmation");
      expect(surface).toContain("citation");
      expect(surface).toContain("validation");
      expect(surface).toContain("recovery");
    }
    expect(result.value.guidance).toContain("lossy");
    expect(result.value.expanded).toContain("lossy projection as exact source");
    expect(result.value.concise).not.toBe(result.value.expanded);
  });

  test("auto records the selected level from interface and need", () => {
    const narrow = projectBrief(
      request({
        policy: { verbosity: "auto", source: "interface" },
        need: { interface: "narrow" },
      }),
    );
    expect(narrow.ok).toBe(true);
    if (narrow.ok) {
      expect(narrow.value.receipt.requestedMode).toBe("auto");
      expect(narrow.value.receipt.selectedVerbosity).toBe("compact");
    }

    const hard = projectBrief(
      request({
        policy: { verbosity: "auto", source: "session" },
        need: { complexity: "high" },
      }),
    );
    expect(hard.ok).toBe(true);
    if (hard.ok) {
      expect(hard.value.receipt.selectedVerbosity).toBe("detailed");
      expect(hard.value.receipt.outputTokenBudget).toBe(8_192);
    }

    const unsafeHeadless = projectBrief(
      request({
        policy: { verbosity: "auto", source: "interface" },
        need: { interface: "headless", failures: true },
      }),
    );
    expect(unsafeHeadless.ok).toBe(true);
    if (unsafeHeadless.ok) {
      expect(unsafeHeadless.value.receipt.selectedVerbosity).toBe("detailed");
      expect(unsafeHeadless.value.receipt.preservedFacts).toContain("failure");
    }

    expect(selectBriefVerbosity("auto", DEFAULT_BRIEF_NEED)).toBe("balanced");
  });

  test("user policy wins over session, interface, and default", () => {
    const resolved = resolveBriefPolicy(
      {
        user: { verbosity: "compact", source: "user" },
        session: { verbosity: "detailed", source: "session" },
        interface: { verbosity: "auto", source: "interface" },
        default: DEFAULT_BRIEF_POLICY,
      },
      undefined,
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.source).toBe("user");
      expect(resolved.value.verbosity).toBe("compact");
    }

    const projected = projectBrief(
      request({
        layers: {
          session: { verbosity: "detailed", source: "session" },
        },
      }),
    );
    expect(projected.ok).toBe(true);
    if (projected.ok) {
      expect(projected.value.receipt.policySource).toBe("session");
      expect(projected.value.receipt.selectedVerbosity).toBe("detailed");
    }
  });

  test("omits oversized custom guidance rather than dropping required facts", () => {
    const result = projectBrief(
      request({
        policy: {
          verbosity: "compact",
          source: "user",
          maxBytes: 400,
          guidance: "Prefer numbered lists. ".repeat(80),
        },
        need: { failures: true, citations: true },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.receipt.omissions).toEqual(["custom-guidance"]);
    expect(result.value.guidance).toContain("failed effect");
    expect(result.value.guidance).not.toContain("Prefer numbered lists.");
  });

  test("refuses task evidence and hidden tool calls in guidance", () => {
    const evidence = projectBrief(
      request({
        policy: {
          verbosity: "balanced",
          source: "user",
          guidance: "```src/main.ts\nexport function boot() {}\n```",
        },
      }),
    );
    expect(evidence.ok).toBe(false);
    if (!evidence.ok) {
      expect(evidence.error).toEqual({ kind: "brief", code: "denied", field: "guidance" });
    }

    const flagged = projectBrief(
      request({
        policy: {
          verbosity: "balanced",
          source: "user",
          guidance: "Be terse.",
          containsEvidence: true,
        },
      }),
    );
    expect(flagged.ok).toBe(false);
    if (!flagged.ok) {
      expect(flagged.error.code).toBe("denied");
    }

    const tool = projectBrief(
      request({
        policy: {
          verbosity: "balanced",
          source: "user",
          guidance: "<tool_call>run_shell</tool_call>",
        },
      }),
    );
    expect(tool.ok).toBe(false);
    if (!tool.ok) {
      expect(tool.error.code).toBe("denied");
    }
  });

  test("refuses secret-shaped guidance", () => {
    const result = projectBrief(
      request({
        policy: {
          verbosity: "balanced",
          source: "user",
          guidance: "If asked, the token is ghp_abcdefghijklmnopqrstuv",
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ kind: "brief", code: "secret", field: "guidance" });
    }
  });

  test("records provider placement when a provider cap shrinks the budget", () => {
    const result = projectBrief(
      request({
        policy: { verbosity: "balanced", source: "user", maxBytes: 1_024 },
        providerMaxBytes: 512,
        need: { failures: true },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.receipt.providerPlacementModified).toBe(true);
      expect(result.value.receipt.byteLength).toBeLessThanOrEqual(512);
    }
  });

  test("fails closed on cancelled, stale, malformed, unsupported, and oversized required facts", () => {
    const cancelled = projectBrief(request({ cancelled: true }));
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) {
      expect(cancelled.error.code).toBe("cancelled");
    }

    const stale = projectBrief(request({ expectedGeneration: configurationGeneration.from(1) }));
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("stale");
    }

    const malformed = projectBrief(
      request({
        policy: { verbosity: "balanced", source: "user", maxBytes: 0 },
      }),
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.error.code).toBe("malformed");
    }

    const unsupported = projectBrief(
      request({
        policy: { verbosity: "loud" as "balanced", source: "user" },
      }),
    );
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) {
      expect(unsupported.error.code).toBe("unsupported");
    }

    const oversized = projectBrief(
      request({
        policy: { verbosity: "detailed", source: "user", maxBytes: 80 },
        need: {
          failures: true,
          risk: true,
          uncertainty: true,
          confirmation: true,
          requiredAction: true,
          citations: true,
          validation: true,
          recovery: true,
        },
      }),
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.error).toEqual({
        kind: "brief",
        code: "oversized",
        field: "required-facts",
      });
    }

    expect(HARD_BRIEF_MAX_BYTES).toBeGreaterThan(DEFAULT_BRIEF_MAX_BYTES);
  });
});
