/**
 * The activity rail, on a real terminal.
 *
 * The unit tests prove the fold and the token mapping in isolation. This proves
 * they are wired to a frame — and, as much as anything, that the rail appears
 * only where the layout says a contextual surface belongs. "One persistent
 * contextual surface on wide layouts" is a claim about arrangement, and a claim
 * about a predicate would not have caught a rail rendered into a 72-column
 * terminal on top of the transcript.
 */

import { describe, expect, test } from "bun:test";
import { running, settled } from "../../presentation/activity/fixtures.ts";
import type { ActivityProjection } from "../../presentation/index.ts";
import { EMPTY_ACTIVITY, reduceActivity } from "../../presentation/index.ts";
import { frameOf, type TerminalShape } from "../harness.tsx";
import { createTextCache } from "../text-cache.ts";
import { resolveTheme, type ThemeRequest } from "../theme/index.ts";
import { known, type ShellModel, unavailable } from "../view-model.ts";
import { ActivityRail } from "./activity-rail.tsx";
import { type Frame, FrameProvider } from "./context.tsx";
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
  help: [{ title: "Leaving", body: "Ctrl+C ends the session." }],
};

/** Wide enough for a contextual panel: `WIDE_COLUMNS` is 104. */
const WIDE = { columns: 140, rows: 30 };
/** Standard: room for a transcript, none for a panel beside it. */
const STANDARD = { columns: 90, rows: 30 };

const FRAME: Frame = {
  theme: resolveTheme(THEME),
  viewport: { columns: 40, rows: 12 },
  terminal: { columns: 40, rows: 12 },
  layout: { kind: "layout", class: "wide" },
  cache: createTextCache({ generation: 1 }),
  composerRows: 3,
};

function projectionOf(events: Parameters<typeof reduceActivity>[1]): ActivityProjection {
  return reduceActivity(EMPTY_ACTIVITY, events);
}

/** The frame a shell draws at a shape, with an activity projection or without one. */
function shell(shape: TerminalShape, activity?: ActivityProjection): Promise<string> {
  return frameOf(
    <ShellApp
      theme={THEME}
      model={MODEL}
      onExit={() => {}}
      {...(activity === undefined ? {} : { activity })}
    />,
    { shape },
  );
}

/** The rail alone, at an exact row budget — the shape #385 overdrew. */
async function rail(
  rows: number,
  activity: ActivityProjection = projectionOf([...running(0, "one"), ...running(1, "two")]),
): Promise<readonly string[]> {
  const frame = await frameOf(
    <FrameProvider value={FRAME}>
      <ActivityRail projection={activity} rows={rows} />
    </FrameProvider>,
    { shape: { columns: 40, rows: Math.max(rows, 4) } },
  );
  return frame
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
}

describe("where the rail appears", () => {
  test("is drawn on a wide layout", async () => {
    expect(await shell(WIDE)).toContain("Activity");
  });

  test("is absent on a standard layout", async () => {
    // The design direction allows one contextual surface on wide layouts and
    // refuses a permanently tiled control centre. A narrower terminal gets no
    // rail rather than a squeezed one.
    const frame = await shell(STANDARD);
    expect(frame).not.toContain("Activity");
  });
});

describe("what the rail says", () => {
  test("names running work and what it is", async () => {
    const frame = await shell(WIDE, projectionOf(running(0, "one")));
    expect(frame).toContain("running");
  });

  test("distinguishes a failure from a completion", async () => {
    const frame = await shell(
      WIDE,
      projectionOf([
        ...settled(0, "good", { kind: "completed" }),
        ...settled(2, "bad", { kind: "failed", effect: "none" }),
      ]),
    );
    expect(frame).toContain("completed");
    expect(frame).toContain("failed");
  });

  test("says nothing is running rather than drawing filler", async () => {
    // A statement about the runtime. The empty state is different from a rail
    // that could not read one, which the status line reports as unknown.
    const frame = await shell(WIDE, EMPTY_ACTIVITY);
    expect(frame).toContain("Nothing is running.");
  });
});

describe("the row budget it was given", () => {
  test("never claims nothing is running while reporting what it hid", async () => {
    // #385. Asking whether any entry was *shown* conflates "the runtime is
    // idle" with "there was no room to show live work", and reports the first
    // when the second is true — so the rail said "Nothing is running." directly
    // above "2 more entries not shown", which cannot both be so, and the surplus
    // rows spilled into the neighbour on a real terminal.
    for (const rows of [1, 2, 3]) {
      const lines = await rail(rows);
      expect({
        rows,
        claimed: lines.some((line) => line.includes("Nothing is running.")),
      }).toEqual({ rows, claimed: false });
    }
  });

  test("never draws the overflow notice alone", async () => {
    for (const rows of [1, 2, 3]) {
      const lines = await rail(rows);
      const notice = lines.some((line) => /more .* not shown/.test(line));
      const entry = lines.some((line) => line.includes("invocation"));
      expect({ rows, noticeAlone: notice && !entry }).toEqual({ rows, noticeAlone: false });
    }
  });

  test("draws no more rows than it was given, at every budget", async () => {
    // A terminal does not clip surplus content: it lands on the neighbour. The
    // count is the guard, matching the palette's budget check.
    for (const rows of [1, 2, 3, 6, 12]) {
      const lines = await rail(rows);
      expect({ rows, drawn: lines.length <= rows }).toEqual({ rows, drawn: true });
    }
  });

  test("still says nothing is running when the projection is empty", async () => {
    const lines = await rail(4, EMPTY_ACTIVITY);
    expect(lines.some((line) => line.includes("Nothing is running."))).toBe(true);
    expect(lines.some((line) => /more .* not shown/.test(line))).toBe(false);
  });

  test("spends a one-row budget on the heading alone", async () => {
    const lines = await rail(1);
    expect(lines.length).toBe(1);
    expect(lines[0] ?? "").toContain("Activity");
  });

  test("keeps one live entry when only one content row fits", async () => {
    const lines = await rail(2);
    expect(lines.some((line) => line.includes("invocation"))).toBe(true);
    expect(lines.some((line) => /more .* not shown/.test(line))).toBe(false);
  });
});

describe("the status line", () => {
  test("reports unknown when no runtime is attached", async () => {
    // Not a green tick. Nothing attached and nothing running are different
    // statements, and only one of them is something to be reassured by.
    const frame = await shell(STANDARD);
    expect(frame).toContain("No runtime is attached");
  });

  test("reports busy, with the count, once work is live", async () => {
    const frame = await shell(STANDARD, projectionOf(running(0, "one")));
    expect(frame).toContain("1 operation running.");
  });

  test("reports an unconfirmed effect ahead of a completed one", async () => {
    const frame = await shell(
      STANDARD,
      projectionOf([
        ...settled(0, "good", { kind: "completed" }),
        ...settled(2, "unknown", { kind: "uncertain", effect: "uncertain" }),
      ]),
    );
    expect(frame).toContain("unconfirmed effect");
  });
});
