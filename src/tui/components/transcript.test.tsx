/**
 * The transcript, on a real terminal.
 *
 * Every test here mounts a React tree into an OpenTUI renderer drawing into
 * memory and asserts on the characters that reached the buffer. The unit tests
 * prove the rows, the window, and the reducer in isolation; this file proves
 * they are wired to each other and to a terminal — including the parts that can
 * only be observed by pressing a key and looking at the screen.
 *
 * The stress cases are here rather than in a unit test on purpose. "A large
 * history renders in a bounded window" is a claim about what a renderer does
 * with ten thousand blocks, and a claim about an array length would not have
 * caught a component that mounted them all.
 */

import { describe, expect, test } from "bun:test";
import {
  admitTranscriptRecord,
  bound,
  complete,
  EMPTY_PROJECTION,
  omitted,
  redacted,
  type TranscriptBlock,
  type TranscriptProjection,
} from "../../presentation/index.ts";
import {
  everyBlockKind,
  FIXTURE_ARTIFACT,
  FIXTURE_AT,
} from "../../presentation/transcript/fixtures.ts";
import { mount, type Rendered, type TerminalShape } from "../harness.tsx";
import type { ThemeRequest } from "../theme/index.ts";
import { known, type ShellModel, unavailable } from "../view-model.ts";
import { createMapArtifactViewer, fixtureCodeArtifactView } from "../viewer/fixtures.ts";
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

/** A projection over the given blocks, with the reducer's own framing. */
function projectionOf(blocks: readonly TranscriptBlock[]): TranscriptProjection {
  return { ...EMPTY_PROJECTION, blocks: blocks.map((block, order) => ({ ...block, order })) };
}

/** A long history of distinguishable blocks, for the bounded-window cases. */
function history(count: number): TranscriptProjection {
  const notice = everyBlockKind().find((block) => block.kind === "notice");
  if (notice === undefined || notice.kind !== "notice") {
    throw new Error("the corpus no longer has a notice block");
  }
  return projectionOf(
    Array.from({ length: count }, (_unused, index) => ({
      ...notice,
      anchor: { of: "declared", key: `entry-${index}` } as const,
      occurredAt: FIXTURE_AT,
      summary: complete(`entry ${index}`),
      note: complete(`the body of entry ${index}`),
    })),
  );
}

/**
 * The escape sequences the named keys actually send.
 *
 * `pressKey("enter")` types the five characters of the word — the mock's own
 * helpers exist because these are sequences and not text, and the two that have
 * no helper are written out here rather than typed as words. A test that pressed
 * the letters would assert that nothing happened and pass.
 */
const SEQUENCES = {
  enter: "\r",
  up: "\u001b[A",
  down: "\u001b[B",
  home: "\u001b[H",
  end: "\u001b[F",
  pageup: "\u001b[5~",
} as const;

type NamedKey = keyof typeof SEQUENCES | "escape";

async function open(
  transcript: TranscriptProjection,
  shape: TerminalShape = { columns: 100, rows: 24 },
  options: {
    readonly artifactViewer?: Parameters<typeof ShellApp>[0]["artifactViewer"];
  } = {},
): Promise<Rendered> {
  const shell = await mount(
    <ShellApp
      theme={THEME}
      model={MODEL}
      onExit={() => {}}
      transcript={transcript}
      {...(options.artifactViewer === undefined ? {} : { artifactViewer: options.artifactViewer })}
    />,
    { shape },
  );
  await shell.frame();
  return shell;
}

/** A named key, through the sequence it actually sends. */
function named(shell: Rendered, key: NamedKey): Promise<string> {
  return key === "escape" ? shell.pressEscape() : shell.press(SEQUENCES[key]);
}

describe("an empty transcript", () => {
  test("names a real command instead of showing filler", async () => {
    // The acceptance criterion. The sentence is built from the registry rows, so
    // it cannot name a key that does nothing.
    using shell = await open(EMPTY_PROJECTION);
    const frame = await shell.frame();
    expect(frame).toContain("Nothing has happened in this session yet");
    expect(frame).toContain("?");
    expect(frame).toContain("help");
  });

  test("offers no transcript commands, because there is nothing to act on", async () => {
    // Tall enough for help to reach the transcript rows. Since #368 the overlay
    // is sized from the primary region rather than from `viewport.rows - 2`, so
    // the composer's three rows come off the panel — and these commands sit far
    // enough down the registry to be the ones that fall off first.
    using shell = await open(EMPTY_PROJECTION, { columns: 100, rows: 30 });
    await shell.press("?");
    expect(await shell.frame()).toContain("there is no transcript yet");
  });
});

