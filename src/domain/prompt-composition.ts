/**
 * Deterministic composition of system prompts, instructions, tools, and
 * context for one turn.
 *
 * The context engine renders provider-neutral sections before any adapter
 * converts them into provider messages. Role precedence fixes section order;
 * tool schemas remain structured definitions rather than pasted prose. This
 * module is pure: it does not call providers, read the filesystem, or hash
 * with crypto — callers derive a digest from {@link ComposedPromptRequest.canonicalForm}.
 *
 * Stages that stream model events, execute tools, retry/fallback, or persist
 * turn events belong to later #40 children.
 */

import type { ConfigurationGeneration, SessionId, TurnId, WorkspaceId } from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

/** Schema version this build writes for composed prompt receipts. */
export const PROMPT_COMPOSITION_SCHEMA_VERSION = 1;

/**
 * Stable section roles in render order.
 *
 * Product invariants cannot be replaced by project files. Brief is last so
 * response-policy guidance sits immediately before inference.
 */
export const PROMPT_SECTION_ROLES = [
  "product-invariant",
  "user-instruction",
  "project-instruction",
  "skill-workflow",
  "task",
  "conversation",
  "memory",
  "evidence",
  "brief",
] as const;

export type PromptSectionRole = (typeof PROMPT_SECTION_ROLES)[number];

export function isPromptSectionRole(value: unknown): value is PromptSectionRole {
  return typeof value === "string" && (PROMPT_SECTION_ROLES as readonly string[]).includes(value);
}

/** Why a candidate piece was omitted from the rendered request. */
export const PROMPT_EXCLUSION_REASONS = [
  "missing",
  "empty",
  "oversized",
  "unavailable",
  "budget-exceeded",
  "duplicate",
] as const;

export type PromptExclusionReason = (typeof PROMPT_EXCLUSION_REASONS)[number];

export function isPromptExclusionReason(value: unknown): value is PromptExclusionReason {
  return (
    typeof value === "string" && (PROMPT_EXCLUSION_REASONS as readonly string[]).includes(value)
  );
}

/** Default total token budget for one composed request. */
export const DEFAULT_PROMPT_MAX_TOTAL_TOKENS = 32_768;

/** Default per-section token budget. */
export const DEFAULT_PROMPT_MAX_SECTION_TOKENS = 8_192;

/** Default max UTF-8 bytes for one tool description. */
export const DEFAULT_PROMPT_MAX_TOOL_DESCRIPTION_BYTES = 4_096;

/** Hard cap on section candidates admitted in one compose call. */
export const MAX_PROMPT_SECTION_INPUTS = 256;

/** Hard cap on tool definitions admitted in one compose call. */
export const MAX_PROMPT_TOOL_INPUTS = 128;

/**
 * Rough token estimate when a caller does not supply one.
 *
 * Not a tokenizer: ~4 UTF-16 code units per token keeps budgets deterministic
 * without binding the domain to a provider tokenizer.
 */
export function estimatePromptTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export type PromptCompositionBudgets = {
  readonly maxTotalTokens: number;
  readonly maxSectionTokens: number;
  readonly maxToolDescriptionBytes: number;
};

export const DEFAULT_PROMPT_COMPOSITION_BUDGETS: PromptCompositionBudgets = {
  maxTotalTokens: DEFAULT_PROMPT_MAX_TOTAL_TOKENS,
  maxSectionTokens: DEFAULT_PROMPT_MAX_SECTION_TOKENS,
  maxToolDescriptionBytes: DEFAULT_PROMPT_MAX_TOOL_DESCRIPTION_BYTES,
};

export type PromptSectionInput = {
  readonly id: string;
  readonly role: PromptSectionRole;
  /** Provenance label (product, path, skill id, retrieval handle, …). */
  readonly source: string;
  readonly content: string;
  readonly required: boolean;
  /**
   * When false, the piece is treated as unavailable even if content is present.
   * Missing content with `available: true` is still empty/missing.
   */
  readonly available: boolean;
  readonly estimatedTokens?: number;
};

export type PromptToolInput = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly required: boolean;
  readonly available: boolean;
};

export type ComposePromptInput = {
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly sections: readonly PromptSectionInput[];
  readonly tools: readonly PromptToolInput[];
  readonly budgets?: PromptCompositionBudgets;
};

export type RenderedPromptSection = {
  readonly id: string;
  readonly role: PromptSectionRole;
  readonly source: string;
  readonly content: string;
  readonly estimatedTokens: number;
  readonly order: number;
};

export type RenderedPromptTool = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly order: number;
};

export type PromptExclusion = {
  readonly id: string;
  readonly kind: "section" | "tool";
  readonly role: PromptSectionRole | "tool-definition";
  readonly reason: PromptExclusionReason;
  readonly required: boolean;
};

