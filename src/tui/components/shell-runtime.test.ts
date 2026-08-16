/**
 * The shell's state machine.
 *
 * A reducer, so the interactive behavior is testable as a sequence of values
 * rather than through a rendered frame. What is checked here is what a user
 * would notice: that opening an overlay contains focus and closing it gives
 * focus back, that a resize does not close anything, and that an unavailable
 * command says why instead of appearing broken.
 */

import { describe, expect, test } from "bun:test";
import { blockKey } from "../../presentation/index.ts";
import { everyBlockKind } from "../../presentation/transcript/fixtures.ts";
import { EMPTY_COMMAND_STATE } from "../commands.ts";
import { isContained } from "../focus.ts";
import {
  activeContexts,
  commandStateFor,
  FRAME_REGIONS,
  INITIAL_SHELL_STATE,
  overlayRegions,
  type ShellAction,
  type ShellState,
  shellReducer,
} from "./shell-runtime.tsx";

function run(actions: readonly ShellAction[], from: ShellState = INITIAL_SHELL_STATE): ShellState {
  return actions.reduce(shellReducer, from);
}

describe("the resting state", () => {
  test("has no overlay and focuses the first region", () => {
    expect(INITIAL_SHELL_STATE.overlay).toEqual({ kind: "none" });
    expect(INITIAL_SHELL_STATE.focus.focused).toBe("frame.header");
    expect(INITIAL_SHELL_STATE.exiting).toBe(false);
  });

  test("makes only the global context active", () => {
    // Every other context's surface is absent, so its bindings must not be
    // registered — a binding in an inactive layer would shadow a broader one.
    expect(activeContexts(INITIAL_SHELL_STATE)).toEqual(["global"]);
  });

  test("reports a command state with nothing behind it", () => {
    expect(commandStateFor(INITIAL_SHELL_STATE)).toEqual(EMPTY_COMMAND_STATE);
  });

  test("reports inspectable selection from the selected block", () => {
    const processExit = everyBlockKind().find((block) => block.kind === "process-exit");
    if (processExit === undefined) {
      throw new Error("the corpus no longer has a process-exit block");
    }
    const key = blockKey(processExit.anchor);
    const state = run([{ kind: "transcript", action: { kind: "reconcile", keys: [key] } }]);
    const inspectable = commandStateFor(state, [processExit]);
    expect(inspectable.hasInspectableSelection).toBe(true);
    expect(inspectable.hasDiagnosticSelection).toBe(true);
    expect(commandStateFor(state).hasInspectableSelection).toBe(false);

    const notice = everyBlockKind().find((block) => block.kind === "notice");
    if (notice === undefined) {
      throw new Error("the corpus no longer has a notice block");
    }
    const noticeState = run([
      { kind: "transcript", action: { kind: "reconcile", keys: [blockKey(notice.anchor)] } },
    ]);
    expect(commandStateFor(noticeState, [notice]).hasInspectableSelection).toBe(false);
    expect(commandStateFor(noticeState, [notice]).hasDiagnosticSelection).toBe(false);
  });
});

describe("opening an overlay", () => {
  test("contains focus within it", () => {
    const state = run([{ kind: "open-overlay", route: { kind: "help" } }]);
    expect(state.overlay).toEqual({ kind: "help" });
    expect(state.focus.order.map((region) => region.id)).toEqual(["overlay.help"]);
    expect(isContained(state.focus)).toBe(true);
  });

  test("activates the overlay context, so escape means close", () => {
    const state = run([{ kind: "open-overlay", route: { kind: "palette", query: "" } }]);
    expect(activeContexts(state)).toEqual(["global", "overlay"]);
    expect(commandStateFor(state).overlayOpen).toBe(true);
  });

  test("names a region for each route", () => {
    expect(overlayRegions({ kind: "help" })[0]?.id).toBe("overlay.help");
    expect(overlayRegions({ kind: "palette", query: "" })[0]?.id).toBe("overlay.palette");
    expect(overlayRegions({ kind: "inspect", key: "process-exit" })[0]?.id).toBe("overlay.inspect");
    // With no overlay the frame's own regions are what is reachable.
    expect(overlayRegions({ kind: "none" })).toEqual(FRAME_REGIONS);
  });

  test("gives every region a label", () => {
    // A focus indicator that is not colour-only needs words.
    for (const route of [
      { kind: "help" } as const,
      { kind: "palette", query: "" } as const,
      { kind: "inspect", key: "process-exit" } as const,
    ]) {
      for (const region of overlayRegions(route)) {
        expect({ id: region.id, labelled: region.label.length > 0 }).toEqual({
          id: region.id,
          labelled: true,
        });
      }
    }
  });
});

