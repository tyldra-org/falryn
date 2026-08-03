/**
 * The capability record.
 *
 * Two properties matter more than any individual field. The record must
 * *extend* the domain's facts rather than restate them — a second derivation of
 * colour or symbols would be a second answer to whether this terminal can draw
 * a character — and it must keep "not observed yet" distinguishable from "not
 * supported", because a view that could not tell them apart would degrade on a
 * terminal that had simply not answered yet.
 */

import { describe, expect, test } from "bun:test";
import {
  createStaticEnvironment,
  DETACHED_HANDLES,
  type ObservedHandles,
  terminalCapabilities,
} from "../domain/index.ts";
import {
  FIRST_CAPABILITY_GENERATION,
  hasUsableSize,
  type RendererCapabilities,
  readShellOverride,
  SHELL_OVERRIDE_VALUES,
  type ShellCapabilities,
  shellCapabilities,
  terminalHints,
  usesMouse,
  withRendererCapabilities,
  withSize,
} from "./capabilities.ts";

const INTERACTIVE: ObservedHandles = {
  stdout: { isTty: true, columns: 100, rows: 30 },
  stderr: { isTty: true, columns: 100, rows: 30 },
  stdin: { isTty: true },
};

function record(
  variables: Readonly<Record<string, string>> = { TERM: "xterm-256color" },
  handles: ObservedHandles = INTERACTIVE,
): ShellCapabilities {
  const environment = createStaticEnvironment(variables);
  return shellCapabilities({ handles: terminalCapabilities(handles, environment), environment });
}

const OBSERVED: RendererCapabilities = {
  screenMode: "split-footer",
  columns: 100,
  rows: 30,
  mouse: false,
  focusEvents: true,
  bracketedPaste: true,
  kittyKeyboard: false,
  hyperlinks: true,
  synchronizedOutput: true,
  themeMode: "dark",
  remote: false,
  multiplexer: "none",
};

describe("the record", () => {
  test("carries the domain's answer verbatim rather than recomputing it", () => {
    const environment = createStaticEnvironment({ TERM: "xterm-256color", LANG: "en_US.UTF-8" });
    const handles = terminalCapabilities(INTERACTIVE, environment);
    // Identity, not equality. A copy would be a second value that could drift;
    // the same object cannot.
    expect(shellCapabilities({ handles, environment }).handles).toBe(handles);
  });

  test("takes its size from the handle the frames land on", () => {
    // stdout, not stderr and not stdin. A record keyed off the wrong handle
    // would lay out against a terminal that is not being drawn into.
    const built = record(
      { TERM: "xterm-256color" },
      {
        ...INTERACTIVE,
        stdout: { isTty: true, columns: 80, rows: 24 },
        stderr: { isTty: true, columns: 200, rows: 60 },
      },
    );
    expect({ columns: built.columns, rows: built.rows }).toEqual({ columns: 80, rows: 24 });
  });

  test("starts with no renderer facts at all", () => {
    // Absent is absent. `null` means "no renderer has looked yet", which a view
    // must be able to tell apart from a terminal that answered "no".
    const built = record();
    expect(built.renderer).toBe(null);
    expect(built.source).toBe("handles");
    expect(built.generation).toBe(FIRST_CAPABILITY_GENERATION);
  });

  test("reports no usable size for handles with nothing attached", () => {
    const built = record({}, DETACHED_HANDLES);
    expect(hasUsableSize(built)).toBe(false);
    expect({ columns: built.columns, rows: built.rows }).toEqual({ columns: null, rows: null });
  });
});

describe("hints", () => {
  test("name a multiplexer from the variable the multiplexer sets", () => {
    expect(terminalHints(createStaticEnvironment({ TMUX: "/tmp/x,1,0" })).multiplexer).toBe("tmux");
    expect(terminalHints(createStaticEnvironment({ ZELLIJ: "0" })).multiplexer).toBe("zellij");
    expect(terminalHints(createStaticEnvironment({ STY: "1.pts-0" })).multiplexer).toBe("screen");
  });

  test("fall back to TERM, but only as a fallback", () => {
    // `screen-256color` outside a multiplexer is a real configuration, so the
    // process variables are checked first and this is the weaker signal.
    expect(terminalHints(createStaticEnvironment({ TERM: "screen-256color" })).multiplexer).toBe(
      "screen",
    );
    expect(terminalHints(createStaticEnvironment({ TERM: "xterm-256color" })).multiplexer).toBe(
      null,
    );
  });

  test("read a remote session from any of the ssh variables", () => {
    for (const variable of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) {
      expect(terminalHints(createStaticEnvironment({ [variable]: "x" })).remote).toBe(true);
    }
    expect(terminalHints(createStaticEnvironment({})).remote).toBe(false);
  });

  test("read CI as a yes or a no rather than as presence", () => {
    // `CI=false` is the ordinary way to say "not CI". Reading any non-empty
    // string as a yes would misreport a developer's own machine.
    expect(terminalHints(createStaticEnvironment({ CI: "true" })).ci).toBe(true);
    expect(terminalHints(createStaticEnvironment({ CI: "1" })).ci).toBe(true);
    expect(terminalHints(createStaticEnvironment({ CI: "false" })).ci).toBe(false);
    expect(terminalHints(createStaticEnvironment({ CI: "0" })).ci).toBe(false);
    expect(terminalHints(createStaticEnvironment({})).ci).toBe(false);
  });

  test("read a dumb terminal from TERM alone", () => {
    expect(terminalHints(createStaticEnvironment({ TERM: "dumb" })).dumbTerminal).toBe(true);
    expect(terminalHints(createStaticEnvironment({ TERM: "xterm" })).dumbTerminal).toBe(false);
  });
});

