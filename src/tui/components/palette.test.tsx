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
import { SHELL_COMMANDS } from "../commands.ts";
import { createTextCache } from "../text-cache.ts";
import type { ThemeRequest } from "../theme/index.ts";
import { resolveTheme } from "../theme/index.ts";
import type { CommandEntry } from "../view-model.ts";
import { known, type ShellModel, unavailable } from "../view-model.ts";
import { type Frame, FrameProvider } from "./context.tsx";
import { CommandPalette } from "./overlay-routes.tsx";
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
    // Nineteen rows since #368, which is the sixteen this was written against
    // plus the three the composer takes. The overlay used to be sized from
    // `viewport.rows - 2`, a reserve that predates the composer; it is sized from
    // the primary region now, so the same panel needs a taller terminal. The
    // budget being asserted is unchanged.
    const session = await mount({ columns: 100, rows: 19 });
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

/**
 * Every registered command as a row, all available.
 *
 * The real registry rather than a handful of literals: the defect below is about
 * a list longer than its budget, and a fixture of three would not be one.
 */
const EVERY_COMMAND: readonly CommandEntry[] = SHELL_COMMANDS.map((command) => ({
  id: command.id,
  title: command.title,
  description: command.description,
  binding: command.defaultBinding,
  unavailableReason: null,
}));

/** A frame value, so the palette can be rendered without the whole shell. */
const FRAME: Frame = {
  theme: resolveTheme({
    variant: "dark",
    colorLevel: "truecolor",
    symbols: "unicode",
    reducedMotion: true,
    generation: 1,
  }),
  viewport: { columns: 80, rows: 24 },
  terminal: { columns: 80, rows: 24 },
  layout: { kind: "layout", class: "standard" },
  cache: createTextCache({ generation: 1 }),
  composerRows: 3,
};

/** The palette alone, at an exact row budget. */
async function palette(
  rows: number,
  commands: readonly CommandEntry[] = EVERY_COMMAND,
  query = "",
): Promise<readonly string[]> {
  const setup = await createTestRenderer({
    width: 80,
    height: 12,
    screenMode: "alternate-screen",
    consoleMode: "disabled",
  });
  live.push(setup);

  createRoot(setup.renderer).render(
    <FrameProvider value={FRAME}>
      <CommandPalette commands={commands} query={query} rows={rows} />
    </FrameProvider>,
  );
  await settle(setup);
  return setup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
}

describe("the row budget it was given", () => {
  test("never claims nothing matches while reporting what it hid", async () => {
    // The regression this file exists to prevent a second time. Asking whether
    // any row was *shown* conflates "your search found nothing" with "there was
    // no room to show what it found", and reports the first when the second is
    // true — so the palette said "Nothing matches that." directly above
    // "24 more", which cannot both be so.
    //
    // One and two rows are the reachable budgets: `OverlayHost` caps its height
    // at `OPENING_ROWS` while the reveal runs, so the palette is handed a
    // single row on every open where motion is not reduced.
    for (const rows of [1, 2, 3]) {
      const lines = await palette(rows);
      expect({ rows, claimed: lines.some((line) => line.includes("Nothing matches")) }).toEqual({
        rows,
        claimed: false,
      });
    }
  });

  test("says how little room there was rather than offering more of nothing", async () => {
    // "24 more" is only true when something was shown. With no room for a single
    // command it invites the reader to look for the rows above it.
    const lines = await palette(2);
    expect(lines.some((line) => line.includes("too little room to list them"))).toBe(true);
    expect(lines.some((line) => line.includes("more — narrow the search"))).toBe(false);
  });

  test("draws no more rows than it was given, at every budget", async () => {
    // Criterion 4, measured rather than argued. A terminal does not clip: a
    // surplus row lands on its neighbour, so the count is the guard.
    for (const rows of [1, 2, 3, 6, 12]) {
      const lines = await palette(rows);
      expect({ rows, drawn: lines.length <= rows }).toEqual({ rows, drawn: true });
    }
  });

  test("still says nothing matches when the query really matches nothing", async () => {
    // The other half. The empty-result line is not removed, only stopped from
    // standing in for a budget that was too small.
    const lines = await palette(6, [], "zzzz");
    expect(lines.some((line) => line.includes("Nothing matches that."))).toBe(true);
  });

  test("spends a one-row budget on the query alone", async () => {
    // Nothing else fits, and drawing the notice anyway is how the search line
    // and the notice land on the same row.
    const lines = await palette(1);
    expect(lines.length).toBe(1);
    expect(lines[0] ?? "").toContain("Type to search commands.");
  });
});
