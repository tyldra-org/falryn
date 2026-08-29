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
