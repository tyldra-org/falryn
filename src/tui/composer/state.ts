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
  type ComposerToken,
  type ComposerTokenPick,
  detectMentionTrigger,
  insertTokenText,
  type MentionTrigger,
  reconcileTokens,
  restoreTokenPlaceholders,
  type TokenRange,
  tokenLimitReason,
} from "../../domain/context/composer-mentions.ts";
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
} from "../../domain/context/index.ts";
import {
  EMPTY_HISTORY,
  type InputHistory,
  recallNext,
  recallPrevious,
  remember,
} from "./history.ts";
import { classifyPaste, describePaste, noticeOfPaste, type PasteNotice } from "./paste.ts";
import { type ComposerSnapshot, type SubmissionOutcome, snapshotOf } from "./submission.ts";
import type { ComposerSuggestions, SuggestionPage } from "./suggestions.ts";

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
  /** Picked mentions in the draft, in text order (#1206). */
  readonly tokens: readonly ComposerToken[];
  /** Monotonic identity source for tokens this session. */
  readonly tokenSeq: number;
  /** The cursor as a UTF-16 offset into `text`, as the view last reported it. */
  readonly cursor: number;
  /**
   * Where the view places the cursor after this machine replaced the text, or
   * `null` for the end. Consumed by the view; carries no other meaning.
   */
  readonly caret: number | null;
  /** Triggers with a registered source; others are ordinary characters. */
  readonly mentionTriggers: ReadonlySet<MentionTrigger>;
  readonly suggestions: ComposerSuggestions | null;
  /** Last request number handed out, so every query is identifiable. */
  readonly suggestionRequest: number;
  /** Start of a trigger the reader dismissed; it stays closed until they move on. */
  readonly dismissed: number | null;
  /** One sentence about the last thing that happened to a mention, or `null`. */
  readonly tokenNotice: string | null;
};

export type ComposerEnhancement = {
  readonly original: string;
  readonly proposed: string;
  /** The draft's tokens, rebound into the proposal. */
  readonly tokens: readonly ComposerToken[];
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
  tokens: [],
  tokenSeq: 0,
  cursor: 0,
  caret: null,
  mentionTriggers: new Set(),
  suggestions: null,
  suggestionRequest: 0,
  dismissed: null,
  tokenNotice: null,
};

