/**
 * The scrollback seam, mounted.
 *
 * `../scrollback.test.ts` proves the adapter's ordering against a real queue
 * with lines it invented. This proves the other half: that the shell actually
 * mounts the adapter, that what reaches scrollback is what the transcript
 * surface decided a block says, and that the rules which only exist at this seam
 * — expanded, unselected, no relative time — are the ones applied.
 *
 * Split-footer with stdout capture on purpose. It is the only mode where any of
 * this happens, and the mode is also the reason the assertions read from the
 * external-output recorder rather than from a captured frame: these rows go to
 * the terminal above the footer, so they are never in the buffer a frame capture
 * decodes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import {
  complete,
  EMPTY_PROJECTION,
  type TranscriptBlock,
  type TranscriptProjection,
} from "../../presentation/index.ts";
import { everyBlockKind, FIXTURE_AT } from "../../presentation/transcript/fixtures.ts";
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

/** A notice block with a chosen key, body, and lifecycle status. */
function entry(
  key: string,
  status: "final" | "in-progress",
  order: number,
  body: string,
): TranscriptBlock {
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
    summary: complete(`summary of ${key}`),
    note: complete(body),
  };
}

function projectionOf(blocks: readonly TranscriptBlock[]): TranscriptProjection {
  return { ...EMPTY_PROJECTION, blocks };
}

type Session = {
  show(transcript: TranscriptProjection): Promise<void>;
  scrollback(): Promise<string>;
};

async function mount(): Promise<Session> {
  const setup = await createTestRenderer({
    width: 100,
    height: 24,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  });
  live.push(setup);

  const root = createRoot(setup.renderer);
  return {
    async show(transcript) {
      root.render(
        <ShellApp theme={THEME} model={MODEL} onExit={() => {}} transcript={transcript} />,
      );
      await settle(setup);
    },
    async scrollback() {
      await settle(setup);
      return setup.externalOutput.takeText();
    },
  };
}

async function settle(setup: TestRendererSetup): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await Bun.sleep(10);
    await setup.flush();
  }
}

describe("the shell in split-footer", () => {
  test("commits a finalized entry's content to scrollback", async () => {
    // The wiring, end to end: a projection reaches the tree, the seam is
    // mounted, and the block's own body — not only its headline — is what
    // landed above the footer.
    const session = await mount();
    await session.show(projectionOf([entry("one", "final", 0, "the durable body")]));

    const scrollback = await session.scrollback();
    expect(scrollback).toContain("summary of one");
    expect(scrollback).toContain("the durable body");
  });

  test("commits an entry once across many renders", async () => {
    const session = await mount();
    const transcript = projectionOf([entry("one", "final", 0, "the durable body")]);

    await session.show(transcript);
    await session.scrollback();
    await session.show(transcript);

    expect(await session.scrollback()).toBe("");
  });

  test("holds an unfinished entry and everything behind it", async () => {
    const session = await mount();
    await session.show(
      projectionOf([
        entry("streaming", "in-progress", 0, "still arriving"),
        entry("later", "final", 1, "already done"),
      ]),
    );

    const scrollback = await session.scrollback();
    expect(scrollback).not.toContain("still arriving");
    expect(scrollback).not.toContain("already done");
  });

  test("commits a settled entry ahead of the one it held", async () => {
    const session = await mount();
    await session.show(
      projectionOf([
        entry("streaming", "in-progress", 0, "still arriving"),
        entry("later", "final", 1, "already done"),
      ]),
    );
    await session.scrollback();
    await session.show(
      projectionOf([
        entry("streaming", "final", 0, "finally settled"),
        entry("later", "final", 1, "already done"),
      ]),
    );

    const scrollback = await session.scrollback();
    expect(scrollback.indexOf("finally settled")).toBeGreaterThanOrEqual(0);
    expect(scrollback.indexOf("finally settled")).toBeLessThan(scrollback.indexOf("already done"));
  });

  test("writes no relative time and no selection marker", async () => {
    // Both are answers about a reading session. A committed row outlives the
    // session, so an age is a claim that stops being true and a selection is a
    // cursor position with nothing left to point at.
    const session = await mount();
    await session.show(projectionOf([entry("one", "final", 0, "the durable body")]));

    const scrollback = await session.scrollback();
    expect(scrollback).not.toContain("ago");
    expect(scrollback).not.toContain("selected");
  });
});

describe("the shell in a mode that owns the whole terminal", () => {
  test("commits nothing to scrollback", async () => {
    const setup = await createTestRenderer({
      width: 100,
      height: 24,
      screenMode: "alternate-screen",
      consoleMode: "disabled",
    });
    live.push(setup);

    createRoot(setup.renderer).render(
      <ShellApp
        theme={THEME}
        model={MODEL}
        onExit={() => {}}
        transcript={projectionOf([entry("one", "final", 0, "the durable body")])}
      />,
    );
    await settle(setup);

    expect(setup.externalOutput.takeText()).toBe("");
  });
});
