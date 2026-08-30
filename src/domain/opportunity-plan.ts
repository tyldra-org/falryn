/**
 * Deterministic capability and automation planning for one model request.
 *
 * This module never loads, installs, activates, or executes a capability. It
 * ranks an immutable capability-health generation and returns a bounded plan
 * that application code may disclose to the model. Execution still belongs to
 * the unified capability gateway.
 */

import type {
  CapabilityEffectiveHealthState,
  CapabilityHealthCode,
  CapabilityHealthSnapshot,
} from "./capability-health.ts";
import type {
  CapabilityContributionKind,
  CapabilityCostClass,
  CapabilityFamily,
  CapabilityLatencyClass,
  CapabilitySource,
} from "./capability-registry.ts";
import type { EffectiveExecutionPolicy } from "./execution-profile.ts";
import type { CapabilityId, ConfigurationGeneration } from "./identity.ts";
import type { EffectClass } from "./work.ts";

export const OPPORTUNITY_PLAN_SCHEMA_VERSION = 1;
export const DEFAULT_OPPORTUNITY_SELECTION_LIMIT = 24;
export const MAX_OPPORTUNITY_SELECTION_LIMIT = 64;
export const DEFAULT_OPPORTUNITY_SCHEMA_TOKEN_BUDGET = 12_000;
export const MAX_OPPORTUNITY_SCHEMA_TOKEN_BUDGET = 64_000;
export const MAX_OPPORTUNITY_REJECTIONS = 64;
export const MAX_OPPORTUNITY_REASON_CODES = 8;
export const MAX_OPPORTUNITY_TASK_CHARACTERS = 32_000;

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

