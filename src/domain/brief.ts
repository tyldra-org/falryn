/**
 * Brief response-style policy facade.
 *
 * Contracts, policy resolution, and projection rendering live under
 * `./brief/` so new density policies do not grow one central module.
 */

export type {
  BriefComplexity,
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
  BriefVerbosityLevel,
  BriefVerbosityMode,
} from "./brief/contracts.ts";
export {
  BRIEF_COMPLEXITIES,
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
  BRIEF_STRATEGY_VERSION,
  BRIEF_VERBOSITY_LEVELS,
  BRIEF_VERBOSITY_MODES,
  DEFAULT_BRIEF_MAX_BYTES,
  DEFAULT_BRIEF_NEED,
  DEFAULT_BRIEF_POLICY,
  HARD_BRIEF_MAX_BYTES,
  MAX_BRIEF_GUIDANCE_BYTES,
} from "./brief/contracts.ts";
export {
  isBriefPolicySource,
  isBriefVerbosityMode,
  preservedFactsFromNeed,
  resolveBriefPolicy,
  selectBriefVerbosity,
} from "./brief/policy.ts";
export { projectBrief } from "./brief/projection.ts";
