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
import { EMPTY_EDITOR } from "../composer/index.ts";
import { STANDARD_COLUMNS, WIDE_COLUMNS } from "../layout.ts";
import {
  EMPTY_ACTIVITY_MODEL,
  EMPTY_COMPOSER_MODEL,
  EMPTY_TRANSCRIPT_MODEL,
} from "../shell-model.ts";
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
    transcript: EMPTY_TRANSCRIPT_MODEL,
    composer: EMPTY_COMPOSER_MODEL,
    activity: EMPTY_ACTIVITY_MODEL,
    ...overrides,
  };
}

/**
 * The cell a test renderer's buffer holds before anything has drawn into it.
 *
 * `U+0A00`, and the whole of #372 is that it is not whitespace. The old
 * predicate asked `frame.trim() !== ""`, which an entirely unpainted buffer
 * satisfies — so a rendered check could be handed the buffer as its answer,
 * failing at random where the assertion was positive and *passing against
 * nothing* where it was negative.
 */
const UNPAINTED = "਀";

/**
 * Whether a captured buffer is a frame the shell drew.
 *
 * Two conditions, and both are needed. A buffer holding an unpainted cell
 * anywhere has not finished being drawn into — the renderer paints the whole
 * region, so a partial capture is a capture taken mid-pass rather than a frame
 * with a gap in it. A buffer of nothing but spaces is painted and empty, which
 * is not a frame either.
 *
 * Exported shape rather than an inline comparison so `#372`'s own reproduction
 * can hand it a buffer directly, which is the only way to check a settle
 * predicate without waiting for the race it exists to lose.
 */
function hasPainted(frame: string): boolean {
  return frame.trim() !== "" && !frame.includes(UNPAINTED);
}

/** How long a mount is given before the wait is a failure rather than a delay. */
const SETTLE_ATTEMPTS = 60;
const SETTLE_INTERVAL_MS = 5;

/**
 * Mounts a tree and returns the characters it drew.
 *
 * The sleep-and-flush loop is deliberate: React commits on a microtask and the
 * test renderer's own frame predicate advances passes without yielding to the
 * host loop, so a wait that never hands the loop back polls a buffer nothing has
 * drawn into.
 *
 * It throws rather than returning the last capture when nothing settles. A
 * helper that hands back whatever the buffer happened to hold turns "the shell
 * never painted" into "the assertion below failed", which is a different defect
 * reported in a different place.
 */
