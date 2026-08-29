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
  decideBriefVerbosity,
  parseBriefNeed,
  preservedFactsFromNeed,
  resolveBriefPolicy,
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
  const decision = decideBriefVerbosity(policy.verbosity, need);
  const selectedVerbosity = decision.verbosity;
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
    styleLine(selectedVerbosity),
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
  const expanded = snapshotExpanded(selectedVerbosity, facts);
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
      selectionReasons: decision.reasons,
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

function styleLine(verbosity: BriefVerbosityLevel): string {
  switch (verbosity) {
    case "compact":
      return "Lead with outcome. Include each required fact once. Copy names, paths, commands, errors, numbers, and negated constraints verbatim. Use the shortest complete answer: one paragraph or list. No restatement, background, repetition, or optional examples.";
    case "balanced":
      return "Lead with the outcome. Include each explicit supplied fact once; copy names, paths, commands, errors, numbers, and negated constraints verbatim and contiguously, without inserting Markdown. Then add only the reasoning and evidence needed to act. Use short sections when helpful. Omit prompt restatement, generic background, repetition, and unnecessary examples.";
    case "detailed":
      return "Lead with the outcome. Include each explicit supplied fact once; copy names, paths, commands, errors, numbers, and negated constraints verbatim and contiguously, without inserting Markdown. Add task-relevant reasoning, evidence, tradeoffs, and actions only when requested or needed. Detailed means complete, not long. Use focused sections; examples only when needed. Omit prompt restatement, invented background, repeated conclusions, and filler.";
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
          ? "Keep every explicit prohibition and risk warning verbatim and visible."
          : "Keep every explicit prohibition and risk warning verbatim and visible at every verbosity.";
      case "uncertainty":
        return compact
          ? "Keep explicit uncertainty wording verbatim and visible."
          : "Keep explicit uncertainty wording verbatim and visible; do not present a guess as established.";
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
          ? "Keep every recovery action, artifact handle, command, and verification condition verbatim."
          : "Keep every recovery action, artifact handle, command, and verification condition verbatim and actionable.";
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
  facts: readonly BriefPreservedFact[],
): string {
  return joinSections([styleLine(verbosity), ...requiredFactLines(facts, "detailed")]);
}
