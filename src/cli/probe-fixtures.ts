/**
 * A scenario harness for the process boundary.
 *
 * No command exists yet, so the exit table, the stdout/stderr split, the broken
 * pipe, and the stdin contract cannot be exercised through a user-facing
 * command. This entry stands in for one: it is a real process that composes the
 * real host streams, resolves a real code through `src/cli/exit.ts`, and exits
 * by setting `process.exitCode`.
 *
 * It is a fixture, not product surface. It ships in no build — `bun run build`
 * compiles `src/main.ts` — and `src/cli/process-boundary.test.ts` is its only
 * caller. It is written to the same rules as product source anyway, because a
 * harness that reached a handle directly would prove nothing about the boundary
 * it exists to test.
 */

import { createRuntimeLifecycle } from "../application/index.ts";
import {
  createSystemClock,
  type FalrynError,
  NO_CORRELATION,
  type TerminalOutcome,
} from "../domain/index.ts";
import { createProcessSignalPort } from "../integrations/index.ts";
import { type ExitCode, resolveExitCode } from "./exit.ts";
import {
  type CliStreams,
  createHostCliStreams,
  outcomeAfterFlush,
  writeDiagnosticLine,
  writeResultLine,
} from "./streams.ts";

/** Every scenario this harness can run. Named so a test cannot drift from it. */
export const PROBE_SCENARIOS = [
  "completed",
  "failed",
  "invalid-input",
  "configuration",
  "authentication",
  "uncertain",
  "cancelled-partial",
  "internal",
  "unrecognized",
  "timed-out",
  "cancelled",
  "stream",
  "stdin",
  "interrupt",
] as const;

export type ProbeScenario = (typeof PROBE_SCENARIOS)[number];

export function isProbeScenario(value: string): value is ProbeScenario {
  return (PROBE_SCENARIOS as readonly string[]).includes(value);
}

/** Records the `stream` and `interrupt` scenarios emit before their terminal one. */
export const STREAM_RECORD_COUNT = 2000;

function error(overrides: Partial<FalrynError>): FalrynError {
  return {
    code: "probe",
    category: "internal",
    message: "probe failure",
    retryable: false,
    effect: "none",
    cause: null,
    correlation: NO_CORRELATION,
    recovery: [],
    exitCategory: "runtime-error",
    related: [],
    relatedDropped: 0,
    recognized: true,
    ...overrides,
  };
}

type ScenarioResult = {
  readonly outcome: TerminalOutcome;
  readonly error?: FalrynError | null;
};

const STATIC_SCENARIOS: Readonly<Partial<Record<ProbeScenario, ScenarioResult>>> = {
  completed: { outcome: { kind: "completed" } },
  // A failure carrying nothing more specific than the fact that it failed.
  failed: { outcome: { kind: "failed", effect: "none" } },
  "invalid-input": {
    outcome: { kind: "failed", effect: "none" },
    error: error({ category: "data", exitCategory: "user-error" }),
  },
  configuration: {
    outcome: { kind: "failed", effect: "none" },
    error: error({ category: "configuration", exitCategory: "user-error" }),
  },
  authentication: {
    outcome: { kind: "failed", effect: "none" },
    error: error({ category: "authentication", exitCategory: "user-error" }),
  },
  uncertain: { outcome: { kind: "uncertain", effect: "uncertain" } },
  // Effect outranks outcome: something already changed, so this is not a plain
  // cancellation however it ended.
  "cancelled-partial": { outcome: { kind: "cancelled", effect: "partial" } },
  internal: {
    outcome: { kind: "failed", effect: "none" },
    error: error({ category: "internal", exitCategory: "internal" }),
  },
  // A category this build claims not to recognize, resolved to internal rather
  // than to the code its category would otherwise have earned.
  unrecognized: {
    outcome: { kind: "failed", effect: "none" },
    error: error({ category: "configuration", exitCategory: "user-error", recognized: false }),
  },
  "timed-out": { outcome: { kind: "timed-out", effect: "none" } },
  cancelled: { outcome: { kind: "cancelled", effect: "none" } },
};

/**
 * Runs one scenario and returns the code the process should exit with.
 *
 * The order is the contract every future command follows: do the work, write
 * the result, flush, fold the flush into the outcome, resolve the code.
 */
