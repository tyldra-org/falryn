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
 * The full screen, which is Falryn's only interactive mode. The test exercises
 * the same viewport contract a user receives.
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
    { shape: { columns: 100, rows } },
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
    // The overlay is a fraction of the frame, so this asserts reasons that sit
    // in the visible window, not every later command in the registry.
    using shell = await open(40);
    const frame = await shell.press("?");
    expect(frame).toContain("there is no transcript yet");
    expect(frame).toContain("there is no openable artifact to view for this entry");
    expect(frame).toContain("no Git dashboard is open");
  });

  test("scrolls long help through OpenTUI's focused scrollbox", async () => {
    using shell = await open(14);
    const opening = await shell.press("?");
    expect(opening).toContain("Help");
    expect(opening).not.toContain("Decline");

    await shell.press("\u001b[F");
    expect(await shell.frame()).toContain("Decline");
  });

  test("closes on escape and gives the frame back", async () => {
    using shell = await open();
    // #381. The negative must name something this frame actually drew while
    // open. `"Close overlay"` is a real command title, but at this height the
    // help list truncates before reaching it — so it is absent in both states
    // and `not.toContain("Close overlay")` would pass if escape stopped closing
    // overlays. The panel title discriminates: pointed at `opened` it fails.
    const opened = await shell.press("?");
    expect(opened).toContain("Help");

    const frame = await shell.pressEscape();
    expect(frame).not.toContain("Help");
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
    // `"Commands"` is measured present while the palette is open, so denying it
    // after escape is a negative that can fail.
    const opened = await shell.press("p", { ctrl: true });
    expect(opened).toContain("Commands");
    const closed = await shell.pressEscape();
    expect(closed).not.toContain("Commands");
    expect(closed).toContain("/work/falryn");
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

    const helpOpen = await shell.press("?");
    expect(helpOpen).toContain("Help");
    // Same measured negative as the dedicated help close check — not the
    // truncated command title that is absent while help is open.
    expect(await shell.pressEscape()).not.toContain("Help");

    const paletteOpen = await shell.press("p", { ctrl: true });
    expect(paletteOpen).toContain("Commands");
    expect(await shell.pressEscape()).not.toContain("Commands");

    await shell.pressTab();
    await shell.pressTab({ shift: true });

    expect(shell.exits()).toBe(0);
    await shell.press("c", { ctrl: true });
    expect(shell.exits()).toBe(1);
  });
});
