/**
 * The composer, on a real terminal.
 *
 * The unit tests prove the editing model, the history, and the state machine in
 * isolation. This proves they are wired to each other, to the keymap, and to a
 * terminal — including the parts that can only be observed by pressing a key and
 * looking at the screen.
 *
 * Draft survival is the reason most of these exist. "The draft survives an
 * overlay" is a claim about what a component tree does when it re-renders with a
 * different route, and a claim about a reducer would not have caught a composer
 * that held its own text in component state.
 */

import { describe, expect, test } from "bun:test";
import { mount, type Rendered, type TerminalShape } from "../harness.tsx";
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
 * The escape sequences the named keys actually send.
 *
 * `pressKey("enter")` types the five characters of the word, so the sequences
 * are written out. See `./transcript.test.tsx`, which makes the same point.
 */
const SEQUENCES = {
  enter: "\r",
  tab: "\t",
  left: "\u001b[D",
  home: "\u001b[H",
  end: "\u001b[F",
} as const;

type NamedKey = keyof typeof SEQUENCES;

/** A mounted shell whose composer these checks type into. */
type Session = Rendered & {
  /** Two tabs: header, then the primary region, then the composer. */
  focusComposer(): Promise<string>;
  pressNamed(key: NamedKey): Promise<string>;
};

async function open(shape: TerminalShape = { columns: 100, rows: 24 }): Promise<Session> {
  const shell = await mount(<ShellApp theme={THEME} model={MODEL} onExit={() => {}} />, {
    shape,
    screenMode: "alternate-screen",
  });
  await shell.frame();
  const pressNamed = (key: NamedKey): Promise<string> => shell.press(SEQUENCES[key]);
  return Object.assign(shell, {
    pressNamed,
    async focusComposer() {
      await pressNamed("tab");
      return await pressNamed("tab");
    },
  });
}

describe("focus", () => {
  test("is required before the composer takes any key", async () => {
    // The "background regions do not consume keys intended for the focused
    // control" rule, in the one place it is easiest to break.
    using shell = await open();
    await shell.type("ignored");
    expect(await shell.frame()).not.toContain("ignored");

    await shell.focusComposer();
    await shell.type("typed");
    expect(await shell.frame()).toContain("typed");
  });

  test("is stated in words rather than only as a border", async () => {
    using shell = await open();
    await shell.focusComposer();
    expect(await shell.frame()).toContain("focused");
  });
});

describe("typing", () => {
  test("accepts a character that is also a binding elsewhere", async () => {
    // `?` opens help from every other region. While the composer has focus the
    // bare single-character bindings are withheld, because a layer that claims a
    // key means the control never sees it — which would make a question mark
    // impossible to type into a prompt.
    using shell = await open();
    await shell.focusComposer();
    await shell.type("why?");
    const frame = await shell.frame();
    expect(frame).toContain("why?");
    // Help did not open over it.
    expect(frame).not.toContain("Ctrl+C ends the shell.");
  });

  test("deletes a whole character rather than half of one", async () => {
    using shell = await open();
    await shell.focusComposer();
    await shell.type("ok\u00e9");
    expect(await shell.frame()).toContain("ok\u00e9");

    await shell.pressBackspace();
    const frame = await shell.frame();
    // One backspace removed the whole accented character, its base letter
    // included. The failure a code-point cursor produces is `ok` followed by a
    // stranded accent, which is why the assertion names the composed form.
    expect(frame).toContain("ok");
    expect(frame).not.toContain("\u00e9");
  });

  test("still leaves both ways out bound", async () => {
    // The rule withholds bare characters only, so every modified and named
    // binding keeps working while typing — including the two commands that may
    // never be unbound.
    using shell = await open();
    await shell.focusComposer();
    await shell.type("draft");
    await shell.press("p", { ctrl: true });
    expect(await shell.frame()).toContain("Command palette");
  });
});

