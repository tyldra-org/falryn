/**
 * Product Brief controls (#717).
 *
 * Holds the user/session verbosity preference and projects it through
 * {@link createBriefComposer} into a prompt `brief` section for live turns.
 * Does not choose evidence or call providers.
 */

import {
  BRIEF_VERBOSITY_MODES,
  type BriefNeed,
  type BriefPolicy,
  type BriefRequest,
  type BriefVerbosityMode,
  type ConfigurationGeneration,
  err,
  isBriefVerbosityMode,
  ok,
  type Result,
  type SessionId,
  type ToolInvocationRecord,
  type TurnId,
} from "../domain/index.ts";
import { type BriefComposer, type BriefComposerResult, createBriefComposer } from "./brief.ts";

export const PRODUCT_BRIEF_OWNER = "#717";

export const PRODUCT_BRIEF_MODES = [...BRIEF_VERBOSITY_MODES, "raw"] as const;
export type ProductBriefMode = (typeof PRODUCT_BRIEF_MODES)[number];

export const PRODUCT_BRIEF_FRONTEND_MODES = [...BRIEF_VERBOSITY_MODES, "on", "off"] as const;
export type ProductBriefFrontendMode = (typeof PRODUCT_BRIEF_FRONTEND_MODES)[number];

export type ProductBriefModeError = {
  readonly code: "unsupported-verbosity";
  readonly value: string;
};

export type ProductBriefControls = {
  readonly owner: typeof PRODUCT_BRIEF_OWNER;
  /** Backend mode. `raw` means Brief contributes no prompt or budget policy. */
  getVerbosity(): ProductBriefMode;
  /** Human-facing state. The backend-only `raw` mode is reported as `off`. */
  getFrontendMode(): ProductBriefFrontendMode;
  setVerbosity(mode: ProductBriefMode | string): Result<ProductBriefMode, ProductBriefModeError>;
  setFrontendMode(
    mode: ProductBriefFrontendMode | string,
  ): Result<ProductBriefFrontendMode, ProductBriefModeError>;
  requestForTurn(input: ProductBriefTurnInput): BriefRequest | null;
  projectForTurn(input: ProductBriefTurnInput): BriefComposerResult | null;
};

export type ProductBriefTurnInput = {
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly prompt?: string;
  readonly interface?: BriefNeed["interface"];
  readonly need?: BriefNeed;
};

export type ProductBriefContextState = {
  readonly status:
    | "current"
    | "ready"
    | "empty"
    | "degraded"
    | "unavailable"
    | "cancelled"
    | "static";
  readonly candidateCount: number;
};

const COMPLEX_TASK =
  /\b(?:analy[sz]e|architect|audit|compare|debug|design|diagnose|explain|implement|integrate|investigate|migrate|optimi[sz]e|plan|refactor|review|secure)\b/gi;
const RISKY_TASK =
  /\b(?:delete|remove|overwrite|reset|deploy|publish|release|credential|secret|production)\b/i;
const VALIDATION_TASK = /\b(?:test|verify|check|lint|typecheck|diagnostic|benchmark|build)\b/i;
const CITATION_TASK = /\b(?:cite|cited|citation|citations|source|reference|link)\b|https?:\/\//i;
const VALIDATION_TOOL = /(?:test|lint|check|diagnostic|typecheck|build|benchmark)/i;
const FAILURE_TASK = /\b(?:failed|failure|errored|timed out|cancelled|denied|unavailable)\b/i;
const UNCERTAINTY_TASK =
  /\b(?:uncertain|uncertainty|unverified|unknown|not (?:confirmed|verified))\b/i;
const CONFIRMATION_TASK =
  /\b(?:requires?|needs?) (?:user )?(?:approval|authorization|confirmation|permission)\b|\b(?:approve|authorize|confirm) before\b/i;
const REQUIRED_ACTION_TASK = /\b(?:next|required) action\b|\brequired fix\b/i;
const RECOVERY_TASK =
  /\b(?:recover|recovery|restore|rollback|roll back|revert|undo)\b|\bartifact-[A-Za-z0-9_-]+\b/i;
