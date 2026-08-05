/**
 * The renderer session: one owner, and a terminal that always comes back.
 *
 * Everything here runs against `createTestRenderer`, which builds the same
 * native renderer the product path uses and skips only host-terminal setup. So
 * these are not tests against a stand-in for OpenTUI — they are tests against
 * OpenTUI, with the terminal replaced by memory. Every one of them destroys its
 * renderer in teardown, because the ownership guard is process-wide and a test
 * that leaked a session would fail the next one instead of itself.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
  createStaticEnvironment,
  type ObservedHandles,
  terminalCapabilities,
} from "../domain/index.ts";
import {
  type ShellCapabilities,
  shellCapabilities,
  withRendererCapabilities,
} from "./capabilities.ts";
import {
  enabledModes,
  hasOpenRendererSession,
  nothingToRestore,
  observeRenderer,
  openRendererSession,
  RESIZE_DEBOUNCE_MS,
  type RendererFactory,
  type RendererSession,
  rendererConfigFor,
} from "./renderer-session.ts";
import { SCREEN_MODES, SPLIT_FOOTER_HEIGHT, selectScreenMode } from "./screen-mode.ts";

const HANDLES: ObservedHandles = {
  stdout: { isTty: true, columns: 100, rows: 30 },
  stderr: { isTty: true, columns: 100, rows: 30 },
  stdin: { isTty: true },
};

function record(variables: Readonly<Record<string, string>> = {}): ShellCapabilities {
  const environment = createStaticEnvironment({ TERM: "xterm-256color", ...variables });
  return shellCapabilities({ handles: terminalCapabilities(HANDLES, environment), environment });
}

/** A real renderer, drawing into memory rather than into the developer's terminal. */
const inMemory: RendererFactory = async (config) => {
  const setup = await createTestRenderer({ ...config, width: 100, height: 30 });
  return setup.renderer;
};

const opened: RendererSession[] = [];

async function open(
  capabilities: ShellCapabilities = record(),
  createRenderer: RendererFactory = inMemory,
  pointer?: boolean,
) {
  const result = await openRendererSession({
    capabilities,
    selection: selectScreenMode(capabilities),
    createRenderer,
    ...(pointer === undefined ? {} : { pointer }),
  });
  if (result.ok) {
    opened.push(result.value);
  }
  return result;
}

afterEach(() => {
  // Unconditionally, and before anything else can run. The guard is module
  // state by design, so a leaked session is not this test failing — it is the
  // next one failing for a reason that has nothing to do with it.
  while (opened.length > 0) {
    opened.pop()?.restore();
  }
});

