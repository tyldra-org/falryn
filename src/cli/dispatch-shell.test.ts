/**
 * The launch seam: `falryn`, with nothing after it.
 *
 * `dispatch` is where the decision becomes behavior, and two properties are
 * asserted here that no unit test of the decision itself can reach.
 *
 * The first is the one the issue asks for by name: a run that will not open a
 * shell must create *no renderer at all*, proved against a factory that throws
 * if it is ever called. A launch decision that was right but consulted too late
 * would pass every test in `src/tui/launch.test.ts` and still load a native
 * library on a run in a container with no terminal.
 *
 * The second is that a shell that was stopped resolves its status through the
 * same table and the same scope every command uses — an interrupt is `130` and a
 * `--timeout` is `124`, decided by the scope tree rather than re-derived here.
 */

import { describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createScopeTree } from "../application/index.ts";
import {
  createStaticEnvironment,
  createSystemClock,
  type EnvironmentPort,
  type ObservedHandles,
  type StreamCapability,
  terminalCapabilities,
} from "../domain/index.ts";
import type { RendererFactory } from "../tui/index.ts";
import { dispatch } from "./dispatch.ts";
import { EXIT_CODES } from "./exit.ts";
import type { InvocationGovernance } from "./invocation-scope.ts";
import { createRecordingCliStreams, type RecordedCliStreams } from "./streams.ts";

const INTERACTIVE: ObservedHandles = {
  stdout: { isTty: true, columns: 100, rows: 30 },
  stderr: { isTty: true, columns: 100, rows: 30 },
  stdin: { isTty: true },
};

const PIPED_STDOUT: StreamCapability = {
  isTty: false,
  columns: null,
  rows: null,
  color: "none",
  symbols: "unicode",
};

/**
 * A factory that fails the test if anything calls it.
 *
 * The whole control. A refused run that reached this would be a run that had
 * already loaded OpenTUI, allocated native memory, and taken the terminal —
 * before deciding it should not have.
 */
const refuseToRender: RendererFactory = () => {
  throw new Error("a renderer was created on a run that should not have launched");
};

let mounting: Promise<TestRendererSetup> | null = null;

const inMemory: RendererFactory = (config) => {
  const setup = createTestRenderer({ ...config, width: 100, height: 30 });
  mounting = setup;
  return setup.then((ready) => ready.renderer);
};

function environment(variables: Readonly<Record<string, string>> = {}): EnvironmentPort {
  return createStaticEnvironment({ TERM: "xterm-256color", ...variables });
}

function streamsFor(
  handles: ObservedHandles = INTERACTIVE,
  variables: Readonly<Record<string, string>> = {},
): RecordedCliStreams {
  return createRecordingCliStreams({
    capabilities: terminalCapabilities(handles, environment(variables)),
  });
}

/** A private governance whose root a test can cancel, standing in for an interrupt. */
function governanceFor(): InvocationGovernance & { interrupt(): void } {
  const clock = createSystemClock();
  const scopes = createScopeTree({ clock });
  return {
    clock,
    scopes,
    interrupt() {
      scopes.cancel(scopes.root().scopeId, { kind: "requested" });
    },
  };
}

describe("a run that will not open a shell", () => {
  test("creates no renderer, on any refused path", async () => {
    for (const [reason, argv, handles, variables] of [
      ["machine-format", ["--format", "json"], INTERACTIVE, {}],
      ["non-interactive", ["--non-interactive"], INTERACTIVE, {}],
      ["unsupported", [], INTERACTIVE, { FALRYN_TUI: "off" }],
      ["not-a-tty", [], { ...INTERACTIVE, stdin: { isTty: false } }, {}],
      ["piped-output", [], { ...INTERACTIVE, stdout: PIPED_STDOUT }, {}],
      ["dumb-terminal", [], INTERACTIVE, { TERM: "dumb" }],
      [
        "no-dimensions",
        [],
        { ...INTERACTIVE, stdout: { isTty: true, columns: null, rows: null } },
        {},
      ],
    ] as const) {
      const streams = streamsFor(handles, variables);
      const code = await dispatch({
        argv: [...argv],
        streams,
        environment: environment(variables),
        // Throws if called. Nothing below asserts it was not — the factory does.
        createRenderer: refuseToRender,
      });
      expect({ reason, code }).toEqual({ reason, code: EXIT_CODES.COMPLETED });
    }
  });

  test("keeps exactly the behavior the invocation had before the shell existed", async () => {
    const streams = streamsFor({ ...INTERACTIVE, stdin: { isTty: false } });
    await dispatch({
      argv: [],
      streams,
      environment: environment(),
      createRenderer: refuseToRender,
    });
    // Help on stdout, unchanged. A refusal is an ordinary answer, not a failure.
    expect(streams.resultWrites().join("")).toContain("falryn");
  });

  test("names its reason on the diagnostic handle, never on the result", async () => {
    const streams = streamsFor({ ...INTERACTIVE, stdout: PIPED_STDOUT });
    await dispatch({
      argv: [],
      streams,
      environment: environment(),
      createRenderer: refuseToRender,
    });

    const diagnostics = streams.diagnosticWrites().join("");
    expect(diagnostics).toContain("standard output");
    // stdout carries the selected result format and nothing else. A notice
    // there would land in the file the user was redirecting into.
    expect(streams.resultWrites().join("")).not.toContain("standard output");
  });

  test("reports an override it does not understand rather than obeying it", async () => {
    // A misspelled value that changed nothing and said nothing would look
    // exactly like one that was honoured.
    const streams = streamsFor({ ...INTERACTIVE, stdin: { isTty: false } }, { FALRYN_TUI: "sput" });
    await dispatch({
      argv: [],
      streams,
      environment: environment({ FALRYN_TUI: "sput" }),
      createRenderer: refuseToRender,
    });
    const diagnostics = streams.diagnosticWrites().join("");
    expect(diagnostics).toContain("FALRYN_TUI=sput");
    expect(diagnostics).toContain("split-footer");
  });
});