describe("a transcript with entries", () => {
  test("draws each block's identity and summary", async () => {
    using shell = await open(projectionOf(everyBlockKind().slice(0, 4)));
    const frame = await shell.frame();
    expect(frame).toContain("You said");
    expect(frame).toContain("Rename the port");
    expect(frame).toContain("Model");
  });

  test("selects the latest entry so a command has something to act on", async () => {
    using shell = await open(history(5));
    expect(await shell.frame()).toContain("selected");
  });
});

describe("progressive disclosure", () => {
  test("reveals content on the expansion key and hides it again", async () => {
    // The whole round trip, through the registry's own binding.
    using shell = await open(history(3));
    expect(await shell.frame()).not.toContain("the body of entry 2");

    await named(shell, "enter");
    expect(await shell.frame()).toContain("the body of entry 2");

    await named(shell, "enter");
    expect(await shell.frame()).not.toContain("the body of entry 2");
  });

  test("expands the entry the reader moved to", async () => {
    using shell = await open(history(4));
    await named(shell, "up");
    await named(shell, "enter");
    const frame = await shell.frame();
    expect(frame).toContain("the body of entry 2");
    expect(frame).not.toContain("the body of entry 3");
  });

  test("shows provenance rather than only content", async () => {
    using shell = await open(history(2));
    await named(shell, "enter");
    expect(await shell.frame()).toContain("source runtime");
  });
});

describe("truncation, redaction, and omission", () => {
  const clipped: TranscriptBlock = {
    ...(() => {
      const block = everyBlockKind().find((candidate) => candidate.kind === "tool-result");
      if (block === undefined || block.kind !== "tool-result") {
        throw new Error("the corpus no longer has a tool result");
      }
      return block;
    })(),
    output: bound("match\n".repeat(900), { bytes: 64, lines: 8 }, 900),
  };

  test("are visibly distinct on screen, in words rather than colour", async () => {
    // Asserted on a monochrome terminal at no colour depth, because "visibly
    // distinct" that depends on colour is not distinct at all.
    const model = everyBlockKind().find((block) => block.kind === "model-text");
    if (model === undefined || model.kind !== "model-text") {
      throw new Error("the corpus no longer has model text");
    }

    using shell = await open(
      projectionOf([
        clipped,
        { ...model, anchor: { of: "declared", key: "withheld" }, text: redacted("policy") },
        {
          ...model,
          anchor: { of: "declared", key: "uncollected" },
          text: omitted("nothing collected it"),
        },
      ]),
    );

    const frame = await shell.frame();
    expect(frame).toContain("Truncated.");
    expect(frame).toContain("Redacted.");
    expect(frame).toContain("Omitted.");
  });

  test("each carry a route or an explanation of why there is none", async () => {
    // Wide enough for the whole notice, so both halves can be asserted. The
    // narrow case is the next test: it is what decides which half survives.
    using shell = await open(projectionOf([clipped]), { columns: 140, rows: 24 });
    const frame = await shell.frame();
    expect(frame).toContain("Truncated.");
    // The route the reader can actually take, named with the key that runs it.
    expect(frame).toContain("Press return");
    // And the exact counts, so "some of this is missing" is a quantity.
    expect(frame).toContain("more lines");
  });

  test("clip the quantity rather than the action on a narrow terminal", async () => {
    // The ordering decision, asserted. A notice that runs out of room loses its
    // byte counts and keeps the key a reader can press.
    using shell = await open(projectionOf([clipped]), { columns: 100, rows: 24 });
    const frame = await shell.frame();
    expect(frame).toContain("Press return");
    expect(frame).toContain("…");
  });

  test("say a secret has no expansion rather than offering one", async () => {
    const secret = everyBlockKind().find((block) => block.sensitivity === "secret");
    if (secret === undefined) {
      throw new Error("the corpus no longer has a secret block");
    }
    using shell = await open(projectionOf([secret]));
    await named(shell, "enter");
    const frame = await shell.frame();
    expect(frame).toContain("Running a provider check");
    expect(frame).toContain("no expansion");
  });
});

