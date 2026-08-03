/**
 * The frame, rendered.
 *
 * Every test here mounts a real React tree into a real OpenTUI renderer drawing
 * into memory, and asserts on the characters that reached the buffer. Semantic
 * assertions rather than golden frames: what matters is that the word "failed"
 * is on the screen, not which cell it started in, and a golden frame would fail
 * on a spacing change while passing on a status that quietly disappeared.
 *
 * The matrix each composite is put through — theme variant, colour depth,
 * Unicode and ASCII, compact through wide, reduced motion — is the acceptance
 * criteria's, and it is walked rather than sampled where the criterion says
 * "every".
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";
import { COLOR_LEVELS, SYMBOL_SUPPORTS } from "../../domain/index.ts";
import { STANDARD_COLUMNS, WIDE_COLUMNS } from "../layout.ts";
import {
  MINIMUM_COLUMNS,
  MINIMUM_ROWS,
  STATUS_PRESENTATION,
  STATUS_TOKENS,
  THEME_VARIANTS,
  type ThemeRequest,
} from "../theme/index.ts";
import type { ShellModel } from "../view-model.ts";
import { known, unavailable } from "../view-model.ts";
import { AppShell } from "./app-shell.tsx";

const live: TestRendererSetup[] = [];

afterEach(() => {
  // Unconditionally: a leaked renderer is process-wide state, so it fails the
  // next test rather than this one.
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

function model(overrides: Partial<ShellModel> = {}): ShellModel {
  return {
    header: {
      workspace: known("/work/falryn"),
      branch: unavailable("no Git yet"),
      session: known("s-1"),
      model: unavailable("no provider yet"),
    },
    status: {
      status: "informational",
      message: "Nothing is running.",
      hints: [{ keys: "^C", command: "exit" }],
    },
    overlay: { kind: "none" },
    commands: [],
    help: [],
    ...overrides,
  };
}

/**
 * Mounts a tree and returns the characters it drew.
 *
 * The sleep-and-flush loop is deliberate: React commits on a microtask and the
 * test renderer's own frame predicate advances passes without yielding to the
 * host loop, so a wait that never hands the loop back polls a buffer nothing has
 * drawn into.
 */
async function render(
  node: ReactNode,
  size: { columns: number; rows: number } = { columns: 100, rows: 30 },
  /**
   * Text to wait for, when the first painted frame is not the final one.
   *
   * An animated reveal commits several frames, and the early ones are a panel
   * two rows tall with nothing in it yet. A test that took the first non-empty
   * frame would be asserting on the middle of a transition.
   */
  until?: string,
): Promise<string> {
  const setup = await createTestRenderer({
    width: size.columns,
    height: size.rows,
    consoleMode: "disabled",
  });
  live.push(setup);
  createRoot(setup.renderer).render(node);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await Bun.sleep(5);
    await setup.flush();
    const frame = setup.captureCharFrame();
    const settled = until === undefined ? frame.trim() !== "" : frame.includes(until);
    if (settled) {
      return frame;
    }
  }
  return setup.captureCharFrame();
}

function shell(
  overrides: Partial<ShellModel> = {},
  theme: Partial<ThemeRequest> = {},
  size?: { columns: number; rows: number },
  until?: string,
): Promise<string> {
  return render(<AppShell theme={{ ...THEME, ...theme }} model={model(overrides)} />, size, until);
}

describe("the frame", () => {
  test("draws the header, the primary region, and the status line", async () => {
    const frame = await shell({}, {}, { columns: 100, rows: 30 });
    expect(frame).toContain("workspace");
    expect(frame).toContain("/work/falryn");
    expect(frame).toContain("no Git yet");
    expect(frame).toContain("exit");
  });

  test("renders in every variant at every colour depth", async () => {
    // The acceptance criterion's matrix. What is asserted is that the frame is
    // still *readable* — a variant that resolved to nothing would draw an empty
    // buffer, and one that threw would draw nothing at all.
    for (const variant of THEME_VARIANTS) {
      for (const colorLevel of COLOR_LEVELS) {
        const frame = await shell({}, { variant, colorLevel });
        expect({ variant, colorLevel, drew: frame.includes("/work/falryn") }).toEqual({
          variant,
          colorLevel,
          drew: true,
        });
      }
    }
  });

  test("renders in every symbol repertoire", async () => {
    for (const symbols of SYMBOL_SUPPORTS) {
      const frame = await shell({}, { symbols });
      expect({ symbols, drew: frame.includes("no Git yet") }).toEqual({ symbols, drew: true });
    }
  });
});

