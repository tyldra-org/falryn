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
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createShutdownCoordinator } from "../application/index.ts";
import { createRecordingCliStreams } from "../cli/index.ts";
import {
  createManualClock,
  createStaticEnvironment,
  type ObservedHandles,
  terminalCapabilities,
} from "../domain/index.ts";
import { type ShellCapabilities, shellCapabilities } from "./capabilities.ts";
import { hasOpenRendererSession, type RendererFactory } from "./renderer-session.ts";
import { runShell } from "./shell.tsx";
import { SHELL_EXIT_HINT } from "./shell-view.tsx";
import { TERMINAL_RESTORE_PARTICIPANT } from "./shutdown.ts";

const HANDLES: ObservedHandles = {
  stdout: { isTty: true, columns: 100, rows: 30 },
  stderr: { isTty: true, columns: 100, rows: 30 },
  stdin: { isTty: true },
};

function record(variables: Readonly<Record<string, string>> = {}): ShellCapabilities {
  const environment = createStaticEnvironment({ TERM: "xterm-256color", ...variables });
  return shellCapabilities({ handles: terminalCapabilities(HANDLES, environment), environment });
}

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
  const streams = createRecordingCliStreams();
  const stop = new AbortController();
  const run = runShell({
    streams,
    capabilities: record(),
    stop: stop.signal,
    createRenderer: inMemory,
    ...options,
  });
  const setup = await mounting;
  const frame = setup === null ? "" : await frameWith(setup, SHELL_EXIT_HINT);
  return { streams, stop, run, setup, frame };
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
    expect(frame).toContain(SHELL_EXIT_HINT);
    // The size it was laid out against, taken from the record rather than from
    // a default nobody could see was wrong.
    expect(frame).toContain("100×30");
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
});

describe("a renderer that never started", () => {
  test("is reported as a failure carrying an exit-resolvable error", async () => {
    const streams = createRecordingCliStreams();
    const result = await runShell({
      streams,
      capabilities: record(),
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

describe("a second shell in one process", () => {
  test("is refused rather than opening a second renderer", async () => {
    const first = await shell();

    const streams = createRecordingCliStreams();
    const second = await runShell({
      streams,
      capabilities: record(),
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
