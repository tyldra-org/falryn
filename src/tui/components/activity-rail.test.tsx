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
  help: [{ title: "Leaving", body: "Ctrl+C ends the session." }],
};

/** Wide enough for a contextual panel: `WIDE_COLUMNS` is 104. */
const WIDE = { columns: 140, rows: 30 };
/** Standard: room for a transcript, none for a panel beside it. */
const STANDARD = { columns: 90, rows: 30 };

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
    { shape, screenMode: "alternate-screen" },
  );
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
