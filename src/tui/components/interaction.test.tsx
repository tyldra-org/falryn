/**
 * The keyboard, end to end.
 *
 * Every test here presses a key into a real OpenTUI renderer with a real keymap
 * and asserts on what reached the screen. The unit tests prove the registry, the
 * plan, the focus model, and the reducer in isolation; this file proves they are
 * wired to each other and to a terminal — which is the part that was broken, and
 * broken invisibly.
 *
 * The defect this file exists for: the shell shipped with no keyboard route out
 * at all. A terminal in raw mode has `ISIG` off, so Ctrl+C arrives as the byte
 * `0x03` rather than as `SIGINT`, and nothing consumed it. Underneath that,
 * `createOpenTuiKeymap` returns a keymap with no binding parsers registered, so
 * the first `registerLayer` threw inside a React effect where nothing surfaced
 * it. Two failures, both silent, and a status line promising `^C exit`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ThemeRequest } from "../theme/index.ts";
import type { ShellModel } from "../view-model.ts";
import { known, unavailable } from "../view-model.ts";
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

const MODEL: Omit<ShellModel, "overlay" | "commands" | "transcript"> = {
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
  readonly setup: TestRendererSetup;
  /** A printable character, with modifiers. */
  press(name: string, modifiers?: { ctrl?: boolean; shift?: boolean }): Promise<void>;
  /** A named key. `pressKey` types its argument as text, so these have their own methods. */
  pressNamed(key: "escape" | "tab", modifiers?: { shift?: boolean }): Promise<void>;
  frame(): Promise<string>;
  exits(): number;
};

/**
 * A mounted shell that keys can be pressed into.
 *
 * `alternate-screen` rather than the default `split-footer`, and the reason is
 * worth stating: in split-footer the live region is a six-row footer, so an
 * overlay has almost nothing to draw into and an assertion about its content
 * would be measuring the footer rather than the interface. The mode is a
 * property of the terminal, not of the interaction being tested.
 */
async function mount(rows = 30): Promise<Session> {
  let exits = 0;
  const setup = await createTestRenderer({
    width: 100,
    height: rows,
    screenMode: "alternate-screen",
    consoleMode: "disabled",
  });
  live.push(setup);

  createRoot(setup.renderer).render(
    <ShellApp
      theme={THEME}
      model={MODEL}
      onExit={() => {
        exits += 1;
      }}
    />,
  );
  await settle(setup);

  return {
    setup,
    async press(name, modifiers = {}) {
      setup.mockInput.pressKey(name, modifiers);
      await settle(setup);
    },
    async pressNamed(key, modifiers = {}) {
      // `pressKey("escape")` types the six characters of the word. The named
      // keys have dedicated methods because they are escape sequences, not text.
      if (key === "escape") {
        setup.mockInput.pressEscape(modifiers);
      } else {
        setup.mockInput.pressTab(modifiers);
      }
      await settle(setup);
    },
    frame: async () => {
      await settle(setup);
      return setup.captureCharFrame();
    },
    exits: () => exits,
  };
}

/** Yields to the loop until React has committed and the renderer has drawn. */
async function settle(setup: TestRendererSetup): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await Bun.sleep(10);
    await setup.flush();
  }
}

describe("the shell at rest", () => {
  test("advertises only keys that currently run", async () => {
    // A hint for an unavailable command is a promise the interface cannot keep,
    // and the status line is the worst place to make one.
    const session = await mount();
    const frame = await session.frame();
    expect(frame).toContain("^C");
    expect(frame).toContain("/work/falryn");
  });
});

describe("exit", () => {
  test("responds to Ctrl+C", async () => {
    // The defect, as a test. In raw mode this key is a byte and not a signal, so
    // nothing outside the keymap can act on it.
    const session = await mount();
    expect(session.exits()).toBe(0);
    await session.press("c", { ctrl: true });
    expect(session.exits()).toBe(1);
  });

  test("does not fire on an ordinary key", async () => {
    const session = await mount();
    await session.press("a");
    await session.press("x");
    expect(session.exits()).toBe(0);
  });
});

describe("help", () => {
  test("opens on its key and lists commands with their keys", async () => {
    const session = await mount();
    await session.press("?");
    const frame = await session.frame();
    expect(frame).toContain("Help");
    expect(frame).toContain("ctrl+c");
    expect(frame).toContain("Exit");
  });

  test("says why a command cannot run", async () => {
    // Listed, discoverable, and answered — rather than hidden or silently inert.
    // Tall enough to show the whole registry: since #355 the transcript's own
    // commands sit above the composer's, and a 30-row terminal reports the rest
    // as "6 more" rather than drawing them. That elision is correct behavior, so
    // the terminal grows instead of the assertion moving to a nearer row.
    const session = await mount(40);
    await session.press("?");
    const frame = await session.frame();
    expect(frame).toContain("no composer yet");
    // The transcript's commands are unavailable for their own reason, and it is
    // a different sentence rather than a shared "unavailable".
    expect(frame).toContain("there is no transcript yet");
    expect(frame).toContain("there is no artifact viewer yet");
  });

  test("closes on escape and gives the frame back", async () => {
    const session = await mount();
    await session.press("?");
    expect(await session.frame()).toContain("Help");

    await session.pressNamed("escape");
    const frame = await session.frame();
    expect(frame).not.toContain("Close overlay");
    expect(frame).toContain("/work/falryn");
  });
});

describe("the command palette", () => {
  test("opens on its key", async () => {
    const session = await mount();
    await session.press("p", { ctrl: true });
    expect(await session.frame()).toContain("Commands");
  });

  test("closes on escape", async () => {
    const session = await mount();
    await session.press("p", { ctrl: true });
    await session.pressNamed("escape");
    expect(await session.frame()).toContain("/work/falryn");
  });
});

describe("escape", () => {
  test("closes an overlay when one is open and does not exit", async () => {
    // The layering, at the level a user experiences it: the same key means two
    // things and the narrower one wins while its surface exists.
    const session = await mount();
    await session.press("?");
    await session.pressNamed("escape");
    expect(session.exits()).toBe(0);
  });

  test("reports that there is nothing to cancel when no overlay is open", async () => {
    // `app.cancel` owns escape at rest and is unavailable, so pressing it says
    // so rather than doing nothing — which is what makes a key feel broken.
    const session = await mount();
    await session.pressNamed("escape");
    expect(await session.frame()).toContain("nothing is running");
  });
});

describe("the keyboard-only journey", () => {
  test("opens help, closes it, opens the palette, closes it, and exits", async () => {
    // The completion proof: every essential action of this shell reached with
    // the keyboard alone, in one sequence, against a real renderer.
    const session = await mount();

    await session.press("?");
    expect(await session.frame()).toContain("Help");

    await session.pressNamed("escape");
    expect(await session.frame()).not.toContain("Close overlay");

    await session.press("p", { ctrl: true });
    expect(await session.frame()).toContain("Commands");

    await session.pressNamed("escape");
    await session.pressNamed("tab");
    await session.pressNamed("tab", { shift: true });

    expect(session.exits()).toBe(0);
    await session.press("c", { ctrl: true });
    expect(session.exits()).toBe(1);
  });
});
