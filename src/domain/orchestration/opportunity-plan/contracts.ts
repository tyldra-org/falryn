import type {
  CapabilityEffectiveHealthState,
  CapabilityHealthCode,
  CapabilityHealthSnapshot,
} from "../../capabilities/capability-health.ts";
import type {
  CapabilityContributionKind,
  CapabilityCostClass,
  CapabilityFamily,
  CapabilityLatencyClass,
  CapabilitySource,
} from "../../capabilities/capability-registry.ts";
import type { CapabilityId, ConfigurationGeneration } from "../../foundation/identity.ts";
import type { EffectiveExecutionPolicy } from "../../sessions/execution-profile.ts";
import type { EffectClass } from "../work.ts";

export const OPPORTUNITY_PLAN_SCHEMA_VERSION = 1;

export const DEFAULT_OPPORTUNITY_SELECTION_LIMIT = 24;

export const MAX_OPPORTUNITY_SELECTION_LIMIT = 64;

export const DEFAULT_OPPORTUNITY_SCHEMA_TOKEN_BUDGET = 12_000;

export const MAX_OPPORTUNITY_SCHEMA_TOKEN_BUDGET = 64_000;

export const MAX_OPPORTUNITY_REJECTIONS = 64;

export const MAX_OPPORTUNITY_REASON_CODES = 8;

export const MAX_OPPORTUNITY_TASK_CHARACTERS = 32_000;

export const CAPABILITY_DEGRADATION_SCHEMA_VERSION = 1;

export const MAX_CAPABILITY_DEGRADATION_TRANSITIONS = 64;

export const MAX_CAPABILITY_FALLBACKS_PER_SOURCE = 4;

export const MAX_CAPABILITY_RUNTIME_FALLBACK_TRANSITIONS = 4;

export const OPPORTUNITY_SIGNAL_FAMILIES = [
  "search",
  "read",
  "edit",
  "run",
  "browser",
  "computer",
  "delegate",
  "capability",
] as const satisfies readonly CapabilityFamily[];

export type OpportunitySignalFamily = (typeof OPPORTUNITY_SIGNAL_FAMILIES)[number];

export const OPPORTUNITY_DECISIONS = [
  "selected",
  "fallback",
  "rejected",
  "unavailable",
  "deferred",
] as const;

export type OpportunityDecisionKind = (typeof OPPORTUNITY_DECISIONS)[number];

export const OPPORTUNITY_REASON_CODES = [
  "explicit-capability",
  "explicit-shell-override",
  "task-family",
  "profile-family",
  "task-term-match",
  "user-preference",
  "healthy",
  "degraded",
  "local-source",
  "lower-cost",
  "lower-latency",
  "structured-before-visual",
  "required-skill-match",
  "workflow-match",
  "independent-work",
  "long-running-work",
  "not-task-relevant",
  "not-selectable",
  "policy-denied",
  "schema-unavailable",
  "schema-budget",
  "selection-limit",
  "stable-tie-break",
] as const;

export type OpportunityReasonCode = (typeof OPPORTUNITY_REASON_CODES)[number];

export type CapabilityOpportunityCandidate = {
  readonly capabilityId: CapabilityId;
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly kind: CapabilityContributionKind;
  readonly family: CapabilityFamily | null;
  readonly source: CapabilitySource;
  readonly effect: EffectClass;
  readonly costClass: CapabilityCostClass;
  readonly latencyClass: CapabilityLatencyClass;
  readonly schemaTokensEstimated: number;
  readonly modelSchemaEligible: boolean;
  /** Stable publication order used only after all semantic scores tie. */
  readonly order: number;
};

export type OpportunityCandidateDecision = {
  readonly capabilityId: CapabilityId;
  readonly name: string;
  readonly kind: CapabilityContributionKind;
  readonly family: CapabilityFamily | null;
  readonly source: CapabilitySource;
  readonly effect: EffectClass;
  readonly health: CapabilityEffectiveHealthState;
  readonly decision: OpportunityDecisionKind;
  readonly score: number;
  readonly schemaTokensEstimated: number;
  readonly reasons: readonly OpportunityReasonCode[];
  readonly diagnosticCodes: readonly CapabilityHealthCode[];
  readonly recoveryHandles: readonly string[];
};

export const CAPABILITY_DEGRADATION_TRIGGERS = [
  "health-degraded",
  "health-unavailable",
  "runtime-unavailable",
] as const;

export type CapabilityDegradationTrigger = (typeof CAPABILITY_DEGRADATION_TRIGGERS)[number];

export type CapabilityFallbackTransition = {
  readonly fromCapabilityId: CapabilityId;
  readonly toCapabilityId: CapabilityId;
  readonly triggers: readonly CapabilityDegradationTrigger[];
  /** A different tool contract always requires a new model proposal. */
  readonly strategy: "model-continuation";
  readonly informationChange: "different-contract";
  readonly effectChange: "same" | "reduced";
  readonly notice: string;
};

export const CAPABILITY_UNAVAILABLE_REASONS = [
  "fallback-exhausted",
  "no-declared-fallback",
  "policy-denied",
  "incompatible",
] as const;

export type CapabilityUnavailableReason = (typeof CAPABILITY_UNAVAILABLE_REASONS)[number];

export type CapabilityUnavailableOutcome = {
  readonly capabilityId: CapabilityId;
  readonly outcome: "unavailable";
  readonly reason: CapabilityUnavailableReason;
  readonly recoveryHandles: readonly string[];
};

export type CapabilityDegradationPlan = {
  readonly schemaVersion: typeof CAPABILITY_DEGRADATION_SCHEMA_VERSION;
  readonly catalogGeneration: ConfigurationGeneration;
  readonly strategy: "explicit-model-continuation";
  readonly maxRuntimeTransitions: number;
  readonly transitions: readonly CapabilityFallbackTransition[];
  readonly terminalOutcomes: readonly CapabilityUnavailableOutcome[];
};

