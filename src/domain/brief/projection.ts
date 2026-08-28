/** Brief guidance rendering and final projection. */

import { createHash } from "node:crypto";

import { assertNever, err, ok, type Result } from "../result.ts";
import {
  BRIEF_PLACEMENT,
  BRIEF_SCHEMA_VERSION,
  BRIEF_STRATEGY_VERSION,
  type BriefDimensions,
  type BriefError,
  type BriefOmission,
  type BriefPreservedFact,
  type BriefProjection,
  type BriefRequest,
  type BriefVerbosityLevel,
  DEFAULT_BRIEF_MAX_BYTES,
  HARD_BRIEF_MAX_BYTES,
} from "./contracts.ts";
import {
  briefDimensionsFor,
  briefError,
  briefOutputTokenBudget,
  parseBriefNeed,
  preservedFactsFromNeed,
  resolveBriefPolicy,
  selectBriefVerbosity,
} from "./policy.ts";

const HIDDEN_TOOL_CALL = /<tool_call\b|<invoke\b|<function(?:_call)?\b|\btool_calls\s*[:=]/i;
const TOOL_JSON_FENCE = /```(?:json)?\s*\{\s*"name"\s*:/i;
const EVIDENCE_FENCE = /```[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|yml|yaml)\b/i;
const EVIDENCE_LINE = /^(?:file|path|evidence)\s*:/im;
const SECRET_SHAPE =
  /\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i;

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

  const needResult = parseBriefNeed(request.need);
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
  const defaults = briefDimensionsFor(selectedVerbosity);
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
  const requiredText = joinSections([
    styleLine(selectedVerbosity, dimensions),
    ...requiredFactLines(facts, selectedVerbosity),
  ]);
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
    if (utf8ByteLength(joinSections([requiredText, custom])) > maxBytes) {
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
      guidanceDigest: createHash("sha256").update(guidance).digest("hex"),
      placement: BRIEF_PLACEMENT,
      providerPlacementModified: providerModified,
      preservedFacts: facts,
      omissions,
      outputTokenBudget: briefOutputTokenBudget(selectedVerbosity),
    },
  });
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
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
