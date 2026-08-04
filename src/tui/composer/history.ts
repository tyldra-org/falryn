/**
 * What has been submitted before, and how a reader walks back through it.
 *
 * Three rules, and each of them is a decision rather than a default.
 *
 * **A secret is never stored.** Content that reads like a credential is not
 * remembered at all — not redacted, not masked, not kept with a flag. History is
 * the one place in the composer where text outlives the moment it was typed, so
 * the cheapest correct answer is not to have it. The signal is `looksSecret`
 * from `../paste.ts`, which is deliberately weak and deliberately the only one:
 * a stronger classifier here would be a second redaction rule, and
 * `src/application/redaction.ts` owns that. A weak signal used for a *refusal to
 * store* is safe in the direction that matters — the failure mode is forgetting
 * something harmless, not keeping something dangerous.
 *
 * **The draft is not lost to a recall.** Pressing up with something typed puts
 * that text aside and returns it when the reader walks back past the newest
 * entry. A history that overwrote the draft would make recall a destructive
 * action, and the reader would find out only after their sentence was gone.
 *
 * **Nothing is persisted.** History lives as long as the session does. A prompt
 * recalled from a previous run would be the one place a secret that slipped
 * through could resurface days later, and no contract asks for it.
 *
 * Pure data and pure functions: no clock, no storage, no renderer.
 */

import { looksSecret } from "../paste.ts";

/**
 * Entries kept.
 *
 * Bounded because history is memory a session never releases, and a hundred
 * prompts is far more than anyone walks back through — past that a reader
 * reaches for search, which this build does not have and does not pretend to.
 */
export const HISTORY_LIMIT = 100;

export type InputHistory = {
  /** Oldest first, so the newest is last and `up` walks towards the start. */
  readonly entries: readonly string[];
  /**
   * How far back the reader has walked, or `null` when they are on the draft.
   *
   * An index from the end rather than into the array, so remembering a new entry
   * while a recall is in progress cannot silently shift what the reader is
   * looking at.
   */
  readonly recalled: number | null;
  /** The text set aside when the walk began, restored when it ends. */
  readonly draft: string | null;
};

export const EMPTY_HISTORY: InputHistory = { entries: [], recalled: null, draft: null };

/**
 * Records a submission, unless it should not be recorded.
 *
 * Three refusals: empty text, text that reads like a credential, and a repeat of
 * the entry already at the top. The last one is not deduplication across the
 * whole history — repeating a command after doing something else is a real thing
 * a person does, and collapsing those would make `up` skip work they did.
 *
 * Always returns a history with the walk reset, because a new submission is the
 * end of whatever recall was in progress.
 */
export function remember(history: InputHistory, text: string): InputHistory {
  const settled: InputHistory = { ...history, recalled: null, draft: null };
  if (text.trim() === "" || looksSecret(text)) {
    return settled;
  }
  if (history.entries.at(-1) === text) {
    return settled;
  }
  return { ...settled, entries: [...history.entries, text].slice(-HISTORY_LIMIT) };
}

export type Recall = {
  readonly history: InputHistory;
  /** What the composer should now contain, or `null` when nothing moved. */
  readonly text: string | null;
};

/**
 * Walks one entry towards the start.
 *
 * The current text is passed in rather than read from the history, because the
 * reader may have edited a recalled entry — and the thing to set aside is what is
 * actually in the composer, not what was put there.
 */
export function recallPrevious(history: InputHistory, current: string): Recall {
  if (history.entries.length === 0) {
    return { history, text: null };
  }
  const next = (history.recalled ?? 0) + 1;
  if (next > history.entries.length) {
    return { history, text: null };
  }
  const draft = history.recalled === null ? current : history.draft;
  return {
    history: { ...history, recalled: next, draft },
    text: history.entries[history.entries.length - next] ?? null,
  };
}

/**
 * Walks one entry towards the newest, and off the end back to the draft.
 *
 * Stepping past the newest entry restores what was set aside rather than
 * clearing the composer, which is the whole reason the draft is held.
 */
export function recallNext(history: InputHistory): Recall {
  if (history.recalled === null) {
    return { history, text: null };
  }
  const next = history.recalled - 1;
  if (next <= 0) {
    return {
      history: { ...history, recalled: null, draft: null },
      text: history.draft ?? "",
    };
  }
  return {
    history: { ...history, recalled: next },
    text: history.entries[history.entries.length - next] ?? null,
  };
}

/** Whether a walk is in progress, which the composer reports as its editing state. */
export function isRecalling(history: InputHistory): boolean {
  return history.recalled !== null;
}
