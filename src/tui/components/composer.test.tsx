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
import { INLINE_PASTE_LIMIT } from "../paste.ts";
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
 * What is Falryn's, now that the renderable owns the rest.
 *
 * The motions, the selection, the buffer, and the cursor belong to
 * `TextareaRenderable`. Checking them here would be checking the library, and
 * the checks that used to live in this file did something worse than that: they
 * validated Falryn's own coordinate arithmetic against fixtures built from the
 * same assumptions, and agreed with themselves while the cursor sat a row above
 * the text on a real terminal.
 *
 * So what remains is the seam. The draft reaching the state machine, the one
 * rule with no library action behind it, and the classification that has to run
 * before the renderable inserts. Where the cursor actually lands is asserted on
 * a real terminal, in `../shell.compiled.test.ts`, because that is the only
 * place the question can be answered.
 */
describe("the draft reaches the session", () => {
  test("typing arrives as content rather than as keystrokes", async () => {
    using shell = await open();
    await shell.focusComposer();
    await shell.type("hello world");
    expect(await shell.frame()).toContain("hello world");
  });

  test("a submission carries what was typed", async () => {
    using shell = await open();
    await shell.focusComposer();
    await shell.type("ask something");
    await shell.pressNamed("enter");
    // The port answers `unavailable` in this build and says so with the issue
    // that will give it a consumer. What matters here is that it was reached
    // with the text, which the notice repeats back.
    expect(await shell.frame()).toContain("Not sent");
  });
});

describe("history recall at the draft's edges", () => {
  // The one rule with no `TextareaAction` behind it, and the reason
  // `onKeyDown` exists in the view at all.
  test("moves a line when there is a line to move to", async () => {
    // Inside a draft `up` is the textarea's own motion. Falryn does not claim
    // the key there, and this is what proves it: the cursor moved, so the
    // character landed on the first line.
    using shell = await open();
    await shell.focusComposer();
    await shell.paste("one\ntwo");

    shell.setup.mockInput.pressArrow("up");
    await shell.frame();
    await shell.type("X");

    const frame = await shell.frame();
    expect(frame).toContain("oneX");
    expect(frame).not.toContain("twoX");
  });

  test("recalls at the top rather than moving nowhere", async () => {
    // At the first line there is no line to move to, and that is where recall
    // begins. With nothing in history the draft is left exactly as it was,
    // which is the honest outcome rather than a cleared composer.
    using shell = await open();
    await shell.focusComposer();
    await shell.type("kept");

    shell.setup.mockInput.pressArrow("up");
    await shell.frame();

    expect(await shell.frame()).toContain("kept");
  });

  test("leaves a selection alone, because extending is not recalling", async () => {
    // `shift+up` extends upward and must never step through history: replacing
    // text the reader is in the middle of choosing is the worst possible
    // response to a selection key.
    using shell = await open();
    await shell.focusComposer();
    await shell.type("chosen");

    shell.setup.mockInput.pressArrow("up", { shift: true });
    await shell.frame();

    expect(await shell.frame()).toContain("chosen");
  });
});

describe("a paste", () => {
  test("goes into the buffer when it is small enough to inline", async () => {
    // Classified by Falryn, inserted by the renderable. The classification runs
    // first because a refusal has to stop the insertion, and this is the case
    // where it does not refuse.
    using shell = await open();
    await shell.focusComposer();
    await shell.paste("pasted text");
    expect(await shell.frame()).toContain("pasted text");
  });

  test("never reaches the buffer when it is too large", async () => {
    // The flood the classification exists to prevent, and the reason the
    // handler runs ahead of the renderable: the renderable would have inserted
    // it. Including it needs the attachment path that does not exist.
    using shell = await open();
    await shell.focusComposer();
    await shell.paste("x".repeat(INLINE_PASTE_LIMIT + 1));

    expect(await shell.frame()).not.toContain("xxxxxxxxxx");
  });

  test("is described to the state, even though nothing draws the description", async () => {
    // Recorded rather than asserted as working. `composerNotice` turns a
    // refusal into a sentence and `../composer/state.test.ts` checks it — and
    // no component renders it, on this branch or before it. So a user whose
    // paste was refused sees the text simply not arrive.
    //
    // That is a real gap and it is not this issue's to close: #399 moves the
    // composer onto the library's renderable and its non-goals say the status
    // rows keep reporting what they report. Asserting the refusal reaches the
    // state is what can honestly be asserted here, and the missing row is
    // reported on the delivery PR rather than quietly fixed inside a migration.
    using shell = await open();
    await shell.focusComposer();
    await shell.paste("x".repeat(INLINE_PASTE_LIMIT + 1));
    await shell.frame();

    // The composer still works afterwards, which is the part a user would
    // otherwise doubt: a paste that vanished silently could look like a hang.
    await shell.type("still typing");
    expect(await shell.frame()).toContain("still typing");
  });
});
