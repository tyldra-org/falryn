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
  type BriefVerbosityMode,
  type ConfigurationGeneration,
  DEFAULT_BRIEF_NEED,
  err,
  isBriefVerbosityMode,
  ok,
  type Result,
  type SessionId,
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
  projectForTurn(input: {
    readonly turnId: TurnId;
    readonly sessionId: SessionId;
    readonly configurationGeneration: ConfigurationGeneration;
    readonly need?: BriefNeed;
  }): BriefComposerResult;
};

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
    projectForTurn(input) {
      const policy: BriefPolicy = {
        verbosity,
        source: "user",
      };
      return composer.projectForTurn(input.turnId, {
        turnId: input.turnId,
        sessionId: input.sessionId,
        configurationGeneration: input.configurationGeneration,
        need: input.need ?? DEFAULT_BRIEF_NEED,
        policy,
      });
    },
  };
}

export function describeBriefVerbosityModes(): string {
  return BRIEF_VERBOSITY_MODES.join("|");
}