describe("status without colour", () => {
  test("still names every status in words", async () => {
    // The monochrome guarantee, at the level that matters: on screen. A status
    // rendered as a coloured glyph alone would pass every unit test of the
    // palette and be invisible here.
    for (const status of STATUS_TOKENS) {
      const frame = await shell(
        { status: { status, message: "", hints: [] } },
        { colorLevel: "none", variant: "monochrome" },
      );
      expect({ status, named: frame.includes(STATUS_PRESENTATION[status].label) }).toEqual({
        status,
        named: true,
      });
    }
  });

  test("draws a symbol beside the word, not instead of it", async () => {
    const frame = await shell(
      { status: { status: "error", message: "", hints: [] } },
      { colorLevel: "none" },
    );
    expect(frame).toContain("✗");
    expect(frame).toContain("failed");
  });
});

describe("the header's states", () => {
  test("says what is missing rather than showing a dash", async () => {
    // A dash beside "branch" tells a user their repository has no branch.
    const frame = await shell({
      header: {
        workspace: known("/w"),
        branch: unavailable("no Git yet"),
        session: { kind: "loading" },
        model: { kind: "error", reason: "unreachable" },
      },
    });
    expect(frame).toContain("no Git yet");
    expect(frame).toContain("reading");
    expect(frame).toContain("unreachable");
  });

  test("keeps empty and unavailable distinguishable", async () => {
    // Known to be nothing, versus nothing could look. Rendering both the same
    // would be the interface inventing a fact.
    const empty = await shell({
      header: {
        workspace: known("/w"),
        branch: { kind: "empty" },
        session: known("s"),
        model: known("m"),
      },
    });
    expect(empty).toContain("none");
    expect(empty).not.toContain("no Git yet");
  });

  test("escapes a value that could forge a line", async () => {
    // A workspace path, a branch name, and a model identifier all come from
    // outside Falryn, and any of them can carry an escape sequence.
    const frame = await shell({
      header: {
        workspace: known("a\u001b[2Jb"),
        branch: known("main"),
        session: known("s"),
        model: known("m"),
      },
    });
    expect(frame).not.toContain("\u001b[2J");
    expect(frame).toContain("\\x1b");
  });
});

describe("width classes", () => {
  test("drop the labels in compact and keep them above it", async () => {
    // Layout may change; the route to content may not be removed. The label is
    // the redundant half — the interface a user is already looking at does not
    // need to be told which field is the workspace — and it is what gives way.
    const compact = await shell({}, {}, { columns: 44, rows: 12 });
    expect(compact).not.toContain("workspace");

    const standard = await shell({}, {}, { columns: STANDARD_COLUMNS, rows: 20 });
    expect(standard).toContain("workspace");
    expect(standard).toContain("/work/falryn");
  });

  test("shorten rather than drop a value that does not fit", async () => {
    // Truncation is degradation, not removal: the value is still there, the mark
    // says it was cut, and the route that restores it is a wider terminal —
    // which is a route the running build actually honours.
    const compact = await shell({}, {}, { columns: 44, rows: 12 });
    expect(compact).toContain("/work/fa");
    expect(compact).toContain("…");
    // And every field is still represented rather than four becoming two.
    expect(compact).toContain("s-1");
  });

  test("shorten the hints in compact to the keys alone", async () => {
    const compact = await shell({}, {}, { columns: 44, rows: 12 });
    expect(compact).toContain("^C");
    expect(compact).not.toContain("^C exit");

    const wide = await shell({}, {}, { columns: WIDE_COLUMNS, rows: 30 });
    expect(wide).toContain("^C exit");
  });

  test("say how much room a terminal needs when it has too little", async () => {
    // Actionable rather than apologetic: "too small" is not something a user can
    // do anything about.
    const frame = await render(<AppShell theme={THEME} model={model()} />, {
      columns: MINIMUM_COLUMNS - 4,
      rows: MINIMUM_ROWS - 2,
    });
    expect(frame).toContain("too small");
    expect(frame).toContain(`${MINIMUM_COLUMNS}×${MINIMUM_ROWS}`);
  });

  test("draw a frame at the smallest terminal that is not too small", async () => {
    // The boundary from the other side: the minimum has to actually be usable,
    // or it is the wrong minimum.
    const frame = await render(<AppShell theme={THEME} model={model()} />, {
      columns: MINIMUM_COLUMNS,
      rows: MINIMUM_ROWS,
    });
    expect(frame).not.toContain("too small");
  });
});

