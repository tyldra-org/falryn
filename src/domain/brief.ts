/**
 * Brief as response-style policy applied immediately before inference (#102).
 *
 * Brief guides density, directness, detail, and presentation. It does not plan
 * work, choose evidence, summarize files, or compress incoming context.
 * Required facts (failure, risk, uncertainty, confirmation, required action,
 * citations, validation, recovery) stay in every projection, including compact.
 */

import { z } from "zod";

import type { ConfigurationGeneration, SessionId, TurnId } from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const BRIEF_SCHEMA_VERSION = 1;
export const BRIEF_STRATEGY_VERSION = "brief.v1";
export const BRIEF_PLACEMENT = "pre-inference" as const;

export const DEFAULT_BRIEF_MAX_BYTES = 2_048;
export const HARD_BRIEF_MAX_BYTES = 8_192;
export const MAX_BRIEF_GUIDANCE_BYTES = HARD_BRIEF_MAX_BYTES;

export const BRIEF_VERBOSITY_LEVELS = ["compact", "balanced", "detailed"] as const;
export type BriefVerbosityLevel = (typeof BRIEF_VERBOSITY_LEVELS)[number];

export const BRIEF_VERBOSITY_MODES = ["compact", "balanced", "detailed", "auto"] as const;
export type BriefVerbosityMode = (typeof BRIEF_VERBOSITY_MODES)[number];

export const BRIEF_POLICY_SOURCES = ["user", "session", "interface", "default"] as const;
export type BriefPolicySource = (typeof BRIEF_POLICY_SOURCES)[number];

export const BRIEF_DENSITIES = ["sparse", "moderate", "dense"] as const;
export type BriefDensity = (typeof BRIEF_DENSITIES)[number];

export const BRIEF_DIRECTNESS_LEVELS = ["hedged", "direct"] as const;
export type BriefDirectness = (typeof BRIEF_DIRECTNESS_LEVELS)[number];

export const BRIEF_DETAIL_LEVELS = ["outline", "standard", "worked"] as const;
export type BriefDetail = (typeof BRIEF_DETAIL_LEVELS)[number];

export const BRIEF_PRESENTATIONS = ["prose", "structured"] as const;
export type BriefPresentation = (typeof BRIEF_PRESENTATIONS)[number];

export const BRIEF_COMPLEXITIES = ["low", "high"] as const;
export type BriefComplexity = (typeof BRIEF_COMPLEXITIES)[number];

export const BRIEF_INTERFACES = ["interactive", "headless", "narrow"] as const;
export type BriefInterface = (typeof BRIEF_INTERFACES)[number];

export const BRIEF_PRESERVED_FACTS = [
  "failure",
  "risk",
  "uncertainty",
  "confirmation",
  "required-action",
  "citation",
  "validation",
  "recovery",
] as const;
export type BriefPreservedFact = (typeof BRIEF_PRESERVED_FACTS)[number];

export const BRIEF_OMISSIONS = ["custom-guidance"] as const;
export type BriefOmission = (typeof BRIEF_OMISSIONS)[number];

export const BRIEF_ERROR_CODES = [
  "malformed",
  "unsupported",
  "oversized",
  "cancelled",
  "stale",
  "denied",
  "secret",
] as const;
export type BriefErrorCode = (typeof BRIEF_ERROR_CODES)[number];

export type BriefError = {
  readonly kind: "brief";
  readonly code: BriefErrorCode;
  readonly field: string | null;
};

export type BriefNeed = {
  readonly complexity: BriefComplexity;
  readonly interface: BriefInterface;
  readonly failures: boolean;
  readonly risk: boolean;
  readonly uncertainty: boolean;
  readonly confirmation: boolean;
  readonly requiredAction: boolean;
  readonly citations: boolean;
  readonly validation: boolean;
  readonly recovery: boolean;
};

