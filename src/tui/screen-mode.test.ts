/**
 * Mode selection, and the stdout consequence that comes with it.
 *
 * The delivered default is `split-footer` because #22 qualified it on a
 * compiled artifact — and the same probe measured the thing documentation could
 * not answer, which is that its stdout capture takes the handle
 * `src/cli/streams.ts` owns. Both halves are asserted here, because a default
 * chosen for a recorded reason and a default nobody re-examined look identical
 * from the outside.
 */

import { describe, expect, test } from "bun:test";
import {
  createStaticEnvironment,
  type ObservedHandles,
  terminalCapabilities,
} from "../domain/index.ts";
import { type ShellCapabilities, shellCapabilities, withSize } from "./capabilities.ts";
import {
  capturesStdout,
  EXTERNAL_OUTPUT_MODE,
  MIN_SPLIT_FOOTER_ROWS,
  reservesFooter,
  SPLIT_FOOTER_HEIGHT,
  selectScreenMode,
} from "./screen-mode.ts";

function record(rows: number, variables: Readonly<Record<string, string>> = {}): ShellCapabilities {
  const handles: ObservedHandles = {
    stdout: { isTty: true, columns: 100, rows },
    stderr: { isTty: true, columns: 100, rows },
    stdin: { isTty: true },
  };
  const environment = createStaticEnvironment({ TERM: "xterm-256color", ...variables });
  return shellCapabilities({ handles: terminalCapabilities(handles, environment), environment });
}

describe("the delivered default", () => {
  test("is split-footer on a terminal with room for it", () => {
    expect(selectScreenMode(record(40))).toEqual({
      mode: "split-footer",
      reason: "transcript-first",
    });
  });

  test("holds at exactly the minimum, and gives way one row below it", () => {
    // The boundary rather than a value on either side of it: an off-by-one here
    // would show up as a footer with nothing above it on a specific terminal
    // size, which is the hardest kind of bug to be told about.
    expect(selectScreenMode(record(MIN_SPLIT_FOOTER_ROWS)).mode).toBe("split-footer");
    expect(selectScreenMode(record(MIN_SPLIT_FOOTER_ROWS - 1)).mode).toBe("alternate-screen");
  });

  test("leaves room above the footer, not just for it", () => {
    // A footer occupying the whole terminal is an alternate screen with extra
    // steps, and the entire reason to prefer split-footer is what stays above it.
    expect(MIN_SPLIT_FOOTER_ROWS).toBeGreaterThan(SPLIT_FOOTER_HEIGHT);
  });
});

describe("a terminal too short to share", () => {
  test("takes the whole viewport rather than a buffered region", () => {
    // Not `main-screen`: a short terminal is exactly where a buffered region
    // overlapping the user's own scrollback is most visible.
    expect(selectScreenMode(record(8))).toEqual({
      mode: "alternate-screen",
      reason: "insufficient-rows",
    });
  });

  test("still resolves when the record has no size at all", () => {
    // Selection is not the layer that refuses a terminal — that is the launch
    // decision — so a record without a size resolves to the mode needing least.
    const sizeless = withSize(record(40), null, null);
    expect(selectScreenMode(sizeless).mode).toBe("alternate-screen");
  });
});

describe("the override", () => {
  test("names the mode, whatever selection would have chosen", () => {
    expect(selectScreenMode(record(40, { FALRYN_TUI: "main-screen" }))).toEqual({
      mode: "main-screen",
      reason: "override",
    });
  });

  test("outranks a terminal too short for the mode it asked for", () => {
    // Believed over detection, which is the reason the override exists at all.
    expect(selectScreenMode(record(6, { FALRYN_TUI: "split-footer" }))).toEqual({
      mode: "split-footer",
      reason: "override",
    });
  });
});

describe("stdout ownership", () => {
  test("is taken by split-footer and by nothing else", () => {
    // The finding #22 recorded, restated as a property of the mode rather than
    // a sentence in a comment. A shell running in either other mode leaves the
    // handle `src/cli/streams.ts` owns exactly where it was.
    expect(capturesStdout("split-footer")).toBe(true);
    expect(capturesStdout("alternate-screen")).toBe(false);
    expect(capturesStdout("main-screen")).toBe(false);
  });

  test("is capture rather than passthrough, deliberately", () => {
    // Stated so that flipping it is a decision someone has to make here, with
    // the reason in front of them: passthrough would let a stray write land
    // mid-frame and tear the interface.
    expect(EXTERNAL_OUTPUT_MODE).toBe("capture-stdout");
  });
});

describe("the footer", () => {
  test("is reserved by split-footer alone", () => {
    expect(reservesFooter("split-footer")).toBe(true);
    expect(reservesFooter("alternate-screen")).toBe(false);
    expect(reservesFooter("main-screen")).toBe(false);
  });
});
