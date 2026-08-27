/**
 * Product composer submission port (#707 / #715 / #717).
 *
 * Maps a composer snapshot onto the application-owned live-turn executor.
 * Accepted means the provider turn reached a durable terminal result; a
 * producer-only turn is never reported as accepted.
 */

import {
  composeProductBriefControls,
  type ProductBriefControls,
  type ProductExecutionProfileControls,
  type ProductLiveTurnExecutor,
} from "../../application/index.ts";
import {
  type ConfigurationGeneration,
  type SessionId,
  type TurnId,
  turnId,
} from "../../domain/index.ts";
import type { ComposerSnapshot, SubmissionOutcome, SubmissionPort } from "./submission.ts";

export const PRODUCT_SUBMISSION_OWNER = "#707";

export type ProductSubmissionPortOptions = {
  readonly executor: ProductLiveTurnExecutor;
  readonly sessionId: SessionId;
  readonly configurationGeneration: ConfigurationGeneration;
  /** Stable turn ids for tests; defaults to a monotonic counter. */
  readonly nextTurnId?: () => TurnId;
  /**
   * When false, submission fails closed even if a producer exists (for example
   * the process is shutting down). Defaults to true.
   */
  readonly isAccepting?: () => boolean;
  /** Shared Brief controls for TUI/session (#717). */
  readonly brief?: ProductBriefControls;
};

export type ProductSubmissionPort = SubmissionPort & {
  readonly brief: ProductBriefControls;
  readonly executionProfile: ProductExecutionProfileControls;
};

/**
 * Build a submission port that executes a complete durable model turn.
 */
export function createProductSubmissionPort(
  options: ProductSubmissionPortOptions,
): ProductSubmissionPort {
  let sequence = 0;
  const nextTurnId =
    options.nextTurnId ??
    (() => {
      sequence += 1;
      return turnId.from(`turn-submit:${String(options.sessionId)}:${sequence}`);
    });
  const brief = options.brief ?? composeProductBriefControls();
  const executionProfile = options.executor.executionProfile ?? {
    get: () => "agent" as const,
    async select() {
      return {
        ok: false as const,
        code: "execution-profile.unavailable",
        message: "execution profile controls are not attached",
      };
    },
  };

  return {
    brief,
    executionProfile,
    async submit(snapshot: ComposerSnapshot): Promise<SubmissionOutcome> {
      if (snapshot.text.trim() === "") {
        return unavailable(snapshot, "the composer is empty");
      }
      if (options.isAccepting !== undefined && !options.isAccepting()) {
        return unavailable(snapshot, "the agent is not accepting submissions right now");
      }

      const id = nextTurnId();
      const briefed = brief.projectForTurn({
        turnId: id,
        sessionId: options.sessionId,
        configurationGeneration: options.configurationGeneration,
      });
      const started = await options.executor.run({
        prompt: snapshot.text,
        turnId: id,
        otherSections: briefed.ok ? [briefed.value.section] : [],
      });
      if (started.kind !== "completed") {
        return unavailable(snapshot, `${started.message} (${started.code})`);
      }

      return { kind: "accepted", snapshot };
    },
  };
}

function unavailable(snapshot: ComposerSnapshot, reason: string): SubmissionOutcome {
  return {
    kind: "unavailable",
    snapshot,
    reason: `${reason} (${PRODUCT_SUBMISSION_OWNER})`,
    owner: PRODUCT_SUBMISSION_OWNER,
    route: "app.commandPalette",
  };
}
