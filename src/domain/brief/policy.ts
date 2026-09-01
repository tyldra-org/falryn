/** Brief policy validation, precedence, and dimension selection. */

import { z } from "zod";

import { assertNever, err, ok, type Result } from "../result.ts";
import {
  BRIEF_COMPLEXITIES,
  BRIEF_DENSITIES,
  BRIEF_DETAIL_LEVELS,
  BRIEF_DIRECTNESS_LEVELS,
  BRIEF_INTERFACES,
  BRIEF_POLICY_SOURCES,
  BRIEF_PRESENTATIONS,
  BRIEF_VERBOSITY_MODES,
  type BriefDimensions,
  type BriefError,
  type BriefErrorCode,
  type BriefLayers,
  type BriefNeed,
  type BriefPolicy,
  type BriefPolicySource,
  type BriefPreservedFact,
  type BriefSelectionReason,
  type BriefVerbosityLevel,
  type BriefVerbosityMode,
  DEFAULT_BRIEF_NEED,
  DEFAULT_BRIEF_POLICY,
  HARD_BRIEF_MAX_BYTES,
  MAX_BRIEF_GUIDANCE_BYTES,
} from "./contracts.ts";

const briefNeedSchema = z.object({
  complexity: z.enum(BRIEF_COMPLEXITIES).optional(),
  interface: z.enum(BRIEF_INTERFACES).optional(),
  failures: z.boolean().optional(),
  risk: z.boolean().optional(),
  uncertainty: z.boolean().optional(),
  confirmation: z.boolean().optional(),
  requiredAction: z.boolean().optional(),
  citations: z.boolean().optional(),
  validation: z.boolean().optional(),
  recovery: z.boolean().optional(),
  safetyCritical: z.boolean().optional(),
  clarification: z.boolean().optional(),
  orderedProcedure: z.boolean().optional(),
});

const briefPolicySchema = z.object({
  verbosity: z.enum(BRIEF_VERBOSITY_MODES),
  source: z.enum(BRIEF_POLICY_SOURCES),
  density: z.enum(BRIEF_DENSITIES).optional(),
  directness: z.enum(BRIEF_DIRECTNESS_LEVELS).optional(),
  detail: z.enum(BRIEF_DETAIL_LEVELS).optional(),
  presentation: z.enum(BRIEF_PRESENTATIONS).optional(),
  maxBytes: z.number().int().positive().max(HARD_BRIEF_MAX_BYTES).optional(),
  guidance: z.string().max(MAX_BRIEF_GUIDANCE_BYTES).optional(),
  containsEvidence: z.boolean().optional(),
});

export function briefError(code: BriefErrorCode, field: string | null): BriefError {
  return { kind: "brief", code, field };
}

export function isBriefVerbosityMode(value: unknown): value is BriefVerbosityMode {
  return typeof value === "string" && (BRIEF_VERBOSITY_MODES as readonly string[]).includes(value);
}

export function isBriefPolicySource(value: unknown): value is BriefPolicySource {
  return typeof value === "string" && (BRIEF_POLICY_SOURCES as readonly string[]).includes(value);
}

export function parseBriefNeed(need: BriefNeed): Result<BriefNeed, BriefError> {
  const parsed = briefNeedSchema.safeParse(need);
  if (!parsed.success) {
    return err(briefError("malformed", parsed.error.issues[0]?.path.join(".") ?? "need"));
  }
  return ok({
    complexity: parsed.data.complexity ?? DEFAULT_BRIEF_NEED.complexity,
    interface: parsed.data.interface ?? DEFAULT_BRIEF_NEED.interface,
    failures: parsed.data.failures ?? false,
    risk: parsed.data.risk ?? false,
    uncertainty: parsed.data.uncertainty ?? false,
    confirmation: parsed.data.confirmation ?? false,
    requiredAction: parsed.data.requiredAction ?? false,
    citations: parsed.data.citations ?? false,
    validation: parsed.data.validation ?? false,
    recovery: parsed.data.recovery ?? false,
    safetyCritical: parsed.data.safetyCritical ?? false,
    clarification: parsed.data.clarification ?? false,
    orderedProcedure: parsed.data.orderedProcedure ?? false,
  });
}

function parsePolicy(policy: BriefPolicy, field: string): Result<BriefPolicy, BriefError> {
  const parsed = briefPolicySchema.safeParse(policy);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".") ?? field;
    const code = path.includes("verbosity") ? "unsupported" : "malformed";
    return err(briefError(code, `${field}${path === field ? "" : `.${path}`}`));
  }
  return ok({
    verbosity: parsed.data.verbosity,
    source: parsed.data.source,
    ...(parsed.data.density === undefined ? {} : { density: parsed.data.density }),
    ...(parsed.data.directness === undefined ? {} : { directness: parsed.data.directness }),
    ...(parsed.data.detail === undefined ? {} : { detail: parsed.data.detail }),
    ...(parsed.data.presentation === undefined ? {} : { presentation: parsed.data.presentation }),
    ...(parsed.data.maxBytes === undefined ? {} : { maxBytes: parsed.data.maxBytes }),
    ...(parsed.data.guidance === undefined ? {} : { guidance: parsed.data.guidance }),
    ...(parsed.data.containsEvidence === undefined
      ? {}
      : { containsEvidence: parsed.data.containsEvidence }),
  });
}

