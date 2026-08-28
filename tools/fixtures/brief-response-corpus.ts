/** Reviewed, synthetic, secret-free response-density fixtures (#827). */

import type { CavemanIntensity } from "../../src/application/index.ts";
import type { BriefVerbosityLevel } from "../../src/domain/index.ts";

export type BriefResponseFixture = {
  readonly id: string;
  readonly category:
    | "coding-explanation"
    | "implementation-summary"
    | "verification-failure"
    | "code-review"
    | "recovery"
    | "short-factual";
  readonly briefMode: BriefVerbosityLevel;
  readonly cavemanIntensity: CavemanIntensity;
  readonly prompt: string;
  readonly requiredFacts: readonly string[];
  readonly forbiddenClaims: readonly string[];
};

export const BRIEF_RESPONSE_FIXTURES: readonly BriefResponseFixture[] = [
  {
    id: "coding-explanation",
    category: "coding-explanation",
    briefMode: "detailed",
    cavemanIntensity: "lite",
    prompt:
      "Explain only these supplied facts: composeTurn ranks evidence through the context planner; Brief guidance is the last prompt section; Brief runs before inference. Keep every named symbol exact.",
    requiredFacts: ["composeTurn", "context planner", "Brief", "before inference"],
    forbiddenClaims: ["post-processing", "second model"],
  },
  {
    id: "implementation-summary",
    category: "implementation-summary",
    briefMode: "balanced",
    cavemanIntensity: "full",
    prompt:
      "Write an implementation summary from these supplied facts: changed src/application/product-brief.ts and src/application/product-live-turn.ts; added task-aware needs; no public mode was removed.",
    requiredFacts: [
      "src/application/product-brief.ts",
      "src/application/product-live-turn.ts",
      "task-aware",
      "no public mode was removed",
    ],
    forbiddenClaims: ["Hush", "Loom"],
  },
  {
    id: "verification-failure",
    category: "verification-failure",
    briefMode: "compact",
    cavemanIntensity: "ultra",
    prompt:
      "Report this verification result without repairing or softening it: command `bun run check` failed; exact error `TS2322: Type string is not assignable to number`; next action is fix the type and rerun the same command.",
    requiredFacts: [
      "bun run check",
      "failed",
      "TS2322: Type string is not assignable to number",
      "rerun",
    ],
    forbiddenClaims: ["passed", "green"],
  },
  {
    id: "code-review",
    category: "code-review",
    briefMode: "balanced",
    cavemanIntensity: "full",
    prompt:
      "State one review finding from supplied evidence: severity P1; src/cache.ts:42 treats missing usage as zero; this can create a false token win; required fix is preserve unknown as null.",
    requiredFacts: ["P1", "src/cache.ts:42", "false token win", "null"],
    forbiddenClaims: ["P2", "safe"],
  },
  {
    id: "recovery",
    category: "recovery",
    briefMode: "detailed",
    cavemanIntensity: "lite",
    prompt:
      "Give recovery instructions from supplied facts: do not run reset --hard; inspect with `git status --short`; recover exact bytes from artifact-42; uncertainty remains until the digest verifies.",
    requiredFacts: ["do not run reset --hard", "git status --short", "artifact-42", "uncertainty"],
    forbiddenClaims: ["recovered successfully", "delete artifact-42"],
  },
  {
    id: "short-factual",
    category: "short-factual",
    briefMode: "compact",
    cavemanIntensity: "ultra",
    prompt:
      "Answer only from this supplied fact: Brief is a pre-inference response-density policy and makes no extra model call.",
    requiredFacts: ["pre-inference", "no extra model call"],
    forbiddenClaims: ["post-processing", "summarizer model"],
  },
] as const;