describe("the override", () => {
  test("reads off, a mode, or nothing", () => {
    expect(readShellOverride(createStaticEnvironment({}))).toEqual({ kind: "none" });
    expect(readShellOverride(createStaticEnvironment({ FALRYN_TUI: "off" }))).toEqual({
      kind: "off",
    });
    expect(readShellOverride(createStaticEnvironment({ FALRYN_TUI: "main-screen" }))).toEqual({
      kind: "mode",
      mode: "main-screen",
    });
  });

  test("is case- and whitespace-insensitive", () => {
    expect(readShellOverride(createStaticEnvironment({ FALRYN_TUI: "  Split-Footer " }))).toEqual({
      kind: "mode",
      mode: "split-footer",
    });
  });

  test("carries an unrecognized value instead of discarding it", () => {
    // A misspelled override that changed nothing and said nothing would look
    // exactly like one that was honoured.
    expect(readShellOverride(createStaticEnvironment({ FALRYN_TUI: "sput" }))).toEqual({
      kind: "unrecognized",
      value: "sput",
    });
  });

  test("names every value it accepts, so a diagnostic can list them", () => {
    expect([...SHELL_OVERRIDE_VALUES].sort()).toEqual([
      "alternate-screen",
      "main-screen",
      "off",
      "split-footer",
    ]);
  });
});

describe("refreshing", () => {
  test("records the renderer's facts and its provenance", () => {
    const refreshed = withRendererCapabilities(record(), OBSERVED);
    expect(refreshed.renderer).toEqual(OBSERVED);
    expect(refreshed.source).toBe("renderer");
    expect(refreshed.generation).toBe(FIRST_CAPABILITY_GENERATION + 1);
  });

  test("lets the renderer's own dimensions win", () => {
    // A terminal that changed size between startup and setup would otherwise
    // leave the record describing the terminal as it used to be.
    const refreshed = withRendererCapabilities(record(), { ...OBSERVED, columns: 64, rows: 20 });
    expect({ columns: refreshed.columns, rows: refreshed.rows }).toEqual({
      columns: 64,
      rows: 20,
    });
  });

  test("keeps the domain's facts and the hints untouched", () => {
    const base = record({ TERM: "xterm-256color", TMUX: "/tmp/x,1,0" });
    const refreshed = withRendererCapabilities(base, OBSERVED);
    expect(refreshed.handles).toBe(base.handles);
    expect(refreshed.hints).toEqual(base.hints);
  });

  test("advances the generation on a resize, and only on a real one", () => {
    const base = withRendererCapabilities(record(), OBSERVED);
    const resized = withSize(base, 80, 24);
    expect(resized.generation).toBe(base.generation + 1);
    // A resize event reporting the size it already had is not a change, and a
    // generation that advanced anyway would make staleness meaningless.
    expect(withSize(resized, 80, 24)).toBe(resized);
  });

  test("carries an unusable size through as no size", () => {
    // Preserving state and pausing rendering both depend on this: the record
    // says there is nothing to draw into rather than inventing something.
    const paused = withSize(withRendererCapabilities(record(), OBSERVED), null, null);
    expect(hasUsableSize(paused)).toBe(false);
    expect(paused.renderer).toEqual(OBSERVED);
  });
});

describe("the mouse gate", () => {
  test("is off before a renderer has observed anything", () => {
    // Every creation happens here, which is the point: nothing consumes a
    // pointer event yet, and OpenTUI's default is on.
    expect(usesMouse(record())).toBe(false);
  });

  test("is off on a dumb terminal even when a renderer reports it", () => {
    const dumb = withRendererCapabilities(record({ TERM: "dumb" }), { ...OBSERVED, mouse: true });
    expect(usesMouse(dumb)).toBe(false);
  });

  test("reads the record rather than a constant", () => {
    // The gate has to be able to answer yes, or it is not a gate.
    const enabled = withRendererCapabilities(record(), { ...OBSERVED, mouse: true });
    expect(usesMouse(enabled)).toBe(true);
  });
});
