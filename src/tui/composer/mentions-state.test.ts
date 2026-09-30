/**
 * Mention tokens and the suggestion list in the composer state (#1206).
 *
 * Asserted on the pure machine: the view keeps tokens atomic and reports where they
 * moved, and these transitions decide what the draft holds.
 */

import { describe, expect, test } from "bun:test";
import type { ComposerTokenPick } from "../../domain/context/composer-mentions.ts";
import {
  type ComposerAction,
  type ComposerState,
  composerNotice,
  composerReducer,
  INITIAL_COMPOSER_STATE,
} from "./state.ts";
import type { SuggestionRow } from "./suggestions.ts";

function apply(state: ComposerState, ...actions: readonly ComposerAction[]): ComposerState {
  return actions.reduce(composerReducer, state);
}

const READY = apply(INITIAL_COMPOSER_STATE, { kind: "mention-triggers", triggers: new Set(["$"]) });

function pick(name: string, kind: ComposerTokenPick["kind"] = "package"): ComposerTokenPick {
  return {
    trigger: "$",
    kind,
    identity: `${kind}:${name}@1`,
    label: `$${name}`,
    source: `${name} 1.0.0`,
    generation: "g1",
  };
}

function row(name: string, extra: Partial<SuggestionRow> = {}): SuggestionRow {
  const value = pick(name, extra.kind ?? "package");
  return {
    id: name,
    label: value.label,
    kind: value.kind,
    detail: "package · workspace",
    exact: false,
    unavailable: null,
    pick: value,
    ...extra,
  };
}

function typed(state: ComposerState, text: string): ComposerState {
  return apply(state, { kind: "draft", text, cursor: text.length });
}

function answered(state: ComposerState, rows: readonly SuggestionRow[]): ComposerState {
  const request = state.suggestions?.request ?? -1;
  return apply(state, {
    kind: "suggestion-results",
    request,
    page: { rows, total: rows.length, notice: null },
  });
}

describe("opening the list", () => {
  test("a registered trigger opens it with a new request; unregistered ones do not", () => {
    expect(typed(INITIAL_COMPOSER_STATE, "use $gm").suggestions).toBeNull();
    const open = typed(READY, "use $gm");
    expect(open.suggestions).toMatchObject({
      trigger: "$",
      start: 4,
      query: "gm",
      status: "loading",
    });
    expect(typed(open, "use $gma").suggestions?.request).toBe((open.suggestions?.request ?? 0) + 1);
    expect(typed(READY, "US$5").suggestions).toBeNull();
  });

  test("a late answer for an older query is ignored", () => {
    const first = typed(READY, "$g");
    const second = typed(first, "$gm");
    const late = apply(second, {
      kind: "suggestion-results",
      request: first.suggestions?.request ?? 0,
      page: { rows: [row("gone")], total: 1, notice: null },
    });
    expect(late.suggestions?.rows).toEqual([]);
    expect(answered(second, [row("gmail")]).suggestions?.rows.map((item) => item.label)).toEqual([
      "$gmail",
    ]);
  });

  test("a dismissed trigger stays closed until the reader moves on or reopens it", () => {
    const open = typed(READY, "use $gm");
    const dismissed = apply(open, { kind: "suggestion-dismiss" });
    expect(dismissed.suggestions).toBeNull();
    expect(typed(dismissed, "use $gma").suggestions).toBeNull();
    expect(apply(dismissed, { kind: "suggestion-reopen" }).suggestions?.query).toBe("gm");
    expect(typed(dismissed, "use $gm and $o").suggestions?.query).toBe("o");
  });

  test("selection wraps", () => {
    const open = answered(typed(READY, "$"), [row("a"), row("b"), row("c")]);
    expect(apply(open, { kind: "suggestion-move", delta: -1 }).suggestions?.selected).toBe(2);
    expect(apply(open, { kind: "suggestion-move", delta: 4 }).suggestions?.selected).toBe(1);
  });
});