const SAFETY_CRITICAL_TASK =
  /\b(?:cannot be undone|irreversible|permanent(?:ly)?|production|credential|secret|private key|delete all|drop (?:table|database)|reset --hard|force[- ]push)\b/i;
const CLARIFICATION_TASK =
  /\b(?:clarify|explain again|rephrase|what do you mean|do not understand|don't understand|confused|ambiguous|unclear)\b/i;
const ORDERED_PROCEDURE_TASK =
  /\b(?:step[- ]by[- ]step|in (?:this|that|the following) order|before (?:you|we|running|executing)|prerequisite|first\b[\s\S]{0,160}\bthen)\b/i;
const LIST_ITEM = /^\s*(?:[-*+] |\d+[.)] )/gm;
const FILE_REFERENCE = /(?:^|\s)(?:\.?\.?\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+(?=\s|$|[,:;)])/gm;

function matchCount(pattern: RegExp, text: string): number {
  return [...text.matchAll(pattern)].length;
}

/** Classify prompt shape without treating one technical keyword as a large task. */
export function classifyProductBriefComplexity(prompt: string): BriefNeed["complexity"] {
  const text = prompt.trim();
  if (text.length === 0) return "low";

  const nonEmptyLines = text.split("\n").filter((line) => line.trim().length > 0).length;
  const operationCount = new Set(
    [...text.matchAll(COMPLEX_TASK)].map((match) => match[0]?.toLowerCase()).filter(Boolean),
  ).size;
  const listItemCount = matchCount(LIST_ITEM, text);
  const fileReferenceCount = matchCount(FILE_REFERENCE, text);
  const questionCount = matchCount(/\?/g, text);
  const containsCodeBlock = text.includes("```");

  const high =
    text.length > 1_200 ||
    nonEmptyLines > 12 ||
    listItemCount >= 4 ||
    operationCount >= 2 ||
    questionCount >= 4 ||
    (fileReferenceCount >= 3 && operationCount > 0);
  if (high) return "high";

  const medium =
    text.length > 400 ||
    nonEmptyLines > 4 ||
    listItemCount >= 2 ||
    operationCount > 0 ||
    questionCount >= 2 ||
    containsCodeBlock ||
    fileReferenceCount >= 2;
  return medium ? "medium" : "low";
}

/** Derive only response-preservation needs; this never adds task evidence. */
export function deriveProductBriefNeed(input: {
  readonly prompt: string;
  readonly interface: BriefNeed["interface"];
  readonly context?: ProductBriefContextState;
}): BriefNeed {
  const prompt = input.prompt.trim();
  const contextUnavailable =
    input.context?.status === "degraded" || input.context?.status === "unavailable";
  return {
    complexity: classifyProductBriefComplexity(prompt),
    interface: input.interface,
    failures: FAILURE_TASK.test(prompt),
    risk: RISKY_TASK.test(prompt),
    uncertainty: contextUnavailable || UNCERTAINTY_TASK.test(prompt),
    confirmation: CONFIRMATION_TASK.test(prompt),
    requiredAction: REQUIRED_ACTION_TASK.test(prompt),
    citations: CITATION_TASK.test(prompt) || (input.context?.candidateCount ?? 0) > 0,
    validation: VALIDATION_TASK.test(prompt),
    recovery: contextUnavailable || RECOVERY_TASK.test(prompt),
    safetyCritical: SAFETY_CRITICAL_TASK.test(prompt),
    clarification: CLARIFICATION_TASK.test(prompt),
    orderedProcedure: ORDERED_PROCEDURE_TASK.test(prompt) || matchCount(LIST_ITEM, prompt) >= 2,
  };
}