describe("submitting", () => {
  test("reports an unavailable outcome and keeps the draft", async () => {
    // The acceptance criterion, end to end: the key is bound, the port refuses,
    // the reason names the owning issue, and the text is still there.
    using shell = await open();
    await shell.focusComposer();
    await shell.type("ask something");
    await shell.pressNamed("enter");

    const frame = await shell.frame();
    expect(frame).toContain("Not sent");
    expect(frame).toContain("#33");
    expect(frame).toContain("ask something");
  });
});

describe("the draft", () => {
  test("survives an overlay opening and closing", async () => {
    using shell = await open();
    await shell.focusComposer();
    await shell.type("kept");

    // Focus leaves the composer, so the bare `?` binding is registered again.
    await shell.pressNamed("tab");
    await shell.press("?");
    expect(await shell.frame()).toContain("Esc closes this");

    await shell.pressEscape();
    const frame = await shell.frame();
    expect(frame).not.toContain("Esc closes this");
    expect(frame).toContain("kept");
  });

  test("survives a resize", async () => {
    using shell = await open();
    await shell.focusComposer();
    await shell.type("kept across a resize");

    await shell.resize(60, 20);
    expect(await shell.frame()).toContain("kept across a resize");

    await shell.resize(100, 24);
    expect(await shell.frame()).toContain("kept across a resize");
  });
});

describe("what is not here", () => {
  test("names the declared gaps rather than half-building them", async () => {
    using shell = await open();
    expect(await shell.frame()).toContain("Not here yet");
  });
});

/**
 * Where the composer's first chrome row is drawn, as a row index in the frame.
 *
 * Derived from the frame rather than computed from the layout, because a
 * constant here would be a second opinion about a number `../layout.ts` owns —
 * and the checks below are about where the cursor is *relative to the text*,
 * which survives the composer moving.
 */
function chromeRow(frame: string): number {
  const rows = frame.split("\n");
  const at = rows.findIndex((row) => /^\s*i\s/.test(row));
  if (at < 1) {
    throw new Error("the composer's status row was not found in the frame");
  }
  return at;
}

/** The cursor, as the renderer holds it. */
function cursorOf(shell: Rendered): { x: number; y: number; visible: boolean } {
  const { x, y, visible } = shell.setup.renderer.getCursorState();
  return { x, y, visible };
}

describe("the cursor", () => {
  test("leaves the text it is inside of alone", async () => {
    // #386, and the check that had to fail before it passed. The caret used to
    // be spliced into the line at the cursor's column, so a cursor in the middle
    // of a word drew `hello wo▏rld` — one grapheme longer than the buffer, with
    // everything after it displaced by a cell.
    //
    // At the end of a draft that is invisible, which is why it shipped and why
    // every other check in this file passed over it: they all type and assert
    // without moving the cursor back into what they typed.
    using shell = await open();
    await shell.focusComposer();
    await shell.type("hello world");

    await shell.press(SEQUENCES.left);
    await shell.press(SEQUENCES.left);
    const frame = await shell.press(SEQUENCES.left);

    expect(frame).toContain("hello world");
  });

  test("is placed on the first settled frame, not a frame later", async () => {
    // React commits on a microtask and Yoga lays out inside the renderer's own
    // pass, so an effect that reads a position without waiting for layout reads
    // one that does not exist yet. That failure is invisible after any later
    // redraw, which is what makes it worth asserting here rather than after a
    // keystroke: on the first frame there has been no later redraw to hide it.
    using shell = await open();
    const frame = await shell.frame();
    // The draft's only row sits directly above the composer's first chrome row.
    expect(cursorOf(shell).y).toBe(chromeRow(frame) - 1);
  });

  test("moves by cells, so a wide character counts twice", async () => {
    // A grapheme offset and a cell offset are different numbers. `日本` is two
    // graphemes and four cells, and a cursor placed by counting graphemes would
    // land inside the second character — the same defect this replaced, one
    // layer down, which is why it is a check rather than a follow-up.
    //
    // Measured as a delta between two positions rather than against an origin,
    // and that is not style: the renderer clamps the cursor's `x` to a minimum
    // of one, so column 0 and column 1 report the same number and an origin
    // taken on an empty draft is a cell short. Both readings here are well
    // clear of the clamp.
    using shell = await open();
    await shell.focusComposer();

    await shell.type("ab");
    const narrow = cursorOf(shell).x;

    await shell.type("日本");
    expect(cursorOf(shell).x - narrow).toBe(4);
  });

  test("follows a motion back into the text", async () => {
    using shell = await open();
    await shell.focusComposer();
    await shell.type("hello");
    const end = cursorOf(shell).x;

    await shell.press(SEQUENCES.left);
    await shell.press(SEQUENCES.left);
    expect(cursorOf(shell).x).toBe(end - 2);
  });

  test("is shown only while the composer has focus", async () => {
    // The gate is `model.focused` and nothing else: `../focus.ts` already moves
    // the focused region to an overlay's when one opens, so a palette over the
    // composer makes this false without a second rule about overlays.
    using shell = await open();
    await shell.frame();
    expect(cursorOf(shell).visible).toBe(false);

    await shell.focusComposer();
    expect(cursorOf(shell).visible).toBe(true);
  });
});

