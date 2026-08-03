/**
 * The OpenTUI packaging probe.
 *
 * `bun build --compile` is the shape Falryn ships in, and OpenTUI is the first
 * dependency whose *runtime assets* have to survive it: a native Zig library
 * chosen per platform, a parser worker, the default Tree-sitter grammars, and
 * the Tree-sitter WASM. None of those are JavaScript the bundler can see, and a
 * source-mode run resolves every one of them from `node_modules` — so source
 * mode cannot fail the way a shipped executable would. This entry exists to be
 * compiled and run before any shell is built on top of it.
 *
 * It is a fixture, not product surface. It ships in no build — `bun run build`
 * compiles `src/main.ts` — and `src/tui/probe.test.tsx` is its only caller. It
 * is held to the process boundary's rules anyway, the same way
 * `src/cli/probe-fixtures.ts` is: it reaches no host handle, takes no exit by
 * calling `process.exit()`, and writes through `src/cli/streams.ts`. A harness
 * that grabbed stdout directly would prove nothing about the boundary the
 * renderer has to coexist with — and one scenario here exists precisely to find
 * out what OpenTUI does to that boundary.
 *
 * Every scenario reports one JSON object on the diagnostic handle, so the test
 * reads observations rather than matching prose.
 */

import type { CliRendererConfig } from "@opentui/core";
import { createCliRenderer, getTreeSitterClient } from "@opentui/core";
import { createTestKeymap } from "@opentui/keymap/testing";
import { testRender } from "@opentui/react/test-utils";
import type { ReactNode } from "react";
import {
  buildIdentity,
  type CliStreams,
  createHostCliStreams,
  EXIT_CODES,
  type ExitCode,
  outcomeAfterFlush,
  resolveExitCode,
  writeDiagnosticLine,
  writeResultLine,
} from "../cli/index.ts";
import type { TerminalOutcome } from "../domain/index.ts";

/** Every scenario this probe can run. Named so the test cannot drift from it. */
export const PROBE_SCENARIOS = [
  /** A React tree through the test renderer, asserted on the frame it produced. */
  "frame",
  /** A real `createCliRenderer`, asserted on the native and Tree-sitter assets it loaded. */
  "native",
  /** `@opentui/keymap` with no renderer at all — the thing #26's tests depend on. */
  "keymap",
  /** What split-footer capture does to a process whose stdout `src/cli/streams.ts` owns. */
  "split-footer",
  /** Whether a renderer told to install no signal handling installs none. */
  "signals",
] as const;

export type ProbeScenario = (typeof PROBE_SCENARIOS)[number];

export function isProbeScenario(value: string): value is ProbeScenario {
  return (PROBE_SCENARIOS as readonly string[]).includes(value);
}

/** The marker every scenario's observation line carries, so a test can find it. */
export const PROBE_MARKER = "falryn.tui.probe";

/** The text the React tree renders, and the only thing the frame assertion looks for. */
export const FRAME_CONTENT = "falryn-probe-frame";

/** Written through the result stream while a split-footer renderer is capturing it. */
export const CAPTURED_LINE = "falryn-probe-captured";

type Observation = Record<string, boolean | number | string | readonly string[]>;

/**
 * Renderer options every scenario shares.
 *
 * `exitSignals: []` and `exitOnCtrlC: false` are not stylistic: `src/cli/exit.ts`
 * owns the numeric contract and `src/cli/invocation-scope.ts` owns interruption,
 * and a renderer that installed its own SIGINT handler would be a second owner
 * of both. The `signals` scenario is what proves the options actually mean that.
 */
const GOVERNED_BY_FALRYN: CliRendererConfig = {
  exitOnCtrlC: false,
  exitSignals: [],
  consoleMode: "disabled",
};

/** A React tree with no state, no effects, and nothing to go wrong but packaging. */
function ProbeApp(): ReactNode {
  return (
    <box border>
      <text>{FRAME_CONTENT}</text>
    </box>
  );
}