export const AUTOMATION_OPPORTUNITY_KINDS = [
  "skill",
  "workflow",
  "mcp-plugin",
  "delegation",
  "background",
  "browser",
  "computer",
] as const;

export type AutomationOpportunityKind = (typeof AUTOMATION_OPPORTUNITY_KINDS)[number];

export type AutomationOpportunity = {
  readonly kind: AutomationOpportunityKind;
  readonly decision: "selected" | "recommended" | "unavailable" | "not-needed" | "deferred";
  readonly capabilityIds: readonly CapabilityId[];
  readonly reason: OpportunityReasonCode;
};

export type OpportunityModelAssistance = {
  /** A separate routing-model request is never the default path. */
  readonly decision: "not-needed" | "eligible";
  readonly candidateIds: readonly CapabilityId[];
  readonly reason: "deterministic-winner" | "semantic-tie";
};

export type ModelCapabilityBrief = {
  readonly schemaVersion: typeof OPPORTUNITY_PLAN_SCHEMA_VERSION;
  readonly planId: string;
  readonly taskFingerprint: string;
  readonly catalogGeneration: ConfigurationGeneration;
  readonly policyGeneration: ConfigurationGeneration;
  readonly profileId: EffectiveExecutionPolicy["profileId"];
  readonly signalledFamilies: readonly CapabilityFamily[];
  readonly requiredFamilies: readonly string[];
  readonly primaryFamily: CapabilityFamily;
  readonly fallbackFamilies: readonly CapabilityFamily[];
  readonly selected: readonly OpportunityCandidateDecision[];
  readonly fallbacks: readonly OpportunityCandidateDecision[];
  readonly rejected: readonly OpportunityCandidateDecision[];
  readonly omittedRejected: number;
  readonly opportunities: readonly AutomationOpportunity[];
  readonly modelAssistance: OpportunityModelAssistance;
  readonly degradation: CapabilityDegradationPlan;
  readonly schemaTokensEstimated: number;
  readonly selectionLimit: number;
  readonly schemaTokenBudget: number;
  readonly discoveryHandle: string;
};

export type OpportunityPlanInput = {
  readonly task: string;
  readonly taskFingerprint: string;
  readonly policy: EffectiveExecutionPolicy;
  readonly health: CapabilityHealthSnapshot;
  readonly candidates: readonly CapabilityOpportunityCandidate[];
  readonly intentFamilies?: readonly CapabilityFamily[];
  readonly preferredCapabilityIds?: readonly CapabilityId[];
  readonly selectionLimit?: number;
  readonly schemaTokenBudget?: number;
};

export const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "for",
  "from",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "please",
  "that",
  "the",
  "this",
  "to",
  "we",
  "what",
  "with",
  "you",
]);

export const FAMILY_TERMS: Readonly<Record<CapabilityFamily, readonly string[]>> = {
  search: ["find", "search", "locate", "where", "reference", "references", "grep", "rg"],
  read: ["read", "show", "explain", "inspect", "review", "audit", "understand", "view"],
  edit: ["implement", "fix", "change", "update", "create", "write", "edit", "refactor", "rename"],
  run: ["run", "test", "build", "lint", "format", "check", "compile", "execute", "debug"],
  browser: ["web", "website", "browser", "url", "http", "https", "api", "online", "download"],
  computer: ["screen", "desktop", "gui", "mouse", "keyboard", "click", "drag", "pixel"],
  delegate: [
    "parallel",
    "subagent",
    "delegate",
    "independent",
    "workflow",
    "background",
    "monitor",
  ],
  capability: ["tool", "skill", "mcp", "plugin", "provider", "capability", "command"],
};

export const BASELINE_ORDER = [
  "read_file",
  "list_dir",
  "stat_path",
  "read_compact_document",
  "search_text",
  "discover_files",
  "preview_patch",
  "apply_patch",
  "run_process",
  "run_shell",
  "git_status",
  "git_diff",
  "git_log",
  "lsp_hover",
  "lsp_definition",
  "lsp_references",
  "lsp_diagnostics",
] as const;

export const DEBUG_ORDER = [
  "read_file",
  "list_dir",
  "stat_path",
  "read_compact_document",
  "discover_files",
  "search_text",
  "git_status",
  "git_diff",
  "git_log",
  "run_process",
  "run_shell",
  "lsp_hover",
  "lsp_definition",
  "lsp_references",
  "lsp_diagnostics",
  "dap_start",
  "dap_launch",
  "dap_set_breakpoints",
  "dap_stack_trace",
  "dap_continue",
  "dap_disconnect",
] as const;

export const SOURCE_SCORE: Readonly<Record<CapabilitySource, number>> = {
  builtin: 8,
  workspace: 7,
  user: 6,
  integration: 5,
  skill: 5,
  workflow: 5,
  mcp: 4,
  plugin: 4,
  provider: 3,
  marketplace: 2,
};

export const COST_SCORE: Readonly<Record<CapabilityCostClass, number>> = {
  none: 8,
  low: 6,
  medium: 3,
  high: 0,
  unknown: 1,
};

export const LATENCY_SCORE: Readonly<Record<CapabilityLatencyClass, number>> = {
  instant: 8,
  interactive: 5,
  background: 2,
  unknown: 1,
};

export type TaskSignals = {
  readonly tokens: ReadonlySet<string>;
  readonly families: readonly CapabilityFamily[];
  readonly taskFamilies: ReadonlySet<CapabilityFamily>;
  readonly explicitShell: boolean;
  readonly independentWork: boolean;
  readonly longRunningWork: boolean;
};