describe("picking", () => {
  test("replaces the query with the label and a space, and binds the pick", () => {
    const open = answered(typed(READY, "find it with $gm please"), [row("gmail")]);
    const cursorAtQuery = apply(open, { kind: "cursor", cursor: 16 });
    const reopened = apply(cursorAtQuery, { kind: "suggestion-reopen" });
    const picked = apply(answered(reopened, [row("gmail")]), { kind: "suggestion-accept" });
    expect(picked.text).toBe("find it with $gmail please");
    expect(picked.tokens).toEqual([{ ...pick("gmail"), id: "tok-1", start: 13, end: 19 }]);
    expect(picked.caret).toBe(20);
    expect(picked.suggestions).toBeNull();
  });

  test("an unavailable row names its reason and inserts nothing", () => {
    const open = answered(typed(READY, "$gi"), [
      row("github", { unavailable: { reason: "not trusted", repair: "/extensions github" } }),
    ]);
    const refused = apply(open, { kind: "suggestion-accept" });
    expect(refused.text).toBe("$gi");
    expect(refused.tokens).toEqual([]);
    expect(composerNotice(refused)).toBe("$github: not trusted (/extensions github).");
  });

  test("the fifth skill is refused at selection", () => {
    let state = READY;
    for (const name of ["a", "b", "c", "d"]) {
      state = typed(state, `${state.text}$${name}`);
      state = apply(answered(state, [row(name, { kind: "skill" })]), { kind: "suggestion-accept" });
    }
    expect(state.tokens).toHaveLength(4);
    state = typed(state, `${state.text}$e`);
    const refused = apply(answered(state, [row("e", { kind: "skill" })]), {
      kind: "suggestion-accept",
    });
    expect(refused.tokens).toHaveLength(4);
    expect(composerNotice(refused)).toBe("At most 4 skills per prompt.");
  });

  test("typing an exact label and a space converts it; a paste does not", () => {
    const open = answered(typed(READY, "use $gmail"), [row("gmail", { exact: true })]);
    const converted = typed(open, "use $gmail ");
    expect(converted.tokens.map((token) => [token.label, token.start])).toEqual([["$gmail", 4]]);
    const pasted = typed(open, "use $gmail and more");
    expect(pasted.tokens).toEqual([]);
    const ambiguous = answered(typed(READY, "use $gmail"), [
      row("gmail", { exact: true }),
      row("gmail2", { exact: true }),
    ]);
    expect(typed(ambiguous, "use $gmail ").tokens).toEqual([]);
  });
});

describe("tokens across edits", () => {
  const picked = apply(answered(typed(READY, "$gm"), [row("gmail")]), {
    kind: "suggestion-accept",
  });

  test("an edit inside a token turns it into plain text and says so", () => {
    const edited = apply(picked, {
      kind: "draft",
      text: "$gmial ",
      tokens: new Map([["tok-1", { start: 0, end: 6 }]]),
    });
    expect(edited.tokens).toEqual([]);
    expect(composerNotice(edited)).toBe("$gmail is now plain text.");
  });

  test("the editor's reported ranges move tokens, and a deleted token is simply gone", () => {
    const moved = apply(picked, {
      kind: "draft",
      text: "hi $gmail ",
      tokens: new Map([["tok-1", { start: 3, end: 9 }]]),
    });
    expect(moved.tokens[0]?.start).toBe(3);
    const deleted = apply(picked, { kind: "draft", text: " ", tokens: new Map() });
    expect(deleted.tokens).toEqual([]);
    expect(composerNotice(deleted)).toBeNull();
  });

  test("a submission carries the tokens, and acceptance remembers them for recall", () => {
    const sending = apply(picked, { kind: "submit" });
    expect(sending.inFlight?.tokens.map((token) => token.label)).toEqual(["$gmail"]);
    const snapshot = sending.inFlight;
    if (snapshot === null) throw new Error("nothing in flight");
    const done = apply(sending, { kind: "resolve", outcome: { kind: "accepted", snapshot } });
    expect(done.tokens).toEqual([]);
    const recalled = apply(done, { kind: "history-previous" });
    expect(recalled.text).toBe("$gmail ");
    expect(recalled.tokens.map((token) => token.label)).toEqual(["$gmail"]);
  });

  test("an enhancement that keeps every placeholder rebinds; one that drops a mention cannot apply", () => {
    const kept = apply(picked, {
      kind: "enhance",
      outcome: {
        kind: "proposal",
        original: "\u27E61\u27E7 ",
        proposed: "Use \u27E61\u27E7.",
        explanation: "capitalised",
        revision: picked.draftRevision,
      },
    });
    const accepted = apply(kept, { kind: "accept-enhancement" });
    expect(accepted.text).toBe("Use $gmail.");
    expect(accepted.tokens[0]).toMatchObject({ start: 4, end: 10 });
    const dropped = apply(picked, {
      kind: "enhance",
      outcome: {
        kind: "proposal",
        original: "\u27E61\u27E7 ",
        proposed: "Use gmail.",
        explanation: "rewrote",
        revision: picked.draftRevision,
      },
    });
    expect(dropped.enhancement).toBeNull();
    expect(composerNotice(dropped)).toContain("dropped or changed a mention");
  });
});
