/**
 * The keys the reference promises, each pressed for real.
 *
 * This file exists because a migration changed them silently. Moving the
 * composer onto `TextareaRenderable` brought the library's default bindings with
 * it, and `home` and `end` disagreed with what
 * `reference/KEYBOARD-SHORTCUTS.md` promises by moving to the draft's ends
 * rather than the line's. `ctrl+home`/`ctrl+end` did nothing at all. Nobody
 * decided that — defaults arrived with a dependency and no check was watching
 * the keys.
 *
 * So the checks here are deliberately one per documented binding rather than a
 * representative sample. What they guard is not the library's behaviour, which
 * is its own to change, but the *agreement* between the reference and the build:
 * a version bump that moves a default fails here rather than in someone's hands.
 *
 * Every case asserts through what typing does afterwards, not through a cursor
 * coordinate. A coordinate check is what shipped the defect this whole area is
 * recovering from.
 */

import { describe, expect, test } from "bun:test";
import { mount, type Rendered } from "../harness.tsx";
import type { ThemeRequest } from "../theme/index.ts";
import { known, type ShellModel, unavailable } from "../view-model.ts";
import { ShellApp } from "./shell-app.tsx";

const THEME: ThemeRequest = {
  variant: "dark",
  colorLevel: "truecolor",
  symbols: "unicode",
  reducedMotion: true,
  generation: 1,
};

const MODEL: Omit<ShellModel, "overlay" | "commands" | "transcript" | "composer" | "activity"> = {
  header: {
    workspace: known("/work/falryn"),
    branch: unavailable("no Git yet"),
    session: unavailable("no session yet"),
    model: unavailable("no provider yet"),
  },
  status: { status: "informational", message: "Nothing is running.", hints: [] },
  help: [{ title: "Leaving", body: "Ctrl+C ends the shell." }],
};

/**
 * The sequences the named keys actually send.
 *
 * Written out because `pressKey("home")` types the four letters of the word —
 * the mock's own helpers exist for the keys that are sequences rather than
 * text, and the two without a helper belong here rather than as a word.
 */
const HOME = "\u001b[H";
const END = "\u001b[F";

/** A mounted shell with the composer focused and a draft in it. */
async function drafting(draft = "alpha\nbravo", kittyKeyboard = false): Promise<Rendered> {
  const shell = await mount(<ShellApp theme={THEME} model={MODEL} onExit={() => {}} />, {
    shape: { columns: 100, rows: 24 },
    kittyKeyboard,
  });
  await shell.frame();
  // Two tabs: header, then the primary region, then the composer.
  await shell.press("\t");
  await shell.press("\t");
  // Pasted rather than typed, because a newline in pasted text is content and
  // that is the only way to get two lines through the mock keyboard. Two lines
  // is what makes a line motion distinguishable from a document one.
  await shell.paste(draft);
  return shell;
}

/** The draft's rows, which is where a motion becomes observable. */
async function draftRows(shell: Rendered): Promise<readonly string[]> {
  return (await shell.frame())
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /alpha|bravo|X/.test(line));
}

