import type { ConfigurationGeneration } from "../../foundation/identity.ts";
import type { EffectClass } from "../work.ts";
import {
  CAPABILITY_DEGRADATION_SCHEMA_VERSION,
  type CapabilityDegradationPlan,
  type CapabilityDegradationTrigger,
  type CapabilityFallbackTransition,
  type CapabilityUnavailableOutcome,
  type CapabilityUnavailableReason,
  MAX_CAPABILITY_DEGRADATION_TRANSITIONS,
  MAX_CAPABILITY_FALLBACKS_PER_SOURCE,
  MAX_CAPABILITY_RUNTIME_FALLBACK_TRANSITIONS,
  MAX_OPPORTUNITY_REASON_CODES,
  type OpportunityCandidateDecision,
  type OpportunityReasonCode,
} from "./contracts.ts";

function fallbackEffectChange(
  from: EffectClass,
  to: EffectClass,
): CapabilityFallbackTransition["effectChange"] | null {
  if (from === to) return "same";
  return to === "observation" ? "reduced" : null;
}

function terminalUnavailableReason(
  source: OpportunityCandidateDecision,
  hasFallback: boolean,
): CapabilityUnavailableReason {
  if (source.health === "denied") return "policy-denied";
  if (source.health === "incompatible") return "incompatible";
  return hasFallback ? "fallback-exhausted" : "no-declared-fallback";
}

export function degradationPlan(
  generation: ConfigurationGeneration,
  selected: readonly OpportunityCandidateDecision[],
  rejected: readonly OpportunityCandidateDecision[],
): CapabilityDegradationPlan {
  const selectedTools = selected.filter(
    (candidate) => candidate.kind === "tool" || candidate.kind === "mcp-tool",
  );
  const sources = [
    ...selectedTools,
    ...rejected.filter(
      (candidate) =>
        candidate.decision === "unavailable" &&
        (candidate.kind === "tool" || candidate.kind === "mcp-tool"),
    ),
  ];
  const selectedOrder = new Map(
    selectedTools.map((candidate, index) => [candidate.capabilityId, index]),
  );
  const transitions: CapabilityFallbackTransition[] = [];
  const terminalOutcomes: CapabilityUnavailableOutcome[] = [];

  for (const source of sources) {
    const sourceIndex = selectedOrder.get(source.capabilityId);
    const targets = selectedTools
      .filter((target) => target.capabilityId !== source.capabilityId)
      .filter(
        (target) =>
          source.family !== null &&
          (target.family === source.family ||
            (source.family === "browser" && target.family === "computer")),
      )
      .filter((target) => {
        const targetIndex = selectedOrder.get(target.capabilityId);
        return (
          sourceIndex === undefined || (targetIndex !== undefined && targetIndex > sourceIndex)
        );
      })
      .map((target) => ({
        target,
        effectChange: fallbackEffectChange(source.effect, target.effect),
      }))
      .filter(
        (
          candidate,
        ): candidate is {
          readonly target: OpportunityCandidateDecision;
          readonly effectChange: CapabilityFallbackTransition["effectChange"];
        } => candidate.effectChange !== null,
      )
      .slice(0, MAX_CAPABILITY_FALLBACKS_PER_SOURCE);

    const triggers: CapabilityDegradationTrigger[] =
      source.decision === "unavailable"
        ? ["health-unavailable"]
        : source.health === "degraded"
          ? ["health-degraded", "runtime-unavailable"]
          : ["runtime-unavailable"];
    for (const { target, effectChange } of targets) {
      if (transitions.length >= MAX_CAPABILITY_DEGRADATION_TRANSITIONS) break;
      transitions.push({
        fromCapabilityId: source.capabilityId,
        toCapabilityId: target.capabilityId,
        triggers: Object.freeze([...triggers]),
        strategy: "model-continuation",
        informationChange: "different-contract",
        effectChange,
        notice: `${source.name} unavailable; ${target.name} is an eligible explicit fallback when its contract preserves the task`,
      });
    }
    terminalOutcomes.push({
      capabilityId: source.capabilityId,
      outcome: "unavailable",
      reason: terminalUnavailableReason(source, targets.length > 0),
      recoveryHandles: source.recoveryHandles,
    });
  }

  return Object.freeze({
    schemaVersion: CAPABILITY_DEGRADATION_SCHEMA_VERSION,
    catalogGeneration: generation,
    strategy: "explicit-model-continuation",
    maxRuntimeTransitions: MAX_CAPABILITY_RUNTIME_FALLBACK_TRANSITIONS,
    transitions: Object.freeze(transitions),
    terminalOutcomes: Object.freeze(
      terminalOutcomes.slice(0, MAX_CAPABILITY_DEGRADATION_TRANSITIONS),
    ),
  });
}

export function withTerminalReason(
  reasons: readonly OpportunityReasonCode[],
  terminal: OpportunityReasonCode,
): readonly OpportunityReasonCode[] {
  return Object.freeze([
    ...reasons.filter((reason) => reason !== terminal).slice(0, MAX_OPPORTUNITY_REASON_CODES - 1),
    terminal,
  ]);
}