export async function runProbe(scenario: string, streams: CliStreams): Promise<ExitCode> {
  if (!isProbeScenario(scenario)) {
    // An unusable invocation, resolved through the same table as everything
    // else rather than through a number written at the call site.
    writeDiagnosticLine(streams, `unknown scenario: ${scenario}`);
    await streams.flush();
    return resolveExitCode({
      outcome: { kind: "failed", effect: "none" },
      error: error({ category: "data", exitCategory: "user-error" }),
    });
  }

  const result = await execute(scenario, streams);
  const flush = await streams.flush();
  return resolveExitCode({
    outcome: outcomeAfterFlush(result.outcome, flush),
    error: result.error ?? null,
  });
}

async function execute(scenario: ProbeScenario, streams: CliStreams): Promise<ScenarioResult> {
  const staticResult = STATIC_SCENARIOS[scenario];
  if (staticResult !== undefined) {
    writeDiagnosticLine(streams, `scenario: ${scenario}`);
    writeResultLine(streams, JSON.stringify({ scenario, kind: staticResult.outcome.kind }));
    return staticResult;
  }

  switch (scenario) {
    case "stream":
      return streamScenario(streams);
    case "stdin":
      return stdinScenario(streams);
    case "interrupt":
      return interruptScenario(streams);
    default:
      // Every scenario is either static or handled above; a new one added to
      // the list without a branch lands here rather than silently completing.
      writeDiagnosticLine(streams, `scenario not implemented: ${scenario}`);
      return {
        outcome: { kind: "failed", effect: "none" },
        error: error({ category: "internal", exitCategory: "internal" }),
      };
  }
}

/**
 * Enough records that a reader taking one line has certainly gone before the
 * last is written. Ends with a terminal record when the stream is still
 * writable.
 */
function streamScenario(streams: CliStreams): ScenarioResult {
  writeDiagnosticLine(streams, "streaming");
  for (let index = 0; index < STREAM_RECORD_COUNT; index += 1) {
    const write = writeResultLine(streams, JSON.stringify({ kind: "progress", index }));
    if (write.status === "closed") {
      // The reader left. Stop writing, say nothing about it on stderr, and end
      // normally — this is `falryn ... | head -1`, not a failure.
      return { outcome: { kind: "completed" } };
    }
  }
  writeResultLine(streams, JSON.stringify({ kind: "terminal", status: "completed" }));
  return { outcome: { kind: "completed" } };
}

async function stdinScenario(streams: CliStreams): Promise<ScenarioResult> {
  const read = await streams.input.read();
  if (!read.ok) {
    writeDiagnosticLine(streams, `stdin: ${read.error.code}`);
    writeResultLine(streams, JSON.stringify({ stdin: read.error.code }));
    return {
      outcome: { kind: "failed", effect: "none" },
      error: error({ category: "data", exitCategory: "user-error" }),
    };
  }

  writeResultLine(
    streams,
    JSON.stringify({
      stdin: read.value.kind,
      ...(read.value.kind === "text" ? { bytes: read.value.bytes, text: read.value.text } : {}),
      stdinIsTty: streams.capabilities.stdin.isTty,
      stdoutIsTty: streams.capabilities.stdout.isTty,
      stdoutColumns: streams.capabilities.stdout.columns,
      stdoutColor: streams.capabilities.stdout.color,
    }),
  );
  return { outcome: { kind: "completed" } };
}

/**
 * Streams until an interrupt requests cancellation through the real lifecycle,
 * then emits its terminal record while the stream is still writable.
 */
async function interruptScenario(streams: CliStreams): Promise<ScenarioResult> {
  const lifecycle = createRuntimeLifecycle({
    clock: createSystemClock(),
    signals: createProcessSignalPort(),
  });
  const cancellation = lifecycle.scopes.root().signal;

  try {
    writeDiagnosticLine(streams, "ready");
    // Flushed so the test can see readiness before it signals; without it the
    // notice could still be buffered when the interrupt arrives.
    await streams.flush();

    let index = 0;
    while (!cancellation.aborted) {
      const write = writeResultLine(streams, JSON.stringify({ kind: "progress", index }));
      if (write.status === "closed") {
        break;
      }
      index += 1;
      // Yields to the loop so the signal handler can run. Cancellation has to
      // land between records, never inside one.
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    // The terminal record still goes out: a JSONL stream cancelled mid-run
    // reports how it ended rather than stopping mid-sequence.
    writeResultLine(streams, JSON.stringify({ kind: "terminal", status: "cancelled", index }));
    await lifecycle.requestShutdown();
    return { outcome: { kind: "cancelled", effect: "none" } };
  } finally {
    lifecycle.dispose();
  }
}

if (import.meta.main) {
  const streams = createHostCliStreams();
  process.exitCode = await runProbe(Bun.argv[2] ?? "", streams);
}
