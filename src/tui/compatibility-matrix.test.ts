/**
 * The terminal test matrix, as a control rather than as a list.
 *
 * `falryn-docs/ui/TERMINAL-COMPATIBILITY-AND-TESTING.md` names the matrix: the
 * targets, terminal classes, dimensions, colour ranges, repertoires, input
 * modes, screen modes, and exit paths a terminal has to be exercised across
 * before Falryn says it supports one. A prose list cannot fail. This file is the
 * same matrix in a form that can, and the failure it exists to produce is a row
 * quietly listed as covered by nothing.
 *
 * Every row declares exactly one of three things, and there is no fourth:
 *
 * - **a test** — a file and the name of a check inside it;
 * - **a manual result** — what was observed by hand, on a named machine, in a
 *   named emulator; or
 * - **unqualified**, with the reason nobody has qualified it.
 *
 * The third is not a loophole, it is the point. A matrix whose every row must
 * claim coverage is a matrix that gets coverage claimed for it. `unqualified`
 * is how a row stays visible while being honest, and the acceptance criterion
 * this file answers — *nothing is listed as covered that is not* — is about the
 * other two.
 *
 * ## What this control proves, and what it does not
 *
 * It proves a named check **exists**. It does not prove that check ran, that it
 * passed, or that it asserts what its name suggests. `bun run check` owns
 * whether the suite is green and no file can own that on its behalf: a control
 * that read its own suite's results would be reporting on a run that had not
 * finished. So the reach is deliberately short and stated here rather than left
 * for a reader to assume, because a control that overstates itself is the exact
 * failure a matrix row exists to prevent.
 *
 * What it does catch is the drift that actually happens: a check renamed or
 * deleted while the row that pointed at it stayed, which turns a covered row
 * into a claim about nothing. The negative control at the bottom is the proof
 * that it catches it.
 *
 * ## Why the declaration lives here rather than in the documentation
 *
 * The manual record's canonical home is `falryn-docs`, and a test in this
 * repository cannot read another one — so a control that resolved manual rows
 * out of the documentation could not exist. The machine-readable declaration
 * lives here as test support, ships in no build, and `./tui-boundaries.test.ts`
 * holds it to that. `falryn-docs` mirrors it in prose; this is the owner.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** `src/`, since rows name files across areas and not only this one. */
const SOURCE_ROOT = dirname(dirname(import.meta.path));

/** A check that exists, named by the file it is in and the name it was given. */
type ExecutedOwner = {
  readonly kind: "test";
  readonly file: string;
  readonly named: string;
};

/**
 * What a person saw, on a machine named well enough to disbelieve.
 *
 * Every field is required and none may be empty. A qualification whose emulator,
 * locale, or font assumption is missing is a qualification of an unknown
 * terminal, which is what "supported" must never come to mean.
 */
type ManualResult = {
  readonly kind: "manual";
  readonly operatingSystem: string;
  readonly architecture: string;
  readonly emulator: string;
  readonly shell: string;
  readonly multiplexer: string;
  readonly locale: string;
  readonly font: string;
  readonly artifact: string;
  /** What was done and what was seen, in the words of whoever saw it. */
  readonly observed: string;
  /** Limitations observed, never limitations expected. Empty means none were. */
  readonly limitations: readonly string[];
};

/** A row nobody has qualified, said out loud. */
type Unqualified = {
  readonly kind: "unqualified";
  readonly because: string;
};

type Row = {
  /** The axis of the matrix this row belongs to, in the document's words. */
  readonly axis: string;
  /** The row itself. */
  readonly row: string;
  readonly by: ExecutedOwner | ManualResult | Unqualified;
};

// ── The matrix ──────────────────────────────────────────────────────────────