describe("the renderer options that are not defaults", () => {
  test("leave interrupt, signals, and diagnostics with their existing owners", () => {
    const config = rendererConfigFor({
      capabilities: record(),
      selection: selectScreenMode(record()),
    });
    // Each of these would otherwise install a second owner of something Falryn
    // already owns, and the first two were measured by #22 rather than assumed.
    expect(config.exitOnCtrlC).toBe(false);
    expect(config.exitSignals).toEqual([]);
    expect(config.consoleMode).toBe("disabled");
  });

  test("gate the mouse rather than leaving OpenTUI's default of on", () => {
    const config = rendererConfigFor({
      capabilities: record(),
      selection: selectScreenMode(record()),
    });
    expect(config.useMouse).toBe(false);
    expect(config.enableMouseMovement).toBe(false);
  });

  test("never turn the mouse on at creation, whatever the record says", () => {
    // The ordering #392 made load-bearing. A renderer is always created with
    // reporting off, because the record cannot answer whether this terminal has
    // a mouse until a renderer has reported one — and a terminal that turns out
    // to have none must never have had reporting turned on for it. Reporting is
    // enabled after the refresh, by `openRendererSession`, which is where both
    // inputs exist.
    const enabled = withRendererCapabilities(record(), {
      screenMode: "split-footer",
      columns: 100,
      rows: 30,
      mouse: true,
      focusEvents: true,
      bracketedPaste: true,
      kittyKeyboard: false,
      hyperlinks: false,
      synchronizedOutput: false,
      themeMode: null,
      remote: false,
      multiplexer: null,
    });
    expect(
      rendererConfigFor({ capabilities: enabled, selection: selectScreenMode(enabled) }).useMouse,
    ).toBe(false);
  });

  test("pair stdout capture with the one mode that permits it", () => {
    // The assertion whose absence let #351 ship. `capture-stdout` is legal only
    // with `split-footer`, and OpenTUI rejects the pairing during construction
    // rather than ignoring it — so a constant here does not configure the other
    // modes wrongly, it stops them starting at all.
    expect(
      rendererConfigFor({
        capabilities: record(),
        selection: { mode: "split-footer", reason: "transcript-first" },
      }).externalOutputMode,
    ).toBe("capture-stdout");

    for (const mode of ["alternate-screen", "main-screen"] as const) {
      expect({
        mode,
        output: rendererConfigFor({
          capabilities: record(),
          selection: { mode, reason: "override" },
        }).externalOutputMode,
      }).toEqual({ mode, output: "passthrough" });
    }
  });

  test("reserve the footer only in the mode that has one", () => {
    const split = record();
    expect(
      rendererConfigFor({
        capabilities: split,
        selection: { mode: "split-footer", reason: "transcript-first" },
      }).footerHeight,
    ).toBe(SPLIT_FOOTER_HEIGHT);
    expect(
      rendererConfigFor({
        capabilities: split,
        selection: { mode: "alternate-screen", reason: "override" },
      }).footerHeight,
    ).toBeUndefined();
  });

  test("debounce resize enough to stop a frame storm and no more", () => {
    const config = rendererConfigFor({
      capabilities: record(),
      selection: selectScreenMode(record()),
    });
    expect(config.debounceDelay).toBe(RESIZE_DEBOUNCE_MS);
    expect(RESIZE_DEBOUNCE_MS).toBeLessThan(100);
  });
});

describe("the modes a session asks for", () => {
  test("are derived from the configuration rather than asserted", () => {
    // A mode nobody enabled must never be reported as one that was restored.
    const split = enabledModes({
      screenMode: "split-footer",
      externalOutputMode: "capture-stdout",
    });
    expect(split).toContain("raw-input");
    expect(split).toContain("stdout-capture");
    expect(split).not.toContain("alternate-screen");
    expect(split).not.toContain("mouse");
  });

  test("include the alternate screen only in that mode", () => {
    expect(enabledModes({ screenMode: "alternate-screen" })).toContain("alternate-screen");
    expect(enabledModes({ screenMode: "main-screen" })).not.toContain("alternate-screen");
  });

  test("include stdout capture only where the renderer actually takes it", () => {
    expect(
      enabledModes({ screenMode: "split-footer", externalOutputMode: "passthrough" }),
    ).not.toContain("stdout-capture");
    expect(
      enabledModes({ screenMode: "alternate-screen", externalOutputMode: "capture-stdout" }),
    ).not.toContain("stdout-capture");
  });
});

describe("every declared mode", () => {
  test("constructs a real renderer", async () => {
    // The check #351 needed and did not have. A mode that cannot start now fails
    // here rather than in a user's session, and it is a *construction* test
    // because that is where OpenTUI rejects an illegal pairing — a configuration
    // assertion alone would not have caught a rule this code does not own.
    for (const mode of SCREEN_MODES) {
      const capabilities = record();
      const result = await openRendererSession({
        capabilities,
        selection: { mode, reason: "override" },
        createRenderer: inMemory,
      });
      expect({ mode, opened: result.ok }).toEqual({ mode, opened: true });
      if (result.ok) {
        // Restored immediately rather than in teardown: the guard is
        // process-wide, so the next mode cannot open until this one lets go.
        result.value.restore();
      }
    }
  });

  test("reports stdout capture as enabled only where it is", async () => {
    // Restoration names exactly what was enabled. A mode that does not capture
    // must not claim it gave the handle back.
    for (const mode of SCREEN_MODES) {
      const capabilities = record();
      const config = rendererConfigFor({ capabilities, selection: { mode, reason: "override" } });
      expect({ mode, captured: enabledModes(config).includes("stdout-capture") }).toEqual({
        mode,
        captured: mode === "split-footer",
      });
    }
  });
});