/**
 * The clicks below prove the *handler*, not the gate.
 *
 * The mock mouse emits events into the renderer directly, so these run whether
 * or not mouse reporting was ever turned on. That is the right split rather than
 * a gap: the gate lives at the transport — with reporting off a terminal sends
 * no mouse bytes at all — and is checked where it lives, in
 * `../capabilities.test.ts` and `../renderer-session.test.ts`. Reading these as
 * evidence that reporting is enabled would be reading them for something they
 * cannot see.
 */
describe("a click in the composer", () => {
  /** The composer's own row in the frame, and the cell its first character sits in. */
  async function composerRow(shell: Session): Promise<number> {
    return chromeRow(await shell.frame()) - 1;
  }

  test("places the cursor where it was clicked", async () => {
    using shell = await open();
    await shell.focusComposer();
    await shell.type("hello world");
    const row = await composerRow(shell);
    const end = cursorOf(shell).x;

    // Six cells in from the start of the draft: between `hello ` and `world`.
    await shell.setup.mockMouse.click(end - 5, row);
    await shell.frame();

    expect(cursorOf(shell).x).toBe(end - 5);
  });

  test("counts cells rather than graphemes, so a wide character is two", async () => {
    // The acceptance criterion, at a cell where a cell index and a grapheme
    // index differ. `日本` is two graphemes and four cells; a click on the cell
    // after them is grapheme two, and a mapping that counted graphemes would put
    // the cursor inside the first character.
    using shell = await open();
    await shell.focusComposer();
    await shell.type("日本ab");
    const row = await composerRow(shell);
    const end = cursorOf(shell).x;

    // Two cells back from the end is the boundary between `日本` and `ab`.
    await shell.setup.mockMouse.click(end - 2, row);
    await shell.frame();
    expect(cursorOf(shell).x).toBe(end - 2);

    // And typing there lands between them rather than inside the wide pair.
    await shell.type("X");
    expect(await shell.frame()).toContain("日本Xab");
  });

  test("places the cursor at the end of the line when clicked past the text", async () => {
    using shell = await open();
    await shell.focusComposer();
    await shell.type("short");
    const row = await composerRow(shell);
    const end = cursorOf(shell).x;

    await shell.setup.mockMouse.click(end + 40, row);
    await shell.frame();

    expect(cursorOf(shell).x).toBe(end);
  });

  test("focuses the composer, so the cursor it placed is visible", async () => {
    // #386 draws the cursor only while the composer has focus. A click that
    // placed one into an unfocused composer would leave no mark and send the
    // next keystroke somewhere else.
    using shell = await open();
    await shell.focusComposer();
    await shell.type("typed");
    const row = await composerRow(shell);

    // Away, then back by clicking rather than by tabbing.
    await shell.pressTab();
    expect(cursorOf(shell).visible).toBe(false);

    await shell.setup.mockMouse.click(1, row);
    await shell.frame();
    expect(cursorOf(shell).visible).toBe(true);
  });
});

