/**
 * The composer's state machine.
 *
 * The two acceptance criteria this file owns are the snapshot's immutability and
 * the draft surviving a submission that could not be taken. Both are asserted on
 * the state rather than through a renderer, because both are properties of the
 * transition and a frame would only show what happened to survive it.
 */

import { describe, expect, test } from "bun:test";
import { INLINE_PASTE_LIMIT } from "../paste.ts";
import {
  type ComposerAction,
  type ComposerState,
  composerNotice,
  composerReducer,
  INITIAL_COMPOSER_STATE,
} from "./state.ts";
import { type SubmissionOutcome, snapshotOf, UNAVAILABLE_SUBMISSION } from "./submission.ts";

function apply(state: ComposerState, ...actions: readonly ComposerAction[]): ComposerState {
  return actions.reduce(composerReducer, state);
}

/** A composer holding this draft. */
function drafting(text: string): ComposerState {
  return apply(INITIAL_COMPOSER_STATE, { kind: "draft", text });
}

/** Submits, asks the build's real port, and resolves — the whole round trip. */
function submitted(state: ComposerState): ComposerState {
  const sending = apply(state, { kind: "submit" });
  if (sending.inFlight === null) {
    return sending;
  }
  return apply(sending, {
    kind: "resolve",
    outcome: UNAVAILABLE_SUBMISSION.submit(sending.inFlight),
  });
}

describe("submitting", () => {
  test("passes through sending and takes a frozen snapshot", () => {
    const sending = apply(drafting("ask something"), { kind: "submit" });
    expect(sending.phase).toBe("sending");
    expect(sending.inFlight?.text).toBe("ask something");
    expect(Object.isFrozen(sending.inFlight)).toBe(true);
  });

  test("later edits reach the next submission and never the one in flight", () => {
    // The acceptance criterion, and the property that makes typing while
    // something runs safe rather than a race between a keystroke and a request.
    const sending = apply(drafting("first"), { kind: "submit" });
    const snapshot = sending.inFlight;
    // The whole content afterwards, because that is what the renderable
    // reports: this machine is told what the draft *is*, never what changed.
    const typing = apply(sending, { kind: "draft", text: "first and more" });

    expect(snapshot?.text).toBe("first");
    expect(typing.inFlight?.text).toBe("first");
    expect(typing.text).toBe("first and more");
  });

  test("numbers submissions so one outcome cannot be read as another's", () => {
    const first = submitted(drafting("one"));
    const second = apply(first, { kind: "draft", text: "two" });
    const sending = apply(second, { kind: "submit" });
    expect(sending.inFlight?.sequence).toBe(2);
  });

  test("refuses to submit nothing", () => {
    const empty = apply(INITIAL_COMPOSER_STATE, { kind: "submit" });
    expect(empty).toBe(INITIAL_COMPOSER_STATE);
    const blank = drafting("   \n ");
    expect(apply(blank, { kind: "submit" })).toBe(blank);
  });

  test("refuses to submit while disabled", () => {
    const disabled = apply(drafting("ask"), { kind: "disable" });
    expect(apply(disabled, { kind: "submit" })).toBe(disabled);
  });
});

describe("a submission nothing can take", () => {
  test("resolves unavailable, names its owner, and offers a route", () => {
    const after = submitted(drafting("ask something"));
    const outcome = after.lastOutcome;
    expect(outcome?.kind).toBe("unavailable");
    if (outcome?.kind !== "unavailable") {
      throw new Error("the build's port stopped refusing");
    }
    expect(outcome.owner).toBe("#33");
    expect(outcome.reason).toContain("no provider is configured");
    expect(outcome.route).toBe("app.commandPalette");
  });

  test("leaves the draft exactly where the user left it", () => {
    // The acceptance criterion. Discarding the input is the failure a composer
    // exists to prevent, and it is the failure that costs the most trust.
    const after = submitted(drafting("ask something"));
    expect(after.text).toBe("ask something");
    expect(after.phase).toBe("editing");
  });

  test("does not remember it, because it is still in the composer", () => {
    // Putting it in history too would offer the reader a recall of the text they
    // are already looking at.
    const after = submitted(drafting("ask something"));
    expect(after.history.entries).toEqual([]);
  });
});

describe("a submission something takes", () => {
  test("clears the draft and remembers it", () => {
    const sending = apply(drafting("ask something"), { kind: "submit" });
    const snapshot = sending.inFlight;
    if (snapshot === null) {
      throw new Error("nothing was in flight");
    }
    const accepted: SubmissionOutcome = { kind: "accepted", snapshot };
    const after = apply(sending, { kind: "resolve", outcome: accepted });

    expect(after.text).toBe("");
    expect(after.history.entries).toEqual(["ask something"]);
    expect(after.phase).toBe("editing");
  });

  test("ignores an outcome with nothing in flight", () => {
    const idle = drafting("draft");
    const stray: SubmissionOutcome = {
      kind: "accepted",
      snapshot: snapshotOf("elsewhere", 9),
    };
    expect(apply(idle, { kind: "resolve", outcome: stray })).toBe(idle);
  });
});

