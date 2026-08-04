/**
 * Input history.
 *
 * Two properties carry the weight. A secret is never stored, which is the one
 * rule here that has a consequence outside the composer — history is where text
 * outlives the moment it was typed. And a recall never costs the draft, which is
 * what makes pressing up a reversible action rather than a destructive one.
 */

import { describe, expect, test } from "bun:test";
import {
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  type InputHistory,
  isRecalling,
  recallNext,
  recallPrevious,
  remember,
} from "./history.ts";

/** A history holding these submissions, oldest first. */
function holding(...entries: readonly string[]): InputHistory {
  return entries.reduce(remember, EMPTY_HISTORY);
}

describe("what is never stored", () => {
  test("refuses content that reads like a credential", () => {
    // Not redacted and not masked — absent. History is the one place a prompt
    // outlives the moment it was typed, so the cheapest correct answer is not to
    // have it. The signal is `looksSecret`, which is deliberately the only one.
    for (const secret of [
      "export API_KEY=abc123",
      "my password is hunter2",
      "Authorization: Bearer abc",
      "-----BEGIN RSA PRIVATE KEY-----",
    ]) {
      expect({ secret, entries: remember(EMPTY_HISTORY, secret).entries }).toEqual({
        secret,
        entries: [],
      });
    }
  });

  test("refuses empty and whitespace-only submissions", () => {
    expect(holding("", "   ", "\n").entries).toEqual([]);
  });

  test("refuses an immediate repeat but not a later one", () => {
    // Repeating a command after doing something else is a real thing a person
    // does, and collapsing those would make `up` skip work they did.
    expect(holding("a", "a").entries).toEqual(["a"]);
    expect(holding("a", "b", "a").entries).toEqual(["a", "b", "a"]);
  });

  test("keeps only the newest entries", () => {
    const many = Array.from({ length: HISTORY_LIMIT + 10 }, (_unused, index) => `entry ${index}`);
    const history = many.reduce(remember, EMPTY_HISTORY);
    expect(history.entries.length).toBe(HISTORY_LIMIT);
    expect(history.entries.at(-1)).toBe(`entry ${HISTORY_LIMIT + 9}`);
    expect(history.entries.at(0)).toBe("entry 10");
  });
});

describe("walking back", () => {
  test("returns the newest entry first", () => {
    const recall = recallPrevious(holding("first", "second"), "");
    expect(recall.text).toBe("second");
    expect(isRecalling(recall.history)).toBe(true);
  });

  test("walks towards the start and stops at it", () => {
    const history = holding("first", "second");
    const one = recallPrevious(history, "");
    const two = recallPrevious(one.history, "second");
    expect(two.text).toBe("first");

    const past = recallPrevious(two.history, "first");
    expect(past.text).toBeNull();
    expect(past.history).toBe(two.history);
  });

  test("does nothing when there is no history", () => {
    const recall = recallPrevious(EMPTY_HISTORY, "a draft");
    expect(recall.text).toBeNull();
    expect(recall.history).toBe(EMPTY_HISTORY);
  });
});

describe("the draft", () => {
  test("is set aside on the first recall and returned at the end of the walk", () => {
    // The reason recall is not destructive. A history that overwrote the draft
    // would lose the sentence someone was writing, and they would find out only
    // after it was gone.
    const history = holding("sent");
    const back = recallPrevious(history, "half a sentence");
    expect(back.text).toBe("sent");

    const forward = recallNext(back.history);
    expect(forward.text).toBe("half a sentence");
    expect(isRecalling(forward.history)).toBe(false);
  });

  test("is the text in the composer, not what was put there", () => {
    // The reader may have edited a recalled entry before walking on, and the
    // thing to set aside is what is actually there.
    const history = holding("one", "two");
    const first = recallPrevious(history, "draft");
    const edited = recallPrevious(first.history, "two, edited");
    expect(edited.text).toBe("one");

    const back = recallNext(edited.history);
    expect(back.text).toBe("two");
    expect(recallNext(back.history).text).toBe("draft");
  });

  test("is released when a new submission is remembered", () => {
    const walked = recallPrevious(holding("one"), "draft").history;
    const after = remember(walked, "two");
    expect(after.draft).toBeNull();
    expect(isRecalling(after)).toBe(false);
  });
});

describe("walking forward", () => {
  test("does nothing when no walk is in progress", () => {
    const history = holding("one");
    const recall = recallNext(history);
    expect(recall.text).toBeNull();
    expect(recall.history).toBe(history);
  });

  test("returns the empty string when there was no draft to restore", () => {
    const back = recallPrevious(holding("one"), "");
    expect(recallNext(back.history).text).toBe("");
  });
});