/** Fold live tool terminal facts into the next response-density request. */
export function briefNeedAfterToolResults(
  need: BriefNeed,
  records: readonly ToolInvocationRecord[],
): BriefNeed {
  if (records.length === 0) {
    return need;
  }
  let failures = need.failures;
  let risk = need.risk;
  let uncertainty = need.uncertainty;
  let confirmation = need.confirmation;
  let requiredAction = need.requiredAction;
  let validation = need.validation;
  let recovery = need.recovery;
  for (const record of records) {
    const status = record.outcome.status;
    failures ||= status !== "completed";
    risk ||= record.effectClass !== null && record.effectClass !== "observation";
    uncertainty ||= status === "uncertain" || status === "partial" || status === "timed-out";
    confirmation ||= status === "denied";
    requiredAction ||= status === "denied" || status === "unavailable";
    validation ||= VALIDATION_TOOL.test(record.toolName);
    recovery ||=
      status === "uncertain" ||
      status === "partial" ||
      status === "timed-out" ||
      status === "unavailable";
  }
  return {
    ...need,
    complexity: uncertainty || recovery ? "high" : need.complexity,
    failures,
    risk,
    uncertainty,
    confirmation,
    requiredAction,
    validation,
    recovery,
  };
}

/** Add retrieval provenance and degraded-state obligations before inference. */
export function briefNeedAfterContext(
  need: BriefNeed,
  context: ProductBriefContextState,
): BriefNeed {
  const degraded = context.status === "degraded" || context.status === "unavailable";
  return {
    ...need,
    complexity: degraded ? "high" : need.complexity,
    uncertainty: need.uncertainty || degraded,
    citations: need.citations || context.candidateCount > 0,
    recovery: need.recovery || degraded,
  };
}

export type ProductBriefControlsOptions = {
  readonly initialVerbosity?: ProductBriefMode;
  readonly composer?: BriefComposer;
};

export function isProductBriefMode(value: string): value is ProductBriefMode {
  return value === "raw" || isBriefVerbosityMode(value);
}

export function isProductBriefFrontendMode(value: string): value is ProductBriefFrontendMode {
  return value === "on" || value === "off" || isBriefVerbosityMode(value);
}

/** Convert a human control into the backend mode used for a stateless turn. */
export function productBriefModeFromFrontend(mode: ProductBriefFrontendMode): ProductBriefMode {
  if (mode === "off") return "raw";
  if (mode === "on") return "auto";
  return mode;
}

/**
 * Compose product Brief controls for CLI/TUI/live prompt composition.
 */
export function composeProductBriefControls(
  options: ProductBriefControlsOptions = {},
): ProductBriefControls {
  const composer = options.composer ?? createBriefComposer();
  let verbosity: ProductBriefMode = options.initialVerbosity ?? "balanced";
  let lastEnabledVerbosity: BriefVerbosityMode = verbosity === "raw" ? "balanced" : verbosity;
  const requestForTurn = (input: ProductBriefTurnInput): BriefRequest | null => {
    if (verbosity === "raw") return null;
    const policy: BriefPolicy = {
      verbosity,
      source: "user",
    };
    return {
      turnId: input.turnId,
      sessionId: input.sessionId,
      configurationGeneration: input.configurationGeneration,
      need:
        input.need ??
        deriveProductBriefNeed({
          prompt: input.prompt ?? "",
          interface: input.interface ?? "interactive",
        }),
      policy,
    };
  };

  return {
    owner: PRODUCT_BRIEF_OWNER,
    getVerbosity() {
      return verbosity;
    },
    getFrontendMode() {
      return verbosity === "raw" ? "off" : verbosity;
    },
    setVerbosity(mode) {
      if (!isProductBriefMode(mode)) {
        return err({ code: "unsupported-verbosity", value: String(mode) });
      }
      verbosity = mode;
      if (mode !== "raw") lastEnabledVerbosity = mode;
      return ok(mode);
    },
    setFrontendMode(mode) {
      if (!isProductBriefFrontendMode(mode)) {
        return err({ code: "unsupported-verbosity", value: String(mode) });
      }
      if (mode === "off") {
        verbosity = "raw";
        return ok("off");
      }
      if (mode === "on") {
        verbosity = lastEnabledVerbosity;
        return ok("on");
      }
      verbosity = mode;
      lastEnabledVerbosity = mode;
      return ok(mode);
    },
    requestForTurn,
    projectForTurn(input) {
      const request = requestForTurn(input);
      return request === null ? null : composer.projectForTurn(input.turnId, request);
    },
  };
}

export function describeBriefVerbosityModes(): string {
  return PRODUCT_BRIEF_FRONTEND_MODES.join("|");
}