describe("history through the composer", () => {
  test("recalling changes the phase, and typing ends it", () => {
    const sending = apply(drafting("remembered"), { kind: "submit" });
    const snapshot = sending.inFlight;
    if (snapshot === null) {
      throw new Error("nothing was in flight");
    }
    const sent = apply(sending, {
      kind: "resolve",
      outcome: { kind: "accepted", snapshot },
    });

    const recalled = apply(sent, { kind: "history-previous" });
    expect(recalled.phase).toBe("recalling");
    expect(recalled.text).toBe("remembered");

    const typing = apply(recalled, { kind: "draft", text: "!" });
    expect(typing.phase).toBe("editing");
  });
});

describe("paste", () => {
  test("records a small one as inline, and inserts nothing itself", () => {
    // The division #399 drew. The classification is this machine's: it decides
    // whether a paste may go in at all. Putting the text into the buffer is the
    // renderable's, because the renderable owns the buffer — so what is
    // asserted here is the verdict and the silence, and
    // `../components/composer.test.tsx` asserts the text arriving.
    const after = apply(drafting("a "), { kind: "paste", text: "pasted" });
    expect(after.lastPaste?.verdict).toBe("inline");
    expect(after.text).toBe("a ");
    expect(composerNotice(after)).toBeNull();
  });

  test("reports a large one instead of inserting it", () => {
    // The flood the classification exists to prevent. Including it is a separate
    // action that records a handle; the notice never keeps the body.
    const large = "x".repeat(INLINE_PASTE_LIMIT + 1);
    const after = apply(drafting("draft"), { kind: "paste", text: large });
    expect(after.text).toBe("draft");
    expect(composerNotice(after)).toContain("not inserted");
    expect(after.lastPaste?.verdict).toBe("preview");
    expect(after.lastPaste !== null && "text" in after.lastPaste).toBe(false);
    expect(after.lastPaste !== null && "preview" in after.lastPaste).toBe(false);
  });

  test("marks a secret-shaped preview without inserting it", () => {
    const large = `export API_KEY=abc123\n${"x".repeat(INLINE_PASTE_LIMIT)}`;
    const after = apply(drafting("draft"), { kind: "paste", text: large });
    expect(after.text).toBe("draft");
    expect(composerNotice(after)).toContain("Looks like a credential");
  });

  test("reports a refusal instead of inserting it", () => {
    const after = apply(drafting("draft"), { kind: "paste", text: "before\0after" });
    expect(after.text).toBe("draft");
    expect(composerNotice(after)).toContain("refused");
  });
});

describe("phases", () => {
  test("disable and enable are reversible and return identity when they change nothing", () => {
    const enabled = drafting("draft");
    expect(composerReducer(enabled, { kind: "enable" })).toBe(enabled);

    const disabled = apply(enabled, { kind: "disable" });
    expect(disabled.phase).toBe("disabled");
    expect(composerReducer(disabled, { kind: "disable" })).toBe(disabled);
    expect(apply(disabled, { kind: "enable" }).phase).toBe("editing");
  });

  test("cancelling is a no-op when nothing is in flight", () => {
    const idle = drafting("draft");
    expect(composerReducer(idle, { kind: "cancel" })).toBe(idle);
  });

  test("cancelling an in-flight submission keeps the draft", () => {
    const sending = apply(drafting("ask"), { kind: "submit" });
    const cancelled = apply(sending, { kind: "cancel" });
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.inFlight).toBeNull();
    expect(cancelled.text).toBe("ask");
  });
});

