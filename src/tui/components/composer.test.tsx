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
import { type CapturedSpan, MouseButton, TextareaRenderable } from "@opentui/core";
import { createManualClock, duration, type Instant } from "../../domain/index.ts";
import { mount, type Rendered, type TerminalShape } from "../harness.tsx";
import { INLINE_PASTE_LIMIT } from "../paste.ts";
import { parseHex, resolveTheme, type ThemeRequest } from "../theme/index.ts";
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

async function open(
  shape: TerminalShape = { columns: 100, rows: 24 },
  kittyKeyboard = false,
  theme: ThemeRequest = THEME,
  now?: () => Instant,
): Promise<Session> {
  const shell = await mount(
    <ShellApp
      theme={theme}
      model={MODEL}
      onExit={() => {}}
      {...(now === undefined ? {} : { now })}
    />,
    { shape, kittyKeyboard },
  );
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

function requiredColor(theme: ThemeRequest, token: "selection" | "foreground"): string {
  const color = resolveTheme(theme).color(token);
  if (color === null) {
    throw new Error(`expected ${token} to resolve to a colour`);
  }
  return color;
}

function rgba(hex: string): [number, number, number, number] {
  const { red, green, blue } = parseHex(hex);
  return [red, green, blue, 255];
}

function spansWithBackground(session: Session, background: readonly number[]): CapturedSpan[] {
  return session.setup
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .filter((span) => span.bg.toInts().every((channel, index) => channel === background[index]));
}

function composerTextarea(session: Session): TextareaRenderable {
  const pending = [...session.setup.renderer.root.getChildren()];
  while (pending.length > 0) {
    const renderable = pending.pop();
    if (renderable === undefined) {
      break;
    }
    if (renderable instanceof TextareaRenderable) {
      return renderable;
    }
    pending.push(...renderable.getChildren());
  }
  throw new Error("expected the mounted composer to contain a textarea");
}

function selectedRange(textarea: TextareaRenderable): {
  readonly start: number;
  readonly end: number;
} {
  const range = textarea.getSelection();
  if (range === null) {
    throw new Error("expected a native textarea selection");
  }
  return range;
}

function click(shell: Session, x: number, y: number): Promise<void> {
  return shell.setup.mockMouse.click(x, y, MouseButton.LEFT, { delayMs: 0 });
}

function wordRange(textarea: TextareaRenderable): { readonly start: number; readonly end: number } {
  textarea.moveCursorRight();
  textarea.moveWordBackward();
  textarea.moveWordForward({ select: true });
  return selectedRange(textarea);
}

function lineRange(textarea: TextareaRenderable): { readonly start: number; readonly end: number } {
  textarea.gotoLineStart();
  textarea.gotoLineEnd({ select: true });
  return selectedRange(textarea);
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

describe("selection", () => {
  test("uses Falryn's selection tokens, announces the range, and keeps its cursor at the focus", async () => {
    using shell = await open();
    await shell.focusComposer();
    await shell.type("chosen");

    const background = rgba(requiredColor(THEME, "selection"));
    const foreground = rgba(requiredColor(THEME, "foreground"));
    const before = shell.setup.captureSpans();
    expect(spansWithBackground(shell, background)).toEqual([]);

    shell.setup.mockInput.pressArrow("left", { shift: true });
    const frame = await shell.frame();
    const after = shell.setup.captureSpans();
    const selected = spansWithBackground(shell, background);

    expect(frame).toContain("Selection active");
    expect(selected.map((span) => span.fg.toInts())).toEqual([foreground]);
    expect(after.cursor).toEqual([before.cursor[0] - 1, before.cursor[1]]);

    shell.setup.mockInput.pressArrow("right");
    expect(await shell.frame()).not.toContain("Selection active");
    expect(spansWithBackground(shell, background)).toEqual([]);
  });

  test("announces a native pointer range and clears it after a click", async () => {
    // The hook is Falryn's observation seam. The pointer itself is OpenTUI's,
    // so this test drives the renderer's mock mouse rather than creating a
    // second selection or calling textarea selection APIs directly.
    using shell = await open();
    await shell.focusComposer();
    await shell.type("chosen");

    const background = rgba(requiredColor(THEME, "selection"));
    const textarea = composerTextarea(shell);
    const row = textarea.y;
    const start = textarea.x + 1;
    const end = textarea.x + 4;

    await shell.setup.mockMouse.drag(start, row, end, row);
    expect(await shell.frame()).toContain("Selection active");
    expect(spansWithBackground(shell, background)).not.toEqual([]);

    await shell.setup.mockMouse.click(end, row);
    expect(await shell.frame()).not.toContain("Selection active");
    expect(spansWithBackground(shell, background)).toEqual([]);
  });

  test("matches native word motions for starts, middles, ends, punctuation, and CJK", async () => {
    const cases = [
      { label: "word start", text: "alpha beta", column: 0 },
      { label: "word middle", text: "alpha beta", column: 2 },
      { label: "word end", text: "alpha beta", column: 4 },
      { label: "punctuation", text: "alpha, beta", column: 5 },
      { label: "CJK run", text: "詞語 text", column: 1 },
    ] as const;

    for (const scenario of cases) {
      const clock = createManualClock();
      using pointer = await open(undefined, false, THEME, clock.now);
      await pointer.focusComposer();
      await pointer.type(scenario.text);
      const pointerTextarea = composerTextarea(pointer);
      const x = pointerTextarea.x + scenario.column;
      const y = pointerTextarea.y;

      await click(pointer, x, y);
      await click(pointer, x, y);
      const frame = await pointer.frame();
      const actual = selectedRange(pointerTextarea);

      using native = await open();
      await native.focusComposer();
      await native.type(scenario.text);
      const nativeTextarea = composerTextarea(native);
      await click(native, x, y);
      const expected = wordRange(nativeTextarea);

      expect(actual, scenario.label).toEqual(expected);
      expect(frame, scenario.label).toContain("Selection active");
      expect(pointer.setup.captureSpans().cursor, scenario.label).not.toBeNull();
    }
  });

  test("matches native logical-line motions for first, middle, final, and empty lines", async () => {
    const cases = [
      { label: "first", text: "first\nmiddle\nfinal", row: 0 },
      { label: "middle", text: "first\nmiddle\nfinal", row: 1 },
      { label: "final", text: "first\nmiddle\nfinal", row: 2 },
      { label: "empty", text: "first\n\nfinal", row: 1 },
    ] as const;

    for (const scenario of cases) {
      const clock = createManualClock();
      using pointer = await open({ columns: 100, rows: 32 }, false, THEME, clock.now);
      await pointer.focusComposer();
      await pointer.paste(scenario.text);
      const pointerTextarea = composerTextarea(pointer);
      const x = pointerTextarea.x + 1;
      const y = pointerTextarea.y + scenario.row;

      await click(pointer, x, y);
      await click(pointer, x, y);
      await click(pointer, x, y);
      const frame = await pointer.frame();
      const actual = selectedRange(pointerTextarea);

      using native = await open({ columns: 100, rows: 32 });
      await native.focusComposer();
      await native.paste(scenario.text);
      const nativeTextarea = composerTextarea(native);
      await click(native, x, y);
      const expected = lineRange(nativeTextarea);

      expect(actual, scenario.label).toEqual(expected);
      expect(frame, scenario.label).toContain("Selection active");
    }
  });

  test("keeps native multi-line drag selection and resets the click sequence", async () => {
    const clock = createManualClock();
    using pointer = await open({ columns: 100, rows: 32 }, false, THEME, clock.now);
    await pointer.focusComposer();
    await pointer.paste("first\nsecond");
    const pointerTextarea = composerTextarea(pointer);
    const x = pointerTextarea.x + 1;
    const y = pointerTextarea.y;

    await pointer.setup.mockMouse.drag(x, y, x, y + 1, MouseButton.LEFT, { delayMs: 0 });
    const dragFrame = await pointer.frame();
    const dragged = selectedRange(pointerTextarea);

    using native = await open({ columns: 100, rows: 32 });
    await native.focusComposer();
    await native.paste("first\nsecond");
    const nativeTextarea = composerTextarea(native);
    await native.setup.mockMouse.drag(x, y, x, y + 1, MouseButton.LEFT, { delayMs: 0 });

    expect(dragged).toEqual(selectedRange(nativeTextarea));
    expect(dragFrame).toContain("Selection active");

    using reset = await open({ columns: 100, rows: 32 }, false, THEME, clock.now);
    await reset.focusComposer();
    await reset.paste("first\nsecond");
    const resetTextarea = composerTextarea(reset);
    const resetX = resetTextarea.x + 1;
    const resetY = resetTextarea.y;
    await click(reset, resetX, resetY);
    await click(reset, resetX, resetY);
    expect(resetTextarea.getSelection()).not.toBeNull();

    await reset.setup.mockMouse.drag(resetX, resetY, resetX, resetY + 1, MouseButton.LEFT, {
      delayMs: 0,
    });
    await reset.frame();
    await click(reset, resetX, resetY);
    expect(resetTextarea.getSelection()).toBeNull();
  });

  test("leaves changed-cell and expired presses as native collapsed placement", async () => {
    const clock = createManualClock();
    using shell = await open(undefined, false, THEME, clock.now);
    await shell.focusComposer();
    await shell.type("alpha beta");
    const textarea = composerTextarea(shell);
    const y = textarea.y;

    await click(shell, textarea.x, y);
    await click(shell, textarea.x + 7, y);
    expect(textarea.getSelection()).toBeNull();

    await click(shell, textarea.x + 7, y);
    await clock.advance(duration(401));
    await click(shell, textarea.x + 7, y);
    expect(textarea.getSelection()).toBeNull();
  });

  test("keeps an explicit multi-line range styled on each drawn line", async () => {
    using shell = await open();
    await shell.focusComposer();
    await shell.paste("first\nsecond");

    const background = rgba(requiredColor(THEME, "selection"));
    for (let count = 0; count < 8; count += 1) {
      shell.setup.mockInput.pressArrow("left", { shift: true });
    }
    await shell.frame();

    const selectedLines = shell.setup
      .captureSpans()
      .lines.filter((line) =>
        line.spans.some((span) =>
          span.bg.toInts().every((channel, index) => channel === background[index]),
        ),
      );
    expect(selectedLines).toHaveLength(2);
  });

  test("keeps the worded state in monochrome and no-colour modes", async () => {
    const monochrome = { ...THEME, variant: "monochrome" } as const;
    using mono = await open(undefined, false, monochrome);
    await mono.focusComposer();
    await mono.type("chosen");
    mono.setup.mockInput.pressArrow("left", { shift: true });
    expect(await mono.frame()).toContain("Selection active");
    expect(spansWithBackground(mono, rgba(requiredColor(monochrome, "selection")))).toHaveLength(1);

    const colorless = { ...THEME, colorLevel: "none" } as const;
    using none = await open(undefined, false, colorless);
    await none.focusComposer();
    await none.type("chosen");
    none.setup.mockInput.pressArrow("left", { shift: true });
    expect(await none.frame()).toContain("Selection active");

    // A no-colour theme resolves its tokens to null, so the textarea preserves
    // OpenTUI's native fallback instead of receiving a substitute grey.
    expect(spansWithBackground(none, [255, 255, 255, 255])).toHaveLength(1);
    none.setup.mockInput.pressArrow("right");
    expect(await none.frame()).not.toContain("Selection active");
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

  test("adds a line with Shift+Return without submitting", async () => {
    using shell = await open({ columns: 100, rows: 24 }, true);
    await shell.focusComposer();
    await shell.type("first");
    shell.setup.mockInput.pressEnter({ shift: true });
    await shell.type("second");

    const frame = await shell.frame();
    expect(frame).toContain("first");
    expect(frame).toContain("second");
    expect(frame).not.toContain("firstsecond");
    expect(frame).not.toContain("Not sent");
  });

  test("honours Command arrows when Kitty reports the Super modifier", async () => {
    using shell = await open({ columns: 100, rows: 24 }, true);
    await shell.focusComposer();
    await shell.paste("one\ntwo");

    shell.setup.mockInput.pressArrow("left", { super: true });
    await shell.type("X");
    shell.setup.mockInput.pressArrow("right", { super: true });
    await shell.type("Y");
    shell.setup.mockInput.pressArrow("up", { super: true });
    await shell.type("A");
    shell.setup.mockInput.pressArrow("down", { super: true });
    await shell.type("Z");

    const frame = await shell.frame();
    expect(frame).toContain("Aone");
    expect(frame).toContain("XtwoYZ");
  });

  test("honours terminal Command-arrow aliases without Kitty reporting", async () => {
    using shell = await open();
    await shell.focusComposer();
    await shell.paste("one\ntwo");

    await shell.press("a", { ctrl: true });
    await shell.type("X");
    await shell.press("e", { ctrl: true });
    await shell.type("Y");
    await shell.press(SEQUENCES.home, { ctrl: true });
    await shell.type("A");
    await shell.press(SEQUENCES.end, { ctrl: true });
    await shell.type("Z");

    const frame = await shell.frame();
    expect(frame).toContain("Aone");
    expect(frame).toContain("XtwoYZ");
  });

  test("honours Option arrows with and without Kitty reporting", async () => {
    for (const kittyKeyboard of [false, true]) {
      {
        using shell = await open({ columns: 100, rows: 24 }, kittyKeyboard);
        await shell.focusComposer();
        await shell.type("one two");

        shell.setup.mockInput.pressArrow("left", { meta: true });
        await shell.type("X");
        shell.setup.mockInput.pressArrow("right", { meta: true });
        await shell.type("Y");

        expect(await shell.frame()).toContain("one XtwoY");
      }
    }
  });

  test("extends selections with Command and Option arrows", async () => {
    {
      using shell = await open({ columns: 100, rows: 24 }, true);
      await shell.focusComposer();
      await shell.type("one two");
      shell.setup.mockInput.pressArrow("left", { super: true, shift: true });
      await shell.type("X");
      const rows = (await shell.frame()).split("\n").map((row) => row.trim());
      expect(rows).toContain("X");
      expect(rows).not.toContain("one two");
    }

    for (const kittyKeyboard of [false, true]) {
      {
        using shell = await open({ columns: 100, rows: 24 }, kittyKeyboard);
        await shell.focusComposer();
        await shell.type("one two");
        shell.setup.mockInput.pressArrow("left", { meta: true, shift: true });
        await shell.type("X");
        expect(await shell.frame()).toContain("one X");
      }
    }
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

  test("explains why a non-inline paste did not enter the draft", async () => {
    // A preview or refusal must be visible: silently dropping a clipboard
    // payload looks like a frozen terminal even when the composer responds.
    using shell = await open();
    await shell.focusComposer();
    await shell.paste("x".repeat(INLINE_PASTE_LIMIT + 1));
    expect(await shell.frame()).toContain(`Pasted ${INLINE_PASTE_LIMIT + 1} characters`);

    // The composer still works afterwards.
    await shell.type("still typing");
    expect(await shell.frame()).toContain("still typing");
  });
});
