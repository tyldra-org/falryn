/**
 * What happens when someone presses send, and what they are told.
 *
 * Nothing in this build can answer a prompt until a product submission port is
 * attached (#707). The question this module settles is what an interface should
 * do about that, and the answer it implements is that a submission *resolves*
 * — through a declared port, to a typed outcome, naming the issue that will
 * make it work and a route the user can take now.
 *
 * The alternatives were both worse. Discarding the input silently is the failure
 * a composer exists to prevent. Growing a stub agent loop behind the button
 * would put a second, fake answer to "what happens to a turn" in the tree, and
 * the day a real one arrived there would be two.
 *
 * ## The snapshot is immutable, and that is the contract
 *
 * A submission takes the text as it was at the moment it was sent. Later
 * keystrokes affect the next submission and never an in-flight one, which is
 * what makes "edit while it runs" safe rather than a race between a user's
 * typing and a request being assembled. The snapshot is a frozen value with no
 * reference back to the editor, so there is nothing for a later edit to reach.
 *
 * Pure: no clock, no renderer, no transport. The port is an interface a later
 * issue implements, and the one implementation here is the honest refusal.
 */

import type { AttachmentDescriptor, MentionSpan } from "../../domain/index.ts";

/**
 * The text of one submission, as it was when it was sent.
 *
 * Carries the sequence rather than a timestamp. A composer needs to distinguish
 * one submission from the next and to say which one an outcome belongs to;
 * neither question needs a clock, and reading one here would make every test of
 * this module a test of what time it was.
 */
export type ComposerSnapshot = {
  readonly text: string;
  /** Monotonic within a session, starting at 1. Identity, not a measurement. */
  readonly sequence: number;
  readonly attachments: readonly AttachmentDescriptor[];
  readonly mentions: readonly MentionSpan[];
};

export function snapshotOf(
  text: string,
  sequence: number,
  attachments: readonly AttachmentDescriptor[] = [],
  mentions: readonly MentionSpan[] = [],
): ComposerSnapshot {
  return Object.freeze({ text, sequence, attachments, mentions });
}

export const SUBMISSION_OUTCOMES = ["accepted", "unavailable"] as const;

export type SubmissionOutcomeKind = (typeof SUBMISSION_OUTCOMES)[number];

export type SubmissionOutcome =
  /**
   * Something took the turn. Nothing produces this yet.
   *
   * Declared rather than omitted because the composer's states — sending,
   * queued, cancelled — are only meaningful against an outcome that can succeed,
   * and a union with one member would make every consumer's `switch` a lie the
   * day the second arrived.
   */
  | { readonly kind: "accepted"; readonly snapshot: ComposerSnapshot }
  /**
   * Nothing can take it, and here is exactly why and what to do.
   *
   * `owner` names the issue rather than describing the gap, so the sentence a
   * user reads and the work that fixes it are the same reference. `route` is a
   * registered command id, so the repair route cannot be a key that does
   * nothing — the composer resolves it through the same command rows the palette
   * and help use.
   */
  | {
      readonly kind: "unavailable";
      readonly snapshot: ComposerSnapshot;
      readonly reason: string;
      readonly owner: string;
      readonly route: string;
    };

/**
 * Where a submission goes.
 *
 * One method, and it returns rather than throws: an unavailable provider is an
 * ordinary outcome the composer has to render, not an exception it has to catch
 * while holding the user's text.
 */
export type SubmissionPort = {
  submit(snapshot: ComposerSnapshot): SubmissionOutcome | Promise<SubmissionOutcome>;
};

/** The issue that owns making a submission do something. */
export const SUBMISSION_OWNER = "#707";

/**
 * The port this build declares when no product producer is attached.
 *
 * Named for what it is. A port called `defaultSubmissionPort` would read as a
 * thing that works, and the whole point is that a reader of this tree can see in
 * one identifier that nothing behind it does.
 */
export const UNAVAILABLE_SUBMISSION: SubmissionPort = {
  submit(snapshot) {
    return {
      kind: "unavailable",
      snapshot,
      reason: `no agent submission port is attached, so nothing can answer a prompt yet (${SUBMISSION_OWNER})`,
      owner: SUBMISSION_OWNER,
      // The palette is the honest route: it is the one surface that lists every
      // command with its availability, so a user sent there finds out what this
      // build can actually do rather than another dead end.
      route: "app.commandPalette",
    };
  },
};

/**
 * One sentence describing an outcome.
 *
 * Words rather than a status token alone, so the result of pressing send
 * survives a monochrome terminal — and it names the draft's fate, because "your
 * text is still here" is the thing a user most wants to know after a submission
 * that did not work.
 */
export function describeOutcome(outcome: SubmissionOutcome): string {
  switch (outcome.kind) {
    case "accepted":
      return "Sent.";
    case "unavailable":
      return `Not sent: ${outcome.reason}. Your draft is unchanged.`;
  }
}
