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

import {
  type AttachmentDescriptor,
  describeAttachments,
  describeBlockingReason,
  describeEnhancement,
  type EnhancementOutcome,
  isBlockingAttachment,
  moveAttachment,
  parseMentions,
  removeAttachment,
  upsertAttachment,
} from "../../domain/index.ts";
import { classifyPaste, describePaste, noticeOfPaste, type PasteNotice } from "../paste.ts";
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
   * A notice, never the clipboard body. The body of a preview paste is held
   * beside this machine — on the payload port — so include does not re-read
   * the clipboard and chrome never sees the bytes.
   */
  readonly lastPaste: PasteNotice | null;
  /** Handles only. Never paste, file, or artifact bytes. */
  readonly attachments: readonly AttachmentDescriptor[];
  /** Monotonic identity source for attachments this session. */
  readonly attachmentSeq: number;
  /** Increments on every draft text change. Enhancement binds this generation. */
  readonly draftRevision: number;
  /** A waiting proposal, or `null`. Never applied until accept. */
  readonly enhancement: ComposerEnhancement | null;
  /** Last enhance outcome that was not a held proposal. */
  readonly lastEnhancement: EnhancementOutcome | null;
};

export type ComposerEnhancement = {
  readonly original: string;
  readonly proposed: string;
  readonly explanation: string;
  readonly draftRevision: number;
  readonly status: "ready" | "stale";
};

