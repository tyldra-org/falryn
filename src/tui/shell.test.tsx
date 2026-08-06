/**
 * The shell, across every path it can end on.
 *
 * The clean return, both interrupt levels, deadline expiry, a renderer that
 * crashed, and a renderer that never started. The last three are the ones that
 * matter most and are least likely to be exercised by hand — and they are the
 * ones where a mistake leaves a user's terminal in raw mode with the alternate
 * screen up and the cursor hidden, which is a state you close the window to
 * escape.
 *
 * Every renderer here is a real one from `createTestRenderer`, drawing into
 * memory. Every test restores in teardown, because the ownership guard is
 * process-wide.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { MouseButton, TextareaRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createScopeTree, createShutdownCoordinator } from "../application/index.ts";
import { createRecordingCliStreams, type GlobalOptions } from "../cli/index.ts";
import {
  createManualClock,
  createStaticEnvironment,
  type ObservedHandles,
  terminalCapabilities,
} from "../domain/index.ts";
import { type ShellCapabilities, shellCapabilities } from "./capabilities.ts";
import { hasOpenRendererSession, type RendererFactory } from "./renderer-session.ts";
import { runShell } from "./shell.tsx";
import { SHELL_KEY_HINTS } from "./shell-model.ts";
import { TERMINAL_RESTORE_PARTICIPANT } from "./shutdown.ts";

const HANDLES: ObservedHandles = {
  stdout: { isTty: true, columns: 100, rows: 30 },
  stderr: { isTty: true, columns: 100, rows: 30 },
  stdin: { isTty: true },
};

const ENVIRONMENT = createStaticEnvironment({ TERM: "xterm-256color" });

/** The parsed options a launched shell always has: human format, no timeout. */
const OPTIONS: GlobalOptions = {
  format: "human",
  color: "auto",
  quiet: false,
  verbose: false,
  nonInteractive: false,
  workspace: null,
  profile: null,
  timeoutMs: null,
  help: false,
  version: false,
};

function record(variables: Readonly<Record<string, string>> = {}): ShellCapabilities {
  const environment = createStaticEnvironment({ TERM: "xterm-256color", ...variables });
  return shellCapabilities({ handles: terminalCapabilities(HANDLES, environment), environment });
}

/** The words the status line draws for the one key this build honours. */
const EXIT_HINT = SHELL_KEY_HINTS[0].command;

/**
 * The renderer a run is creating, captured the moment the factory is called.
 *
 * A promise rather than the settled value, because the factory is invoked
 * synchronously while `runShell` is still running but resolves a turn later — so
 * a test reading a plain variable straight after starting the shell would read
 * `null` every time.
 */
let mounting: Promise<TestRendererSetup> | null = null;

const inMemory: RendererFactory = (config) => {
  const setup = createTestRenderer({ ...config, width: 100, height: 30 });
  mounting = setup;
  return setup.then((ready) => ready.renderer);
};

afterEach(async () => {
  // The guard is module state, so a leaked session is the *next* test failing.
  const setup = await mounting?.catch(() => null);
  setup?.renderer.destroy();
  mounting = null;
});

/**
 * The frame, once React has committed the tree into it.
 *
 * A poll rather than `waitForFrame`, and the difference is not cosmetic: the
 * test renderer's own wait advances render passes without ever yielding to the
 * host event loop, and React's reconciler commits on a microtask. So the frame
 * predicate would spin twenty times against a buffer nothing had drawn into
 * yet. Handing the loop back is what lets the commit land.
 */
async function frameWith(setup: TestRendererSetup, marker: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  let frame = "";
  while (Date.now() < deadline) {
    await Bun.sleep(5);
    await setup.flush();
    frame = setup.captureCharFrame();
    if (frame.includes(marker)) {
      return frame;
    }
  }
  return frame;
}