export type ComposedPromptRequest = {
  readonly schemaVersion: typeof PROMPT_COMPOSITION_SCHEMA_VERSION;
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly sections: readonly RenderedPromptSection[];
  readonly tools: readonly RenderedPromptTool[];
  readonly exclusions: readonly PromptExclusion[];
  readonly totalEstimatedTokens: number;
  /**
   * Stable UTF-8 text binding every semantic input that survived composition.
   * Digest with the content hasher at the application boundary for cache keys.
   */
  readonly canonicalForm: string;
};

export type ComposePromptError =
  | {
      readonly code: "too-many-sections";
      readonly count: number;
      readonly max: number;
    }
  | {
      readonly code: "too-many-tools";
      readonly count: number;
      readonly max: number;
    }
  | {
      readonly code: "invalid-section-id";
      readonly reason: "empty" | "duplicate";
      readonly id: string;
    }
  | {
      readonly code: "invalid-tool-name";
      readonly reason: "empty" | "duplicate";
      readonly name: string;
    }
  | {
      readonly code: "required-piece-failed";
      readonly exclusions: readonly PromptExclusion[];
    }
  | {
      readonly code: "insufficient-context";
      readonly exclusions: readonly PromptExclusion[];
      readonly totalEstimatedTokens: number;
    };

export type ComposePromptResult = Result<ComposedPromptRequest, ComposePromptError>;

function roleRank(role: PromptSectionRole): number {
  const index = PROMPT_SECTION_ROLES.indexOf(role);
  return index < 0 ? PROMPT_SECTION_ROLES.length : index;
}

function sectionTokens(section: PromptSectionInput): number {
  return section.estimatedTokens ?? estimatePromptTokens(section.content);
}

function classifySection(
  section: PromptSectionInput,
  budgets: PromptCompositionBudgets,
): PromptExclusionReason | null {
  if (!section.available) {
    return "unavailable";
  }
  if (section.content.length === 0) {
    return section.required ? "missing" : "empty";
  }
  if (sectionTokens(section) > budgets.maxSectionTokens) {
    return "oversized";
  }
  return null;
}

function classifyTool(
  tool: PromptToolInput,
  budgets: PromptCompositionBudgets,
): PromptExclusionReason | null {
  if (!tool.available) {
    return "unavailable";
  }
  if (tool.name.length === 0) {
    return "missing";
  }
  if (tool.description.length === 0 && tool.required) {
    return "empty";
  }
  if (utf8ByteLength(tool.description) > budgets.maxToolDescriptionBytes) {
    return "oversized";
  }
  return null;
}

/**
 * Stable JSON-ish serialization for cache identity.
 *
 * Keys are emitted in a fixed order. Nested tool parameters are serialized with
 * sorted object keys so equivalent schemas hash identically regardless of
 * insertion order.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function buildCanonicalForm(input: {
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly sections: readonly RenderedPromptSection[];
  readonly tools: readonly RenderedPromptTool[];
  readonly exclusions: readonly PromptExclusion[];
}): string {
  return stableJson({
    schemaVersion: PROMPT_COMPOSITION_SCHEMA_VERSION,
    turnId: input.turnId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    configurationGeneration: input.configurationGeneration,
    sections: input.sections.map((section) => ({
      id: section.id,
      role: section.role,
      source: section.source,
      content: section.content,
      estimatedTokens: section.estimatedTokens,
      order: section.order,
    })),
    tools: input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      order: tool.order,
    })),
    exclusions: input.exclusions.map((exclusion) => ({
      id: exclusion.id,
      kind: exclusion.kind,
      role: exclusion.role,
      reason: exclusion.reason,
      required: exclusion.required,
    })),
  });
}

/**
 * Compose a provider-neutral prompt request for one turn.
 *
 * Sections are sorted by role precedence, then by id within a role. Tools are
 * sorted by name. Optional pieces that fail admission become exclusions;
 * required failures reject the compose. Under total budget pressure, later
 * optional evidence/memory/conversation pieces are deferred first.
 */