describe("attachments", () => {
  const paste = {
    id: "att-1",
    kind: "paste" as const,
    identity: "paste:att-1",
    status: "ready" as const,
    byteLength: 12,
    characters: 12,
    lines: 1,
    digest: `sha-256:${"a".repeat(64)}`,
    revision: null,
    mediaType: "text/plain",
    secret: false,
  };

  test("include records a handle and never a payload field", () => {
    const after = apply(drafting("draft"), { kind: "include-paste", attachment: paste });
    expect(after.attachments).toEqual([paste]);
    expect(after.lastPaste).toBeNull();
    expect(JSON.stringify(after.attachments)).not.toContain("held-out");
    expect(composerNotice(after)).toContain("paste:att-1");
  });

  test("blocks submit when a mention cannot be resolved", () => {
    const after = apply(drafting("see @mcp:res"), { kind: "submit" });
    expect(after.phase).toBe("editing");
    expect(after.inFlight).toBeNull();
    expect(after.lastOutcome?.kind).toBe("unavailable");
    expect(after.lastOutcome?.kind === "unavailable" && after.lastOutcome.reason).toContain(
      "unsupported",
    );
    expect(after.lastOutcome?.kind === "unavailable" && after.lastOutcome.route).toBe(
      "composer.removeAttachment",
    );
    expect(after.text).toBe("see @mcp:res");
  });

  test("blocks submit when an attachment is not ready", () => {
    const blocked = apply(drafting("send this"), {
      kind: "include-paste",
      attachment: { ...paste, status: "oversized" },
    });
    const after = apply(blocked, { kind: "submit" });
    expect(after.phase).toBe("editing");
    expect(after.inFlight).toBeNull();
    expect(after.lastOutcome?.kind === "unavailable" && after.lastOutcome.reason).toContain(
      "oversized",
    );
  });

  test("snapshots handles and mentions when everything is ready", () => {
    const ready = apply(drafting("see @paste:att-1"), { kind: "include-paste", attachment: paste });
    const sending = apply(ready, { kind: "submit" });
    expect(sending.phase).toBe("sending");
    expect(sending.inFlight?.attachments).toEqual([paste]);
    expect(sending.inFlight?.mentions[0]?.identity).toBe("paste:att-1");
    expect(Object.isFrozen(sending.inFlight)).toBe(true);
  });

  test("takes resolved file mentions from the submit action in one step", () => {
    const file = {
      id: "file-readme-md",
      kind: "file" as const,
      identity: "readme.md",
      status: "ready" as const,
      byteLength: 4,
      characters: null,
      lines: null,
      digest: `sha-256:${"b".repeat(64)}`,
      revision: "1",
      mediaType: "text/plain",
      secret: false,
    };
    const sending = apply(drafting("see @readme.md"), { kind: "submit", attachments: [file] });
    expect(sending.phase).toBe("sending");
    expect(sending.attachments).toEqual([file]);
    expect(sending.inFlight?.mentions[0]?.identity).toBe("readme.md");
  });
});

describe("enhancement", () => {
  test("holds a proposal and does not submit", () => {
    const drafted = drafting("  hello  \n");
    const proposed = apply(drafted, {
      kind: "enhance",
      outcome: {
        kind: "proposal",
        original: drafted.text,
        proposed: "hello",
        explanation: "trimmed trailing spaces, and trimmed edges",
        revision: drafted.draftRevision,
      },
    });
    expect(proposed.phase).toBe("editing");
    expect(proposed.inFlight).toBeNull();
    expect(proposed.text).toBe(drafted.text);
    expect(proposed.enhancement?.status).toBe("ready");
    expect(composerNotice(proposed)).toContain("Accept or reject");
  });

  test("accept replaces the draft and reject leaves it", () => {
    const drafted = drafting("  hello  \n");
    const proposed = apply(drafted, {
      kind: "enhance",
      outcome: {
        kind: "proposal",
        original: drafted.text,
        proposed: "hello",
        explanation: "trimmed edges",
        revision: drafted.draftRevision,
      },
    });
    const accepted = apply(proposed, { kind: "accept-enhancement" });
    expect(accepted.text).toBe("hello");
    expect(accepted.enhancement).toBeNull();
    expect(accepted.inFlight).toBeNull();

    const rejected = apply(proposed, { kind: "reject-enhancement" });
    expect(rejected.text).toBe(drafted.text);
    expect(rejected.enhancement).toBeNull();
  });

  test("typing marks a proposal stale and blocks accept", () => {
    const drafted = drafting("  hello  \n");
    const proposed = apply(drafted, {
      kind: "enhance",
      outcome: {
        kind: "proposal",
        original: drafted.text,
        proposed: "hello",
        explanation: "trimmed edges",
        revision: drafted.draftRevision,
      },
    });
    const typed = apply(proposed, { kind: "draft", text: "  hello  \n and more" });
    expect(typed.enhancement?.status).toBe("stale");
    const after = apply(typed, { kind: "accept-enhancement" });
    expect(after.text).toBe("  hello  \n and more");
    expect(after.enhancement?.status).toBe("stale");
  });

  test("enhance never becomes a submit", () => {
    const after = apply(drafting("ask"), {
      kind: "enhance",
      outcome: { kind: "unchanged", revision: 1 },
    });
    expect(after.phase).toBe("editing");
    expect(after.inFlight).toBeNull();
    expect(composerNotice(after)).toContain("Already clear");
  });
});
