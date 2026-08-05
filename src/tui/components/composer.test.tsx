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
