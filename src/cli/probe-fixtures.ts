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
  addDuration,
  assertNever,
  createSystemClock,
  duration,
  type FalrynError,
  type FileSystemPort,
  NO_CORRELATION,
  scopeId,
  type TerminalOutcome,
} from "../domain/index.ts";
import { createHostFileSystem, createProcessSignalPort } from "../integrations/index.ts";
import { dispatch } from "./dispatch.ts";
import { type ExitCode, resolveExitCode } from "./exit.ts";
import { createHostGovernance, type InvocationGovernance } from "./invocation-scope.ts";
import {
  type CliStreams,
  createHostCliStreams,
  outcomeAfterFlush,
  writeDiagnosticLine,
  writeResultLine,
} from "./streams.ts";

/**
 * Scenarios whose whole behavior is the outcome they end with.
 *
 * Separated from the behavioral ones because a test can state the exact code
 * each must produce, and `Record<OutcomeScenario, …>` then makes that table
 * total: adding a name here fails to compile until both the fixture's outcome
 * and the test's expected code exist. A `Partial<Record<…>>` would accept the
 * new name silently and quietly stop asserting a code.
 */
export const OUTCOME_SCENARIOS = [
  "completed",
  "failed",
  "invalid-input",
  "configuration",
  "authentication",
  "integration",
  "uncertain",
  "cancelled-partial",
  "internal",
  "unrecognized",
  "timed-out",
  "cancelled",
] as const;

export type OutcomeScenario = (typeof OUTCOME_SCENARIOS)[number];

/** Scenarios that exercise a handle rather than a code: streaming, input, interruption. */
export const BEHAVIOR_SCENARIOS = ["stream", "stdin", "interrupt"] as const;

export type BehaviorScenario = (typeof BEHAVIOR_SCENARIOS)[number];

/**
 * Scenarios that run a real command through `dispatch`.
 *
 * They exist because `config` and `doctor` finish in roughly 50 ms, which is
 * far too fast to race an interrupt against reliably. They keep the real
 * command tree, the real command, the real projections, and the real exit
 * resolution, and replace only the filesystem the command reads — with one that
 * waits until the invocation's own scope stops it. What is under test is the
 * composition; what is staged is how long the work takes.
 */
export const DISPATCH_SCENARIOS = [
  /** A real command through `dispatch`, finishing normally. */
  "dispatch-run",
  /** A real command whose work outlives the `--timeout` it was given. */
  "dispatch-timeout",
  /** A real command interrupted while its work is in flight. */
  "dispatch-interrupt",
  /** The same, on an invocation that had already changed something. */
  "dispatch-interrupt-partial",
] as const;

export type DispatchScenario = (typeof DISPATCH_SCENARIOS)[number];

/** The scenarios this harness answers with an outcome of its own. */
type StagedScenario = OutcomeScenario | BehaviorScenario;

/** Every scenario this harness can run. Named so a test cannot drift from it. */
export const PROBE_SCENARIOS = [
  ...OUTCOME_SCENARIOS,
  ...BEHAVIOR_SCENARIOS,
  ...DISPATCH_SCENARIOS,
] as const;

export type ProbeScenario = StagedScenario | DispatchScenario;

export function isProbeScenario(value: string): value is ProbeScenario {
  return (PROBE_SCENARIOS as readonly string[]).includes(value);
}

function isStagedScenario(value: string): value is StagedScenario {
  return (
    (OUTCOME_SCENARIOS as readonly string[]).includes(value) ||
    (BEHAVIOR_SCENARIOS as readonly string[]).includes(value)
  );
}

function isDispatchScenario(value: string): value is DispatchScenario {
  return (DISPATCH_SCENARIOS as readonly string[]).includes(value);
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
  readonly error: FalrynError | null;
};

/** Total over `OutcomeScenario`: a new name here fails to compile until it has an outcome. */
const OUTCOMES: Readonly<Record<OutcomeScenario, ScenarioResult>> = {
  completed: { outcome: { kind: "completed" }, error: null },
  // A failure carrying nothing more specific than the fact that it failed.
  failed: { outcome: { kind: "failed", effect: "none" }, error: null },
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
  // A dependency this run needed and did not have. Reachable since #23, whose
  // renderer failures are the first thing in the build to produce the category
  // — staged here rather than run for real, because what is under test is the
  // table, and a real one would need a terminal.
  integration: {
    outcome: { kind: "failed", effect: "none" },
    error: error({ category: "integration", exitCategory: "runtime-error" }),
  },
  uncertain: { outcome: { kind: "uncertain", effect: "uncertain" }, error: null },
  // Effect outranks outcome: something already changed, so this is not a plain
  // cancellation however it ended.
  "cancelled-partial": { outcome: { kind: "cancelled", effect: "partial" }, error: null },
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
  "timed-out": { outcome: { kind: "timed-out", effect: "none" }, error: null },
  cancelled: { outcome: { kind: "cancelled", effect: "none" }, error: null },
};

function isOutcomeScenario(scenario: StagedScenario): scenario is OutcomeScenario {
  return (OUTCOME_SCENARIOS as readonly string[]).includes(scenario);
}

/**
 * Runs one scenario and returns the code the process should exit with.
 *
 * The order is the contract every future command follows: do the work, write
 * the result, flush, fold the flush into the outcome, resolve the code.
 */
