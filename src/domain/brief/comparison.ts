/** Matched Brief/Caveman comparison contracts (#827). */

export const BRIEF_COMPARISON_SCHEMA_VERSION = 1;
export const BRIEF_COMPARISON_VERDICTS = ["pass", "tie", "loss", "invalid"] as const;
export type BriefComparisonVerdict = (typeof BRIEF_COMPARISON_VERDICTS)[number];

export const BRIEF_COMPARISON_INVALID_REASONS = [
  "mismatched-input",
  "baseline-drift",
  "cancelled",
  "provider-failure",
  "missing-usage",
  "partial-run",
] as const;
export type BriefComparisonInvalidReason = (typeof BRIEF_COMPARISON_INVALID_REASONS)[number];

export type BriefComparisonMatch = {
  readonly taskDigest: string;
  readonly fixtureDigest: string;
  readonly workspaceDigest: string;
  readonly instructionDigest: string;
  readonly evidenceDigest: string;
  readonly toolHistoryDigest: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoning: string;
  readonly outputTokenLimit: number;
  readonly cacheState: string;
  readonly retryPolicyDigest: string;
};

export type BriefComparisonUsage = {
  readonly provenance: "provider-reported";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
};

export type BriefComparisonArm = {
  readonly policy: "brief" | "caveman";
  readonly policyMode: string;
  readonly policyDigest: string;
  readonly guidanceBytes: number;
  readonly guidanceTokensEstimated: number;
  readonly match: BriefComparisonMatch;
  readonly order: 1 | 2;
  readonly terminal: "completed" | "cancelled" | "provider-failure" | "partial" | "baseline-drift";
  readonly usage: BriefComparisonUsage | null;
  readonly responseBytes: number;
  readonly responseTokens: number;
  readonly responseTokenizer: string;
  readonly wallTimeMs: number;
  readonly costUsd: number | null;
  readonly providerRequests: number;
  readonly retries: number;
  readonly requiredFacts: readonly string[];
  readonly preservedFacts: readonly string[];
  readonly missingFacts: readonly string[];
  readonly unsupportedClaims: number;
};

export type BriefComparisonPair = {
  readonly pairId: string;
  readonly brief: BriefComparisonArm;
  readonly caveman: BriefComparisonArm;
};

export type BriefComparisonResult = {
  readonly schemaVersion: typeof BRIEF_COMPARISON_SCHEMA_VERSION;
  readonly pairId: string;
  readonly verdict: BriefComparisonVerdict;
  readonly accepted: boolean;
  readonly reason: string;
  readonly invalidReason: BriefComparisonInvalidReason | null;
  readonly briefComparableTokens: number | null;
  readonly cavemanComparableTokens: number | null;
  readonly tokenDelta: number | null;
  readonly briefFidelity: number;
  readonly cavemanFidelity: number;
};

function stableMatch(value: BriefComparisonMatch): string {
  return JSON.stringify(value);
}

function comparableTokens(arm: BriefComparisonArm): number | null {
  return arm.usage?.totalTokens ?? null;
}

function fidelity(arm: BriefComparisonArm): number {
  if (arm.requiredFacts.length === 0) {
    return arm.unsupportedClaims === 0 ? 1 : 0;
  }
  const present = new Set(arm.preservedFacts);
  const preserved = arm.requiredFacts.filter((fact) => present.has(fact)).length;
  return Math.max(0, (preserved - arm.unsupportedClaims) / arm.requiredFacts.length);
}

function invalidReason(pair: BriefComparisonPair): BriefComparisonInvalidReason | null {
  if (stableMatch(pair.brief.match) !== stableMatch(pair.caveman.match)) {
    return "mismatched-input";
  }
  const terminals = [pair.brief.terminal, pair.caveman.terminal];
  if (terminals.includes("baseline-drift")) return "baseline-drift";
  if (terminals.includes("cancelled")) return "cancelled";
  if (terminals.includes("provider-failure")) return "provider-failure";
  if (terminals.includes("partial")) return "partial-run";
  if (pair.brief.usage === null || pair.caveman.usage === null) return "missing-usage";
  return null;
}

/** Compare one immutable pair. Missing data is invalid, never a zero-token win. */
export function compareBriefPair(pair: BriefComparisonPair): BriefComparisonResult {
  const briefFidelity = fidelity(pair.brief);
  const cavemanFidelity = fidelity(pair.caveman);
  const invalid = invalidReason(pair);
  const briefTokens = comparableTokens(pair.brief);
  const cavemanTokens = comparableTokens(pair.caveman);
  const base = {
    schemaVersion: BRIEF_COMPARISON_SCHEMA_VERSION,
    pairId: pair.pairId,
    briefComparableTokens: briefTokens,
    cavemanComparableTokens: cavemanTokens,
    tokenDelta: briefTokens === null || cavemanTokens === null ? null : briefTokens - cavemanTokens,
    briefFidelity,
    cavemanFidelity,
  } as const;
  if (invalid !== null) {
    return {
      ...base,
      verdict: "invalid",
      accepted: false,
      reason: invalid,
      invalidReason: invalid,
    };
  }
  if (pair.brief.missingFacts.length > 0 || briefFidelity < 1) {
    return {
      ...base,
      verdict: "loss",
      accepted: false,
      reason: "Brief lost a required fact or introduced an unsupported claim",
      invalidReason: null,
    };
  }
  if ((briefTokens ?? 0) < (cavemanTokens ?? 0)) {
    return {
      ...base,
      verdict: "pass",
      accepted: true,
      reason: "Brief used fewer complete-turn tokens with full fidelity",
      invalidReason: null,
    };
  }
  if (briefTokens === cavemanTokens) {
    const betterFidelity = briefFidelity > cavemanFidelity;
    return {
      ...base,
      verdict: "tie",
      accepted: betterFidelity,
      reason: betterFidelity
        ? "Brief tied on tokens with strictly better fidelity"
        : "Token tie without strictly better Brief fidelity",
      invalidReason: null,
    };
  }
  return {
    ...base,
    verdict: "loss",
    accepted: false,
    reason: "Brief used more complete-turn tokens",
    invalidReason: null,
  };
}