const MATRIX: readonly Row[] = [
  // Source mode and the exact `bun build --compile` artifact.
  {
    axis: "mode",
    row: "source mode renders a React tree to a real frame",
    by: { kind: "test", file: "tui/probe.test.tsx", named: "renders a React tree to a real frame" },
  },
  {
    axis: "mode",
    row: "the standalone executable resolves its native renderer and Tree-sitter assets",
    by: {
      kind: "test",
      file: "tui/probe.test.tsx",
      named: "loads the native renderer and the Tree-sitter assets with no asset root set",
    },
  },
  {
    axis: "mode",
    row: "the shipped dist/falryn opens an interface on a real terminal",
    by: {
      kind: "test",
      file: "tui/shell.compiled.test.ts",
      named: "opens an interface and lays it out against the terminal it was given",
    },
  },
  {
    axis: "mode",
    row: "the CLI inside the standalone executable",
    by: {
      kind: "test",
      file: "main.compiled.test.ts",
      named: "runs the CLI, and a bare invocation prints help without opening a database",
    },
  },

  // Supported targets.
  {
    axis: "target",
    row: "Linux",
    by: {
      kind: "unqualified",
      because:
        "no Linux host has run this suite and no Linux artifact has been built; the pseudo-terminal path opens `libutil.so.1` there and has never been executed",
    },
  },
  {
    axis: "target",
    row: "Windows",
    by: {
      kind: "unqualified",
      because:
        "no Windows target is built or exercised; the terminal work assumes a POSIX pseudo-terminal, and `openpty` has no counterpart there",
    },
  },
  {
    axis: "target",
    row: "macOS x86_64",
    by: {
      kind: "unqualified",
      because: "only arm64 has been exercised; nothing has run on an Intel Mac",
    },
  },

  // Terminal classes.
  {
    axis: "terminal class",
    row: "interactive TTY",
    by: {
      kind: "test",
      file: "tui/launch.test.ts",
      named: "launches, and reports the size it will be laid out against",
    },
  },
  {
    axis: "terminal class",
    row: "piped input",
    by: {
      kind: "test",
      file: "tui/launch.test.ts",
      named: "refuses when stdin is not a terminal",
    },
  },
  {
    axis: "terminal class",
    row: "redirected output",
    by: {
      kind: "test",
      file: "tui/launch.test.ts",
      named: "refuses when either output handle is captured",
    },
  },
  {
    axis: "terminal class",
    row: "CI",
    by: {
      kind: "test",
      file: "tui/launch.test.ts",
      named: "launches in CI when a terminal is genuinely attached",
    },
  },
  {
    axis: "terminal class",
    row: "dumb terminal",
    by: { kind: "test", file: "tui/launch.test.ts", named: "refuses a dumb terminal" },
  },

  // Dimensions.
  {
    axis: "dimensions",
    row: "minimum",
    by: {
      kind: "test",
      file: "tui/components/frame.test.tsx",
      named: "draw a frame at the smallest terminal that is not too small",
    },
  },
  {
    axis: "dimensions",
    row: "compact",
    by: {
      kind: "test",
      file: "tui/components/frame.test.tsx",
      named: "drop the labels in compact and keep them above it",
    },
  },
  {
    axis: "dimensions",
    row: "standard and wide, at each boundary",
    by: {
      kind: "test",
      file: "tui/layout.test.ts",
      named: "names each class at its own boundary and one cell below",
    },
  },
  {
    axis: "dimensions",
    row: "resize storm",
    by: {
      kind: "test",
      file: "tui/components/frame.test.tsx",
      named: "survives a storm without losing what was open",
    },
  },
  {
    axis: "dimensions",
    row: "zero size",
    by: {
      kind: "test",
      file: "tui/capabilities.test.ts",
      named: "carries an unusable size through as no size",
    },
  },
  {
    axis: "dimensions",
    row: "a real resize delivered to the shipped artifact",
    by: {
      kind: "test",
      file: "tui/shell.compiled.test.ts",
      named: "re-lays out when the terminal is resized under it",
    },
  },

  // Colour and theme.
  {
    axis: "colour",
    row: "true colour, 256, 16, and no colour, in every theme variant",
    by: {
      kind: "test",
      file: "tui/components/frame.test.tsx",
      named: "renders in every variant at every colour depth",
    },
  },
  {
    axis: "colour",
    row: "meaning survives colour being removed",
    by: {
      kind: "test",
      file: "tui/components/frame.test.tsx",
      named: "still names every status in words",
    },
  },

  // Character repertoire.
  {
    axis: "repertoire",
    row: "combining marks, wide glyphs, emoji, and mixed runs",
    by: {
      kind: "test",
      file: "tui/components/frame.test.tsx",
      named: "never draws a row wider than the terminal, in any repertoire",
    },
  },
  {
    axis: "repertoire",
    row: "ASCII fallback",
    by: {
      kind: "test",
      file: "tui/components/frame.test.tsx",
      named: "draws in the ASCII repertoire everywhere it draws in the Unicode one",
    },
  },
  {
    axis: "repertoire",
    row: "invalid bytes and lone surrogates",
    by: {
      kind: "test",
      file: "tui/paste.test.ts",
      named: "is refused when it contains an unpaired surrogate",
    },
  },
  {
    axis: "repertoire",
    row: "RTL and bidirectional text",
    by: {
      kind: "unqualified",
      because:
        "nothing renders or asserts bidirectional text, and the width arithmetic has no case for it",
    },
  },

  // Input.
  {
    axis: "input",
    row: "bracketed paste",
    by: { kind: "test", file: "tui/paste.test.ts", named: "is inline right up to the limit" },
  },
  {
    axis: "input",
    row: "mouse absent",
    by: {
      kind: "test",
      file: "tui/renderer-session.test.ts",
      named: "gate the mouse rather than leaving OpenTUI's default of on",
    },
  },
  {
    axis: "input",
    row: "mouse present",
    by: {
      kind: "test",
      file: "tui/renderer-session.test.ts",
      named: "turn the mouse on when the record says to",
    },
  },
  {
    axis: "input",
    row: "key conflicts",
    by: {
      kind: "test",
      file: "tui/commands.test.ts",
      named: "refuse the plan rather than resolving by registration order",
    },
  },
  {
    axis: "input",
    row: "typing and submission across a real tty in raw mode",
    by: {
      kind: "test",
      file: "tui/shell.compiled.test.ts",
      named: "takes typing into the composer and answers a submission",
    },
  },
  {
    axis: "input",
    row: "clipboard present or absent",
    by: {
      kind: "unqualified",
      because: "this build has no clipboard path, so there is nothing to exercise either way",
    },
  },

  // Screen modes and environment.
  {
    axis: "screen mode",
    row: "split-footer",
    by: {
      kind: "test",
      file: "tui/screen-mode.test.ts",
      named: "is split-footer on a terminal with room for it",
    },
  },
  {
    axis: "screen mode",
    row: "split-footer commits above the footer, in order",
    by: {
      kind: "test",
      file: "tui/scrollback.test.ts",
      named: "interleaves with captured output in the order both were produced",
    },
  },
  {
    axis: "screen mode",
    row: "alternate-screen",
    by: {
      kind: "test",
      file: "tui/screen-mode.test.ts",
      named: "takes the whole viewport rather than a buffered region",
    },
  },
  {
    axis: "screen mode",
    row: "main-screen and alternate-screen on the shipped artifact",
    by: {
      kind: "test",
      file: "tui/shell.compiled.test.ts",
      named: "opens the shell in every mode the override accepts",
    },
  },
  {
    axis: "screen mode",
    row: "plain output",
    by: {
      kind: "test",
      file: "tui/launch.test.ts",
      named: "reports the format rather than the terminal",
    },
  },
  {
    axis: "environment",
    row: "multiplexer",
    by: {
      kind: "test",
      file: "tui/capabilities.test.ts",
      named: "name a multiplexer from the variable the multiplexer sets",
    },
  },
  {
    axis: "environment",
    row: "remote shell",
    by: {
      kind: "test",
      file: "tui/capabilities.test.ts",
      named: "read a remote session from any of the ssh variables",
    },
  },
  {
    axis: "environment",
    row: "the repertoire narrows inside a multiplexer and over ssh",
    by: {
      kind: "test",
      file: "tui/appearance.test.ts",
      named: "are on inside a multiplexer and over ssh",
    },
  },
  {
    axis: "environment",
    row: "suspend and resume",
    by: {
      kind: "unqualified",
      because:
        "capability refresh on suspend and resume is a design target; nothing drives SIGTSTP or SIGCONT into a running shell",
    },
  },

  // Exit paths.
  {
    axis: "exit path",
    row: "normal exit from the keyboard",
    by: {
      kind: "test",
      file: "tui/shell.compiled.test.ts",
      named: "exits from the keyboard, and restores the terminal",
    },
  },
  {
    axis: "exit path",
    row: "interrupt",
    by: {
      kind: "test",
      file: "tui/shell.compiled.test.ts",
      named: "takes an interrupt through Falryn's own governance and exits 130",
    },
  },
  {
    axis: "exit path",
    row: "deadline",
    by: {
      kind: "test",
      file: "tui/shell.compiled.test.ts",
      named: "restores the terminal when a deadline ends the session instead",
    },
  },
  {
    axis: "exit path",
    row: "renderer or adapter failure",
    by: {
      kind: "test",
      file: "tui/shell.test.tsx",
      named: "is reported as a failure carrying an exit-resolvable error",
    },
  },
  {
    axis: "exit path",
    row: "forced teardown at every escalation level",
    by: {
      kind: "test",
      file: "tui/shutdown.test.ts",
      named: "restores it under every level, because a shorter grace is still a grace",
    },
  },
  {
    axis: "exit path",
    row: "double interrupt",
    by: {
      kind: "unqualified",
      because:
        "no check drives a second interrupt into a shell on a terminal; escalation is the invocation scope's and is exercised without a renderer",
    },
  },

  // Performance and leak checks.
  {
    axis: "performance",
    row: "startup to first draw",
    by: { kind: "test", file: "tui/measurement.test.tsx", named: "startup to first draw" },
  },
  {
    axis: "performance",
    row: "render cadence",
    by: { kind: "test", file: "tui/measurement.test.tsx", named: "render cadence" },
  },
  {
    axis: "performance",
    row: "input latency under stream load",
    by: {
      kind: "test",
      file: "tui/measurement.test.tsx",
      named: "input latency under stream load",
    },
  },
  {
    axis: "performance",
    row: "event-loop delay",
    by: { kind: "test", file: "tui/measurement.test.tsx", named: "event-loop delay" },
  },
  {
    axis: "performance",
    row: "memory growth across a long transcript",
    by: {
      kind: "test",
      file: "tui/measurement.test.tsx",
      named: "memory growth across a long transcript",
    },
  },
  {
    axis: "performance",
    row: "shutdown latency",
    by: { kind: "test", file: "tui/measurement.test.tsx", named: "shutdown latency" },
  },
  {
    axis: "performance",
    row: "frame coalescing loses no semantic terminal event",
    by: {
      kind: "test",
      file: "tui/coalescing.test.tsx",
      named: "leaves every semantic terminal event in the frame",
    },
  },
  {
    axis: "performance",
    row: "subscriptions and renderers are released on teardown",
    by: {
      kind: "test",
      file: "tui/harness.test.tsx",
      named: "releases what the tree subscribed to",
    },
  },
  {
    axis: "performance",
    row: "a leaked renderer is noticed rather than tolerated",
    by: {
      kind: "test",
      file: "tui/harness.test.tsx",
      named: "notices a renderer that was not cleaned up",
    },
  },
];