export type BriefPolicy = {
  readonly verbosity: BriefVerbosityMode;
  readonly source: BriefPolicySource;
  readonly density?: BriefDensity;
  readonly directness?: BriefDirectness;
  readonly detail?: BriefDetail;
  readonly presentation?: BriefPresentation;
  readonly maxBytes?: number;
  /** Style notes only. Must not contain task evidence or hidden tool calls. */
  readonly guidance?: string;
  readonly containsEvidence?: boolean;
};

export type BriefDimensions = {
  readonly verbosity: BriefVerbosityLevel;
  readonly density: BriefDensity;
  readonly directness: BriefDirectness;
  readonly detail: BriefDetail;
  readonly presentation: BriefPresentation;
};

export type BriefReceipt = {
  readonly schemaVersion: typeof BRIEF_SCHEMA_VERSION;
  readonly strategyVersion: typeof BRIEF_STRATEGY_VERSION;
  readonly policySource: BriefPolicySource;
  readonly requestedMode: BriefVerbosityMode;
  readonly selectedVerbosity: BriefVerbosityLevel;
  readonly dimensions: BriefDimensions;
  readonly byteLength: number;
  readonly placement: typeof BRIEF_PLACEMENT;
  readonly providerPlacementModified: boolean;
  readonly preservedFacts: readonly BriefPreservedFact[];
  readonly omissions: readonly BriefOmission[];
};

export type BriefProjection = {
  readonly schemaVersion: typeof BRIEF_SCHEMA_VERSION;
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly guidance: string;
  readonly concise: string;
  readonly expanded: string;
  readonly receipt: BriefReceipt;
};

export type BriefLayers = {
  readonly user?: BriefPolicy;
  readonly session?: BriefPolicy;
  readonly interface?: BriefPolicy;
  readonly default?: BriefPolicy;
};

export type BriefRequest = {
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly expectedGeneration?: ConfigurationGeneration;
  readonly cancelled?: boolean;
  readonly need: BriefNeed;
  readonly policy?: BriefPolicy;
  readonly layers?: BriefLayers;
  readonly providerMaxBytes?: number;
};

export const DEFAULT_BRIEF_NEED: BriefNeed = {
  complexity: "low",
  interface: "interactive",
  failures: false,
  risk: false,
  uncertainty: false,
  confirmation: false,
  requiredAction: false,
  citations: false,
  validation: false,
  recovery: false,
};

export const DEFAULT_BRIEF_POLICY: BriefPolicy = {
  verbosity: "balanced",
  source: "default",
};

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

const HIDDEN_TOOL_CALL = /<tool_call\b|<invoke\b|<function(?:_call)?\b|\btool_calls\s*[:=]/i;
const TOOL_JSON_FENCE = /```(?:json)?\s*\{\s*"name"\s*:/i;
const EVIDENCE_FENCE = /```[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|yml|yaml)\b/i;
const EVIDENCE_LINE = /^(?:file|path|evidence)\s*:/im;
const SECRET_SHAPE =
  /\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i;

export function isBriefVerbosityMode(value: unknown): value is BriefVerbosityMode {
  return typeof value === "string" && (BRIEF_VERBOSITY_MODES as readonly string[]).includes(value);
}

export function isBriefPolicySource(value: unknown): value is BriefPolicySource {
  return typeof value === "string" && (BRIEF_POLICY_SOURCES as readonly string[]).includes(value);
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function briefError(code: BriefErrorCode, field: string | null): BriefError {
  return { kind: "brief", code, field };
}

function parseNeed(need: BriefNeed): Result<BriefNeed, BriefError> {
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

/**
 * User overrides session, then interface, then the built-in default.
 */
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
    if (layer.value === undefined) {
      continue;
    }
    return parsePolicy(layer.value, layer.source);
  }
  return ok(DEFAULT_BRIEF_POLICY);
}

export function selectBriefVerbosity(
  mode: BriefVerbosityMode,
  need: BriefNeed,
): BriefVerbosityLevel {
  if (mode !== "auto") {
    return mode;
  }
  if (need.interface === "narrow" || need.interface === "headless") {
    return "compact";
  }
  if (need.complexity === "high" || need.failures || need.uncertainty || need.recovery) {
    return "detailed";
  }
  return "balanced";
}

