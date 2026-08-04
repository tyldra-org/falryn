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

import { describe, expect, test } from "bun:test";
import { mount, type Rendered } from "../harness.tsx";
import type { ThemeRequest } from "../theme/index.ts";
import type { ShellModel } from "../view-model.ts";
import { known, unavailable } from "../view-model.ts";
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

/** A mounted shell, plus the count of times it asked to leave. */
type Session = Rendered & {
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
async function open(rows = 30): Promise<Session> {
  let exits = 0;
  const shell = await mount(
    <ShellApp
      theme={THEME}
      model={MODEL}
      onExit={() => {
        exits += 1;
      }}
    />,
    { shape: { columns: 100, rows }, screenMode: "alternate-screen" },
  );
  await shell.frame("/work/falryn");
  return Object.assign(shell, { exits: () => exits });
}

describe("the shell at rest", () => {
  test("advertises only keys that currently run", async () => {
    // A hint for an unavailable command is a promise the interface cannot keep,
    // and the status line is the worst place to make one.
    using shell = await open();
    const frame = await shell.frame();
    expect(frame).toContain("^C");
    expect(frame).toContain("/work/falryn");
  });
});

describe("exit", () => {
  test("responds to Ctrl+C", async () => {
    // The defect, as a test. In raw mode this key is a byte and not a signal, so
    // nothing outside the keymap can act on it.
    using shell = await open();
    expect(shell.exits()).toBe(0);
    await shell.press("c", { ctrl: true });
    expect(shell.exits()).toBe(1);
  });

  test("does not fire on an ordinary key", async () => {
    using shell = await open();
    await shell.press("a");
    await shell.press("x");
    expect(shell.exits()).toBe(0);
  });
});

describe("help", () => {
  test("opens on its key and lists commands with their keys", async () => {
    using shell = await open();
    const frame = await shell.press("?");
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
    using shell = await open(40);
    const frame = await shell.press("?");
    expect(frame).toContain("the composer is not focused");
    // The transcript's commands are unavailable for their own reason, and it is
    // a different sentence rather than a shared "unavailable".
    expect(frame).toContain("there is no transcript yet");
    expect(frame).toContain("there is no artifact viewer yet");
  });

  test("closes on escape and gives the frame back", async () => {
    using shell = await open();
    expect(await shell.press("?")).toContain("Help");

    const frame = await shell.pressEscape();
    expect(frame).not.toContain("Close overlay");
    expect(frame).toContain("/work/falryn");
  });
});

describe("the command palette", () => {
  test("opens on its key", async () => {
    using shell = await open();
    expect(await shell.press("p", { ctrl: true })).toContain("Commands");
  });

  test("closes on escape", async () => {
    using shell = await open();
    await shell.press("p", { ctrl: true });
    expect(await shell.pressEscape()).toContain("/work/falryn");
  });
});

describe("escape", () => {
  test("closes an overlay when one is open and does not exit", async () => {
    // The layering, at the level a user experiences it: the same key means two
    // things and the narrower one wins while its surface exists.
    using shell = await open();
    await shell.press("?");
    await shell.pressEscape();
    expect(shell.exits()).toBe(0);
  });

  test("reports that there is nothing to cancel when no overlay is open", async () => {
    // `app.cancel` owns escape at rest and is unavailable, so pressing it says
    // so rather than doing nothing — which is what makes a key feel broken.
    using shell = await open();
    expect(await shell.pressEscape()).toContain("nothing is running");
  });
});

describe("the keyboard-only journey", () => {
  test("opens help, closes it, opens the palette, closes it, and exits", async () => {
    // The completion proof: every essential action of this shell reached with
    // the keyboard alone, in one sequence, against a real renderer.
    using shell = await open();

    expect(await shell.press("?")).toContain("Help");
    expect(await shell.pressEscape()).not.toContain("Close overlay");
    expect(await shell.press("p", { ctrl: true })).toContain("Commands");

    await shell.pressEscape();
    await shell.pressTab();
    await shell.pressTab({ shift: true });

    expect(shell.exits()).toBe(0);
    await shell.press("c", { ctrl: true });
    expect(shell.exits()).toBe(1);
  });
});