export function composePromptRequest(input: ComposePromptInput): ComposePromptResult {
  const budgets = input.budgets ?? DEFAULT_PROMPT_COMPOSITION_BUDGETS;

  if (input.sections.length > MAX_PROMPT_SECTION_INPUTS) {
    return err({
      code: "too-many-sections",
      count: input.sections.length,
      max: MAX_PROMPT_SECTION_INPUTS,
    });
  }
  if (input.tools.length > MAX_PROMPT_TOOL_INPUTS) {
    return err({
      code: "too-many-tools",
      count: input.tools.length,
      max: MAX_PROMPT_TOOL_INPUTS,
    });
  }

  const seenSectionIds = new Set<string>();
  for (const section of input.sections) {
    if (section.id.length === 0) {
      return err({ code: "invalid-section-id", reason: "empty", id: "" });
    }
    if (seenSectionIds.has(section.id)) {
      return err({ code: "invalid-section-id", reason: "duplicate", id: section.id });
    }
    seenSectionIds.add(section.id);
  }

  const seenToolNames = new Set<string>();
  for (const tool of input.tools) {
    if (tool.name.length === 0) {
      return err({ code: "invalid-tool-name", reason: "empty", name: "" });
    }
    if (seenToolNames.has(tool.name)) {
      return err({ code: "invalid-tool-name", reason: "duplicate", name: tool.name });
    }
    seenToolNames.add(tool.name);
  }

  const exclusions: PromptExclusion[] = [];
  const admitted: PromptSectionInput[] = [];

  const orderedSections = [...input.sections].sort((left, right) => {
    const byRole = roleRank(left.role) - roleRank(right.role);
    if (byRole !== 0) {
      return byRole;
    }
    return left.id.localeCompare(right.id);
  });

  for (const section of orderedSections) {
    const reason = classifySection(section, budgets);
    if (reason !== null) {
      exclusions.push({
        id: section.id,
        kind: "section",
        role: section.role,
        reason,
        required: section.required,
      });
      continue;
    }
    admitted.push(section);
  }

  const orderedTools = [...input.tools].sort((left, right) => left.name.localeCompare(right.name));
  const admittedTools: PromptToolInput[] = [];
  for (const tool of orderedTools) {
    const reason = classifyTool(tool, budgets);
    if (reason !== null) {
      exclusions.push({
        id: tool.name,
        kind: "tool",
        role: "tool-definition",
        reason,
        required: tool.required,
      });
      continue;
    }
    admittedTools.push(tool);
  }

  const requiredFailures = exclusions.filter((exclusion) => exclusion.required);
  if (requiredFailures.length > 0) {
    return err({ code: "required-piece-failed", exclusions: requiredFailures });
  }

  // Under total budget pressure, drop optional lower-priority sections from the
  // end of the precedence list (evidence/memory/conversation) before invariants.
  let runningTokens = 0;
  const kept: PromptSectionInput[] = [];
  const deferrable = new Set<PromptSectionRole>(["evidence", "memory", "conversation"]);

  for (const section of admitted) {
    const tokens = sectionTokens(section);
    if (runningTokens + tokens <= budgets.maxTotalTokens) {
      kept.push(section);
      runningTokens += tokens;
      continue;
    }
    if (!section.required && deferrable.has(section.role)) {
      exclusions.push({
        id: section.id,
        kind: "section",
        role: section.role,
        reason: "budget-exceeded",
        required: false,
      });
      continue;
    }
    if (section.required) {
      exclusions.push({
        id: section.id,
        kind: "section",
        role: section.role,
        reason: "budget-exceeded",
        required: true,
      });
      return err({
        code: "insufficient-context",
        exclusions: exclusions.filter((exclusion) => exclusion.required),
        totalEstimatedTokens: runningTokens + tokens,
      });
    }
    exclusions.push({
      id: section.id,
      kind: "section",
      role: section.role,
      reason: "budget-exceeded",
      required: false,
    });
  }

  const hasProductInvariant = kept.some((section) => section.role === "product-invariant");
  const hasTask = kept.some((section) => section.role === "task");
  if (!hasProductInvariant || !hasTask) {
    const missing: PromptExclusion[] = [];
    if (!hasProductInvariant) {
      missing.push({
        id: "product-invariant",
        kind: "section",
        role: "product-invariant",
        reason: "missing",
        required: true,
      });
    }
    if (!hasTask) {
      missing.push({
        id: "task",
        kind: "section",
        role: "task",
        reason: "missing",
        required: true,
      });
    }
    return err({
      code: "insufficient-context",
      exclusions: missing,
      totalEstimatedTokens: runningTokens,
    });
  }

  const sections: RenderedPromptSection[] = kept.map((section, index) => ({
    id: section.id,
    role: section.role,
    source: section.source,
    content: section.content,
    estimatedTokens: sectionTokens(section),
    order: index,
  }));

  const tools: RenderedPromptTool[] = admittedTools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    order: index,
  }));

  const stableExclusions = [...exclusions].sort((left, right) => {
    const byKind = left.kind.localeCompare(right.kind);
    if (byKind !== 0) {
      return byKind;
    }
    return left.id.localeCompare(right.id);
  });

  const composed: ComposedPromptRequest = {
    schemaVersion: PROMPT_COMPOSITION_SCHEMA_VERSION,
    turnId: input.turnId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    configurationGeneration: input.configurationGeneration,
    sections,
    tools,
    exclusions: stableExclusions,
    totalEstimatedTokens: runningTokens,
    canonicalForm: buildCanonicalForm({
      turnId: input.turnId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      configurationGeneration: input.configurationGeneration,
      sections,
      tools,
      exclusions: stableExclusions,
    }),
  };

  return ok(composed);
}

/** Exhaustive role label for diagnostics — never throws on a known role. */
export function promptSectionRoleLabel(role: PromptSectionRole): string {
  switch (role) {
    case "product-invariant":
      return "product-invariant";
    case "user-instruction":
      return "user-instruction";
    case "project-instruction":
      return "project-instruction";
    case "skill-workflow":
      return "skill-workflow";
    case "task":
      return "task";
    case "conversation":
      return "conversation";
    case "memory":
      return "memory";
    case "evidence":
      return "evidence";
    case "brief":
      return "brief";
    default:
      return assertNever(role, "unhandled prompt section role");
  }
}