// ── Resolving a row ─────────────────────────────────────────────────────────

/** Why a row does not resolve, or `null` when it does. */
async function unresolved(row: Row): Promise<string | null> {
  switch (row.by.kind) {
    case "test": {
      const source = await readFile(join(SOURCE_ROOT, row.by.file), "utf8").catch(() => null);
      if (source === null) {
        return `names ${row.by.file}, which does not exist`;
      }
      // The name as a string literal in the file. Not the assertion inside it:
      // this control's whole reach is that a check by this name exists, and it
      // says so rather than implying more.
      return source.includes(JSON.stringify(row.by.named))
        ? null
        : `names a check "${row.by.named}" that ${row.by.file} does not declare`;
    }
    case "manual": {
      const missing = (
        [
          ["operating system", row.by.operatingSystem],
          ["architecture", row.by.architecture],
          ["emulator", row.by.emulator],
          ["shell", row.by.shell],
          ["multiplexer", row.by.multiplexer],
          ["locale", row.by.locale],
          ["font", row.by.font],
          ["artifact", row.by.artifact],
          ["observation", row.by.observed],
        ] as const
      )
        .filter(([, value]) => value.trim() === "")
        .map(([field]) => field);
      return missing.length === 0 ? null : `is a manual result missing its ${missing.join(", ")}`;
    }
    case "unqualified":
      return row.by.because.trim() === "" ? "is unqualified with no reason given" : null;
  }
}