describe("one renderer per process", () => {
  test("opens the first and refuses the second", () => {
    return (async () => {
      const first = await open();
      expect(first.ok).toBe(true);
      expect(hasOpenRendererSession()).toBe(true);

      // Not a second view: two objects fighting over one terminal, one
      // `requestAnimationFrame`, and one set of process listeners.
      const second = await open();
      expect(second.ok).toBe(false);
      expect(second.ok ? null : second.error).toEqual({ code: "already-open", detail: null });
    })();
  });

  test("frees the slot once the first is restored", async () => {
    const first = await open();
    expect(first.ok).toBe(true);
    if (first.ok) {
      first.value.restore();
    }
    expect(hasOpenRendererSession()).toBe(false);

    const second = await open();
    expect(second.ok).toBe(true);
  });
});

describe("restoration", () => {
  test("happens once in effect and any number of times safely", async () => {
    const result = await open();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const session = result.value;

    const first = session.restore();
    expect(first.restoredNow).toBe(true);
    expect(first.failure).toBe(null);
    expect(first.modes.length).toBeGreaterThan(0);
    expect(session.isRestored()).toBe(true);

    // Both the shell's own teardown and the `restore-terminal` participant call
    // this, frequently at the same time. The second call must be safe *and*
    // distinguishable, or an idempotent contract is untestable.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const again = session.restore();
      expect(again.restoredNow).toBe(false);
      expect(again.modes).toEqual(first.modes);
    }
  });

  test("names what it gave back", async () => {
    const result = await open();
    if (!result.ok) {
      throw new Error("the session did not open");
    }
    expect([...result.value.restore().modes].sort()).toEqual([...result.value.enabled].sort());
  });
});

