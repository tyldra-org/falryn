/**
 * Execution profiles: one runtime with four explicit authority presets (#789).
 *
 * Profiles are not agents, prompt stacks, or provider configurations. They
 * select the smallest sufficient capability surface and an effect ceiling for
 * one turn. Application code resolves the preferred work intent into a model
 * route and binds the resulting policy to the attempt generation.
 */

import type { BriefVerbosityMode } from "./brief.ts";
import type { ConfigurationGeneration } from "./identity.ts";
import type { EffectClass } from "./work.ts";

export const EXECUTION_PROFILE_SCHEMA_VERSION = 1;

export const EXECUTION_PROFILE_IDS = ["ask", "plan", "debug", "agent"] as const;

export type ExecutionProfileId = (typeof EXECUTION_PROFILE_IDS)[number];

export function isExecutionProfileId(value: unknown): value is ExecutionProfileId {
  return typeof value === "string" && (EXECUTION_PROFILE_IDS as readonly string[]).includes(value);
}

export const EXECUTION_PROFILE_COMPLETIONS = [
  "answer",
  "durable-plan",
  "diagnosis",
  "implemented-and-verified",
] as const;

export type ExecutionProfileCompletion = (typeof EXECUTION_PROFILE_COMPLETIONS)[number];

export const EXECUTION_PROFILE_REASONING_REQUESTS = ["model-default", "balanced"] as const;

export type ExecutionProfileReasoningRequest =
  (typeof EXECUTION_PROFILE_REASONING_REQUESTS)[number];

/** Provider-neutral model job requested by a profile. */
export type ExecutionProfileWorkIntent = "read" | "planning" | "deepReview" | "coding";

export type ExecutionProfile = {
  readonly schemaVersion: typeof EXECUTION_PROFILE_SCHEMA_VERSION;
  readonly id: ExecutionProfileId;
  readonly label: string;
  readonly description: string;
  readonly workIntent: ExecutionProfileWorkIntent;
  readonly reasoning: ExecutionProfileReasoningRequest;
  readonly requiredCapabilityFamilies: readonly string[];
  readonly allowedEffects: readonly EffectClass[];
  /** Narrow, named exclusions used when an effect class is intentionally broad. */
  readonly deniedToolNames: readonly string[];
  readonly completion: ExecutionProfileCompletion;
  readonly contextPolicy:
    | "answer-evidence"
    | "planning-evidence"
    | "diagnostic-evidence"
    | "task-evidence";
  readonly defaultBriefVerbosity: BriefVerbosityMode;
  readonly confirmationPolicy: "focused-for-consequential-effects";
  readonly promptGuidance: string;
};

const DEBUG_MUTATION_TOOLS = [
  "write_files",
  "mutate_paths",
  "apply_patch",
  "git_create_branch",
  "git_switch_branch",
  "git_delete_branch",
  "git_create_worktree",
  "git_remove_worktree",
  "git_stage",
  "git_unstage",
  "git_commit",
  "git_sync",
  "lsp_change_document",
  "lsp_save_document",
  "lsp_format",
  "lsp_format_range",
  "lsp_rename",
  "lsp_code_actions",
  "dap_set_variable",
  "dap_set_expression",
] as const;

