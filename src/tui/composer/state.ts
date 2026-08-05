/**
 * The composer as one state machine.
 *
 * The editor holds text, the history holds what was sent, and the port decides
 * what a submission resolves to. This is the piece that makes them one thing: it
 * owns the phase, routes a paste through the classification `../paste.ts`
 * already performs, and guarantees the two properties a composer is judged on.
 *
 * **A submission takes an immutable snapshot.** Taken in the same transition
 * that moves the phase to `sending`, from the text as it is at that instant, so
 * there is no window in which a keystroke can reach it. Later edits are the next
 * submission's problem, which is what makes typing while something is in flight
 * safe rather than a race.
 *
 * **The draft survives everything.** A failed submission does not clear the
 * composer. Neither does an overlay, a resize, or a renderer that paused and
 * resumed — those preserve the draft by construction rather than by bookkeeping,
 * because this state lives above the components that draw it and none of them
 * can reach it. That is the same argument the transcript surface's reader state
 * makes, and it holds for the same reason.
 *
 * Pure. No renderer, no clock, no storage.
 */

import { classifyPaste, describePaste, type PasteClassification } from "../paste.ts";
import {
  EMPTY_HISTORY,
  type InputHistory,
  recallNext,
  recallPrevious,
  remember,
} from "./history.ts";
import { type ComposerSnapshot, type SubmissionOutcome, snapshotOf } from "./submission.ts";

/**
 * What the composer is doing, as one closed union.
 *
 * All six are declared because a view that could not render a phase would have
 * to invent one the day it became reachable. Three are driven in this build —
 * `editing`, `recalling`, and the `sending` a submission passes through.
 * `queued` and `cancelled` need something that can accept a turn and hold it,
 * which is [#33](https://github.com/yogeshprasad098/falryn/issues/33); `disabled`
 * is set by the caller when the composer has no business accepting input.
 * Declaring the unreachable ones is the same choice the command registry makes
 * about an unavailable command: naming the gap beats pretending it is not there.
 */
export const COMPOSER_PHASES = [
  "editing",
  "recalling",
  "sending",
  "queued",
  "cancelled",
  "disabled",
] as const;

export type ComposerPhase = (typeof COMPOSER_PHASES)[number];

export type ComposerState = {
  /**
   * The draft, as text.
   *
   * A string rather than an editing model since #399: the composer is
   * `TextareaRenderable`, which owns the buffer, the cursor, the selection, and
   * every motion over them. What this machine still needs is the *content* — to
   * snapshot on submission, to remember in history, and to answer whether there
   * is anything to send. Holding a second cursor beside the renderable's is
   * exactly the arrangement that put the cursor in the wrong cell.
   */
  readonly text: string;
  readonly history: InputHistory;
  readonly phase: ComposerPhase;
  /** The submission awaiting an outcome, or `null`. Frozen when it was taken. */
  readonly inFlight: ComposerSnapshot | null;
  /** What the last submission resolved to. Kept so the frame can say. */
  readonly lastOutcome: SubmissionOutcome | null;
  /** Submissions taken this session. The snapshot's identity comes from this. */
  readonly submissions: number;
  /**
   * The last paste that was not inlined, or `null`.
   *
   * Held so the notice can describe it. The content is deliberately not held:
   * including a large paste is a decision this build does not offer, and keeping
   * megabytes against a decision nobody can make would be memory spent on a
   * capability that does not exist. See `./features.ts`.
   */
  readonly lastPaste: PasteClassification | null;
};

export const INITIAL_COMPOSER_STATE: ComposerState = {
  text: "",
  history: EMPTY_HISTORY,
  phase: "editing",
  inFlight: null,
  lastOutcome: null,
  submissions: 0,
  lastPaste: null,
};