function defaultDimensions(verbosity: BriefVerbosityLevel): Omit<BriefDimensions, "verbosity"> {
  switch (verbosity) {
    case "compact":
      return {
        density: "sparse",
        directness: "direct",
        detail: "outline",
        presentation: "structured",
      };
    case "balanced":
      return {
        density: "moderate",
        directness: "direct",
        detail: "standard",
        presentation: "prose",
      };
    case "detailed":
      return { density: "dense", directness: "hedged", detail: "worked", presentation: "prose" };
    default:
      return assertNever(verbosity, "unhandled brief verbosity");
  }
}

export function preservedFactsFromNeed(need: BriefNeed): readonly BriefPreservedFact[] {
  const facts: BriefPreservedFact[] = [];
  if (need.failures) {
    facts.push("failure");
  }
  if (need.risk) {
    facts.push("risk");
  }
  if (need.uncertainty) {
    facts.push("uncertainty");
  }
  if (need.confirmation) {
    facts.push("confirmation");
  }
  if (need.requiredAction) {
    facts.push("required-action");
  }
  if (need.citations) {
    facts.push("citation");
  }
  if (need.validation) {
    facts.push("validation");
  }
  if (need.recovery) {
    facts.push("recovery");
  }
  return facts;
}

function styleLine(verbosity: BriefVerbosityLevel, dimensions: BriefDimensions): string {
  const base = `Respond with ${verbosity} ${dimensions.density} ${dimensions.presentation}, ${dimensions.directness} tone, and ${dimensions.detail} detail.`;
  switch (verbosity) {
    case "compact":
      return `${base} Prefer short sentences. Do not add examples unless a required fact needs one.`;
    case "balanced":
      return `${base} Explain enough to act; keep examples rare.`;
    case "detailed":
      return `${base} Include short examples where they clarify a required fact.`;
    default:
      return assertNever(verbosity, "unhandled brief verbosity");
  }
}

function requiredFactLines(
  facts: readonly BriefPreservedFact[],
  verbosity: BriefVerbosityLevel,
): readonly string[] {
  const compact = verbosity === "compact";
  return facts.map((fact) => {
    switch (fact) {
      case "failure":
        return compact
          ? "Keep every failed effect visible. Verbosity never hides a failure."
          : "Keep every failed effect visible. Verbosity never authorizes omitting a failed effect.";
      case "risk":
        return compact
          ? "Keep risk warnings visible."
          : "Keep risk warnings visible at every verbosity.";
      case "uncertainty":
        return compact
          ? "Keep uncertainty visible."
          : "Keep uncertainty visible; do not present a guess as established.";
      case "confirmation":
        return compact
          ? "Keep required confirmation visible."
          : "Keep focused confirmation visible until the observed outcome is recorded.";
      case "required-action":
        return compact
          ? "Keep the required user action visible."
          : "Keep the required user action visible and distinct from optional next steps.";
      case "citation":
        return compact
          ? "Keep citations and provenance. Never treat a lossy projection as exact source."
          : "Keep citations and provenance. Never represent a lossy projection as exact source.";
      case "validation":
        return compact
          ? "Keep validation results visible."
          : "Keep validation results visible, including failures.";
      case "recovery":
        return compact
          ? "Keep recovery actions visible."
          : "Keep recovery actions visible and actionable.";
      default:
        return assertNever(fact, "unhandled preserved fact");
    }
  });
}

function refuseGuidance(
  guidance: string,
  containsEvidence: boolean | undefined,
): BriefError | null {
  if (containsEvidence === true || EVIDENCE_FENCE.test(guidance) || EVIDENCE_LINE.test(guidance)) {
    return briefError("denied", "guidance");
  }
  if (HIDDEN_TOOL_CALL.test(guidance) || TOOL_JSON_FENCE.test(guidance)) {
    return briefError("denied", "guidance");
  }
  if (SECRET_SHAPE.test(guidance)) {
    return briefError("secret", "guidance");
  }
  return null;
}