describe("scroll anchoring", () => {
  test("does not yank a reader back when new entries arrive", async () => {
    // The contract, end to end. The reader scrolls up, and the arriving history
    // is announced below rather than dragging the view.
    using shell = await open(history(400), { columns: 100, rows: 24 });
    await named(shell, "pageup");
    const scrolled = await shell.frame();
    expect(scrolled).toContain("later entries below");
    expect(scrolled).not.toContain("entry 399");
  });

  test("surfaces unseen activity with the key that follows it again", async () => {
    using shell = await open(history(400));
    await named(shell, "pageup");
    expect(await shell.frame()).toContain("press end to follow the latest");
  });

  test("follows the latest again on the jump command", async () => {
    using shell = await open(history(400));
    await named(shell, "pageup");
    expect(await shell.frame()).toContain("later entries below");

    await named(shell, "end");
    const frame = await shell.frame();
    expect(frame).toContain("entry 399");
    expect(frame).not.toContain("later entries below");
  });

  test("reaches the start and the end of the history", async () => {
    using shell = await open(history(200));
    await named(shell, "home");
    expect(await shell.frame()).toContain("entry 0");

    await named(shell, "end");
    expect(await shell.frame()).toContain("entry 199");
  });
});

describe("a large history", () => {
  test("renders in a window bounded by the terminal, not by the session", async () => {
    // Ten thousand blocks into a 24-row terminal. What is asserted is the number
    // of renderables in the tree: a component that mounted the history and let
    // the renderer cull it would draw the same frame and fail this.
    using shell = await open(history(10_000));
    expect(await shell.frame()).toContain("entry 9999");
    expect(shell.renderableCount()).toBeLessThan(200);
  });

  test("draws the same bounded frame for a hundred blocks and for ten thousand", async () => {
    using small = await open(history(100));
    using large = await open(history(10_000));
    const difference = Math.abs(small.renderableCount() - large.renderableCount());
    expect(difference).toBeLessThanOrEqual(4);
  });

  test("never draws past the region it was given", async () => {
    using shell = await open(history(10_000), { columns: 100, rows: 24 });
    const frame = await shell.frame();
    expect(frame.split("\n").filter((line) => line.trim() !== "").length).toBeLessThanOrEqual(24);
  });
});

describe("long unbroken content", () => {
  test("wraps rather than overflowing the region", async () => {
    const model = everyBlockKind().find((block) => block.kind === "model-text");
    if (model === undefined || model.kind !== "model-text") {
      throw new Error("the corpus no longer has model text");
    }
    using shell = await open(projectionOf([{ ...model, text: complete("x".repeat(5_000)) }]), {
      columns: 80,
      rows: 24,
    });
    await named(shell, "enter");
    const frame = await shell.frame();
    for (const line of frame.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(81);
    }
  });

  test("escapes content that would otherwise forge a line", async () => {
    // The negative control. A block's content comes from a provider, a file, or
    // a process, and any of them can carry an escape sequence.
    const model = everyBlockKind().find((block) => block.kind === "model-text");
    if (model === undefined || model.kind !== "model-text") {
      throw new Error("the corpus no longer has model text");
    }
    using shell = await open(projectionOf([{ ...model, text: complete("a\u001b[2Jb") }]));
    await named(shell, "enter");
    const frame = await shell.frame();
    expect(frame).not.toContain("\u001b[2J");
    expect(frame).toContain("\\x1b");
  });
});

describe("resize", () => {
  test("re-wraps expanded content without losing the reader's place", async () => {
    using shell = await open(history(400), { columns: 100, rows: 24 });
    await named(shell, "pageup");
    const before = await shell.frame();
    const anchored = /entry (\d+)/.exec(before)?.[1];
    expect(anchored).toBeDefined();

    await shell.resize(60, 20);
    const after = await shell.frame();
    // The same entry is still on screen: the anchor names a block, so a narrower
    // terminal changes that block's height and not which block is being read.
    expect(after).toContain(`entry ${anchored}`);
  });

  test("survives a resize storm with the transcript still drawn", async () => {
    using shell = await open(history(500));
    for (let columns = 40; columns <= 120; columns += 4) {
      await shell.resize(columns, 24);
    }
    expect(await shell.frame()).toContain("entry");
  });

  test("keeps an expansion open across a resize", async () => {
    using shell = await open(history(5));
    await named(shell, "enter");
    expect(await shell.frame()).toContain("the body of entry 4");

    await shell.resize(60, 20);
    expect(await shell.frame()).toContain("the body of entry 4");
  });
});