export type ComposerAction =
  /**
   * The draft changed, as the renderable reports it.
   *
   * Typing, deleting, motions, and selection are the textarea's and never
   * arrive here. This is the content afterwards, which is all this machine has
   * ever needed.
   */
  | { readonly kind: "draft"; readonly text: string }
  /** Raw pasted text, before classification. Never inserted without one. */
  | { readonly kind: "paste"; readonly text: string }
  | { readonly kind: "history-previous" }
  | { readonly kind: "history-next" }
  /** Takes the snapshot and enters `sending`. Refused when there is nothing to send. */
  | { readonly kind: "submit" }
  /** The port answered. The draft is kept or cleared according to the outcome. */
  | { readonly kind: "resolve"; readonly outcome: SubmissionOutcome }
  | { readonly kind: "cancel" }
  | { readonly kind: "disable" }
  | { readonly kind: "enable" };

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.kind) {
    case "draft": {
      if (action.text === state.text) {
        return state;
      }
      // Typing ends a recall. The reader has made the entry theirs, and leaving
      // the phase at `recalling` would keep saying they are browsing history
      // while they write something new.
      return {
        ...state,
        text: action.text,
        phase: state.phase === "recalling" ? "editing" : state.phase,
      };
    }

    case "paste": {
      const classification = classifyPaste(action.text);
      if (classification.verdict !== "inline") {
        // Reported, not inserted. A preview needs a decision this build does not
        // offer, and a refusal is a refusal — quietly inserting either would be
        // the flood the classification exists to prevent.
        return { ...state, lastPaste: classification };
      }
      // The text itself is inserted by the view, into the renderable that owns
      // the buffer. What is recorded here is that a paste happened and what it
      // was classified as, which is what the notice reads.
      return {
        ...state,
        phase: state.phase === "recalling" ? "editing" : state.phase,
        lastPaste: classification,
      };
    }

    case "history-previous": {
      const recall = recallPrevious(state.history, state.text);
      if (recall.text === null) {
        return state;
      }
      return {
        ...state,
        history: recall.history,
        text: recall.text,
        phase: "recalling",
      };
    }

    case "history-next": {
      const recall = recallNext(state.history);
      if (recall.text === null) {
        return state;
      }
      return {
        ...state,
        history: recall.history,
        text: recall.text,
        // Walking off the end returns to the draft, which is editing again.
        phase: recall.history.recalled === null ? "editing" : "recalling",
      };
    }

    case "submit": {
      if (state.phase === "disabled" || state.text.trim() === "") {
        return state;
      }
      const sequence = state.submissions + 1;
      return {
        ...state,
        // Frozen here, from the text as it is now. Nothing after this transition
        // can reach it.
        inFlight: snapshotOf(state.text, sequence),
        submissions: sequence,
        phase: "sending",
      };
    }

    case "resolve": {
      if (state.inFlight === null) {
        return state;
      }
      const accepted = action.outcome.kind === "accepted";
      return {
        ...state,
        inFlight: null,
        lastOutcome: action.outcome,
        phase: "editing",
        // Remembered only when something took it. A prompt nothing could answer
        // is still in the composer, so putting it in history too would offer the
        // reader a recall of the text they are already looking at.
        history: accepted ? remember(state.history, action.outcome.snapshot.text) : state.history,
        // The draft is cleared only on acceptance. This is the acceptance
        // criterion: a submission that resolved `unavailable` leaves the text
        // exactly where the user left it.
        text: accepted ? "" : state.text,
      };
    }

    case "cancel":
      return state.inFlight === null ? state : { ...state, inFlight: null, phase: "cancelled" };

    case "disable":
      return state.phase === "disabled" ? state : { ...state, phase: "disabled" };

    case "enable":
      return state.phase === "disabled" ? { ...state, phase: "editing" } : state;
  }
}

/**
 * One sentence about the last thing that happened to the composer, or `null`.
 *
 * The paste outcome outranks the submission outcome, because it is the more
 * recent event whenever there is one to report and because a refused paste is
 * the thing a user is most likely to be waiting to hear about.
 */
export function composerNotice(state: ComposerState): string | null {
  if (state.lastPaste !== null && state.lastPaste.verdict !== "inline") {
    return describePaste(state.lastPaste);
  }
  return null;
}