const PROFILE_TABLE = {
  ask: {
    schemaVersion: EXECUTION_PROFILE_SCHEMA_VERSION,
    id: "ask",
    label: "Ask",
    description: "Explain and investigate without consequential effects.",
    workIntent: "read",
    reasoning: "model-default",
    requiredCapabilityFamilies: ["search", "read", "capability"],
    allowedEffects: ["observation"],
    deniedToolNames: [],
    completion: "answer",
    contextPolicy: "answer-evidence",
    defaultBriefVerbosity: "compact",
    confirmationPolicy: "focused-for-consequential-effects",
    promptGuidance:
      "Answer the request using read-only evidence. Do not propose or perform implementation effects.",
  },
  plan: {
    schemaVersion: EXECUTION_PROFILE_SCHEMA_VERSION,
    id: "plan",
    label: "Plan",
    description: "Investigate read-only and produce a durable reviewable plan.",
    workIntent: "planning",
    reasoning: "balanced",
    requiredCapabilityFamilies: ["search", "read", "capability"],
    allowedEffects: ["observation"],
    deniedToolNames: [],
    completion: "durable-plan",
    contextPolicy: "planning-evidence",
    defaultBriefVerbosity: "detailed",
    confirmationPolicy: "focused-for-consequential-effects",
    promptGuidance:
      "Investigate without changing state, then produce a concrete reviewable implementation plan.",
  },
  debug: {
    schemaVersion: EXECUTION_PROFILE_SCHEMA_VERSION,
    id: "debug",
    label: "Debug",
    description: "Diagnose with bounded probes and do not silently apply a fix.",
    workIntent: "deepReview",
    reasoning: "balanced",
    requiredCapabilityFamilies: ["search", "read", "run", "capability"],
    allowedEffects: ["observation", "mutation", "external", "interactive"],
    deniedToolNames: DEBUG_MUTATION_TOOLS,
    completion: "diagnosis",
    contextPolicy: "diagnostic-evidence",
    defaultBriefVerbosity: "detailed",
    confirmationPolicy: "focused-for-consequential-effects",
    promptGuidance:
      "Gather evidence with bounded diagnostic probes. Explain the cause; do not apply a fix unless the user explicitly changes profile.",
  },
  agent: {
    schemaVersion: EXECUTION_PROFILE_SCHEMA_VERSION,
    id: "agent",
    label: "Agent",
    description: "Execute the full authorized coding and verification loop.",
    workIntent: "coding",
    reasoning: "model-default",
    requiredCapabilityFamilies: [
      "search",
      "read",
      "edit",
      "run",
      "browser",
      "computer",
      "delegate",
      "capability",
    ],
    allowedEffects: ["observation", "mutation", "external", "interactive"],
    deniedToolNames: [],
    completion: "implemented-and-verified",
    contextPolicy: "task-evidence",
    defaultBriefVerbosity: "balanced",
    confirmationPolicy: "focused-for-consequential-effects",
    promptGuidance:
      "Complete the requested work through the authorized coding, validation, and recovery loop.",
  },
} as const satisfies Readonly<Record<ExecutionProfileId, ExecutionProfile>>;

export const EXECUTION_PROFILES: readonly ExecutionProfile[] = EXECUTION_PROFILE_IDS.map(
  (id) => PROFILE_TABLE[id],
);

export function executionProfile(id: ExecutionProfileId): ExecutionProfile {
  return PROFILE_TABLE[id];
}

export type EffectiveExecutionPolicy = {
  readonly schemaVersion: typeof EXECUTION_PROFILE_SCHEMA_VERSION;
  readonly profileId: ExecutionProfileId;
  readonly profileVersion: typeof EXECUTION_PROFILE_SCHEMA_VERSION;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly workIntent: ExecutionProfileWorkIntent;
  readonly reasoning: ExecutionProfileReasoningRequest;
  readonly requiredCapabilityFamilies: readonly string[];
  readonly allowedEffects: readonly EffectClass[];
  readonly deniedEffects: readonly EffectClass[];
  readonly deniedToolNames: readonly string[];
  readonly completion: ExecutionProfileCompletion;
  readonly contextPolicy: ExecutionProfile["contextPolicy"];
  readonly defaultBriefVerbosity: BriefVerbosityMode;
  readonly confirmationPolicy: ExecutionProfile["confirmationPolicy"];
  readonly promptGuidance: string;
};

const ALL_EFFECTS: readonly EffectClass[] = ["observation", "mutation", "external", "interactive"];

/** Resolve one immutable policy snapshot for a turn boundary. */
export function resolveExecutionProfile(
  id: ExecutionProfileId,
  configurationGeneration: ConfigurationGeneration,
): EffectiveExecutionPolicy {
  const profile = executionProfile(id);
  const allowed = new Set<EffectClass>(profile.allowedEffects);
  return Object.freeze({
    schemaVersion: EXECUTION_PROFILE_SCHEMA_VERSION,
    profileId: profile.id,
    profileVersion: EXECUTION_PROFILE_SCHEMA_VERSION,
    configurationGeneration,
    workIntent: profile.workIntent,
    reasoning: profile.reasoning,
    requiredCapabilityFamilies: Object.freeze([...profile.requiredCapabilityFamilies]),
    allowedEffects: Object.freeze([...profile.allowedEffects]),
    deniedEffects: Object.freeze(ALL_EFFECTS.filter((effect) => !allowed.has(effect))),
    deniedToolNames: Object.freeze([...profile.deniedToolNames]),
    completion: profile.completion,
    contextPolicy: profile.contextPolicy,
    defaultBriefVerbosity: profile.defaultBriefVerbosity,
    confirmationPolicy: profile.confirmationPolicy,
    promptGuidance: profile.promptGuidance,
  });
}