function joinSections(parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join("\n");
}

function snapshotConcise(
  verbosity: BriefVerbosityLevel,
  facts: readonly BriefPreservedFact[],
): string {
  const factList = facts.length === 0 ? "none" : facts.join(", ");
  return `Brief ${verbosity}. Preserve: ${factList}.`;
}

function snapshotExpanded(
  verbosity: BriefVerbosityLevel,
  dimensions: BriefDimensions,
  facts: readonly BriefPreservedFact[],
): string {
  return joinSections([styleLine(verbosity, dimensions), ...requiredFactLines(facts, "detailed")]);
}

export function projectBrief(request: BriefRequest): Result<BriefProjection, BriefError> {
  if (request.cancelled === true) {
    return err(briefError("cancelled", null));
  }
  if (
    request.expectedGeneration !== undefined &&
    request.expectedGeneration !== request.configurationGeneration
  ) {
    return err(briefError("stale", "configurationGeneration"));
  }

  const needResult = parseNeed(request.need);
  if (!needResult.ok) {
    return needResult;
  }
  const need = needResult.value;

  const policyResult = resolveBriefPolicy(request.layers, request.policy);
  if (!policyResult.ok) {
    return policyResult;
  }
  const policy = policyResult.value;
  const selectedVerbosity = selectBriefVerbosity(policy.verbosity, need);
  const defaults = defaultDimensions(selectedVerbosity);
  const dimensions: BriefDimensions = {
    verbosity: selectedVerbosity,
    density: policy.density ?? defaults.density,
    directness: policy.directness ?? defaults.directness,
    detail: policy.detail ?? defaults.detail,
    presentation: policy.presentation ?? defaults.presentation,
  };

  const requestedMax = policy.maxBytes ?? DEFAULT_BRIEF_MAX_BYTES;
  const providerModified =
    request.providerMaxBytes !== undefined && request.providerMaxBytes < requestedMax;
  const maxBytes = providerModified
    ? Math.max(1, request.providerMaxBytes ?? requestedMax)
    : requestedMax;

  const facts = preservedFactsFromNeed(need);
  const style = styleLine(selectedVerbosity, dimensions);
  const required = requiredFactLines(facts, selectedVerbosity);
  const requiredText = joinSections([style, ...required]);
  if (utf8ByteLength(requiredText) > maxBytes) {
    return err(briefError("oversized", "required-facts"));
  }

  const omissions: BriefOmission[] = [];
  let custom = policy.guidance?.trim() ?? "";
  if (custom.length > 0) {
    const refused = refuseGuidance(custom, policy.containsEvidence);
    if (refused !== null) {
      return err(refused);
    }
    const withCustom = joinSections([requiredText, custom]);
    if (utf8ByteLength(withCustom) > maxBytes) {
      omissions.push("custom-guidance");
      custom = "";
    }
  }

  const guidance = custom.length > 0 ? joinSections([requiredText, custom]) : requiredText;
  const concise = snapshotConcise(selectedVerbosity, facts);
  const expanded = snapshotExpanded(selectedVerbosity, dimensions, facts);
  if (
    utf8ByteLength(concise) > HARD_BRIEF_MAX_BYTES ||
    utf8ByteLength(expanded) > HARD_BRIEF_MAX_BYTES
  ) {
    return err(briefError("oversized", "snapshot"));
  }

  return ok({
    schemaVersion: BRIEF_SCHEMA_VERSION,
    turnId: request.turnId,
    sessionId: request.sessionId,
    configurationGeneration: request.configurationGeneration,
    guidance,
    concise,
    expanded,
    receipt: {
      schemaVersion: BRIEF_SCHEMA_VERSION,
      strategyVersion: BRIEF_STRATEGY_VERSION,
      policySource: policy.source,
      requestedMode: policy.verbosity,
      selectedVerbosity,
      dimensions,
      byteLength: utf8ByteLength(guidance),
      placement: BRIEF_PLACEMENT,
      providerPlacementModified: providerModified,
      preservedFacts: facts,
      omissions,
    },
  });
}