export const INITIAL_COMPOSER_STATE: ComposerState = {
  text: "",
  history: EMPTY_HISTORY,
  phase: "editing",
  inFlight: null,
  lastOutcome: null,
  submissions: 0,
  lastPaste: null,
  attachments: [],
  attachmentSeq: 0,
  draftRevision: 0,
  enhancement: null,
  lastEnhancement: null,
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
  /**
   * Takes the snapshot and enters `sending`. Refused when there is nothing to send.
   * `attachments` is the TOCTOU-resolved list from the application seam; omitted
   * in pure reducer tests that already hold ready handles.
   */
  | { readonly kind: "submit"; readonly attachments?: readonly AttachmentDescriptor[] }
  /** The port answered. The draft is kept or cleared according to the outcome. */
  | { readonly kind: "resolve"; readonly outcome: SubmissionOutcome }
  | { readonly kind: "cancel" }
  | { readonly kind: "disable" }
  | { readonly kind: "enable" }
  /** Include a held-out paste as an attachment handle. Bytes stay on the payload port. */
  | { readonly kind: "include-paste"; readonly attachment: AttachmentDescriptor }
  | { readonly kind: "exclude-paste" }
  | { readonly kind: "attach"; readonly attachment: AttachmentDescriptor }
  | { readonly kind: "remove-attachment"; readonly id?: string }
  | {
      readonly kind: "move-attachment";
      readonly id: string;
      readonly direction: "earlier" | "later";
    }
  /** Replace the attachment list after a probe refresh. */
  | { readonly kind: "attachments"; readonly attachments: readonly AttachmentDescriptor[] }
  /** Apply a port outcome. Never submits. */
  | { readonly kind: "enhance"; readonly outcome: EnhancementOutcome }
  | { readonly kind: "accept-enhancement" }
  | { readonly kind: "reject-enhancement" };

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.kind) {
    case "draft": {
      if (action.text === state.text) {
        return state;
      }
      const draftRevision = state.draftRevision + 1;
      // Typing ends a recall. The reader has made the entry theirs, and leaving
      // the phase at `recalling` would keep saying they are browsing history
      // while they write something new.
      return {
        ...state,
        text: action.text,
        draftRevision,
        phase: state.phase === "recalling" ? "editing" : state.phase,
        enhancement: staleEnhancement(state.enhancement, draftRevision),
      };
    }

    case "paste": {
      const classification = classifyPaste(action.text);
      const lastPaste = noticeOfPaste(classification);
      if (classification.verdict !== "inline") {
        // Reported, not inserted. Include is a separate action that records a
        // handle; a refusal is a refusal.
        return { ...state, lastPaste };
      }
      // The text itself is inserted by the view, into the renderable that owns
      // the buffer. What is recorded here is that a paste happened and what it
      // was classified as, which is what the notice reads.
      return {
        ...state,
        phase: state.phase === "recalling" ? "editing" : state.phase,
        lastPaste,
      };
    }

    case "history-previous": {
      const recall = recallPrevious(state.history, state.text);
      if (recall.text === null) {
        return state;
      }
      const draftRevision = state.draftRevision + 1;
      return {
        ...state,
        history: recall.history,
        text: recall.text,
        draftRevision,
        phase: "recalling",
        enhancement: staleEnhancement(state.enhancement, draftRevision),
      };
    }

    case "history-next": {
      const recall = recallNext(state.history);
      if (recall.text === null) {
        return state;
      }
      const draftRevision = state.draftRevision + 1;
      return {
        ...state,
        history: recall.history,
        text: recall.text,
        draftRevision,
        // Walking off the end returns to the draft, which is editing again.
        phase: recall.history.recalled === null ? "editing" : "recalling",
        enhancement: staleEnhancement(state.enhancement, draftRevision),
      };
    }

    case "submit": {
      if (state.phase === "disabled") {
        return state;
      }
      const attachments = action.attachments ?? state.attachments;
      if (state.text.trim() === "" && attachments.length === 0) {
        return state;
      }
      const mentions = parseMentions(state.text);
      const unresolved = mentions.filter((mention) => {
        switch (mention.kind) {
          case "unsupported":
            return true;
          case "file":
            return !attachments.some(
              (item) => item.kind === "file" && item.identity === mention.identity,
            );
          case "paste":
          case "artifact":
          case "transcript":
            return !attachments.some(
              (item) => item.identity === mention.identity || item.id === mention.identity,
            );
          default: {
            const exhaustive: never = mention.kind;
            return exhaustive;
          }
        }
      });
      const sequence = state.submissions + 1;
      const snapshot = snapshotOf(state.text, sequence, attachments, mentions);
      if (unresolved.length > 0 || attachments.some(isBlockingAttachment)) {
        const reason =
          unresolved[0]?.kind === "unsupported"
            ? `${unresolved[0].identity} is unsupported`
            : unresolved.length > 0
              ? `${unresolved[0]?.identity ?? "a mention"} is unresolved`
              : describeBlockingReason(attachments);
        return {
          ...state,
          attachments,
          lastOutcome: {
            kind: "unavailable",
            snapshot,
            reason,
            owner: "#278",
            route: "composer.removeAttachment",
          },
        };
      }
      return {
        ...state,
        attachments,
        inFlight: snapshot,
        submissions: sequence,
        phase: "sending",
        enhancement: null,
        lastEnhancement: null,
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
        attachments: accepted ? [] : state.attachments,
        enhancement: accepted ? null : state.enhancement,
        lastEnhancement: accepted ? null : state.lastEnhancement,
        draftRevision: accepted ? state.draftRevision + 1 : state.draftRevision,
      };
    }

    case "cancel":
      return state.inFlight === null ? state : { ...state, inFlight: null, phase: "cancelled" };

    case "disable":
      return state.phase === "disabled" ? state : { ...state, phase: "disabled" };

    case "enable":
      return state.phase === "disabled" ? { ...state, phase: "editing" } : state;

    case "include-paste": {
      const seq = state.attachmentSeq + 1;
      const attachment = { ...action.attachment, id: action.attachment.id || `att-${seq}` };
      return {
        ...state,
        lastPaste: null,
        lastOutcome: null,
        attachments: upsertAttachment(state.attachments, attachment),
        attachmentSeq: seq,
      };
    }

    case "exclude-paste":
      return state.lastPaste === null ? state : { ...state, lastPaste: null };

    case "attach": {
      const seq = state.attachmentSeq + 1;
      const attachment = {
        ...action.attachment,
        id: action.attachment.id.length > 0 ? action.attachment.id : `att-${seq}`,
      };
      return {
        ...state,
        attachments: upsertAttachment(state.attachments, attachment),
        attachmentSeq: seq,
      };
    }

    case "remove-attachment": {
      if (state.attachments.length === 0) {
        return state;
      }
      const id = action.id ?? state.attachments[state.attachments.length - 1]?.id;
      if (id === undefined) {
        return state;
      }
      const attachments = removeAttachment(state.attachments, id);
      return attachments === state.attachments ? state : { ...state, attachments };
    }

    case "move-attachment": {
      const attachments = moveAttachment(state.attachments, action.id, action.direction);
      return attachments === state.attachments ? state : { ...state, attachments };
    }

    case "attachments":
      return { ...state, attachments: action.attachments };

    case "enhance":
      return applyEnhancementOutcome(state, action.outcome);

    case "accept-enhancement": {
      const held = state.enhancement;
      if (held === null) {
        return state;
      }
      if (held.status !== "ready" || held.draftRevision !== state.draftRevision) {
        return {
          ...state,
          enhancement: held.status === "stale" ? held : { ...held, status: "stale" },
          lastEnhancement: {
            kind: "stale",
            revision: state.draftRevision,
          },
        };
      }
      const draftRevision = state.draftRevision + 1;
      return {
        ...state,
        text: held.proposed,
        draftRevision,
        enhancement: null,
        lastEnhancement: null,
        lastOutcome: null,
        lastPaste: null,
      };
    }

    case "reject-enhancement":
      return state.enhancement === null && state.lastEnhancement === null
        ? state
        : { ...state, enhancement: null, lastEnhancement: null };

    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
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
  if (state.enhancement !== null) {
    return describeEnhancement(
      state.enhancement.status === "stale"
        ? { kind: "stale", revision: state.enhancement.draftRevision }
        : {
            kind: "proposal",
            original: state.enhancement.original,
            proposed: state.enhancement.proposed,
            explanation: state.enhancement.explanation,
            revision: state.enhancement.draftRevision,
          },
    );
  }
  if (state.lastEnhancement !== null) {
    return describeEnhancement(state.lastEnhancement);
  }
  if (state.attachments.length > 0) {
    return describeAttachments(state.attachments);
  }
  return null;
}

function staleEnhancement(
  enhancement: ComposerEnhancement | null,
  draftRevision: number,
): ComposerEnhancement | null {
  if (enhancement === null || enhancement.draftRevision === draftRevision) {
    return enhancement;
  }
  return { ...enhancement, status: "stale" };
}

function applyEnhancementOutcome(state: ComposerState, outcome: EnhancementOutcome): ComposerState {
  switch (outcome.kind) {
    case "proposal":
      if (outcome.revision !== state.draftRevision) {
        return {
          ...state,
          lastOutcome: null,
          lastEnhancement: { kind: "stale", revision: state.draftRevision },
          enhancement: null,
        };
      }
      return {
        ...state,
        lastOutcome: null,
        lastEnhancement: null,
        enhancement: {
          original: outcome.original,
          proposed: outcome.proposed,
          explanation: outcome.explanation,
          draftRevision: outcome.revision,
          status: "ready",
        },
      };
    case "unchanged":
    case "empty":
    case "unavailable":
    case "cancelled":
    case "stale":
      return {
        ...state,
        lastOutcome: null,
        enhancement: null,
        lastEnhancement: outcome,
      };
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