/**
 * The frame assertion.
 *
 * `createTestRenderer` builds the same native renderer the product path uses and
 * skips only host-terminal setup, so a frame captured here is real native output
 * — which is what makes it a packaging check rather than a React check.
 */
async function observeFrame(): Promise<Observation> {
  const setup = await testRender(<ProbeApp />, { width: 40, height: 6 });
  try {
    const frame = await setup.waitForFrame((value) => value.includes(FRAME_CONTENT));
    return {
      scenario: "frame",
      rendered: frame.includes(FRAME_CONTENT),
      // The border proves layout ran, not just that a string reached a buffer.
      bordered: frame.includes("┌") && frame.includes("┘"),
      columns: setup.renderer.width,
      rows: setup.renderer.height,
    };
  } finally {
    setup.renderer.destroy();
  }
}

/**
 * The native-asset assertion.
 *
 * A real `createCliRenderer` loads the platform's Zig library through FFI, and
 * highlighting one line of TypeScript pulls the parser worker, the default
 * grammar, and the Tree-sitter WASM behind it. In compiled mode all four have to
 * come out of the executable with no `OTUI_ASSET_ROOT` set; that is the whole
 * question this issue was ordered first to answer.
 */
async function observeNative(): Promise<Observation> {
  const startedAt = performance.now();
  const renderer = await createCliRenderer(GOVERNED_BY_FALRYN);
  const startupMs = performance.now() - startedAt;
  try {
    const client = getTreeSitterClient();
    await client.initialize();
    const highlighted = await client.highlightOnce("const probe = 1", "typescript");
    try {
      return {
        scenario: "native",
        mode: buildIdentity().mode,
        rendererCreated: true,
        // Reported to a tenth of a millisecond: #23 sizes a startup budget
        // against it, and rounding to whole milliseconds hides the difference
        // between a cheap call and a free one.
        startupMs: Number(startupMs.toFixed(1)),
        screenMode: renderer.screenMode,
        externalOutputMode: renderer.externalOutputMode,
        // A grammar that failed to embed returns no highlights rather than
        // throwing, so the count is the assertion.
        highlightCount: (highlighted.highlights ?? []).length,
      };
    } finally {
      await client.destroy();
    }
  } finally {
    // OpenTUI cleans up on neither `process.exit` nor an unhandled error.
    renderer.destroy();
  }
}

/**
 * The keymap assertion.
 *
 * `@opentui/keymap` is pure JavaScript and its test host implements the whole
 * `KeymapHost` interface without a renderable. If that holds, #26 can test
 * bindings, conflicts, and commands without standing up a terminal at all.
 */
function observeKeymap(): Observation {
  const harness = createTestKeymap({ defaultKeys: true });
  try {
    const ran: string[] = [];
    harness.keymap.registerLayer({
      bindings: [{ key: "ctrl+p", cmd: "probe.run" }],
      commands: [
        {
          name: "probe.run",
          run: () => {
            ran.push("probe.run");
          },
        },
      ],
    });
    harness.host.focus(harness.root);
    harness.host.press("p", { ctrl: true });
    return {
      scenario: "keymap",
      rendererCreated: false,
      dispatched: ran,
      warnings: harness.diagnostics.warnings,
      errors: harness.diagnostics.errors,
    };
  } finally {
    harness.cleanup();
  }
}

/**
 * What split-footer capture does to Falryn's own result stream.
 *
 * #23 prefers split-footer because the transcript is the product. The question
 * it cannot answer from documentation is what `capture-stdout` means for a
 * process whose stdout `src/cli/streams.ts` already owns — so this writes a real
 * line through the real result port while the renderer is active and reports
 * whether the renderer took it. The answer decides whether the shell may keep
 * the CLI's stdout contract while a renderer is up.
 */