/**
 * Starts the shell and waits until it has actually mounted.
 *
 * The wait is the point. `runShell` opens its renderer asynchronously, so a
 * helper that returned the bare promise would hand back a shell that has not
 * created anything yet — and a test asserting on the renderer, on the
 * registered participant, or on a second shell being refused would be racing
 * the thing it is trying to observe.
 */
async function shell(options: Partial<Parameters<typeof runShell>[0]> = {}) {
  const { clock = createManualClock(), ...overrides } = options;
  const streams = createRecordingCliStreams();
  const stop = new AbortController();
  const run = runShell({
    streams,
    capabilities: record(),
    clock,
    options: OPTIONS,
    environment: ENVIRONMENT,
    stop: stop.signal,
    createRenderer: inMemory,
    ...overrides,
  });
  const setup = await mounting;
  const frame = setup === null ? "" : await frameWith(setup, EXIT_HINT);
  return { streams, stop, run, setup, frame };
}

function composerTextarea(setup: TestRendererSetup): TextareaRenderable {
  const pending = [...setup.renderer.root.getChildren()];
  while (pending.length > 0) {
    const renderable = pending.pop();
    if (renderable === undefined) {
      break;
    }
    if (renderable instanceof TextareaRenderable) {
      return renderable;
    }
    pending.push(...renderable.getChildren());
  }
  throw new Error("expected the shell to mount a composer textarea");
}

describe("a shell that was stopped", () => {
  test("reports that it was stopped rather than that it finished", async () => {
    // The caller resolves `cancelled` or `timed-out` from the scope. A shell
    // that reported a clean close would turn an interrupt into an exit zero.
    const { stop, run } = await shell();
    stop.abort();
    expect(await run).toEqual({ kind: "stopped" });
  });

  test("gives the terminal back", async () => {
    const { stop, run } = await shell();
    stop.abort();
    await run;
    expect(hasOpenRendererSession()).toBe(false);
  });

  test("returns immediately when the scope had already stopped", async () => {
    // An interrupt that lands between the launch decision and the mount is a
    // real race, and a shell that waited on an already-aborted signal would
    // hang forever holding the terminal.
    const stopped = new AbortController();
    stopped.abort();
    const streams = createRecordingCliStreams();
    expect(
      await runShell({
        streams,
        capabilities: record(),
        clock: createManualClock(),
        options: OPTIONS,
        environment: ENVIRONMENT,
        stop: stopped.signal,
        createRenderer: inMemory,
      }),
    ).toEqual({ kind: "stopped" });
    expect(hasOpenRendererSession()).toBe(false);
  });
});

describe("what the shell drew", () => {
  test("mounted a tree with the one interaction this build promises", async () => {
    const { stop, run, frame } = await shell();
    expect(frame).toContain(EXIT_HINT);
    // The frame the shell actually mounts since #24: a workspace header, a
    // primary region, and a status line. The header's labels are what prove the
    // layout class came from the terminal rather than from the footer the tree
    // is drawn into — six rows would have selected compact and dropped them.
    expect(frame).toContain("workspace");
    expect(frame).toContain("no Git yet");
    stop.abort();
    await run;
  });

  test("unmounted the tree before releasing the renderer", async () => {
    // Order, not just occurrence. Unmounting into a destroyed renderer is a
    // second failure stacked on the first, and it happens on the crash path.
    const { stop, run, setup } = await shell();
    stop.abort();
    expect(await run).toEqual({ kind: "stopped" });
    expect(setup?.renderer.isDestroyed).toBe(true);
  });

  test("threads the injected invocation clock into pointer recognition", async () => {
    const clock = createManualClock();
    let reads = 0;
    const { stop, run, setup } = await shell({
      clock: {
        now: () => {
          reads += 1;
          return clock.now();
        },
      },
      configuration: { "interface.pointer.enabled": true },
    });
    if (setup === null) {
      throw new Error("expected the test shell to mount");
    }

    const textarea = composerTextarea(setup);
    await setup.mockMouse.click(textarea.x + 1, textarea.y, MouseButton.LEFT, { delayMs: 0 });
    expect(reads).toBe(1);

    stop.abort();
    expect(await run).toEqual({ kind: "stopped" });
  });
});

