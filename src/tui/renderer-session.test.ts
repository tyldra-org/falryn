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
    const config = rendererConfigFor({ capabilities: record() });
    // Each of these would otherwise install a second owner of something Falryn
    // already owns, and the first two were measured by #22 rather than assumed.
    expect(config.exitOnCtrlC).toBe(false);
    expect(config.exitSignals).toEqual([]);
    expect(config.consoleMode).toBe("disabled");
  });

  test("gate the mouse rather than leaving OpenTUI's default of on", () => {
    const config = rendererConfigFor({ capabilities: record() });
    expect(config.useMouse).toBe(false);
    expect(config.enableMouseMovement).toBe(false);
  });

  test("requests Kitty keyboard modifier reporting explicitly", () => {
    const config = rendererConfigFor({ capabilities: record() });
    expect(config.useKittyKeyboard).toEqual({});
  });

  test("never turn the mouse on from the record alone", () => {
    // Creation *is* when reporting is turned on, when the setting says so — see
    // "mouse reporting" below. What this holds is the other half: a record
    // reporting a mouse decides nothing on its own.
    //
    // That is not a preference. `observeRenderer` records
    // `mouse: renderer.useMouse`, which is this program's own setting reflected
    // back rather than anything the terminal said — OpenTUI's
    // `TerminalCapabilities` declares no mouse field at all. A gate that read it
    // would ask whether reporting was on in order to decide whether to turn it
    // on, and would never enable once. #392 was planned that way and this is
    // where that would have shown up.
    const enabled = withRendererCapabilities(record(), {
      screenMode: "alternate-screen",
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
    expect(rendererConfigFor({ capabilities: enabled }).useMouse).toBe(false);
  });

  test("always requests the full alternate screen without capturing stdout", () => {
    const config = rendererConfigFor({ capabilities: record() });
    expect(config.screenMode).toBe("alternate-screen");
    expect(config.externalOutputMode).toBe("passthrough");
    expect(config.footerHeight).toBeUndefined();
  });

  test("debounce resize enough to stop a frame storm and no more", () => {
    const config = rendererConfigFor({ capabilities: record() });
    expect(config.debounceDelay).toBe(RESIZE_DEBOUNCE_MS);
    expect(RESIZE_DEBOUNCE_MS).toBeLessThan(100);
  });
});

describe("the terminal state a session asks for", () => {
  test("includes the alternate screen and never claims stdout capture", () => {
    const modes = enabledModes(rendererConfigFor({ capabilities: record() }));
    expect(modes).toContain("raw-input");
    expect(modes).toContain("alternate-screen");
    expect(modes).not.toContain("stdout-capture");
    expect(modes).not.toContain("mouse");
  });

  test("constructs the only interactive renderer", async () => {
    const result = await openRendererSession({ capabilities: record(), createRenderer: inMemory });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.renderer.screenMode).toBe("alternate-screen");
      result.value.restore();
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
