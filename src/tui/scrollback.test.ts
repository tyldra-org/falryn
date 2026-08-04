/**
 * The scrollback adapter, against a real renderer's real queue.
 *
 * Every test here creates an OpenTUI renderer in `split-footer` with stdout
 * capture and reads what reached the terminal through the test renderer's
 * external-output recorder. That is the whole point: the claim #356 makes is
 * about ordering inside a FIFO the native renderer owns, and a stand-in host
 * would only ever prove that this file agrees with itself.
 *
 * The recorder sees the same commits the terminal does, in the same order,
 * whether they came from a scrollback writer or from a captured `stdout.write`.
 * Reaching for `renderer.stdout.write` in a test is deliberate and is the only
 * honest way to ask the interleaving question — while the renderer is alive that
 * handle *is* the capture path, which is exactly what a child process's bytes
 * would arrive through.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { TranscriptBlock } from "../presentation/index.ts";
import { blockKey, complete } from "../presentation/index.ts";
import { everyBlockKind, FIXTURE_AT } from "../presentation/transcript/fixtures.ts";
import { createScrollbackAdapter, type ScrollbackRenderer } from "./scrollback.ts";

const live: TestRendererSetup[] = [];

afterEach(() => {
  while (live.length > 0) {
    live.pop()?.renderer.destroy();
  }
});

/**
 * A stdout the test holds a reference to.
 *
 * The test renderer makes its own when none is supplied, and the interception
 * that makes capture work replaces `write` on *that* object — so a test with no
 * handle of its own has no way to ask the interleaving question. Discards what
 * it is given, because in capture mode the renderer takes the text before this
 * ever runs, and on the paths where it does not there is nothing worth writing
 * to a terminal that is not attached.
 */
function captureStdout(columns: number, rows: number): NodeJS.WriteStream {
  const stream = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  return Object.assign(stream, {
    isTTY: true,
    columns,
    rows,
    getColorDepth: () => 24,
  }) as unknown as NodeJS.WriteStream;
}

async function renderer(
  mode: "split-footer" | "alternate-screen" | "main-screen" = "split-footer",
): Promise<TestRendererSetup & { readonly out: NodeJS.WriteStream }> {
  const out = captureStdout(40, 12);
  const setup = await createTestRenderer({
    width: 40,
    height: 12,
    stdout: out,
    screenMode: mode,
    // Legal only with `split-footer`; OpenTUI rejects the pairing outright
    // otherwise, which is the same reason `rendererConfigFor` derives it.
    externalOutputMode: mode === "split-footer" ? "capture-stdout" : "passthrough",
    consoleMode: "disabled",
  });
  live.push(setup);
  return { ...setup, out };
}

/**
 * A block with a chosen key and lifecycle status.
 *
 * Built from the corpus rather than from a literal, so a block that gains a
 * required field does not leave this file constructing something no producer
 * would.
 */
function entry(key: string, status: "final" | "in-progress", order: number): TranscriptBlock {
  const notice = everyBlockKind().find((block) => block.kind === "notice");
  if (notice === undefined || notice.kind !== "notice") {
    throw new Error("the corpus no longer has a notice block");
  }
  return {
    ...notice,
    anchor: { of: "declared", key },
    occurredAt: FIXTURE_AT,
    order,
    status,
    summary: complete(key),
    note: complete(`the body of ${key}`),
  };
}

/**
 * The key the adapter reports for one of these entries.
 *
 * Derived through `blockKey` rather than written out, because block identity is
 * the projection's answer and a literal here would be this file's second one.
 */
function keyOf(key: string): string {
  return blockKey({ of: "declared", key });
}

/**
 * One line per block, naming it.
 *
 * The rendering decision is `../tui/transcript/lines.ts`'s and is asserted
 * there. What these tests need is a line they can recognize in the recorder,
 * so ordering assertions read as ordering rather than as string matching.
 */
const name: ScrollbackRenderer = (block) => [
  { text: block.summary.text, color: null, attributes: 0 },
];

/** The text of every commit the recorder has, in commit order. */
function committedText(setup: TestRendererSetup): readonly string[] {
  return setup.externalOutput.take().flatMap((commit) => commit.rows.map((row) => row.trimEnd()));
}

describe("committing finalized entries", () => {
  test("commits each finalized block once, in semantic order", async () => {
    const setup = await renderer();
    const adapter = createScrollbackAdapter(setup.renderer);
    const blocks = [entry("one", "final", 0), entry("two", "final", 1)];

    const report = await adapter.commit({ blocks, render: name });

    expect(report.committed).toEqual([keyOf("one"), keyOf("two")]);
    expect(report.failure).toBeNull();
    expect(committedText(setup)).toEqual(["one", "two"]);
  });

  test("commits nothing a second time for the same projection", async () => {
    // The acceptance criterion, and the failure it guards is duplication rather
    // than absence: a render loop observes the same projection many times, and
    // scrollback has no way to take a row back.
    const setup = await renderer();
    const adapter = createScrollbackAdapter(setup.renderer);
    const blocks = [entry("one", "final", 0)];

    await adapter.commit({ blocks, render: name });
    setup.externalOutput.clear();
    const again = await adapter.commit({ blocks, render: name });

    expect(again.committed).toEqual([]);
    expect(committedText(setup)).toEqual([]);
  });

  test("commits only the entries a growing projection added", async () => {
    const setup = await renderer();
    const adapter = createScrollbackAdapter(setup.renderer);
    const first = [entry("one", "final", 0)];

    await adapter.commit({ blocks: first, render: name });
    setup.externalOutput.clear();
    const grown = await adapter.commit({
      blocks: [...first, entry("two", "final", 1)],
      render: name,
    });

    expect(grown.committed).toEqual([keyOf("two")]);
    expect(committedText(setup)).toEqual(["two"]);
    expect([...adapter.committedKeys()]).toEqual([keyOf("one"), keyOf("two")]);
  });
});