describe("overlays", () => {
  test("mount the help route with its content", async () => {
    const frame = await shell({
      overlay: { kind: "help" },
      help: [{ title: "Leaving", body: "Ctrl+C ends the session." }],
    });
    expect(frame).toContain("Leaving");
    expect(frame).toContain("ends the session");
  });

  test("mount the palette route, and say so when nothing matches", async () => {
    // Since #26 the palette is driven by the registry, so an empty list means a
    // search matched nothing rather than a build with no commands.
    const frame = await shell({ overlay: { kind: "palette" }, commands: [] });
    expect(frame).toContain("Nothing matches that");
  });

  test("list commands when there are some", async () => {
    const frame = await shell({
      overlay: { kind: "palette" },
      commands: [
        {
          id: "app.exit",
          title: "Exit Falryn",
          description: "Close the shell.",
          binding: "ctrl+c",
          unavailableReason: null,
        },
      ],
    });
    expect(frame).toContain("Exit Falryn");
  });

  test("never cover the status line", async () => {
    // The rule this area cannot break: an overlay may not hide a terminal
    // outcome. The status is where an outcome arrives.
    const frame = await shell({
      overlay: { kind: "help" },
      help: [{ title: "A", body: "b" }],
      status: { status: "error", message: "It failed.", hints: [] },
    });
    expect(frame).toContain("failed");
    expect(frame).toContain("It failed.");
  });

  test("carry a dismissal hint, since nothing binds a key yet", async () => {
    const frame = await shell({ overlay: { kind: "help" }, help: [{ title: "A", body: "b" }] });
    expect(frame).toContain("Esc");
  });
});

describe("reduced motion", () => {
  test("produces the final frame immediately", async () => {
    // Not "eventually the same frame". The first commit is already final, which
    // is what the zero-duration mapping buys — and it is asserted by rendering
    // with no waiting beyond the first flush.
    const setup = await createTestRenderer({ width: 100, height: 30, consoleMode: "disabled" });
    live.push(setup);
    createRoot(setup.renderer).render(
      <AppShell
        theme={{ ...THEME, reducedMotion: true }}
        model={model({ overlay: { kind: "help" }, help: [{ title: "Leaving", body: "b" }] })}
      />,
    );
    await Bun.sleep(20);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Leaving");
  });

  test("reaches the same content as an animated reveal", async () => {
    // The mapping must shorten the transition, never skip the state change.
    const animated = await shell(
      { overlay: { kind: "help" }, help: [{ title: "Leaving", body: "b" }] },
      { reducedMotion: false },
      undefined,
      "Leaving",
    );
    expect(animated).toContain("Leaving");
  });
});

describe("resize", () => {
  test("keeps the overlay open and re-lays out around it", async () => {
    // The preservation contract. The overlay route, the theme, and the cache all
    // live above the measurement, so a narrower terminal changes the arrangement
    // and cannot change what is open.
    const setup = await createTestRenderer({
      width: WIDE_COLUMNS,
      height: 30,
      consoleMode: "disabled",
    });
    live.push(setup);
    createRoot(setup.renderer).render(
      <AppShell
        theme={THEME}
        model={model({ overlay: { kind: "help" }, help: [{ title: "Leaving", body: "b" }] })}
      />,
    );
    await Bun.sleep(30);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Leaving");

    setup.resize(44, 12);
    await Bun.sleep(30);
    await setup.flush();
    const narrow = setup.captureCharFrame();
    expect(narrow).toContain("Leaving");
    // And the arrangement did change: compact drops the header's labels.
    expect(narrow).not.toContain("workspace");
  });

  test("survives a storm without losing what was open", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30, consoleMode: "disabled" });
    live.push(setup);
    createRoot(setup.renderer).render(
      <AppShell
        theme={THEME}
        model={model({ overlay: { kind: "help" }, help: [{ title: "Leaving", body: "b" }] })}
      />,
    );
    await Bun.sleep(30);
    for (let width = 40; width <= 120; width += 4) {
      setup.resize(width, 24);
    }
    await Bun.sleep(40);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Leaving");
  });
});

describe("long unbroken content", () => {
  test("truncates with the theme's own mark rather than overflowing", async () => {
    const frame = await shell({
      header: {
        workspace: known("/a".repeat(200)),
        branch: known("main"),
        session: known("s"),
        model: known("m"),
      },
    });
    expect(frame).toContain("…");
    // Every line stays inside the terminal it was drawn into.
    for (const line of frame.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(101);
    }
  });

  test("uses the ASCII mark when that is the repertoire", async () => {
    // Three cells rather than one, which is the reason the mark is a theme value
    // handed to the truncation rather than a constant in a component.
    const frame = await shell(
      {
        header: {
          workspace: known("/a".repeat(200)),
          branch: known("main"),
          session: known("s"),
          model: known("m"),
        },
      },
      { symbols: "ascii" },
    );
    expect(frame).toContain("...");
    expect(frame).not.toContain("…");
  });
});