async function render(
  node: ReactNode,
  size: { columns: number; rows: number } = { columns: 100, rows: 30 },
  /**
   * Text to wait for, when the first painted frame is not the final one.
   *
   * An animated reveal commits several frames, and the early ones are a panel
   * two rows tall with nothing in it yet. A test that took the first painted
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
  let last = "";
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    await Bun.sleep(SETTLE_INTERVAL_MS);
    await setup.flush();
    last = setup.captureCharFrame();
    if (hasPainted(last) && (until === undefined || last.includes(until))) {
      return last;
    }
  }
  throw new Error(
    `the frame never settled after ${SETTLE_ATTEMPTS * SETTLE_INTERVAL_MS}ms` +
      ` (${size.columns}×${size.rows}, painted: ${hasPainted(last)}` +
      `${until === undefined ? "" : `, waiting for ${JSON.stringify(until)}`})`,
  );
}

/** An open palette, spelled once because the sweeps below open it many times. */
const PALETTE_OPEN = { kind: "palette", query: EMPTY_EDITOR } as const;

function shell(
  overrides: Partial<ShellModel> = {},
  theme: Partial<ThemeRequest> = {},
  size?: { columns: number; rows: number },
  until?: string,
): Promise<string> {
  return render(<AppShell theme={{ ...THEME, ...theme }} model={model(overrides)} />, size, until);
}

describe("the settle predicate", () => {
  test("refuses the buffer a renderer starts with", async () => {
    // #372's reproduction, and it needs no race: a renderer's buffer before
    // anything draws into it is `U+0A00` in every cell, which is not whitespace.
    // The old predicate — `frame.trim() !== ""` — is *true* for that buffer, so
    // it was handed back as a settled frame whenever a capture won the race
    // against the first paint. Roughly one full-suite run in four.
    const setup = await createTestRenderer({ width: 20, height: 4, consoleMode: "disabled" });
    live.push(setup);
    const unpainted = setup.captureCharFrame();

    expect(unpainted.trim() !== "").toBe(true);
    expect(hasPainted(unpainted)).toBe(false);
  });

  test("refuses a frame with an unpainted cell left in it", async () => {
    // A capture taken mid-pass, rather than a whole buffer. The renderer paints
    // the region it owns, so one unpainted cell means the pass was not finished
    // and not that the frame has a hole in it.
    expect(hasPainted(`the header  ${UNPAINTED}`)).toBe(false);
  });

  test("refuses a frame that is painted and empty", async () => {
    // The condition the old predicate got right, which is why it survived: a
    // buffer of spaces is a renderer that drew nothing.
    expect(hasPainted("   \n   \n")).toBe(false);
  });

  test("accepts a frame the shell actually drew", async () => {
    const frame = await render(<AppShell theme={THEME} model={model()} />);
    expect(hasPainted(frame)).toBe(true);
    expect(frame).toContain("/work/falryn");
  });

  test("reports a failure to settle rather than handing back the last capture", async () => {
    // The other half of #372. A helper that returns whatever the buffer held
    // reports "the shell never painted" as "the assertion below failed", which
    // sends a reader to the wrong place entirely.
    await expect(
      render(
        <AppShell theme={THEME} model={model()} />,
        { columns: 60, rows: 12 },
        "nothing draws this",
      ),
    ).rejects.toThrow(/never settled/);
  });
});

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
    // Said positively as well, and #372 is why. This was the one test in this
    // file whose only assertion was a negative, so on a run where the settle
    // predicate accepted an unpainted buffer it passed against nothing. A
    // negative alone cannot tell "the notice is absent" from "the frame is".
    expect(frame).toContain("/work/");
    expect(frame).toContain("Not here yet");
  });
});

/** Characters only the overlay panel's own border draws. */
const BORDER = /[┏┓┗┛┃]/u;

/**
 * The status message the sweeps below use, and the text that says a frame is
 * finished.
 *
 * Short on purpose: the status line is the last region drawn, so it is what
 * "settled" means here — and a message long enough to be truncated at
 * `MINIMUM_COLUMNS` would never be found on the narrow half of the sweep.
 */
const SETTLED = "Idle.";
const STATUS: ShellModel["status"] = { status: "informational", message: SETTLED, hints: [] };

/**
 * Text that belongs to a region other than the primary one.
 *
 * Each survives truncation at `MINIMUM_COLUMNS`, which matters: a landmark that
 * disappears on a narrow terminal would make the sweep below pass by finding
 * nothing rather than by finding nothing wrong.
 */
const ELSEWHERE = ["Ready", "Not here yet", SETTLED] as const;

/** Rows where a region drew over another one. */
function collisions(frame: string): readonly string[] {
  return frame
    .split("\n")
    .filter((line) => BORDER.test(line) && ELSEWHERE.some((text) => line.includes(text)));
}

/**
 * A whole frame at an exact size, waited for rather than caught mid-paint.
 *
 * The waiting is the point. `render` returns the first non-empty frame, and on a
 * six-row terminal that can be the header alone — a frame with no status line in
 * it has no collision to find, so a sweep that took it would pass by looking at
 * nothing. Waiting for the status line waits for the last region to arrive.
 */
function settledFrame(
  overlay: ShellModel["overlay"],
  size: { columns: number; rows: number },
): Promise<string> {
  return shell({ overlay, status: STATUS }, {}, size, SETTLED);
}

