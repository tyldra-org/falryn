/**
 * Product composer submission port (#707 / #715 / #717).
 *
 * Maps a composer snapshot onto the live session/turn producer: ensure a
 * session is ready, compose a Brief + planner-backed prompt, start a turn,
 * and return accepted — or fail closed with a precise unavailable reason.
 */

import {
  CONTEXT_PLANNER_OWNER,
  composeProductBriefControls,
  createContextPlanner,
  type ProductBriefControls,
} from "../../application/index.ts";
import type { SessionTurnTranscriptProducer } from "../../application/session-turn-transcript-producer.ts";
import {
  type ConfigurationGeneration,
  type EvidenceCandidate,
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
  /** Shared Brief controls for TUI/session (#717). */
  readonly brief?: ProductBriefControls;
  /** Current exact/recoverable evidence produced by product tools (#814). */
  readonly contextCandidates?: () => readonly EvidenceCandidate[];
};

export type ProductSubmissionPort = SubmissionPort & {
  readonly brief: ProductBriefControls;
};

/**
 * Build a submission port that starts a real turn through the product producer.
 */
export function createProductSubmissionPort(
  options: ProductSubmissionPortOptions,
): ProductSubmissionPort {
  let sequence = 0;
  let sessionStarted = false;
  const nextTurnId =
    options.nextTurnId ??
    (() => {
      sequence += 1;
      return turnId.from(`turn-submit-${sequence}`);
    });
  const planner = createContextPlanner();
  const brief = options.brief ?? composeProductBriefControls();

  return {
    brief,
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

      const id = nextTurnId();
      const briefed = brief.projectForTurn({
        turnId: id,
        sessionId: options.sessionId,
        configurationGeneration: options.configurationGeneration,
      });
      const planned = planner.composeTurn({
        turnId: id,
        sessionId: options.sessionId,
        workspaceId: options.workspaceId,
        configurationGeneration: options.configurationGeneration,
        task: snapshot.text,
        candidates: options.contextCandidates?.() ?? [],
        otherSections: briefed.ok ? [briefed.value.section] : [],
      });
      if (!planned.ok) {
        return unavailable(
          snapshot,
          `context planner could not compose (${"code" in planned.error ? planned.error.code : "failed"}; ${CONTEXT_PLANNER_OWNER})`,
        );
      }

      const startedTurn = await options.producer.startTurn({
        turnId: id,
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
