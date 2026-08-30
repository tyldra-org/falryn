/** Public Brief policy and projection contracts. */

import type { ConfigurationGeneration, SessionId, TurnId } from "../identity.ts";

export const BRIEF_SCHEMA_VERSION = 1;
export const BRIEF_STRATEGY_VERSION = "brief.v4";
export const BRIEF_PLACEMENT = "pre-inference" as const;

export const DEFAULT_BRIEF_MAX_BYTES = 2_048;
export const HARD_BRIEF_MAX_BYTES = 8_192;
export const MAX_BRIEF_GUIDANCE_BYTES = HARD_BRIEF_MAX_BYTES;

export const BRIEF_VERBOSITY_LEVELS = ["compact", "balanced", "detailed"] as const;
export type BriefVerbosityLevel = (typeof BRIEF_VERBOSITY_LEVELS)[number];

export const BRIEF_VERBOSITY_MODES = ["compact", "balanced", "detailed", "auto"] as const;
export type BriefVerbosityMode = (typeof BRIEF_VERBOSITY_MODES)[number];

export const BRIEF_DELIVERIES = ["prompt", "native", "native-with-semantic-prompt"] as const;
export type BriefDelivery = (typeof BRIEF_DELIVERIES)[number];

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

export const BRIEF_COMPLEXITIES = ["low", "medium", "high"] as const;
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

export const BRIEF_SELECTION_REASONS = [
  "explicit-mode",
  "high-complexity",
  "medium-complexity",
  "failure",
  "risk",
  "uncertainty",
  "confirmation",
  "required-action",
  "recovery",
  "safety-critical",
  "clarification",
  "ordered-procedure",
  "interactive-interface",
  "headless-interface",
  "narrow-interface",
] as const;
export type BriefSelectionReason = (typeof BRIEF_SELECTION_REASONS)[number];

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
  /** The response covers credentials, production, destructive work, or another unsafe ambiguity. */
  readonly safetyCritical: boolean;
  /** The user is asking Falryn to clarify a misunderstood or previously ambiguous answer. */
  readonly clarification: boolean;
  /** The response must preserve an explicit sequence, dependency, or prerequisite order. */
  readonly orderedProcedure: boolean;
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
  /** Ordered facts that caused the selected level. */
  readonly selectionReasons: readonly BriefSelectionReason[];
  readonly dimensions: BriefDimensions;
  /** How the effective provider request received Brief's response-density policy. */
  readonly delivery: BriefDelivery;
  /** Exact normalized native control sent to the provider, when one was sent. */
  readonly providerResponseDensityControl: string | null;
  /** Bytes of Brief guidance actually included in the provider prompt. */
  readonly byteLength: number;
  readonly guidanceDigest: string;
  readonly placement: typeof BRIEF_PLACEMENT;
  readonly providerPlacementModified: boolean;
  readonly preservedFacts: readonly BriefPreservedFact[];
  readonly omissions: readonly BriefOmission[];
  /** Provider output ceiling selected by Brief. This bounds generation; it never truncates it. */
  readonly outputTokenBudget: number;
};

export type BriefProjection = {
  readonly schemaVersion: typeof BRIEF_SCHEMA_VERSION;
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly configurationGeneration: ConfigurationGeneration;
  /** Complete provider-neutral fallback guidance. */
  readonly guidance: string;
  /** Required facts and user guidance that native density controls cannot express. */
  readonly semanticGuidance: string;
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
  safetyCritical: false,
  clarification: false,
  orderedProcedure: false,
};

export const DEFAULT_BRIEF_POLICY: BriefPolicy = {
  verbosity: "balanced",
  source: "default",
};