describe("short terminals", () => {
  test("draw every region into rows no other region has", async () => {
    // #368. `OverlayHost` sized itself against a two-row reserve — the header and
    // the status line — that was written before #357 put a composer between them.
    // On a short terminal the panel was handed rows the composer and its notice
    // were already drawing into, and the status line ended up underneath the
    // panel's bottom border: the one row `overlay.tsx` opens by promising an
    // overlay may never cover.
    //
    // Every height rather than a sample, at the narrowest accepted width and a
    // realistic one, with the overlay open and closed. The defect appeared at
    // twelve and below and was invisible at sixteen and above, which is exactly
    // the shape a spot check misses.
    for (let rows = MINIMUM_ROWS; rows <= 24; rows += 1) {
      for (const columns of [MINIMUM_COLUMNS, 76]) {
        for (const overlay of [{ kind: "none" } as const, PALETTE_OPEN]) {
          const frame = await settledFrame(overlay, { columns, rows });
          expect({ rows, columns, open: overlay.kind, collided: collisions(frame) }).toEqual({
            rows,
            columns,
            open: overlay.kind,
            collided: [],
          });
        }
      }
    }
  }, 60_000);

  test("keep the status line readable with an overlay open", async () => {
    // The rule this area cannot break, at the size it was broken. At
    // `MINIMUM_ROWS` the status message used to arrive spliced into the panel's
    // bottom border as `i━Ready━━━━━━━┛`.
    const frame = await settledFrame(PALETTE_OPEN, {
      columns: MINIMUM_COLUMNS,
      rows: MINIMUM_ROWS,
    });
    const status = frame.split("\n").filter((line) => line.includes(SETTLED));
    expect(status.length).toBe(1);
    expect(BORDER.test(status[0] ?? "")).toBe(false);
  });

  test("say what is open and how to leave when a panel will not fit", async () => {
    // A region shorter than a border and a way out cannot hold a panel, and
    // `Panel` draws its two border rows whatever height it is given — so asking
    // for one row is asking for an overdraw. Drawing nothing instead would make
    // the key that opened this look broken, so the remainder is one plain line
    // that still names both.
    const frame = await settledFrame(PALETTE_OPEN, { columns: 76, rows: MINIMUM_ROWS });
    expect(frame).toContain("Commands — Esc closes this");
    expect(frame).not.toMatch(BORDER);
  });

  test("still draw the panel as soon as one fits", async () => {
    // The other side of that boundary, so the fallback cannot quietly become the
    // normal case.
    const frame = await settledFrame(PALETTE_OPEN, { columns: 76, rows: 8 });
    expect(frame).toMatch(BORDER);
    expect(frame).toContain("Esc closes this");
    expect(collisions(frame)).toEqual([]);
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
    const frame = await shell({ overlay: { kind: "palette", query: EMPTY_EDITOR }, commands: [] });
    expect(frame).toContain("Nothing matches that");
  });

  test("list commands when there are some", async () => {
    const frame = await shell({
      overlay: { kind: "palette", query: EMPTY_EDITOR },
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

/**
 * Every frame drawn between mount and the reveal arriving.
 *
 * The frames a settling helper exists to skip, which is exactly why #366 lived
 * so long: `render` waits for the final text, so the transition's own steps were
 * never asserted on by anything.
 */
async function revealFrames(
  node: ReactNode,
  size: { columns: number; rows: number },
  arrivedWhen: string,
): Promise<{ readonly during: readonly string[]; readonly arrived: string }> {
  const setup = await createTestRenderer({
    width: size.columns,
    height: size.rows,
    consoleMode: "disabled",
  });
  live.push(setup);
  createRoot(setup.renderer).render(node);
  const during: string[] = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await Bun.sleep(4);
    await setup.flush();
    const frame = setup.captureCharFrame();
    // Painted first, for the reason #372 records: a capture taken mid-pass is
    // not a step of the transition, and collecting one would put an assertion
    // about what the overlay drew onto a buffer it had not finished drawing.
    if (!hasPainted(frame)) {
      continue;
    }
    if (frame.includes(arrivedWhen)) {
      return { during, arrived: frame };
    }
    if (frame.includes("┏")) {
      during.push(frame);
    }
  }
  throw new Error(`the reveal never arrived, waiting for ${JSON.stringify(arrivedWhen)}`);
}

/**
 * The non-blank rows between the overlay panel's own border rows.
 *
 * Trimmed, because what is being asserted is which lines reached the panel and
 * not where they started. A row two lines drew into is one entry holding both of
 * them, spliced — which is the signature the defect leaves and the reason this
 * reads rows rather than searching for a substring.
 */
function panelInterior(frame: string): readonly string[] {
  const lines = frame.split("\n");
  const top = lines.findIndex((line) => line.includes("┏"));
  // The corner rather than the whole bottom edge: on a six-row terminal the
  // frame's own rows already land on the panel's bottom border, so the left
  // corner is overwritten while the right one survives.
  const bottom = lines.findIndex((line) => line.includes("┛"));
  if (top < 0 || bottom < 0 || bottom <= top) {
    throw new Error("the frame has no overlay panel");
  }
  return lines
    .slice(top + 1, bottom)
    .map((line) => line.replaceAll(/[┃│▏]/gu, "").trim())
    .filter((line) => line !== "");
}

describe("the reveal", () => {
  test("keeps the palette inside its panel at every frame", async () => {
    // #366. The reveal's first step is a three-row panel: two rows of border and
    // one inside. The host used to hand the route a row anyway, so the palette's
    // search line and the dismissal hint drew into the same one and reached the
    // screen as `Esceclosesathiscommands.`
    const { during, arrived } = await revealFrames(
      <AppShell
        theme={{ ...THEME, reducedMotion: false }}
        model={model({ overlay: { kind: "palette", query: EMPTY_EDITOR }, commands: [] })}
      />,
      { columns: 76, rows: 20 },
      "Nothing matches that",
    );
    expect(during.length).toBeGreaterThan(0);
    for (const frame of during) {
      expect(panelInterior(frame)).toEqual(["Esc closes this"]);
    }
    // And the way out is still on its own row once the panel is full height.
    expect(panelInterior(arrived)).toContain("Esc closes this");
  });

  test("keeps the help route inside its panel at every frame", async () => {
    // Both routes go through this host, so the defect was never the palette's.
    const { during, arrived } = await revealFrames(
      <AppShell
        theme={{ ...THEME, reducedMotion: false }}
        model={model({ overlay: { kind: "help" }, help: [{ title: "Leaving", body: "b" }] })}
      />,
      { columns: 76, rows: 20 },
      "Leaving",
    );
    expect(during.length).toBeGreaterThan(0);
    for (const frame of during) {
      expect(panelInterior(frame)).toEqual(["Esc closes this"]);
    }
    expect(panelInterior(arrived)).toContain("Esc closes this");
  });

  test("holds at the shortest terminal that seats a panel", async () => {
    // Where the resting panel fits by exactly one content row and the reveal
    // step does not — so a fix that merely gave the overlay more rows would pass
    // everywhere but here. Nine rows since #368: below that the frame's own
    // chrome leaves too little for a border and a way out, and the overlay draws
    // one plain line instead.
    const { during, arrived } = await revealFrames(
      <AppShell
        theme={{ ...THEME, reducedMotion: false }}
        model={model({ overlay: { kind: "palette", query: EMPTY_EDITOR }, commands: [] })}
      />,
      { columns: MINIMUM_COLUMNS, rows: 9 },
      "Type to search",
    );
    for (const frame of during) {
      expect(panelInterior(frame)).toEqual(["Esc closes this"]);
    }
    // Two rows inside a four-row panel, and neither is two lines on one row.
    const rested = panelInterior(arrived);
    expect(rested.length).toBe(2);
    expect(rested[0]).toStartWith("Type to search");
    expect(rested[1]).toBe("Esc closes this");
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