export type ComposerAction =
  /**
   * The draft changed, as the renderable reports it.
   *
   * Typing, deleting, motions, and selection are the textarea's and never
   * arrive here. This is the content afterwards, which is all this machine has
   * ever needed.
   */
  | {
      readonly kind: "draft";
      readonly text: string;
      /** The cursor after the change, as a UTF-16 offset; the end when omitted. */
      readonly cursor?: number;
      /** Where each token now sits, as the editor tracked it; by label when omitted. */
      readonly tokens?: ReadonlyMap<string, TokenRange>;
    }
  /** The cursor moved without the text changing. */
  | { readonly kind: "cursor"; readonly cursor: number }
  /** Which triggers have a source in this session. */
  | { readonly kind: "mention-triggers"; readonly triggers: ReadonlySet<MentionTrigger> }
  /** A source answered; ignored unless `request` is the open one. */
  | { readonly kind: "suggestion-results"; readonly request: number; readonly page: SuggestionPage }
  | { readonly kind: "suggestion-failed"; readonly request: number; readonly reason: string }
  | { readonly kind: "suggestion-move"; readonly delta: number }
  /** Insert the selected row as a token, or say why it cannot be. */
  | { readonly kind: "suggestion-accept" }
  | { readonly kind: "suggestion-dismiss" }
  /** Reopen the list for a plain trigger word before the cursor. */
  | { readonly kind: "suggestion-reopen" }
  /** Raw pasted text, before classification. Never inserted without one. */
  | { readonly kind: "paste"; readonly text: string }
  | { readonly kind: "history-previous" }
  | { readonly kind: "history-next" }
  /**
   * Takes the snapshot and enters `sending`. Refused when there is nothing to send.
   * `attachments` is the TOCTOU-resolved list from the application seam; omitted
   * in pure reducer tests that already hold ready handles.
   */
  | {
      readonly kind: "submit";
      readonly binding?: string;
      readonly attachments?: readonly AttachmentDescriptor[];
    }
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
      const cursor = Math.min(action.cursor ?? action.text.length, action.text.length);
      if (action.text === state.text) {
        return cursor === state.cursor ? state : refreshSuggestions({ ...state, cursor });
      }
      const draftRevision = state.draftRevision + 1;
      const carried = reconcileTokens(state.tokens, action.text, action.tokens);
      // Typing ends a recall. The reader has made the entry theirs, and leaving
      // the phase at `recalling` would keep saying they are browsing history
      // while they write something new.
      const next: ComposerState = {
        ...state,
        text: action.text,
        cursor,
        caret: null,
        draftRevision,
        tokens: carried.tokens,
        tokenNotice:
          carried.demoted.length > 0
            ? `${carried.demoted.map((token) => token.label).join(", ")} ${carried.demoted.length === 1 ? "is" : "are"} now plain text.`
            : state.tokenNotice,
        phase: state.phase === "recalling" ? "editing" : state.phase,
        enhancement: staleEnhancement(state.enhancement, draftRevision),
      };
      return refreshSuggestions(commitTypedLabel(state, next));
    }

    case "cursor": {
      const cursor = Math.max(0, Math.min(action.cursor, state.text.length));
      return cursor === state.cursor ? state : refreshSuggestions({ ...state, cursor });
    }

    case "mention-triggers":
      return refreshSuggestions({ ...state, mentionTriggers: action.triggers });

    case "suggestion-results": {
      const open = state.suggestions;
      if (open === null || open.request !== action.request) return state;
      return {
        ...state,
        suggestions: {
          ...open,
          status: "ready",
          rows: action.page.rows,
          total: action.page.total,
          notice: action.page.notice,
          selected: Math.min(open.selected, Math.max(0, action.page.rows.length - 1)),
        },
      };
    }

    case "suggestion-failed": {
      const open = state.suggestions;
      if (open === null || open.request !== action.request) return state;
      return {
        ...state,
        suggestions: { ...open, status: "failed", rows: [], total: 0, notice: action.reason },
      };
    }

    case "suggestion-move": {
      const open = state.suggestions;
      if (open === null || open.rows.length === 0) return state;
      const count = open.rows.length;
      const selected = (((open.selected + action.delta) % count) + count) % count;
      return { ...state, suggestions: { ...open, selected } };
    }

    case "suggestion-dismiss":
      return state.suggestions === null
        ? state
        : { ...state, suggestions: null, dismissed: state.suggestions.start };

    case "suggestion-reopen":
      return refreshSuggestions({ ...state, dismissed: null });

    case "suggestion-accept": {
      const open = state.suggestions;
      const row = open?.rows[open.selected];
      if (open === null || row === undefined) return state;
      if (row.unavailable !== null) {
        return {
          ...state,
          tokenNotice: `${row.label}: ${row.unavailable.reason}${row.unavailable.repair === null ? "" : ` (${row.unavailable.repair})`}.`,
        };
      }
      return insertPick(state, row.pick, open.start, open.end);
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
      const recall = recallPrevious(state.history, state.text, state.tokens);
      if (recall.text === null) {
        return state;
      }
      const draftRevision = state.draftRevision + 1;
      return {
        ...state,
        history: recall.history,
        text: recall.text,
        tokens: recall.tokens,
        cursor: recall.text.length,
        caret: null,
        suggestions: null,
        dismissed: null,
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
        tokens: recall.tokens,
        cursor: recall.text.length,
        caret: null,
        suggestions: null,
        dismissed: null,
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
      const snapshot = snapshotOf(
        state.text,
        sequence,
        attachments,
        mentions,
        action.binding,
        state.tokens,
      );
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
        suggestions: null,
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
        history: accepted
          ? remember(state.history, action.outcome.snapshot.text, action.outcome.snapshot.tokens)
          : state.history,
        // The draft is cleared only on acceptance. This is the acceptance
        // criterion: a submission that resolved `unavailable` leaves the text
        // exactly where the user left it.
        text: accepted ? "" : state.text,
        tokens: accepted ? [] : state.tokens,
        cursor: accepted ? 0 : state.cursor,
        tokenNotice: accepted ? null : state.tokenNotice,
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
        tokens: held.tokens,
        cursor: held.proposed.length,
        caret: null,
        suggestions: null,
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
  if (state.tokenNotice !== null) {
    return state.tokenNotice;
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
    case "proposal": {
      if (outcome.revision !== state.draftRevision) {
        return {
          ...state,
          lastOutcome: null,
          lastEnhancement: { kind: "stale", revision: state.draftRevision },
          enhancement: null,
        };
      }
      // The proposal was written over placeholders; a rewrite that lost or
      // invented a mention cannot be applied (#1206).
      const restored =
        state.tokens.length === 0
          ? ({ ok: true, text: outcome.proposed, tokens: [] } as const)
          : restoreTokenPlaceholders(outcome.proposed, state.tokens);
      if (!restored.ok) {
        return {
          ...state,
          lastOutcome: null,
          enhancement: null,
          lastEnhancement: {
            kind: "unavailable",
            reason: "the proposal dropped or changed a mention, so it cannot be applied",
            owner: "#1206",
          },
        };
      }
      return {
        ...state,
        lastOutcome: null,
        lastEnhancement: null,
        enhancement: {
          original: state.text,
          proposed: restored.text,
          tokens: restored.tokens,
          explanation: outcome.explanation,
          draftRevision: outcome.revision,
          status: "ready",
        },
      };
    }
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

/**
 * Open, keep or close the suggestion list for the draft and cursor as they are now.
 *
 * Pure: a new query is a new request number, and the shell runtime answers it. The
 * same trigger and query keep the open list, so moving the selection survives an
 * unrelated re-render. A dismissed trigger stays closed until the reader moves to
 * another one.
 */
function refreshSuggestions(state: ComposerState): ComposerState {
  const match =
    state.mentionTriggers.size === 0 || state.phase === "disabled"
      ? null
      : detectMentionTrigger(state.text, state.cursor, state.mentionTriggers, state.tokens);
  if (match === null) {
    return state.suggestions === null && state.dismissed === null
      ? state
      : { ...state, suggestions: null, dismissed: null };
  }
  if (match.start === state.dismissed) {
    return state.suggestions === null ? state : { ...state, suggestions: null };
  }
  const open = state.suggestions;
  if (
    open !== null &&
    open.trigger === match.trigger &&
    open.start === match.start &&
    open.query === match.query
  ) {
    return open.end === match.end ? state : { ...state, suggestions: { ...open, end: match.end } };
  }
  const request = state.suggestionRequest + 1;
  return {
    ...state,
    dismissed: null,
    suggestionRequest: request,
    suggestions: {
      trigger: match.trigger,
      start: match.start,
      end: match.end,
      query: match.query,
      request,
      status: "loading",
      // Rows of the previous query stay visible while the next one loads, so the
      // list does not flicker on every keystroke.
      rows: open?.rows ?? [],
      total: open?.total ?? 0,
      selected: 0,
      notice: null,
    },
  };
}

/**
 * Typing an exact label and then a separator converts it, as if it had been picked.
 * Only while the list is open for that query and shows exactly one exact, available
 * row, and only for a single typed character: a paste never converts.
 */
function commitTypedLabel(before: ComposerState, after: ComposerState): ComposerState {
  const open = before.suggestions;
  if (open === null || open.status !== "ready") return after;
  const exact = open.rows.filter((row) => row.exact && row.unavailable === null);
  const row = exact[0];
  if (exact.length !== 1 || row === undefined) return after;
  const label = before.text.slice(open.start, open.end);
  if (label !== row.label || after.text.length !== before.text.length + 1) return after;
  const typed = after.text[open.end] ?? "";
  if (
    !/[\s.,;:!?)\]}]/u.test(typed) ||
    after.text.slice(0, open.end) !== before.text.slice(0, open.end) ||
    after.text.slice(open.end + 1) !== before.text.slice(open.end)
  ) {
    return after;
  }
  const limit = tokenLimitReason(after.tokens, row.pick);
  if (limit !== null) return { ...after, tokenNotice: limit };
  const token: ComposerToken = {
    ...row.pick,
    id: `tok-${after.tokenSeq + 1}`,
    start: open.start,
    end: open.start + row.label.length,
  };
  return {
    ...after,
    tokenSeq: after.tokenSeq + 1,
    tokens: [...after.tokens, token].sort((a, b) => a.start - b.start),
    tokenNotice: null,
    suggestions: null,
  };
}

