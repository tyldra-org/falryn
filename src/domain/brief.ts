/**
 * Brief response-style policy facade.
 *
 * Contracts, policy resolution, and projection rendering live under
 * `./brief/` so new density policies do not grow one central module.
 */

export type {
  BriefComparisonArm,
  BriefComparisonInvalidReason,
  BriefComparisonMatch,
  BriefComparisonPair,
  BriefComparisonResult,
  BriefComparisonUsage,
  BriefComparisonVerdict,
} from "./brief/comparison.ts";
export {
  BRIEF_COMPARISON_INVALID_REASONS,
  BRIEF_COMPARISON_SCHEMA_VERSION,
  BRIEF_COMPARISON_VERDICTS,
  compareBriefPair,
} from "./brief/comparison.ts";
export type {
  BriefComplexity,
  BriefDelivery,
  BriefDensity,
  BriefDetail,
  BriefDimensions,
  BriefDirectness,
  BriefError,
  BriefErrorCode,
  BriefInterface,
  BriefLayers,
  BriefNeed,
  BriefOmission,
  BriefPolicy,
  BriefPolicySource,
  BriefPresentation,
  BriefPreservedFact,
  BriefProjection,
  BriefReceipt,
  BriefRequest,
  BriefSelectionReason,
  BriefVerbosityLevel,
  BriefVerbosityMode,
} from "./brief/contracts.ts";
export {
  BRIEF_COMPLEXITIES,
  BRIEF_DELIVERIES,
  BRIEF_DENSITIES,
  BRIEF_DETAIL_LEVELS,
  BRIEF_DIRECTNESS_LEVELS,
  BRIEF_ERROR_CODES,
  BRIEF_INTERFACES,
  BRIEF_OMISSIONS,
  BRIEF_PLACEMENT,
  BRIEF_POLICY_SOURCES,
  BRIEF_PRESENTATIONS,
  BRIEF_PRESERVED_FACTS,
  BRIEF_SCHEMA_VERSION,
  BRIEF_SELECTION_REASONS,
  BRIEF_STRATEGY_VERSION,
  BRIEF_VERBOSITY_LEVELS,
  BRIEF_VERBOSITY_MODES,
  DEFAULT_BRIEF_MAX_BYTES,
  DEFAULT_BRIEF_NEED,
  DEFAULT_BRIEF_POLICY,
  HARD_BRIEF_MAX_BYTES,
  MAX_BRIEF_GUIDANCE_BYTES,
} from "./brief/contracts.ts";
export type { BriefVerbosityDecision } from "./brief/policy.ts";
export {
  briefOutputTokenBudget,
  decideBriefVerbosity,
  isBriefPolicySource,
  isBriefVerbosityMode,
  preservedFactsFromNeed,
  resolveBriefPolicy,
  selectBriefVerbosity,
} from "./brief/policy.ts";
export { projectBrief, recordBriefDelivery } from "./brief/projection.ts";