async function observeSplitFooter(streams: CliStreams): Promise<Observation> {
  const commits: number[] = [];
  const renderer = await createCliRenderer({
    ...GOVERNED_BY_FALRYN,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
    footerHeight: 4,
  });
  try {
    renderer.on("external_output", (event: { rowColumns: number }) => {
      commits.push(event.rowColumns);
    });
    // The real result port, while the renderer is up. Nothing here reaches a
    // handle directly, so what happens to this line is what would happen to a
    // command's output with a shell running above it.
    writeResultLine(streams, CAPTURED_LINE);
    renderer.requestRender();
    await renderer.idle();
    return {
      scenario: "split-footer",
      screenMode: renderer.screenMode,
      externalOutputMode: renderer.externalOutputMode,
      // The finding #23 needs: split-footer capture does not leave the CLI's
      // stdout contract alone, it takes ownership of it.
      resultLineCaptured: commits.length > 0,
      commits: commits.length,
    };
  } finally {
    renderer.destroy();
  }
}

/**
 * Whether the renderer leaves signal handling alone when told to.
 *
 * Counted rather than trusted: `exitSignals: []` promising nothing is only
 * useful if a listener count of zero can be observed, and the default is
 * measured beside it so the control tests a boundary rather than a constant.
 */
async function observeSignals(): Promise<Observation> {
  const before = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
  const governed = await createCliRenderer(GOVERNED_BY_FALRYN);
  const duringGoverned = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
  governed.destroy();

  const defaults = await createCliRenderer({ consoleMode: "disabled" });
  const duringDefaults = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
  defaults.destroy();

  return {
    scenario: "signals",
    before,
    duringGoverned,
    duringDefaults,
    // The fact #23 needs: opting out is total, and opting out is not the default.
    governedInstallsNone: duringGoverned === before,
    defaultInstallsSome: duringDefaults > before,
  };
}

async function observe(scenario: ProbeScenario, streams: CliStreams): Promise<Observation> {
  switch (scenario) {
    case "frame":
      return observeFrame();
    case "native":
      return observeNative();
    case "keymap":
      return observeKeymap();
    case "split-footer":
      return observeSplitFooter(streams);
    case "signals":
      return observeSignals();
  }
}

/** Runs one scenario and reports it, returning the code the process should end with. */
async function runProbe(requested: string, streams: CliStreams): Promise<ExitCode> {
  if (!isProbeScenario(requested)) {
    writeDiagnosticLine(streams, `unknown probe scenario: ${requested || "(none)"}`);
    writeDiagnosticLine(streams, `expected one of: ${PROBE_SCENARIOS.join(", ")}`);
    await streams.flush();
    return EXIT_CODES.INVALID_USAGE;
  }

  let outcome: TerminalOutcome = { kind: "completed" };
  try {
    const observation = await observe(requested, streams);
    // On the diagnostic handle, not the result handle. A live renderer owns
    // stdout and fills it with frame and terminal-setup bytes; stderr is the one
    // handle it never touches, which is what makes the observation readable —
    // and it leaves stdout free to be the *subject* of the split-footer
    // scenario rather than its reporting channel.
    writeDiagnosticLine(streams, JSON.stringify({ marker: PROBE_MARKER, ...observation }));
  } catch (cause) {
    // Reported rather than thrown, so a packaging failure arrives as a readable
    // line and a code rather than a stack the compiled run would print itself.
    writeDiagnosticLine(streams, `probe ${requested} failed: ${String(cause)}`);
    outcome = { kind: "failed", effect: "none" };
  }
  const flush = await streams.flush();
  return resolveExitCode({ outcome: outcomeAfterFlush(outcome, flush), error: null });
}

// Guarded so `src/tui/probe.test.tsx` can import the scenario names and markers
// without running a probe, the same way `src/cli/probe-fixtures.ts` is guarded.
if (import.meta.main) {
  const streams = createHostCliStreams();
  try {
    process.exitCode = await runProbe(Bun.argv[2] ?? "", streams);
  } finally {
    // Releases what the ports hold on the host handles, always and even on a
    // throw — the discipline `src/main.ts` applies to its own composition.
    streams.dispose();
  }
}