/** Replace the open trigger and its query with a picked label and one space. */
function insertPick(
  state: ComposerState,
  pick: ComposerTokenPick,
  start: number,
  end: number,
): ComposerState {
  const limit = tokenLimitReason(state.tokens, pick);
  if (limit !== null) return { ...state, tokenNotice: limit };
  const inserted = insertTokenText(state.text, { start, end }, pick.label);
  const shift = inserted.text.length - state.text.length;
  const token: ComposerToken = {
    ...pick,
    id: `tok-${state.tokenSeq + 1}`,
    start: inserted.start,
    end: inserted.end,
  };
  const moved = state.tokens.map((item) =>
    item.start >= end ? { ...item, start: item.start + shift, end: item.end + shift } : item,
  );
  const draftRevision = state.draftRevision + 1;
  return {
    ...state,
    text: inserted.text,
    cursor: inserted.cursor,
    caret: inserted.cursor,
    draftRevision,
    tokenSeq: state.tokenSeq + 1,
    tokens: [...moved, token].sort((a, b) => a.start - b.start),
    tokenNotice: null,
    suggestions: null,
    dismissed: null,
    phase: state.phase === "recalling" ? "editing" : state.phase,
    enhancement: staleEnhancement(state.enhancement, draftRevision),
  };
}
