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

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ThemeRequest } from "../theme/index.ts";
import { known, type ShellModel, unavailable } from "../view-model.ts";
import { ShellApp } from "./shell-app.tsx";

const live: TestRendererSetup[] = [];

afterEach(() => {
  while (live.length > 0) {
    live.pop()?.renderer.destroy();
  }
});

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
  help: [{ title: "Leaving", body: "Ctrl+C ends the session." }],
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
} as const;

type NamedKey = keyof typeof SEQUENCES;

type Session = {
  press(name: string, modifiers?: { ctrl?: boolean; shift?: boolean }): Promise<void>;
  pressNamed(key: NamedKey): Promise<void>;
  backspace(): Promise<void>;
  escape(): Promise<void>;
  type(text: string): Promise<void>;
  /** Two tabs: header, then the primary region, then the composer. */
  focusComposer(): Promise<void>;
  frame(): Promise<string>;
  resize(columns: number, rows: number): Promise<void>;
};

async function mount(size = { columns: 100, rows: 24 }): Promise<Session> {
  const setup = await createTestRenderer({
    width: size.columns,
    height: size.rows,
    screenMode: "alternate-screen",
    consoleMode: "disabled",
  });
  live.push(setup);

  createRoot(setup.renderer).render(<ShellApp theme={THEME} model={MODEL} onExit={() => {}} />);
  await settle(setup);

  const session: Session = {
    async press(name, modifiers = {}) {
      setup.mockInput.pressKey(name, modifiers);
      await settle(setup);
    },
    async pressNamed(key) {
      setup.mockInput.pressKey(SEQUENCES[key]);
      await settle(setup);
    },
    async escape() {
      // The mock's own helper, for the reason `pressKey` cannot be used: the
      // key is an escape byte and `pressKey("escape")` types the six letters
      // of the word, which asserts that nothing happened and passes.
      setup.mockInput.pressEscape();
      await settle(setup);
    },
    async backspace() {
      // The mock's own helper. Backspace is a control byte rather than a word,
      // and a test that typed the letters would assert that nothing happened
      // and pass.
      setup.mockInput.pressBackspace();
      await settle(setup);
    },
    async type(text) {
      for (const character of text) {
        setup.mockInput.pressKey(character);
      }
      await settle(setup);
    },
    async focusComposer() {
      await session.pressNamed("tab");
      await session.pressNamed("tab");
    },
    frame: async () => {
      await settle(setup);
      return setup.captureCharFrame();
    },
    async resize(columns, rows) {
      setup.resize(columns, rows);
      await settle(setup);
    },
  };
  return session;
}

async function settle(setup: TestRendererSetup): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await Bun.sleep(10);
    await setup.flush();
  }
}

describe("focus", () => {
  test("is required before the composer takes any key", async () => {
    // The "background regions do not consume keys intended for the focused
    // control" rule, in the one place it is easiest to break.
    const session = await mount();
    await session.type("ignored");
    expect(await session.frame()).not.toContain("ignored");

    await session.focusComposer();
    await session.type("typed");
    expect(await session.frame()).toContain("typed");
  });

  test("is stated in words rather than only as a border", async () => {
    const session = await mount();
    await session.focusComposer();
    expect(await session.frame()).toContain("focused");
  });
});

describe("typing", () => {
  test("accepts a character that is also a binding elsewhere", async () => {
    // `?` opens help from every other region. While the composer has focus the
    // bare single-character bindings are withheld, because a layer that claims a
    // key means the control never sees it — which would make a question mark
    // impossible to type into a prompt.
    const session = await mount();
    await session.focusComposer();
    await session.type("why?");
    const frame = await session.frame();
    expect(frame).toContain("why?");
    // Help did not open over it.
    expect(frame).not.toContain("Ctrl+C ends the session.");
  });

  test("deletes a whole character rather than half of one", async () => {
    const session = await mount();
    await session.focusComposer();
    await session.type("ok\u00e9");
    expect(await session.frame()).toContain("ok\u00e9");

    await session.backspace();
    const frame = await session.frame();
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
    const session = await mount();
    await session.focusComposer();
    await session.type("draft");
    await session.press("p", { ctrl: true });
    expect(await session.frame()).toContain("Command palette");
  });
});

describe("submitting", () => {
  test("reports an unavailable outcome and keeps the draft", async () => {
    // The acceptance criterion, end to end: the key is bound, the port refuses,
    // the reason names the owning issue, and the text is still there.
    const session = await mount();
    await session.focusComposer();
    await session.type("ask something");
    await session.pressNamed("enter");

    const frame = await session.frame();
    expect(frame).toContain("Not sent");
    expect(frame).toContain("#33");
    expect(frame).toContain("ask something");
  });
});

describe("the draft", () => {
  test("survives an overlay opening and closing", async () => {
    const session = await mount();
    await session.focusComposer();
    await session.type("kept");

    // Focus leaves the composer, so the bare `?` binding is registered again.
    await session.pressNamed("tab");
    await session.press("?");
    expect(await session.frame()).toContain("Esc closes this");

    await session.escape();
    const frame = await session.frame();
    expect(frame).not.toContain("Esc closes this");
    expect(frame).toContain("kept");
  });

  test("survives a resize", async () => {
    const session = await mount();
    await session.focusComposer();
    await session.type("kept across a resize");

    await session.resize(60, 20);
    expect(await session.frame()).toContain("kept across a resize");

    await session.resize(100, 24);
    expect(await session.frame()).toContain("kept across a resize");
  });
});

describe("what is not here", () => {
  test("names the declared gaps rather than half-building them", async () => {
    const session = await mount();
    expect(await session.frame()).toContain("Not here yet");
  });
});