describe("inspection", () => {
  function ofKind(kind: TranscriptBlock["kind"]): TranscriptBlock {
    const block = everyBlockKind().find((candidate) => candidate.kind === kind);
    if (block === undefined) {
      throw new Error(`the corpus no longer has a ${kind} block`);
    }
    return block;
  }

  test("opens an overlay over a failed process without inferring success", async () => {
    using shell = await open(projectionOf([ofKind("process-exit")]));
    await shell.press("p", { ctrl: true });
    await shell.type("transcript.inspect");
    shell.setup.mockInput.pressEnter();

    const frame = await shell.frame();
    expect(frame).toContain("Process exited");
    expect(frame).toContain("Build failed");
    expect(frame).toContain("exit  1");
    expect(frame).toContain("failed (partial effect)");
    expect(frame).not.toContain("Not sent");

    await named(shell, "escape");
    const restored = await shell.frame();
    expect(restored).toContain("Build failed");
    expect(restored).toContain("selected");
    expect(restored).not.toContain("failed (partial effect)");
    expect(restored).not.toContain("Esc closes this");
  });

  test("shows diagnostics through the same overlay", async () => {
    using shell = await open(projectionOf([ofKind("process-exit")]));
    await shell.press("p", { ctrl: true });
    await shell.type("transcript.showDiagnostics");
    shell.setup.mockInput.pressEnter();

    const frame = await shell.frame();
    expect(frame).toContain("Process exited");
    expect(frame).toContain("failed (partial effect)");
  });

  test("refuses a notice that has no inspection", async () => {
    using shell = await open(history(3), { columns: 100, rows: 30 });
    await shell.press("p", { ctrl: true });
    await shell.type("transcript.inspect");
    shell.setup.mockInput.pressEnter();

    expect(await shell.frame()).toContain("no tool, process, reasoning, or error inspection");
  });
});

describe("the code artifact viewer", () => {
  const SOURCE = "export const answer = 42;\n";

  function artifactBlock(): TranscriptBlock {
    const block = everyBlockKind().find((candidate) => candidate.kind === "artifact");
    if (block === undefined || block.kind !== "artifact") {
      throw new Error("the corpus no longer has an artifact block");
    }
    return block;
  }

  test("opens syntax-highlighted source and restores the transcript on close", async () => {
    const viewer = createMapArtifactViewer({
      [FIXTURE_ARTIFACT]: fixtureCodeArtifactView({
        id: "artifact-fixture",
        text: SOURCE,
      }),
    });

    using shell = await open(
      projectionOf([artifactBlock()]),
      { columns: 100, rows: 30 },
      {
        artifactViewer: viewer,
      },
    );
    await shell.press("p", { ctrl: true });
    await shell.type("transcript.openArtifact");
    shell.setup.mockInput.pressEnter();

    const opened = await shell.frame();
    expect(opened).toContain("Source");
    expect(opened).toContain("export const answer");

    await named(shell, "escape");
    const restored = await shell.frame();
    expect(restored).toContain("Captured the build log");
    expect(restored).not.toContain("Source");
  });
});

describe("an overlay over the transcript", () => {
  test("does not disturb the anchor or the expansion underneath it", async () => {
    // The preservation contract. An overlay is a route, and opening one is not a
    // decision about what the reader was reading.
    using shell = await open(history(400));
    await named(shell, "pageup");
    await named(shell, "enter");
    const before = await shell.frame();
    const anchored = /entry (\d+)/.exec(before)?.[1];

    await shell.press("?");
    expect(await shell.frame()).toContain("Help");

    await named(shell, "escape");
    const after = await shell.frame();
    expect(after).toContain(`entry ${anchored}`);
    expect(after).toContain("later entries below");
  });
});

describe("an unknown fallback", () => {
  test("names the gap without copying payload onto the frame", async () => {
    const SECRET = "sk-live-SECRET-MUST-NOT-ESCAPE";
    const result = admitTranscriptRecord({
      kind: "future-widget",
      order: 0,
      occurredAt: FIXTURE_AT,
      text: SECRET,
      summary: SECRET,
    });
    if (!result.ok) {
      throw new Error(`expected admission, got ${result.error.code}`);
    }
    using shell = await open(projectionOf([result.value]));
    const frame = await shell.frame();
    expect(frame).toContain("Unrecognized block");
    expect(frame).not.toContain(SECRET);
    expect(frame).not.toContain("Notice");
  });
});