describe("the keyboard reaches every motion", () => {
  /** The cursor's cell, which is what a motion visibly changes. */
  async function cell(shell: Session): Promise<number> {
    await shell.frame();
    return cursorOf(shell).x;
  }

  test("alt and ctrl arrows move by word", async () => {
    // Both, because they are the conventions of different platforms and a
    // terminal sends whichever its user's keyboard produces. Binding one would
    // make the feature present on macOS and absent on Linux for no reason a
    // user could see.
    //
    // The mock's `meta` modifier sets the CSI bit the parser decodes as
    // `option`, which is what Alt actually arrives as — `key.meta` is set by
    // Alt *and* by other things, so a binding that means Alt has to read
    // `option`.
    for (const modifiers of [{ meta: true }, { ctrl: true }] as const) {
      using shell = await open();
      await shell.focusComposer();
      await shell.type("one two three");
      const end = await cell(shell);

      shell.setup.mockInput.pressArrow("left", modifiers);
      const back = await cell(shell);
      // "three" is five characters, so a word left lands five cells earlier.
      expect({ modifiers, moved: end - back }).toEqual({ modifiers, moved: 5 });

      shell.setup.mockInput.pressArrow("right", modifiers);
      expect({ modifiers, at: await cell(shell) }).toEqual({ modifiers, at: end });
    }
  });

  test("a modified arrow is a word motion rather than a lesser plain one", async () => {
    // The defect #387 found rather than the feature it added. `editFor`
    // switched on `key.name` before any modifier was considered, so `alt+left`
    // fell into the plain-left case and moved one character — a chord that
    // looked bound and behaved worse than one that was missing.
    using shell = await open();
    await shell.focusComposer();
    await shell.type("one two");
    const end = await cell(shell);

    shell.setup.mockInput.pressArrow("left", { meta: true });
    expect(end - (await cell(shell))).not.toBe(1);
  });

  test("ctrl+home and ctrl+end reach the document's ends", async () => {
    // Two lines, and that is the whole check rather than a detail. On a
    // single-line draft a line's start and the document's start are the same
    // position, so an assertion there passes whether these chords give the
    // document motions or the line ones — measured, by making them return
    // `line-start`/`line-end` and watching nothing fail.
    //
    // The draft is pasted rather than typed: a newline in pasted text is
    // content rather than a submission, which is what bracketed paste is for,
    // and `shift+return` does not produce one through the mock keyboard.
    //
    // Asserted by what typing does rather than by the cursor's cell. The
    // renderer clamps the cursor's `x` to a minimum of one — recorded in #386 —
    // so a line's start and its second cell report the same number, and a
    // coordinate check would be off by one for a reason unrelated to the motion.
    using shell = await open();
    await shell.focusComposer();
    await shell.paste("alpha\nbravo");

    shell.setup.mockInput.pressKey(SEQUENCES.home, { ctrl: true });
    await shell.frame();
    await shell.type("X");
    const started = await shell.frame();
    // The *first* line took it. A line motion from the last line would have put
    // it at the start of `bravo` instead.
    expect(started).toContain("Xalpha");
    expect(started).not.toContain("Xbravo");

    shell.setup.mockInput.pressKey(SEQUENCES.end, { ctrl: true });
    await shell.frame();
    await shell.type("Z");
    const ended = await shell.frame();
    // And the *last* line did. A line motion from the first line would have put
    // it after `Xalpha`.
    expect(ended).toContain("bravoZ");
    expect(ended).not.toContain("XalphaZ");
  });

  test("shift with a motion extends the selection, on each binding that takes one", async () => {
    // Per binding rather than for one representative: `extend` is threaded
    // through every branch of the matcher, and a branch that dropped it would
    // pass a check that only exercised its neighbour.
    //
    // Typing is the discriminator, and it had to be measured. Deleting after the
    // motion does not separate the two — on `one two`, a shift+alt+left that
    // extended deletes the selection and one that did not deletes the space, and
    // both stop containing `one two`. Typing replaces a selection and inserts
    // without one, so the resulting text names which happened.
    const CASES = [
      {
        name: "shift+left",
        from: 0,
        press: (shell: Session) => shell.setup.mockInput.pressArrow("left", { shift: true }),
        extended: "one twX",
        moved: "one twXo",
      },
      {
        name: "shift+alt+left",
        from: 0,
        press: (shell: Session) =>
          shell.setup.mockInput.pressArrow("left", { shift: true, meta: true }),
        extended: "one X",
        moved: "one Xtwo",
      },
      {
        name: "shift+ctrl+left",
        from: 0,
        press: (shell: Session) =>
          shell.setup.mockInput.pressArrow("left", { shift: true, ctrl: true }),
        extended: "one X",
        moved: "one Xtwo",
      },
      {
        name: "shift+home",
        from: 0,
        press: (shell: Session) => shell.setup.mockInput.pressKey(SEQUENCES.home, { shift: true }),
        extended: "X",
        moved: "Xone two",
      },
      // The pair the plan singled out as the missing capability: `up` and `down`
      // are bound as commands and dispatch with `extend: false`, so shifted they
      // could not extend until this issue handled them where they land. They are
      // exercised on a single-line draft, where `up` is the document's start and
      // `down` its end — the composer's own `shift+return` does not produce a
      // newline through the mock keyboard, which is recorded on the delivery PR
      // as a separate observation rather than worked around here.
      {
        name: "shift+up",
        from: 2,
        press: (shell: Session) => shell.setup.mockInput.pressArrow("up", { shift: true }),
        extended: "Xwo",
        moved: "Xone two",
      },
      {
        name: "shift+down",
        from: 2,
        press: (shell: Session) => shell.setup.mockInput.pressArrow("down", { shift: true }),
        extended: "one tX",
        moved: "one twoX",
      },
    ] as const;

    for (const { name, from, press, extended, moved } of CASES) {
      using shell = await open();
      await shell.focusComposer();
      await shell.type("one two");
      // Where the motion starts, per case. The vertical pair needs the cursor
      // inside the text: at the end of the draft `shift+down` would select
      // nothing and pass whether or not it extended.
      for (let back = 0; back < from; back += 1) {
        await shell.press(SEQUENCES.left);
      }

      press(shell);
      await shell.frame();
      await shell.type("X");
      const frame = await shell.frame();

      // One shape of mistake this cannot catch, stated so nobody assumes it
      // does: making `chordMotion` claim bare `up` and `down` as well changes
      // nothing observable here, because the keymap dispatches them before any
      // subscriber sees them. The branch is unreachable for them by
      // construction, not by this check.
      //
      // The drawn draft line, compared exactly rather than searched for. A
      // substring match is not enough here and that was measured: with the
      // shifted vertical branch removed the motion does nothing, leaving
      // `one tXwo` — which *contains* the `Xwo` an extending motion produces, so
      // an `includes` check passed against the behaviour it existed to reject.
      const drawn = frame.split("\n")[chromeRow(frame) - 1]?.trimEnd() ?? "";
      expect({ name, drawn }).toEqual({ name, drawn: extended });
      expect({ name, inserted: drawn === moved }).toEqual({ name, inserted: false });
    }
  });

  test("a chord nothing binds still types nothing", async () => {
    // The rule that survived the matcher being rewritten. A chord falling
    // through to the text branch would type its letter — `alt+p` inserting `p`
    // is the failure this prevents.
    using shell = await open();
    await shell.focusComposer();
    await shell.type("kept");

    shell.setup.mockInput.pressKey("p", { meta: true });
    shell.setup.mockInput.pressKey("j", { ctrl: true });
    const frame = await shell.frame();

    expect(frame).toContain("kept");
    expect(frame).not.toContain("keptp");
    expect(frame).not.toContain("keptj");
  });
});