const STOP_WORDS = new Set([
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

const FAMILY_TERMS: Readonly<Record<CapabilityFamily, readonly string[]>> = {
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

const BASELINE_ORDER = [
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

const DEBUG_ORDER = [
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

const SOURCE_SCORE: Readonly<Record<CapabilitySource, number>> = {
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

const COST_SCORE: Readonly<Record<CapabilityCostClass, number>> = {
  none: 8,
  low: 6,
  medium: 3,
  high: 0,
  unknown: 1,
};

const LATENCY_SCORE: Readonly<Record<CapabilityLatencyClass, number>> = {
  instant: 8,
  interactive: 5,
  background: 2,
  unknown: 1,
};

type TaskSignals = {
  readonly tokens: ReadonlySet<string>;
  readonly families: readonly CapabilityFamily[];
  readonly taskFamilies: ReadonlySet<CapabilityFamily>;
  readonly explicitShell: boolean;
  readonly independentWork: boolean;
  readonly longRunningWork: boolean;
};

function tokens(value: string): ReadonlySet<string> {
  return new Set(
    value
      .toLocaleLowerCase()
      .split(/[^a-z0-9_.:/-]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2 && !STOP_WORDS.has(part)),
  );
}

function taskSignals(task: string, intentFamilies: readonly CapabilityFamily[]): TaskSignals {
  const bounded = task.slice(0, MAX_OPPORTUNITY_TASK_CHARACTERS);
  const lower = bounded.toLocaleLowerCase();
  const taskTokens = tokens(lower);
  const signalled = new Set<CapabilityFamily>(intentFamilies);
  const taskFamilies = new Set<CapabilityFamily>();
  for (const family of OPPORTUNITY_SIGNAL_FAMILIES) {
    if (FAMILY_TERMS[family].some((term) => lower.includes(term))) {
      signalled.add(family);
      taskFamilies.add(family);
    }
  }
  if (signalled.size === 0) {
    signalled.add("read");
    signalled.add("capability");
  }
  const explicitShell =
    /(?:^|\b)(?:bash|shell|terminal|command line|run command)(?:\b|$)/u.test(lower) ||
    /```(?:sh|bash|zsh|shell)/u.test(lower);
  if (explicitShell) {
    signalled.add("run");
    taskFamilies.add("run");
  }
  const independentWork =
    /(?:\bparallel\b|\bsubagents?\b|\bdelegate\b|\bindependent(?:ly)?\b)/u.test(lower) ||
    (lower.split(/\n\s*(?:[-*]|\d+[.)])\s+/u).length >= 3 && lower.includes(" and "));
  if (independentWork) {
    signalled.add("delegate");
    taskFamilies.add("delegate");
  }
  const longRunningWork =
    /(?:\bwatch(?:er|ing)?\b|\bmonitor(?:ing)?\b|\bdev server\b|\bserve\b|\bdaemon\b|\blong[- ]running\b)/u.test(
      lower,
    );
  if (longRunningWork) {
    signalled.add("run");
    signalled.add("delegate");
    taskFamilies.add("run");
    taskFamilies.add("delegate");
  }
  if (signalled.has("computer") && signalled.has("browser")) {
    // Browser remains the structured first choice; computer stays available as a fallback.
    signalled.delete("computer");
    signalled.add("computer");
  }
  signalled.add("capability");
  return {
    tokens: taskTokens,
    families: Object.freeze(OPPORTUNITY_SIGNAL_FAMILIES.filter((family) => signalled.has(family))),
    taskFamilies,
    explicitShell,
    independentWork,
    longRunningWork,
  };
}

function taskOverlap(candidate: CapabilityOpportunityCandidate, task: TaskSignals): number {
  const candidateTokens = tokens(`${candidate.name} ${candidate.title} ${candidate.summary}`);
  let overlap = 0;
  for (const token of task.tokens) {
    if (candidateTokens.has(token)) overlap += token.length >= 6 ? 3 : 2;
    if (candidate.name.toLocaleLowerCase() === token) overlap += 8;
  }
  return overlap;
}

function stablePriority(name: string, debug: boolean): number {
  const order = debug ? DEBUG_ORDER : BASELINE_ORDER;
  const index = order.indexOf(name as never);
  return index < 0 ? 0 : Math.max(1, order.length - index);
}

function familyBudget(
  family: CapabilityFamily,
  signals: TaskSignals,
  policy: EffectiveExecutionPolicy,
): number {
  if (signals.families.includes(family)) {
    if (family === "read") return 4;
    if (family === "search" || family === "run") return policy.profileId === "debug" ? 8 : 5;
    if (family === "edit") return 5;
    return 3;
  }
  return policy.requiredCapabilityFamilies.includes(family) ? 1 : 0;
}

function candidateReasons(
  candidate: CapabilityOpportunityCandidate,
  health: CapabilityHealthSnapshot["entries"][number],
  signals: TaskSignals,
  policy: EffectiveExecutionPolicy,
  preferred: ReadonlySet<CapabilityId>,
  overlap: number,
): OpportunityReasonCode[] {
  const reasons: OpportunityReasonCode[] = [];
  const lowerTask = [...signals.tokens];
  if (lowerTask.includes(candidate.name.toLocaleLowerCase())) reasons.push("explicit-capability");
  if (
    signals.explicitShell &&
    (candidate.name === "run_shell" || candidate.name === "run_process")
  ) {
    reasons.push("explicit-shell-override");
  }
  if (candidate.family !== null && signals.families.includes(candidate.family)) {
    reasons.push("task-family");
  } else if (
    candidate.family !== null &&
    policy.requiredCapabilityFamilies.includes(candidate.family)
  ) {
    reasons.push("profile-family");
  }
  if (overlap > 0) reasons.push("task-term-match");
  if (preferred.has(candidate.capabilityId)) reasons.push("user-preference");
  if (health.health === "healthy") reasons.push("healthy");
  if (health.health === "degraded") reasons.push("degraded");
  if (candidate.source === "builtin" || candidate.source === "workspace") {
    reasons.push("local-source");
  }
  if (candidate.costClass === "none" || candidate.costClass === "low") reasons.push("lower-cost");
  if (candidate.latencyClass === "instant" || candidate.latencyClass === "interactive") {
    reasons.push("lower-latency");
  }
  if (candidate.family === "browser" && signals.families.includes("browser")) {
    reasons.push("structured-before-visual");
  }
  if (candidate.kind === "skill" && overlap > 0) reasons.push("required-skill-match");
  if (candidate.kind === "workflow" && overlap > 0) reasons.push("workflow-match");
  return reasons.slice(0, MAX_OPPORTUNITY_REASON_CODES);
}

function candidateScore(
  candidate: CapabilityOpportunityCandidate,
  health: CapabilityHealthSnapshot["entries"][number],
  signals: TaskSignals,
  policy: EffectiveExecutionPolicy,
  preferred: ReadonlySet<CapabilityId>,
  overlap: number,
): number {
  let score = stablePriority(candidate.name, policy.profileId === "debug");
  if (candidate.family !== null && signals.taskFamilies.has(candidate.family)) score += 100;
  else if (candidate.family !== null && signals.families.includes(candidate.family)) score += 70;
  else if (
    candidate.family !== null &&
    policy.requiredCapabilityFamilies.includes(candidate.family)
  ) {
    score += 30;
  }
  score += Math.min(40, overlap * 3);
  if (preferred.has(candidate.capabilityId)) score += 45;
  if (signals.explicitShell && candidate.name === "run_shell") score += 100;
  if (signals.explicitShell && candidate.name === "run_process") score += 80;
  if (candidate.family === "browser" && signals.families.includes("browser")) score += 18;
  if (candidate.family === "computer" && signals.families.includes("browser")) score -= 18;
  if (candidate.kind === "skill" || candidate.kind === "workflow") {
    score += overlap > 0 ? 30 : -40;
  }
  score += SOURCE_SCORE[candidate.source];
  score += COST_SCORE[candidate.costClass];
  score += LATENCY_SCORE[candidate.latencyClass];
  if (health.health === "degraded") score -= 8;
  return score;
}

function decision(
  candidate: CapabilityOpportunityCandidate,
  health: CapabilityHealthSnapshot["entries"][number],
  kind: OpportunityDecisionKind,
  score: number,
  reasons: readonly OpportunityReasonCode[],
): OpportunityCandidateDecision {
  return Object.freeze({
    capabilityId: candidate.capabilityId,
    name: candidate.name,
    kind: candidate.kind,
    family: candidate.family,
    source: candidate.source,
    effect: candidate.effect,
    health: health.health,
    decision: kind,
    score,
    schemaTokensEstimated: candidate.schemaTokensEstimated,
    reasons: Object.freeze([...reasons]),
    diagnosticCodes: Object.freeze(health.diagnostics.map((item) => item.code)),
  });
}

function withTerminalReason(
  reasons: readonly OpportunityReasonCode[],
  terminal: OpportunityReasonCode,
): readonly OpportunityReasonCode[] {
  return Object.freeze([
    ...reasons.filter((reason) => reason !== terminal).slice(0, MAX_OPPORTUNITY_REASON_CODES - 1),
    terminal,
  ]);
}

function automationOpportunities(
  selected: readonly OpportunityCandidateDecision[],
  fallbacks: readonly OpportunityCandidateDecision[],
  rejected: readonly OpportunityCandidateDecision[],
  signals: TaskSignals,
): readonly AutomationOpportunity[] {
  const all = [...selected, ...fallbacks];
  const byKind = (...kinds: CapabilityContributionKind[]): CapabilityId[] =>
    all.filter((item) => kinds.includes(item.kind)).map((item) => item.capabilityId);
  const byFamily = (family: CapabilityFamily): CapabilityId[] =>
    all.filter((item) => item.family === family).map((item) => item.capabilityId);
  const skills = byKind("skill");
  const workflows = byKind("workflow");
  const extensions = byKind("mcp-tool", "mcp-resource", "mcp-prompt", "plugin");
  const unavailableByKind = (...kinds: CapabilityContributionKind[]): CapabilityId[] =>
    rejected
      .filter((item) => kinds.includes(item.kind))
      .filter((item) =>
        item.reasons.some((reason) =>
          [
            "explicit-capability",
            "user-preference",
            "task-term-match",
            "required-skill-match",
            "workflow-match",
          ].includes(reason),
        ),
      )
      .map((item) => item.capabilityId)
      .slice(0, MAX_OPPORTUNITY_SELECTION_LIMIT);
  const unavailableSkills = unavailableByKind("skill");
  const unavailableWorkflows = unavailableByKind("workflow");
  const unavailableExtensions = unavailableByKind(
    "mcp-tool",
    "mcp-resource",
    "mcp-prompt",
    "plugin",
  );
  const delegation = byFamily("delegate");
  const browsers = byFamily("browser");
  const computers = byFamily("computer");
  return Object.freeze([
    {
      kind: "skill",
      decision:
        skills.length > 0
          ? "selected"
          : unavailableSkills.length > 0
            ? "unavailable"
            : "not-needed",
      capabilityIds: Object.freeze(skills.length > 0 ? skills : unavailableSkills),
      reason:
        skills.length > 0 || unavailableSkills.length > 0
          ? "required-skill-match"
          : "not-task-relevant",
    },
    {
      kind: "workflow",
      decision:
        workflows.length > 0
          ? "selected"
          : unavailableWorkflows.length > 0
            ? "unavailable"
            : "not-needed",
      capabilityIds: Object.freeze(workflows.length > 0 ? workflows : unavailableWorkflows),
      reason:
        workflows.length > 0 || unavailableWorkflows.length > 0
          ? "workflow-match"
          : "not-task-relevant",
    },
    {
      kind: "mcp-plugin",
      decision:
        extensions.length > 0
          ? "selected"
          : unavailableExtensions.length > 0
            ? "unavailable"
            : "not-needed",
      capabilityIds: Object.freeze(extensions.length > 0 ? extensions : unavailableExtensions),
      reason:
        extensions.length > 0 || unavailableExtensions.length > 0
          ? "task-term-match"
          : "not-task-relevant",
    },
    {
      kind: "delegation",
      decision: signals.independentWork
        ? delegation.length > 0
          ? "recommended"
          : "unavailable"
        : "not-needed",
      capabilityIds: Object.freeze(delegation),
      reason: signals.independentWork ? "independent-work" : "not-task-relevant",
    },
    {
      kind: "background",
      decision: signals.longRunningWork
        ? delegation.length > 0
          ? "recommended"
          : "deferred"
        : "not-needed",
      capabilityIds: Object.freeze(delegation),
      reason: signals.longRunningWork ? "long-running-work" : "not-task-relevant",
    },
    {
      kind: "browser",
      decision: signals.families.includes("browser")
        ? browsers.length > 0
          ? "selected"
          : "unavailable"
        : "not-needed",
      capabilityIds: Object.freeze(browsers),
      reason: signals.families.includes("browser")
        ? "structured-before-visual"
        : "not-task-relevant",
    },
    {
      kind: "computer",
      decision: signals.families.includes("computer")
        ? computers.length > 0
          ? browsers.length > 0
            ? "deferred"
            : "selected"
          : "unavailable"
        : "not-needed",
      capabilityIds: Object.freeze(computers),
      reason:
        browsers.length > 0 && signals.families.includes("computer")
          ? "structured-before-visual"
          : signals.families.includes("computer")
            ? "task-family"
            : "not-task-relevant",
    },
  ] satisfies AutomationOpportunity[]);
}

function primaryFamily(signals: TaskSignals): CapabilityFamily {
  const preferred: readonly CapabilityFamily[] = [
    "browser",
    "computer",
    "edit",
    "search",
    "read",
    "run",
    "delegate",
    "capability",
  ];
  return (
    preferred.find((family) => signals.taskFamilies.has(family)) ??
    preferred.find((family) => signals.families.includes(family)) ??
    "capability"
  );
}

/** Build one byte-stable plan from a bound registry/health/policy generation. */
export function planCapabilityOpportunities(input: OpportunityPlanInput): ModelCapabilityBrief {
  if (input.health.generation !== input.policy.configurationGeneration) {
    throw new Error("opportunity planning generations do not match");
  }
  if (!/^[a-f0-9]{24}$/u.test(input.taskFingerprint)) {
    throw new Error("opportunity planning task fingerprint is invalid");
  }
  const selectionLimit = Math.min(
    MAX_OPPORTUNITY_SELECTION_LIMIT,
    Math.max(
      1,
      Math.trunc(
        Number.isFinite(input.selectionLimit)
          ? (input.selectionLimit ?? DEFAULT_OPPORTUNITY_SELECTION_LIMIT)
          : DEFAULT_OPPORTUNITY_SELECTION_LIMIT,
      ),
    ),
  );
  const schemaTokenBudget = Math.min(
    MAX_OPPORTUNITY_SCHEMA_TOKEN_BUDGET,
    Math.max(
      0,
      Math.trunc(
        Number.isFinite(input.schemaTokenBudget)
          ? (input.schemaTokenBudget ?? DEFAULT_OPPORTUNITY_SCHEMA_TOKEN_BUDGET)
          : DEFAULT_OPPORTUNITY_SCHEMA_TOKEN_BUDGET,
      ),
    ),
  );
  const signals = taskSignals(input.task, input.intentFamilies ?? []);
  const preferred = new Set(input.preferredCapabilityIds ?? []);
  const healthById = new Map(input.health.entries.map((entry) => [entry.capabilityId, entry]));
  const ranked = input.candidates
    .map((candidate) => {
      const health = healthById.get(candidate.capabilityId);
      if (health === undefined)
        throw new Error("opportunity candidate is absent from health snapshot");
      const overlap = taskOverlap(candidate, signals);
      return {
        candidate,
        health,
        overlap,
        score: candidateScore(candidate, health, signals, input.policy, preferred, overlap),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.order - right.candidate.order ||
        String(left.candidate.capabilityId).localeCompare(String(right.candidate.capabilityId)),
    );

  const selected: OpportunityCandidateDecision[] = [];
  const fallbacks: OpportunityCandidateDecision[] = [];
  const rejected: OpportunityCandidateDecision[] = [];
  const familyCounts = new Map<CapabilityFamily, number>();
  let selectedSchemaTokens = 0;

  for (const rankedCandidate of ranked) {
    const { candidate, health, overlap, score } = rankedCandidate;
    const reasons = candidateReasons(candidate, health, signals, input.policy, preferred, overlap);
    if (!health.selectable) {
      const terminalReason = health.health === "denied" ? "policy-denied" : "not-selectable";
      rejected.push(
        decision(
          candidate,
          health,
          "unavailable",
          score,
          withTerminalReason(reasons, terminalReason),
        ),
      );
      continue;
    }
    if (
      !candidate.modelSchemaEligible &&
      (candidate.kind === "tool" || candidate.kind === "mcp-tool")
    ) {
      rejected.push(decision(candidate, health, "rejected", score, ["schema-unavailable"]));
      continue;
    }
    const family = candidate.family;
    const relevantByKind =
      (candidate.kind === "skill" || candidate.kind === "workflow") && overlap > 0;
    const relevantByExtension =
      ["mcp-tool", "mcp-resource", "mcp-prompt", "plugin"].includes(candidate.kind) && overlap > 0;
    const requiresSemanticMatch = [
      "skill",
      "workflow",
      "mcp-tool",
      "mcp-resource",
      "mcp-prompt",
      "plugin",
      "agent",
      "subagent",
    ].includes(candidate.kind);
    const budget = family === null ? 0 : familyBudget(family, signals, input.policy);
    const count = family === null ? 0 : (familyCounts.get(family) ?? 0);
    const relevant =
      preferred.has(candidate.capabilityId) ||
      relevantByKind ||
      relevantByExtension ||
      (!requiresSemanticMatch && family !== null && budget > count);
    if (!relevant) {
      rejected.push(decision(candidate, health, "rejected", score, ["not-task-relevant"]));
      continue;
    }
    const wouldExceedTokens =
      selectedSchemaTokens + candidate.schemaTokensEstimated > schemaTokenBudget;
    if (selected.length >= selectionLimit || wouldExceedTokens) {
      const reason: OpportunityReasonCode = wouldExceedTokens ? "schema-budget" : "selection-limit";
      fallbacks.push(decision(candidate, health, "fallback", score, [...reasons, reason]));
      continue;
    }
    selected.push(decision(candidate, health, "selected", score, reasons));
    selectedSchemaTokens += candidate.schemaTokensEstimated;
    if (family !== null) familyCounts.set(family, count + 1);
  }

  const boundedRejected = rejected.slice(0, MAX_OPPORTUNITY_REJECTIONS);
  const selectedTop = selected[0];
  const nextTop = selected[1];
  const semanticTie =
    selectedTop !== undefined &&
    nextTop !== undefined &&
    selectedTop.score === nextTop.score &&
    selectedTop.family === nextTop.family &&
    !selectedTop.reasons.includes("explicit-capability") &&
    !selectedTop.reasons.includes("user-preference");
  const primary = primaryFamily(signals);
  const modelAssistance: OpportunityModelAssistance = {
    decision: semanticTie ? "eligible" : "not-needed",
    candidateIds: Object.freeze(
      semanticTie && selectedTop !== undefined && nextTop !== undefined
        ? [selectedTop.capabilityId, nextTop.capabilityId]
        : [],
    ),
    reason: semanticTie ? "semantic-tie" : "deterministic-winner",
  };
  return Object.freeze({
    schemaVersion: OPPORTUNITY_PLAN_SCHEMA_VERSION,
    planId: `capability-plan:${input.health.generation}:${input.taskFingerprint}`,
    taskFingerprint: input.taskFingerprint,
    catalogGeneration: input.health.generation,
    policyGeneration: input.policy.configurationGeneration,
    profileId: input.policy.profileId,
    signalledFamilies: signals.families,
    requiredFamilies: Object.freeze([...input.policy.requiredCapabilityFamilies]),
    primaryFamily: primary,
    fallbackFamilies: Object.freeze(
      OPPORTUNITY_SIGNAL_FAMILIES.filter(
        (family) => family !== primary && signals.families.includes(family),
      ),
    ),
    selected: Object.freeze(selected),
    fallbacks: Object.freeze(fallbacks.slice(0, MAX_OPPORTUNITY_REJECTIONS)),
    rejected: Object.freeze(boundedRejected),
    omittedRejected: Math.max(0, rejected.length - boundedRejected.length),
    opportunities: automationOpportunities(selected, fallbacks, rejected, signals),
    modelAssistance,
    schemaTokensEstimated: selectedSchemaTokens,
    selectionLimit,
    schemaTokenBudget,
    discoveryHandle: `capability-catalog:${input.health.generation}`,
  });
}