describe("an entry that is still streaming", () => {
  test("holds every later entry behind it", async () => {
    // Scrollback is append-only. Committing the finished entry behind an
    // unfinished one would place it before its predecessor permanently, and
    // there is no later frame in which to correct the order.
    const setup = await renderer();
    const adapter = createScrollbackAdapter(setup.renderer);

    const report = await adapter.commit({
      blocks: [entry("one", "in-progress", 0), entry("two", "final", 1)],
      render: name,
    });

    expect(report.committed).toEqual([]);
    expect(report.held).toBe(keyOf("one"));
    expect(committedText(setup)).toEqual([]);
  });

  test("settles, then commits its rows exactly once, before the entries it held", async () => {
    // The second acceptance criterion. The settling path renders into a backing
    // buffer and copies rows out only after `settle()` — and the entry that was
    // waiting behind it still lands after it.
    const setup = await renderer();
    const adapter = createScrollbackAdapter(setup.renderer);

    await adapter.commit({
      blocks: [entry("one", "in-progress", 0), entry("two", "final", 1)],
      render: name,
    });
    const settled = await adapter.commit({
      blocks: [entry("one", "final", 0), entry("two", "final", 1)],
      render: name,
    });

    expect(settled.committed).toEqual([keyOf("one"), keyOf("two")]);
    expect(settled.held).toBeNull();
    expect(committedText(setup)).toEqual(["one", "two"]);

    setup.externalOutput.clear();
    await adapter.commit({
      blocks: [entry("one", "final", 0), entry("two", "final", 1)],
      render: name,
    });
    expect(committedText(setup)).toEqual([]);
  });

  test("keeps a settling entry ahead of an atomic one enqueued after it", async () => {
    // The ordering the serializing chain exists for. A surface has to settle
    // before it can commit and a writer does not, so without one chain the
    // atomic entry would overtake the streamed one it is supposed to follow.
    const setup = await renderer();
    const adapter = createScrollbackAdapter(setup.renderer);

    await adapter.commit({ blocks: [entry("streamed", "in-progress", 0)], render: name });
    await adapter.commit({
      blocks: [entry("streamed", "final", 0), entry("atomic", "final", 1)],
      render: name,
    });

    expect(committedText(setup)).toEqual(["streamed", "atomic"]);
  });
});

describe("ordering against captured stdout", () => {
  test("interleaves with captured output in the order both were produced", async () => {
    // One FIFO, asserted rather than assumed. Both sources produce styled
    // snapshots that the native side emits alongside the footer repaint, and
    // the recorder observes that single queue.
    const setup = await renderer();
    const adapter = createScrollbackAdapter(setup.renderer);

    await adapter.commit({ blocks: [entry("before", "final", 0)], render: name });
    // The handle the renderer took ownership of, which is what a child
    // process's bytes would arrive on. Its `write` is the capture path while the
    // renderer is alive, so this reaches the same queue the commits do.
    setup.out.write("captured\n");
    await adapter.commit({
      blocks: [entry("before", "final", 0), entry("after", "final", 1)],
      render: name,
    });

    expect(committedText(setup)).toEqual(["before", "captured", "after"]);
  });
});

describe("a mode that draws into the whole terminal", () => {
  test("commits nothing in alternate-screen", async () => {
    // A no-op rather than a refusal. OpenTUI's scrollback APIs throw when the
    // mode is wrong, and an adapter that let that reach the render loop would
    // take the interface down for a mode change the user asked for.
    const setup = await renderer("alternate-screen");
    const adapter = createScrollbackAdapter(setup.renderer);

    const report = await adapter.commit({
      blocks: [entry("one", "final", 0)],
      render: name,
    });

    expect(report).toEqual({ committed: [], held: null, failure: null });
    expect([...adapter.committedKeys()]).toEqual([]);
  });

  test("commits nothing in main-screen", async () => {
    const setup = await renderer("main-screen");
    const adapter = createScrollbackAdapter(setup.renderer);

    const report = await adapter.commit({ blocks: [entry("one", "final", 0)], render: name });

    expect(report.committed).toEqual([]);
  });

  test("commits nothing after it is destroyed", async () => {
    const setup = await renderer();
    const adapter = createScrollbackAdapter(setup.renderer);
    adapter.destroy();

    const report = await adapter.commit({ blocks: [entry("one", "final", 0)], render: name });

    expect(report.committed).toEqual([]);
    expect(committedText(setup)).toEqual([]);
  });
});

describe("a commit the renderer refused", () => {
  test("reports the failure and keeps committing afterwards", async () => {
    // A renderer that refused one entry is not a scrollback that stops working
    // for the rest of the session, and a shell that stopped drawing because a
    // row could not be committed would be a worse outcome than the missing row.
    const setup = await renderer();
    const adapter = createScrollbackAdapter(setup.renderer);
    const refuse: ScrollbackRenderer = () => {
      throw new Error("no lines for this block");
    };

    const refused = await adapter.commit({ blocks: [entry("bad", "final", 0)], render: refuse });
    expect(refused.failure).toContain("no lines");

    setup.externalOutput.clear();
    const after = await adapter.commit({
      blocks: [entry("bad", "final", 0), entry("good", "final", 1)],
      render: name,
    });

    expect(after.failure).toBeNull();
    expect(committedText(setup)).toEqual(["good"]);
  });
});