describe("the keys the reference promises", () => {
  test("home goes to the line's start, not the draft's", async () => {
    // The library binds this to `buffer-home`. On a two-line draft that is the
    // difference between marking the line the cursor is on and jumping to the
    // top of the draft — and the reference has always promised the former.
    using shell = await drafting();
    shell.setup.mockInput.pressKey(HOME);
    await shell.frame();
    await shell.type("X");
    expect(await draftRows(shell)).toEqual(["alpha", "Xbravo"]);
  });

  test("end goes to the line's end rather than the draft's", async () => {
    // Started from the *first* line, because that is the only place the two
    // answers differ: on the last line `line-end` and the library's default
    // `buffer-end` land on the same character and a check standing there would
    // pass either way.
    //
    // Asserted with backspace rather than typing, because the library's
    // `line-end` sits just *past* the line break rather than on the last
    // character of the line — one cell further than the reference's wording
    // implies, and visible to a user as the cursor appearing at the start of
    // the row below. That is the library's boundary, it is reported on the
    // delivery PR rather than papered over here, and backspace states where
    // the cursor actually is: it takes the newline and joins the two lines.
    // Had `end` gone to the draft's end instead it would have taken the `o`.
    using shell = await drafting();
    shell.setup.mockInput.pressArrow("up");
    await shell.frame();
    shell.setup.mockInput.pressKey(END);
    await shell.frame();
    await shell.pressBackspace();
    expect(await draftRows(shell)).toEqual(["alphabravo"]);
  });

  test("ctrl+home goes to the draft's start", async () => {
    // The library binds nothing to this, so before it was pinned the key did
    // nothing at all — the quietest kind of regression.
    using shell = await drafting();
    shell.setup.mockInput.pressKey(HOME, { ctrl: true });
    await shell.frame();
    await shell.type("X");
    expect(await draftRows(shell)).toEqual(["Xalpha", "bravo"]);
  });

  test("ctrl+end goes to the draft's end", async () => {
    // Same reason for starting a line up: unbound, this key does nothing, and
    // nothing is indistinguishable from a correct motion when the cursor is
    // already where the motion would put it.
    using shell = await drafting();
    shell.setup.mockInput.pressArrow("up");
    await shell.frame();
    shell.setup.mockInput.pressKey(END, { ctrl: true });
    await shell.frame();
    await shell.type("X");
    expect(await draftRows(shell)).toEqual(["alpha", "bravoX"]);
  });

  test("ctrl+a moves to line home, including a terminal's Command+Left alias", async () => {
    using shell = await drafting();
    shell.setup.mockInput.pressKey("a", { ctrl: true });
    await shell.frame();
    await shell.type("X");
    expect(await draftRows(shell)).toEqual(["alpha", "Xbravo"]);
  });

  test("Command+a selects the draft when Kitty reports Super", async () => {
    // Typing distinguishes replacement from insertion without reaching into
    // the renderable's private selection state.
    using shell = await drafting("alpha\nbravo", true);
    shell.setup.mockInput.pressKey("a", { super: true });
    await shell.frame();
    await shell.type("X");
    expect(await draftRows(shell)).toEqual(["X"]);
  });

  test("alt and ctrl arrows move by word", async () => {
    // Not overridden — the library's defaults already match the reference here,
    // and this is what says so rather than leaving it assumed.
    //
    // One line, two words, because that is the case the reference describes and
    // the only one with a single obvious answer. Across a line break the
    // library stops at the previous line's *end* rather than the current word's
    // start; that is its boundary to choose and nothing here promises otherwise.
    for (const modifiers of [{ meta: true }, { ctrl: true }] as const) {
      using shell = await drafting("alpha bravo");
      shell.setup.mockInput.pressArrow("left", modifiers);
      await shell.frame();
      await shell.type("X");
      expect({ modifiers, rows: await draftRows(shell) }).toEqual({
        modifiers,
        rows: ["alpha Xbravo"],
      });
    }
  });

  test("shift with a motion extends rather than moves", async () => {
    // The same key twice, and backspace as the question: after a move it
    // deletes one character, after an extension it deletes everything the
    // motion crossed. Typing would answer the same question less clearly,
    // because where an insertion lands inside a replaced selection is the
    // library's business and not what this is asking about.
    using bare = await drafting();
    bare.setup.mockInput.pressKey(HOME);
    await bare.frame();
    await bare.pressBackspace();
    // Moved to the line's start; backspace took the newline and joined them.
    expect(await draftRows(bare)).toEqual(["alphabravo"]);

    using extended = await drafting();
    extended.setup.mockInput.pressKey(HOME, { shift: true });
    await extended.frame();
    await extended.pressBackspace();
    // Extended over the line instead, so backspace took all of it.
    expect(await draftRows(extended)).toEqual(["alpha"]);
  });
});