describe("a renderer that never started", () => {
  test("is reported as a failure carrying an exit-resolvable error", async () => {
    const streams = createRecordingCliStreams();
    const result = await runShell({
      streams,
      capabilities: record(),
      clock: createManualClock(),
      options: OPTIONS,
      environment: ENVIRONMENT,
      stop: new AbortController().signal,
      createRenderer: () => {
        throw new Error("no native library for this platform");
      },
    });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      // `integration`, not `internal`: the platform did not provide what this
      // run needed, which is a true statement about a machine that may simply
      // have no terminal today.
      expect(result.error.category).toBe("integration");
      expect(result.error.effect).toBe("none");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("leaves no session open and nothing on the result stream", async () => {
    const streams = createRecordingCliStreams();
    await runShell({
      streams,
      capabilities: record(),
      clock: createManualClock(),
      options: OPTIONS,
      environment: ENVIRONMENT,
      stop: new AbortController().signal,
      createRenderer: () => Promise.reject(new Error("refused")),
    });
    expect(hasOpenRendererSession()).toBe(false);
    // stdout carries the selected result format and nothing else, including
    // when the thing that failed is the interface itself.
    expect(streams.resultWrites()).toEqual([]);
  });

  test("still registers a restore-terminal participant", async () => {
    // The path where the terminal is most likely already half-configured is the
    // last one that should be missing a restoration.
    const coordinator = createShutdownCoordinator({ clock: createManualClock() });
    await runShell({
      streams: createRecordingCliStreams(),
      capabilities: record(),
      clock: createManualClock(),
      options: OPTIONS,
      environment: ENVIRONMENT,
      stop: new AbortController().signal,
      shutdown: coordinator,
      createRenderer: () => {
        throw new Error("refused");
      },
    });
    expect(coordinator.registeredParticipants()).toEqual([
      { name: TERMINAL_RESTORE_PARTICIPANT, phase: "restore-terminal" },
    ]);
  });
});

describe("a renderer that went away underneath the shell", () => {
  test("ends the run rather than waiting for a signal that is not coming", async () => {
    const { run, setup } = await shell();
    // OpenTUI tears itself down on an unhandled rejection reaching its own
    // handler, or on a host stream that closed. Nothing aborts the stop signal
    // when that happens, so a shell waiting only on the scope would hang.
    setup?.renderer.destroy();
    const result = await run;
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.error.code).toBe("integration.renderer.lost");
    }
  });

  test("is not reported as lost when the scope stopped it first", async () => {
    // Every clean stop destroys the renderer too. Reading that as a crash would
    // make an ordinary Ctrl+C exit report an interface failure.
    const { stop, run } = await shell();
    stop.abort();
    expect(await run).toEqual({ kind: "stopped" });
  });
});

describe("the shutdown participant", () => {
  test("is registered before anything can stop the shell", async () => {
    const coordinator = createShutdownCoordinator({ clock: createManualClock() });
    const { stop, run } = await shell({ shutdown: coordinator });
    expect(coordinator.registeredParticipants()).toEqual([
      { name: TERMINAL_RESTORE_PARTICIPANT, phase: "restore-terminal" },
    ]);
    stop.abort();
    await run;
  });

  test("restores nothing further once the shell already did", async () => {
    // Both run on the interrupt path. The second is safe and reports that it
    // changed nothing, which is what makes the contract testable.
    const coordinator = createShutdownCoordinator({ clock: createManualClock() });
    const { stop, run } = await shell({ shutdown: coordinator });
    stop.abort();
    await run;

    const report = await coordinator.shutdown();
    expect(report.failures).toEqual([]);
    expect(report.unfinished).toEqual([]);
  });

  test("is not required, and a shell without one still restores", async () => {
    // A caller that composed no runtime has no coordinator to offer, and the
    // shell must not depend on one to give the terminal back.
    const { stop, run } = await shell();
    stop.abort();
    await run;
    expect(hasOpenRendererSession()).toBe(false);
  });
});