export async function runProbe(
  scenario: string,
  streams: CliStreams,
  /** The command line a `dispatch-*` scenario runs. Ignored by every other one. */
  argv: readonly string[] = [],
): Promise<ExitCode> {
  if (isDispatchScenario(scenario)) {
    // `dispatch` writes its own records, flushes, and resolves its own code
    // through the same table. Wrapping that in this harness's outcome shape
    // would be a second answer to what the run exited with.
    return dispatchScenario(scenario, streams, argv);
  }

  if (!isStagedScenario(scenario)) {
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
    error: result.error,
  });
}

async function execute(scenario: StagedScenario, streams: CliStreams): Promise<ScenarioResult> {
  if (isOutcomeScenario(scenario)) {
    const result = OUTCOMES[scenario];
    writeDiagnosticLine(streams, `scenario: ${scenario}`);
    writeResultLine(streams, JSON.stringify({ scenario, kind: result.outcome.kind }));
    return result;
  }

  switch (scenario) {
    case "stream":
      return streamScenario(streams);
    case "stdin":
      return stdinScenario(streams);
    case "interrupt":
      return interruptScenario(streams);
    default:
      // A behavioral scenario added without a branch fails to compile here
      // rather than silently completing with someone else's outcome.
      return assertNever(scenario, "unhandled probe scenario");
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
      return { outcome: { kind: "completed" }, error: null };
    }
  }
  writeResultLine(streams, JSON.stringify({ kind: "terminal", status: "completed" }));
  return { outcome: { kind: "completed" }, error: null };
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
  return { outcome: { kind: "completed" }, error: null };
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
    return { outcome: { kind: "cancelled", effect: "none" }, error: null };
  } finally {
    lifecycle.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/* A real command, through dispatch                                            */
/* -------------------------------------------------------------------------- */

/** The scope identity the invocation is given, so this harness can reach it. */
const INVOCATION_SCOPE = scopeId.from("probe-invocation");

/**
 * Longer than any of these scenarios is meant to take.
 *
 * The wait is not what ends it: an interrupt or the invocation's own deadline
 * does, and both abort the signal this wait is holding. The span only bounds a
 * scenario nothing stopped, so a broken run fails rather than hanging.
 */
const SLOW_READ_MS = 30_000;

/**
 * Runs one real command through `dispatch`, under a real lifecycle.
 *
 * The governance is the composed one — the same shape `src/main.ts` supplies —
 * so an interrupt reaches the root scope through the real signal adapter and
 * the real escalation policy, and the invocation's scope is derived from it.
 * The scope is named, so this harness can record an effect against the scope
 * the command is actually running under rather than against one of its own.
 */
async function dispatchScenario(
  scenario: DispatchScenario,
  streams: CliStreams,
  argv: readonly string[],
): Promise<ExitCode> {
  // The entry's own composition, called rather than repeated: what these
  // scenarios prove about an interrupt has to be true of the binary that ships,
  // and a second wiring here could agree with it today and drift tomorrow.
  const host = createHostGovernance(INVOCATION_SCOPE);
  const governance = host.governance;

  try {
    return await dispatch({
      argv,
      streams,
      governance,
      ...(scenario === "dispatch-run"
        ? {}
        : { serviceOverrides: { fileSystem: heldFileSystem(scenario, governance, streams) } }),
    });
  } finally {
    host.dispose();
  }
}

/**
 * The host filesystem, with every read held until the invocation stops.
 *
 * A command that cannot finish is what makes an interrupt and an expiry
 * observable: the race these scenarios exist to prove is otherwise decided by
 * whichever of two ~50 ms events happened to land first. The hold resolves as
 * soon as the scope aborts, so nothing outlives the run that abandoned it.
 *
 * Readiness is announced from the first held call, which is the moment the work
 * is genuinely in flight — a fixed delay before signalling would be the same
 * race in a different place.
 */
function heldFileSystem(
  scenario: DispatchScenario,
  governance: InvocationGovernance,
  streams: CliStreams,
): FileSystemPort {
  const host = createHostFileSystem();
  let announced = false;

  const hold = async (): Promise<void> => {
    const scope = governance.scopes.handle(INVOCATION_SCOPE);
    if (scope === null) {
      return;
    }
    if (!announced) {
      announced = true;
      if (scenario === "dispatch-interrupt-partial") {
        // Recorded against the invocation's own scope, before anything
        // interrupts it: this is a run that had begun changing something, and
        // effect certainty has to outrank the cancellation that follows.
        governance.scopes.recordEffect(INVOCATION_SCOPE, "partial");
      }
      writeDiagnosticLine(streams, "ready");
      await streams.flush();
    }
    await governance.clock.waitUntil(
      addDuration(governance.clock.now(), duration(SLOW_READ_MS)),
      scope.signal,
    );
  };

  return {
    ...host,
    async stat(path, signal) {
      await hold();
      return host.stat(path, signal);
    },
    async readText(path, maximumBytes, signal) {
      await hold();
      return host.readText(path, maximumBytes, signal);
    },
    async list(path, signal) {
      await hold();
      return host.list(path, signal);
    },
    async probeWritable(path, signal) {
      await hold();
      return host.probeWritable(path, signal);
    },
  };
}

if (import.meta.main) {
  const streams = createHostCliStreams();
  try {
    process.exitCode = await runProbe(Bun.argv[2] ?? "", streams, Bun.argv.slice(3));
  } finally {
    // Releases what the ports hold on the host handles, the same discipline
    // `src/main.ts` applies to its signal subscription. Always after the
    // flush inside `runProbe`, and always even on a throw.
    streams.dispose();
  }
}