describe("a renderer that never started", () => {
  test("is reported rather than thrown", async () => {
    // The caller has to restore, emit a plain diagnostic, and resolve an exit
    // status — none of which it can do from inside a stack unwind.
    const result = await open(record(), () => {
      throw new Error("no native library for this platform");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("initialization-failed");
      expect(result.error.detail).toBe("no native library for this platform");
    }
  });

  test("leaves no session open", async () => {
    await open(record(), () => Promise.reject(new Error("refused")));
    expect(hasOpenRendererSession()).toBe(false);
  });

  test("still has something to restore, which reports that there was nothing", async () => {
    // A failure path that skipped restoration is the one path where the
    // terminal is most likely already half-configured. "Nothing to give back"
    // is a fact the report should state, not an absence nobody recorded.
    const terminal = nothingToRestore();
    expect(terminal.isRestored()).toBe(false);
    expect(terminal.restore()).toEqual({ modes: [], restoredNow: true, failure: null });
    expect(terminal.restore().restoredNow).toBe(false);
    expect(terminal.isRestored()).toBe(true);
  });
});

describe("what a live renderer reports", () => {
  test("reads an unanswered capability query as no rather than yes", async () => {
    const result = await open();
    if (!result.ok) {
      throw new Error("the session did not open");
    }
    const observed = observeRenderer(result.value.renderer);
    expect(observed.columns).toBe(100);
    expect(observed.rows).toBe(30);
    expect(observed.mouse).toBe(false);
    // The test renderer answers no capability query, so every flag below is the
    // "not answered" case — which must not read as support.
    expect(observed.kittyKeyboard).toBe(false);
    expect(observed.hyperlinks).toBe(false);
  });

  test("reaches the record, which then says it came from a renderer", async () => {
    const result = await open();
    if (!result.ok) {
      throw new Error("the session did not open");
    }
    const capabilities = result.value.capabilities();
    expect(capabilities.source).toBe("renderer");
    expect(capabilities.renderer).not.toBe(null);
    expect(result.value.isRenderable()).toBe(true);
  });
});

describe("resize", () => {
  test("refreshes the record and tells every listener", async () => {
    const result = await open();
    if (!result.ok) {
      throw new Error("the session did not open");
    }
    const session = result.value;
    const seen: (number | null)[] = [];
    session.onResize((capabilities) => seen.push(capabilities.columns));

    session.renderer.emit("resize", 80, 24);
    expect(seen).toEqual([80]);
    expect(session.capabilities().columns).toBe(80);
    expect(session.isRenderable()).toBe(true);
  });

  test("treats zero and absurd dimensions as no size at all", async () => {
    const result = await open();
    if (!result.ok) {
      throw new Error("the session did not open");
    }
    const session = result.value;

    session.renderer.emit("resize", 0, 24);
    // Not a zero-width terminal: a terminal with no usable size. Drawing pauses
    // and nothing is torn down, so the size coming back is a repaint.
    expect(session.isRenderable()).toBe(false);
    expect(session.capabilities().columns).toBe(null);

    session.renderer.emit("resize", 100, 30);
    expect(session.isRenderable()).toBe(true);
  });

  test("stops telling a listener that unsubscribed", async () => {
    const result = await open();
    if (!result.ok) {
      throw new Error("the session did not open");
    }
    const session = result.value;
    let calls = 0;
    const unsubscribe = session.onResize(() => {
      calls += 1;
    });
    session.renderer.emit("resize", 90, 30);
    unsubscribe();
    session.renderer.emit("resize", 70, 30);
    expect(calls).toBe(1);
  });

  test("delivers nothing to a listener once the session is restored", async () => {
    const result = await open();
    if (!result.ok) {
      throw new Error("the session did not open");
    }
    const session = result.value;
    let calls = 0;
    session.onResize(() => {
      calls += 1;
    });
    session.restore();
    // A subscription that outlived its renderer would keep a torn-down session
    // reachable, which is the shape of every listener leak.
    expect(calls).toBe(0);
  });
});

describe("mouse reporting", () => {
  test("is off when the user has not asked for it", async () => {
    const session = await open(record(), inMemory, false);
    expect(session.ok).toBe(true);
    if (!session.ok) {
      return;
    }
    expect(session.value.renderer.useMouse).toBe(false);
    // And the restoration report does not claim a mode nobody enabled.
    expect(session.value.enabled).not.toContain("mouse");
  });

  test("is off when nothing resolved the setting at all", async () => {
    // Every rendered check that mounts a shell directly is this caller. An
    // unanswered question is not a yes.
    const session = await open(record(), inMemory);
    expect(session.ok).toBe(true);
    if (!session.ok) {
      return;
    }
    expect(session.value.renderer.useMouse).toBe(false);
    expect(session.value.enabled).not.toContain("mouse");
  });

  test("is on when the user asked for it, and is reported as a mode to give back", async () => {
    // The gate answering yes, which is what makes it a gate — and the mode
    // appearing in what the session says it enabled, because a terminal left in
    // mouse reporting after exit is the failure this module exists to prevent
    // and the report is what says it did not happen.
    const session = await open(record(), inMemory, true);
    expect(session.ok).toBe(true);
    if (!session.ok) {
      return;
    }
    expect(session.value.renderer.useMouse).toBe(true);
    expect(session.value.enabled).toContain("mouse");

    const report = session.value.restore();
    expect(report.restoredNow).toBe(true);
    expect(report.modes).toContain("mouse");
    expect(report.failure).toBe(null);
  });
});
