/**
 * The command palette's search, on a real terminal.
 *
 * Every criterion #364 names is a claim about what happens when someone types,
 * so every test here presses keys and reads the frame. A unit test over
 * `searchCommands` would have passed before this issue existed — the matcher was
 * always correct, and the defect was that nothing called it.
 *
 * The row-budget case is here rather than in a unit test for the same reason. "A
 * truncated list draws within its budget" is a claim about what a renderer put
 * on the screen, and the failure it guards is an extra row drawn over the
 * panel's own border, which only a frame can show.
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

type Session = {
  openPalette(): Promise<void>;
  type(text: string): Promise<void>;
  backspace(): Promise<void>;
  escape(): Promise<void>;
  frame(): Promise<string>;
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
    async openPalette() {
      setup.mockInput.pressKey("p", { ctrl: true });
      await settle(setup);
    },
    async type(text) {
      for (const character of text) {
        setup.mockInput.pressKey(character);
      }
      await settle(setup);
    },
    async backspace() {
      setup.mockInput.pressBackspace();
      await settle(setup);
    },
    async escape() {
      // The mock's own helper: `pressKey("escape")` would type the six letters
      // of the word, which asserts that nothing happened and passes.
      setup.mockInput.pressEscape();
      await settle(setup);
    },
    frame: async () => {
      await settle(setup);
      return setup.captureCharFrame();
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

describe("typing into the palette", () => {
  test("narrows the listed commands", async () => {
    // The acceptance criterion, and the whole point of the issue: before this,
    // the palette was handed a literal empty query and typing narrowed nothing.
    const session = await mount();
    await session.openPalette();

    const everything = await session.frame();
    expect(everything).toContain("Command palette");
    expect(everything).toContain("Exit");

    await session.type("exit");
    const narrowed = await session.frame();
    expect(narrowed).toContain("Search: exit");
    expect(narrowed).toContain("Exit");
    expect(narrowed).not.toContain("Command palette");
  });

  test("matches a stable command id, not only display text", async () => {
    // Someone reading the published reference types `app.help`, and a palette
    // that searched display text alone would not find what the documentation
    // told them to look for. The matcher already did this; now it is reachable.
    const session = await mount();
    await session.openPalette();
    await session.type("app.help");

    const frame = await session.frame();
    expect(frame).toContain("Help");
    expect(frame).not.toContain("Exit");
  });

  test("says nothing matches rather than showing an empty panel", async () => {
    // The branch that was unreachable before this issue. A blank region is a
    // rendering gap the reader has to interpret; a sentence is an answer.
    const session = await mount();
    await session.openPalette();
    await session.type("zzzznotacommand");

    expect(await session.frame()).toContain("Nothing matches that.");
  });

  test("widens again when characters are removed", async () => {
    const session = await mount();
    await session.openPalette();
    await session.type("exitx");
    expect(await session.frame()).toContain("Nothing matches that.");

    await session.backspace();
    const frame = await session.frame();
    expect(frame).toContain("Search: exit");
    expect(frame).toContain("Exit");
  });

  test("accepts a character that is a binding elsewhere", async () => {
    // `?` opens help from every other surface. The palette is a focused text
    // control, so bare single-character bindings are withheld while it is open —
    // otherwise a question mark could never be searched for.
    const session = await mount();
    await session.openPalette();
    await session.type("?");

    const frame = await session.frame();
    expect(frame).toContain("Search: ?");
    // Help did not open over it.
    expect(frame).not.toContain("Ctrl+C ends the session.");
  });
});

describe("closing the palette", () => {
  test("clears the query, so reopening starts fresh", async () => {
    // True by construction rather than by bookkeeping: the query lives on the
    // route, and closing replaces the route. There is nowhere for a stale search
    // to survive.
    const session = await mount();
    await session.openPalette();
    await session.type("exit");
    expect(await session.frame()).toContain("Search: exit");

    await session.escape();
    expect(await session.frame()).not.toContain("Search: exit");

    await session.openPalette();
    const reopened = await session.frame();
    expect(reopened).toContain("Type to search commands.");
    expect(reopened).not.toContain("Search: exit");
  });

  test("still leaves escape bound while the search has focus", async () => {
    // The withholding rule is narrow: only bare characters are withheld, so the
    // way out of the overlay keeps working while typing.
    const session = await mount();
    await session.openPalette();
    await session.type("e");
    await session.escape();

    expect(await session.frame()).not.toContain("Type to search commands.");
  });
});

describe("the row budget", () => {
  test("a truncated list draws every row it shows intact", async () => {
    // The second defect #364 names. The budget was computed and then discarded —
    // the render sliced to `rows - 1` and lost the row the notice needs — so a
    // truncated palette asked for one row more than the panel had. The panel
    // does not grow: the surplus row collides with its neighbour, and what
    // reaches the screen is two command rows spliced into one.
    //
    // So the assertion is intactness rather than a row count. A count cannot see
    // it, because the panel's height is the same either way.
    const session = await mount({ columns: 100, rows: 16 });
    await session.openPalette();
    const frame = await session.frame();

    expect(frame).toContain("more — narrow the search");
    // The last row the corrected budget has room for. With the off-by-one it is
    // the one overwritten, and the frame shows `Focusrprevious` where two rows
    // landed on top of each other.
    expect(frame).toContain("Focus next region");
    expect(frame).not.toMatch(/Focus\S+previous/);
  });

  test("drops the notice when nothing is hidden", async () => {
    const session = await mount();
    await session.openPalette();
    await session.type("exit");

    expect(await session.frame()).not.toContain("more — narrow the search");
  });
});