describe("a shell that was interrupted", () => {
  test("exits with the cancellation code the table owns", async () => {
    const governance = governanceFor();
    const streams = streamsFor();
    const run = dispatch({
      argv: [],
      streams,
      environment: environment(),
      governance,
      createRenderer: inMemory,
    });

    // Once the renderer exists, so the interrupt is landing on a live shell
    // rather than racing its creation.
    await mounting;
    governance.interrupt();

    // 130, and it came from the scope tree acknowledging a cancellation — not
    // from a number this seam chose for itself.
    expect(await run).toBe(EXIT_CODES.CANCELLED);
  });

  test("wrote no frame bytes into the result stream", async () => {
    // The renderer owns stdout while it is alive; nothing goes through
    // `writeResultLine` during a session. A frame reaching the result port
    // would mean the two owners had both written to it.
    const governance = governanceFor();
    const streams = streamsFor();
    const run = dispatch({
      argv: [],
      streams,
      environment: environment(),
      governance,
      createRenderer: inMemory,
    });
    await mounting;
    governance.interrupt();
    await run;
    expect(streams.resultWrites()).toEqual([]);
  });
});

describe("a shell that ran out of time", () => {
  test("exits with the timeout code rather than the cancellation one", async () => {
    // `--timeout` becomes the invocation scope's deadline, exactly as it does
    // for a command. The scope decides `timed-out` from the reason it recorded,
    // which is what keeps `124` and `130` different answers.
    const streams = streamsFor();
    expect(
      await dispatch({
        argv: ["--timeout", "60"],
        streams,
        environment: environment(),
        governance: governanceFor(),
        createRenderer: inMemory,
      }),
    ).toBe(EXIT_CODES.TIMED_OUT);
  });
});

describe("a shell whose renderer never started", () => {
  test("exits as an unavailable dependency and says so on stderr", async () => {
    const streams = streamsFor();
    const code = await dispatch({
      argv: [],
      streams,
      environment: environment(),
      governance: governanceFor(),
      createRenderer: () => {
        throw new Error("no native library for this platform");
      },
    });
    // 5, through the same table: the platform did not provide what this run
    // needed. Not 70 — that would report a defect in Falryn.
    expect(code).toBe(EXIT_CODES.UNAVAILABLE);
    expect(streams.diagnosticWrites().join("")).toContain("could not be started");
    // And nothing that failed said anything on stdout.
    expect(streams.resultWrites()).toEqual([]);
  });

  test("says what went wrong, not only that something did", async () => {
    // #351's second half. The message alone — "The terminal interface could not
    // be started." — is what made a one-line configuration defect take a
    // pseudo-terminal and three experiments to locate, when the renderer had
    // already handed over a complete sentence naming the cause.
    const streams = streamsFor();
    await dispatch({
      argv: [],
      streams,
      environment: environment(),
      governance: governanceFor(),
      createRenderer: () => {
        throw new Error('externalOutputMode "capture-stdout" requires screenMode "split-footer"');
      },
    });
    expect(streams.diagnosticWrites().join("")).toContain("requires screenMode");
  });

  test("carries the bounded detail rather than the thrown value", async () => {
    // The detail is redacted and length-bounded on its way through the error
    // translator. A raw thrown value reaching a diagnostic is how a path, an
    // argument, or a credential ends up in someone's terminal.
    const streams = streamsFor();
    await dispatch({
      argv: [],
      streams,
      environment: environment(),
      governance: governanceFor(),
      createRenderer: () => {
        throw new Error("x".repeat(1000));
      },
    });
    const written = streams.diagnosticWrites().join("");
    expect(written.length).toBeLessThan(600);
    expect(written).toContain("could not be started");
  });
});