describe("closing an overlay", () => {
  test("returns focus where it was", () => {
    // The round trip a user performs constantly: move somewhere, open help,
    // close it, and still be where they were.
    const state = run([
      { kind: "focus-next" },
      { kind: "open-overlay", route: { kind: "help" } },
      { kind: "close-overlay" },
    ]);
    expect(state.overlay).toEqual({ kind: "none" });
    expect(state.focus.focused).toBe("frame.primary");
    expect(isContained(state.focus)).toBe(false);
  });

  test("changes nothing when no overlay is open", () => {
    // Identity, so a stray escape does not clear a notice or move focus.
    const state = run([{ kind: "focus-next" }]);
    expect(shellReducer(state, { kind: "close-overlay" })).toBe(state);
  });
});

describe("focus movement", () => {
  test("walks the frame in reading order and wraps", () => {
    let state = run([{ kind: "focus-next" }]);
    expect(state.focus.focused).toBe("frame.primary");
    // Four regions since #357 put the composer between the primary region and
    // the status line, so the wrap takes one more step than it did.
    state = run([{ kind: "focus-next" }, { kind: "focus-next" }, { kind: "focus-next" }], state);
    expect(state.focus.focused).toBe("frame.header");
  });

  test("is confined to the overlay while one is open", () => {
    // Background regions do not take a key meant for the focused control, and
    // Tab is the key that would prove it if they did.
    const state = run([
      { kind: "open-overlay", route: { kind: "help" } },
      { kind: "focus-next" },
      { kind: "focus-next" },
    ]);
    expect(state.focus.focused).toBe("overlay.help");
  });
});

describe("a resize", () => {
  test("keeps focus where it is when the region survived", () => {
    const state = run([{ kind: "focus-next" }, { kind: "reseat", regions: FRAME_REGIONS }]);
    expect(state.focus.focused).toBe("frame.primary");
  });

  test("moves focus to the neighbour when its region went away", () => {
    const survivors = [FRAME_REGIONS[0] as never, FRAME_REGIONS[3] as never];
    const state = run([{ kind: "focus-next" }, { kind: "reseat", regions: survivors }]);
    expect(state.focus.focused).toBe("frame.status");
  });

  test("does not close an open overlay", () => {
    // A resize rearranges; it does not decide what the user was reading.
    const state = run([
      { kind: "open-overlay", route: { kind: "help" } },
      { kind: "reseat", regions: overlayRegions({ kind: "help" }) },
    ]);
    expect(state.overlay).toEqual({ kind: "help" });
  });

  test("still restores focus correctly afterwards", () => {
    const state = run([
      { kind: "focus-next" },
      { kind: "open-overlay", route: { kind: "help" } },
      { kind: "reseat", regions: overlayRegions({ kind: "help" }) },
      { kind: "close-overlay" },
    ]);
    expect(state.focus.focused).toBe("frame.primary");
  });
});

describe("notices", () => {
  test("carry what happened and are cleared by an empty one", () => {
    expect(run([{ kind: "notice", message: "unavailable" }]).notice).toBe("unavailable");
    expect(
      run([
        { kind: "notice", message: "unavailable" },
        { kind: "notice", message: "" },
      ]).notice,
    ).toBe(null);
  });

  test("do not outlive an overlay transition", () => {
    // A message about the last thing that happened must not sit under an
    // overlay that has since opened.
    const state = run([
      { kind: "notice", message: "unavailable" },
      { kind: "open-overlay", route: { kind: "help" } },
    ]);
    expect(state.notice).toBe(null);
  });
});

describe("exiting", () => {
  test("is recorded rather than performed", () => {
    // The reducer sets a flag; the caller ends the session. A state machine
    // that tore down a renderer would be a second owner of the exit.
    expect(run([{ kind: "exit" }]).exiting).toBe(true);
  });
});