describe("the terminal test matrix", () => {
  test("has an executed owner or a recorded result for every row that claims one", async () => {
    // The control. A row pointing at a check that was renamed or deleted is a
    // row listed as covered by nothing, and that is the failure this produces.
    const walked = await Promise.all(
      MATRIX.map(async (row) => ({ row: row.row, why: await unresolved(row) })),
    );
    expect(walked.filter((entry) => entry.why !== null)).toEqual([]);
    // A control that walked an empty list would pass against anything.
    expect(walked.length).toBe(MATRIX.length);
  });

  test("fails when a row names a check that does not exist", async () => {
    // The negative control, and the reason to believe the one above. The same
    // resolver, handed rows of each kind that cannot be satisfied.
    expect(
      await unresolved({
        axis: "negative control",
        row: "a row naming a check nobody wrote",
        by: {
          kind: "test",
          file: "tui/shell.compiled.test.ts",
          named: "a check by a name no file declares",
        },
      }),
    ).toBe(
      'names a check "a check by a name no file declares" that tui/shell.compiled.test.ts does not declare',
    );

    expect(
      await unresolved({
        axis: "negative control",
        row: "a row naming a file nobody wrote",
        by: { kind: "test", file: "tui/nothing-here.test.ts", named: "anything" },
      }),
    ).toBe("names tui/nothing-here.test.ts, which does not exist");

    expect(
      await unresolved({
        axis: "negative control",
        row: "a row claiming to be unqualified for no reason",
        by: { kind: "unqualified", because: "  " },
      }),
    ).toBe("is unqualified with no reason given");

    // And a manual result that does not name the terminal it was taken on.
    // "Qualified on macOS" without an emulator, a locale, or a font assumption
    // is a qualification of a terminal nobody can identify, which is how a
    // supported-terminal list stops meaning anything.
    expect(
      await unresolved({
        axis: "negative control",
        row: "a manual result that names no terminal",
        by: {
          kind: "manual",
          operatingSystem: "macOS 26.6",
          architecture: "arm64",
          emulator: "",
          shell: "zsh",
          multiplexer: "none",
          locale: "",
          font: "",
          artifact: "dist/falryn",
          observed: "it worked",
          limitations: [],
        },
      }),
    ).toBe("is a manual result missing its emulator, locale, font");
  });

  test("proves that a named check exists, and claims nothing about whether it ran", async () => {
    // Stated as a check rather than only in prose, because the limit is the part
    // a reader is most likely to assume away. `bun run check` owns whether the
    // suite passed; this file owns whether the matrix points at anything.
    const source = await readFile(import.meta.path, "utf8");
    expect(source).toContain("It proves a named check **exists**");
    expect(source).toContain("It does not prove that check ran");
  });

  test("names every row it declares exactly once", () => {
    // Two rows with the same text are one row and one stale copy of it.
    const rows = MATRIX.map((row) => `${row.axis}: ${row.row}`);
    expect(rows.length).toBe(new Set(rows).size);
  });

  test("records what is unqualified rather than leaving it out", () => {
    // The other half of the acceptance criterion. A matrix that only listed what
    // it covered would be complete by construction and worth nothing, so the
    // unqualified rows are asserted to be present and to carry their reason.
    const unqualifiedRows = MATRIX.filter((row) => row.by.kind === "unqualified");
    expect(unqualifiedRows.length).toBeGreaterThan(0);
    for (const row of unqualifiedRows) {
      expect({
        row: row.row,
        said: row.by.kind === "unqualified" && row.by.because.length > 20,
      }).toEqual({
        row: row.row,
        said: true,
      });
    }
  });
});