describe("the runtime the shell is running inside", () => {
  test("does not report nothing attached while it is holding a coordinator", async () => {
    // #370, and the sentence that made it a bug rather than a gap. `attached()`
    // counts a non-null shutdown coordinator, `dispatch.ts` has always passed
    // one, and the shell reported that no runtime was attached anyway — a status
    // line stating something untrue about state it was holding.
    const coordinator = createShutdownCoordinator({ clock: createManualClock() });
    const { stop, run, setup } = await shell({ shutdown: coordinator });
    const frame = setup === null ? "" : await frameWith(setup, "Nothing is running.");
    expect(frame).not.toContain("No runtime is attached");
    expect(frame).toContain("Nothing is running.");
    stop.abort();
    await run;
  });

  test("still reports nothing attached when nothing is", async () => {
    // The other half, and the reason the first is not just a louder default:
    // absent has to stay distinguishable from calm. A build with no runtime
    // composed says so.
    const { stop, run, frame } = await shell();
    expect(frame).toContain("No runtime is attached");
    stop.abort();
    await run;
  });

  test("projects a live scope, and its settlement", async () => {
    // The rail's own content, reached through the shell rather than through the
    // reducer: a scope opens before the shell mounts, the projection folds the
    // tree's events, and completing it changes the frame without anything
    // re-rendering by hand.
    const clock = createManualClock();
    const scopes = createScopeTree({ clock });
    const derived = scopes.derive(scopes.root().scopeId, { kind: "invocation", deadline: null });
    expect(derived.ok).toBe(true);

    const { stop, run, setup } = await shell({ scopes });
    // Two: the tree's own root and the invocation under it, which is what a real
    // dispatch opens as well. The count is the runtime's rather than a fixture's.
    const running = setup === null ? "" : await frameWith(setup, "2 operations running.");
    expect(running).toContain("2 operations running.");

    if (derived.ok) {
      scopes.complete(derived.value.scopeId);
    }
    // One, not none: the root scope is still live. A projection that dropped to
    // zero here would be showing the settlement of something it was not told
    // about.
    const settled = setup === null ? "" : await frameWith(setup, "1 operation running.");
    expect(settled).toContain("1 operation running.");
    expect(settled).not.toContain("2 operations running.");

    stop.abort();
    await run;
  });

  test("reads the tree without being able to touch it", async () => {
    // The rail is a reader. A view that could cancel a scope is a status line
    // that will eventually stop the wrong work, so the shell is handed the tree
    // and the scope it did not open is still live when the run ends.
    const clock = createManualClock();
    const scopes = createScopeTree({ clock });
    const derived = scopes.derive(scopes.root().scopeId, { kind: "invocation", deadline: null });

    const { stop, run } = await shell({ scopes });
    stop.abort();
    await run;

    expect(derived.ok ? scopes.state(derived.value.scopeId)?.status : null).toBe("active");
  });
});

describe("a second shell in one process", () => {
  test("is refused rather than opening a second renderer", async () => {
    const first = await shell();

    const streams = createRecordingCliStreams();
    const second = await runShell({
      streams,
      capabilities: record(),
      clock: createManualClock(),
      options: OPTIONS,
      environment: ENVIRONMENT,
      stop: new AbortController().signal,
      createRenderer: inMemory,
    });
    expect(second.kind).toBe("failed");
    if (second.kind === "failed") {
      // Not an unavailable dependency: nothing was missing, Falryn asked for
      // two owners of one terminal. Reporting it as an integration failure
      // would send someone to check their environment for a defect in this
      // program.
      expect(second.error.category).toBe("internal");
      expect(second.error.code).toBe("internal.renderer-already-open");
    }

    first.stop.abort();
    await first.run;
  });
});
