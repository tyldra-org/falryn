/**
 * Product composer submission port (#707).
 *
 * Maps a composer snapshot onto the live session/turn producer: ensure a
 * session is ready, start a turn, and return accepted — or fail closed with a
 * precise unavailable reason. Lives in the TUI layer because {@link SubmissionPort}
 * is owned here; the producer itself lives in application.
 *
 * Mid-turn steer policy remains #610–#613. Headless `falryn run` is #708.
 * Live vendor adapters are #709.
 */

import type { SessionTurnTranscriptProducer } from "../../application/session-turn-transcript-producer.ts";
import {
  type ConfigurationGeneration,
  type SessionId,
  type TraceId,
  type TurnId,
  turnId,
  type WorkspaceId,
} from "../../domain/index.ts";
import type { ComposerSnapshot, SubmissionOutcome, SubmissionPort } from "./submission.ts";

export const PRODUCT_SUBMISSION_OWNER = "#707";

export type ProductSubmissionPortOptions = {
  readonly producer: SessionTurnTranscriptProducer;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly traceId: TraceId;
  readonly configurationGeneration: ConfigurationGeneration;
  /** Stable turn ids for tests; defaults to a monotonic counter. */
  readonly nextTurnId?: () => TurnId;
  /**
   * When false, submission fails closed even if a producer exists (for example
   * the process is shutting down). Defaults to true.
   */
  readonly isAccepting?: () => boolean;
};

/**
 * Build a submission port that starts a real turn through the product producer.
 */
export function createProductSubmissionPort(options: ProductSubmissionPortOptions): SubmissionPort {
  let sequence = 0;
  let sessionStarted = false;
  const nextTurnId =
    options.nextTurnId ??
    (() => {
      sequence += 1;
      return turnId.from(`turn-submit-${sequence}`);
    });

  return {
    async submit(snapshot: ComposerSnapshot): Promise<SubmissionOutcome> {
      if (snapshot.text.trim() === "") {
        return unavailable(snapshot, "the composer is empty");
      }
      if (options.isAccepting !== undefined && !options.isAccepting()) {
        return unavailable(snapshot, "the agent is not accepting submissions right now");
      }

      if (!sessionStarted) {
        const started = await options.producer.startSession({
          sessionId: options.sessionId,
          workspaceId: options.workspaceId,
          configurationGeneration: options.configurationGeneration,
        });
        if (!started.ok) {
          return unavailable(snapshot, `session could not start (${started.error.code})`);
        }
        sessionStarted = true;
      }

      const startedTurn = await options.producer.startTurn({
        turnId: nextTurnId(),
        sessionId: options.sessionId,
        workspaceId: options.workspaceId,
        traceId: options.traceId,
        configurationGeneration: options.configurationGeneration,
      });
      if (!startedTurn.ok) {
        return unavailable(snapshot, `turn could not start (${startedTurn.error.code})`);
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