/** User overrides session, then interface, then the built-in default. */
export function resolveBriefPolicy(
  layers: BriefLayers | undefined,
  policy: BriefPolicy | undefined,
): Result<BriefPolicy, BriefError> {
  if (policy !== undefined) {
    return parsePolicy(policy, "policy");
  }
  const order: readonly {
    readonly source: BriefPolicySource;
    readonly value: BriefPolicy | undefined;
  }[] = [
    { source: "user", value: layers?.user },
    { source: "session", value: layers?.session },
    { source: "interface", value: layers?.interface },
    { source: "default", value: layers?.default ?? DEFAULT_BRIEF_POLICY },
  ];
  for (const layer of order) {
    if (layer.value !== undefined) {
      return parsePolicy(layer.value, layer.source);
    }
  }
  return ok(DEFAULT_BRIEF_POLICY);
}

export type BriefVerbosityDecision = {
  readonly verbosity: BriefVerbosityLevel;
  readonly reasons: readonly BriefSelectionReason[];
};

function activeReasons(
  candidates: readonly (readonly [active: boolean, reason: BriefSelectionReason])[],
): readonly BriefSelectionReason[] {
  return candidates.filter(([active]) => active).map(([, reason]) => reason);
}

/** Choose the shortest level that can explain the current response obligations safely. */
export function decideBriefVerbosity(
  mode: BriefVerbosityMode,
  need: BriefNeed,
): BriefVerbosityDecision {
  if (mode !== "auto") {
    return { verbosity: mode, reasons: ["explicit-mode"] };
  }

  const detailedReasons = activeReasons([
    [need.complexity === "high", "high-complexity"],
    [need.uncertainty, "uncertainty"],
    [need.recovery, "recovery"],
    [need.safetyCritical, "safety-critical"],
    [need.clarification, "clarification"],
  ]);
  if (detailedReasons.length > 0) {
    return { verbosity: "detailed", reasons: detailedReasons };
  }

  const balancedReasons = activeReasons([
    [need.complexity === "medium", "medium-complexity"],
    [need.failures, "failure"],
    [need.risk, "risk"],
    [need.confirmation, "confirmation"],
    [need.requiredAction, "required-action"],
    [need.orderedProcedure, "ordered-procedure"],
  ]);
  if (balancedReasons.length > 0) {
    return { verbosity: "balanced", reasons: balancedReasons };
  }

  switch (need.interface) {
    case "interactive":
      return { verbosity: "balanced", reasons: ["interactive-interface"] };
    case "headless":
      return { verbosity: "compact", reasons: ["headless-interface"] };
    case "narrow":
      return { verbosity: "compact", reasons: ["narrow-interface"] };
    default:
      return assertNever(need.interface, "unhandled brief interface");
  }
}

export function selectBriefVerbosity(
  mode: BriefVerbosityMode,
  need: BriefNeed,
): BriefVerbosityLevel {
  return decideBriefVerbosity(mode, need).verbosity;
}

/** Bound generation at the provider instead of trimming a completed answer. */
export function briefOutputTokenBudget(verbosity: BriefVerbosityLevel): number {
  switch (verbosity) {
    case "compact":
      return 2_048;
    case "balanced":
      return 4_096;
    case "detailed":
      return 8_192;
    default:
      return assertNever(verbosity, "unhandled brief output budget");
  }
}

export function briefDimensionsFor(verbosity: BriefVerbosityLevel): BriefDimensions {
  switch (verbosity) {
    case "compact":
      return {
        verbosity,
        density: "sparse",
        directness: "direct",
        detail: "outline",
        presentation: "structured",
      };
    case "balanced":
      return {
        verbosity,
        density: "moderate",
        directness: "direct",
        detail: "standard",
        presentation: "structured",
      };
    case "detailed":
      return {
        verbosity,
        density: "dense",
        directness: "direct",
        detail: "worked",
        presentation: "structured",
      };
    default:
      return assertNever(verbosity, "unhandled brief verbosity");
  }
}

export function preservedFactsFromNeed(need: BriefNeed): readonly BriefPreservedFact[] {
  const facts: BriefPreservedFact[] = [];
  if (need.failures) facts.push("failure");
  if (need.risk) facts.push("risk");
  if (need.uncertainty) facts.push("uncertainty");
  if (need.confirmation) facts.push("confirmation");
  if (need.requiredAction) facts.push("required-action");
  if (need.citations) facts.push("citation");
  if (need.validation) facts.push("validation");
  if (need.recovery) facts.push("recovery");
  return facts;
}
