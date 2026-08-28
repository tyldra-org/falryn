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

export type ProductBriefControls = {
  readonly owner: typeof PRODUCT_BRIEF_OWNER;
  getVerbosity(): BriefVerbosityMode;
  setVerbosity(
    mode: BriefVerbosityMode | string,
  ): Result<BriefVerbosityMode, { readonly code: "unsupported-verbosity"; readonly value: string }>;
  requestForTurn(input: ProductBriefTurnInput): BriefRequest;
  projectForTurn(input: ProductBriefTurnInput): BriefComposerResult;
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
  /\b(?:implement|refactor|debug|audit|investigate|migrate|design|architecture|security|performance|compare)\b/i;
const RISKY_TASK =
  /\b(?:delete|remove|overwrite|reset|deploy|publish|release|credential|secret|production)\b/i;
const VALIDATION_TASK = /\b(?:test|verify|check|lint|typecheck|diagnostic|benchmark|build)\b/i;
const CITATION_TASK = /\b(?:cite|cited|citation|citations|source|reference|link)\b|https?:\/\//i;
const VALIDATION_TOOL = /(?:test|lint|check|diagnostic|typecheck|build|benchmark)/i;

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
    complexity:
      prompt.length > 1_200 || prompt.split("\n").length > 12 || COMPLEX_TASK.test(prompt)
        ? "high"
        : "low",
    interface: input.interface,
    failures: false,
    risk: RISKY_TASK.test(prompt),
    uncertainty: contextUnavailable,
    confirmation: false,
    requiredAction: false,
    citations: CITATION_TASK.test(prompt) || (input.context?.candidateCount ?? 0) > 0,
    validation: VALIDATION_TASK.test(prompt),
    recovery: contextUnavailable,
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
    complexity: failures || uncertainty || recovery ? "high" : need.complexity,
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
  readonly initialVerbosity?: BriefVerbosityMode;
  readonly composer?: BriefComposer;
};

/**
 * Compose product Brief controls for CLI/TUI/live prompt composition.
 */
export function composeProductBriefControls(
  options: ProductBriefControlsOptions = {},
): ProductBriefControls {
  const composer = options.composer ?? createBriefComposer();
  let verbosity: BriefVerbosityMode = options.initialVerbosity ?? "balanced";
  const requestForTurn = (input: ProductBriefTurnInput): BriefRequest => {
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
    setVerbosity(mode) {
      if (!isBriefVerbosityMode(mode)) {
        return err({ code: "unsupported-verbosity", value: String(mode) });
      }
      verbosity = mode;
      return ok(mode);
    },
    requestForTurn,
    projectForTurn(input) {
      return composer.projectForTurn(input.turnId, requestForTurn(input));
    },
  };
}

export function describeBriefVerbosityModes(): string {
  return BRIEF_VERBOSITY_MODES.join("|");
}
