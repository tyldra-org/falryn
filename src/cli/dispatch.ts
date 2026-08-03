/**
 * One invocation, start to finish.
 *
 * This is the only place that turns an argument vector into bytes and a number,
 * and it is deliberately small: parse, run, write, flush, resolve. Everything
 * it composes already exists — #20's streams and exit table, the command tree,
 * and the two commands.
 *
 * Every output format renders through a pure projection: `render-human.ts` for
 * the human and quiet contracts, `render-json.ts` and `render-jsonl.ts` for the
 * machine ones. This module chooses which, supplies the facts each needs, and
 * writes what comes back to the handle that owns it.
 */

import {
  assertNever,
  MAX_STREAM_READ_LIMIT,
  type RuntimeEvent,
  streamId,
  type Timestamp,
  timestampFromEpochMilliseconds,
} from "../domain/index.ts";
import {
  helpText,
  type Invocation,
  parseInvocation,
  type RunnableCommand,
} from "./command-tree.ts";
import {
  type RunCommandResult,
  runConfigPath,
  runConfigShow,
  runConfigValidate,
  runDoctor,
  stoppedResult,
} from "./commands.ts";
import { EXIT_CODES, type ExitCode, resolveExitCode } from "./exit.ts";
import {
  createInvocationGovernance,
  type InvocationGovernance,
  openInvocationScope,
  runUnderScope,
} from "./invocation-scope.ts";
import {
  allowsColor,
  configurationOverridesFor,
  type GlobalOptions,
  resolveColor,
} from "./options.ts";
import { renderHuman, renderQuiet } from "./render-human.ts";
import { type RenderedRecords, renderJson } from "./render-json.ts";
import { renderJsonl } from "./render-jsonl.ts";
import {
  CLI_EVENT_STREAM,
  createServiceProvider,
  type HostServiceOptions,
  type ServiceProvider,
} from "./services.ts";
import {
  type CliStreams,
  outcomeAfterFlush,
  writeDiagnosticLine,
  writeResultLine,
} from "./streams.ts";
import { versionText } from "./version.ts";

export type DispatchOptions = {
  readonly argv: readonly string[];
  readonly streams: CliStreams;
  /**
   * Supplied by tests. When absent the real provider is built — but only when
   * a command asks for it, which is what keeps `--help` from constructing one.
   */
  readonly services?: (options: GlobalOptions) => ServiceProvider;
  readonly serviceOverrides?: HostServiceOptions;
  /**
   * The clock and scope tree this invocation runs under.
   *
   * Supplied by the entry, which composes the runtime lifecycle and so can
   * cancel the root scope when a signal arrives. A caller that supplies none
   * gets a private governance: `--timeout` still applies, and nothing can
   * interrupt a run nobody is holding a signal for.
   */
  readonly governance?: InvocationGovernance;
};

/**
 * Runs one invocation and returns the code the process should exit with.
 *
 * Never throws and never exits. The caller sets `process.exitCode` and lets the
 * loop drain, so buffered output is delivered rather than abandoned.
 */
export async function dispatch(options: DispatchOptions): Promise<ExitCode> {
  const { streams } = options;
  const invocation = await parseInvocation(options.argv);

  const code = await run(invocation, options);
  const flush = await streams.flush();

  // A result that could not be flushed did not reach anyone, so the run cannot
  // claim the code its work earned. A reader that simply left is unchanged.
  if (code === EXIT_CODES.COMPLETED && !flush.complete && !flush.readerLeft) {
    return resolveExitCode({
      outcome: outcomeAfterFlush({ kind: "completed" }, flush),
      error: null,
    });
  }
  return code;
}

async function run(invocation: Invocation, options: DispatchOptions): Promise<ExitCode> {
  const { streams } = options;

  switch (invocation.kind) {
    case "invalid":
      // Invalid usage never reaches application work, and its text goes to
      // stderr — stdout carries results only, including when there is none.
      writeDiagnosticLine(streams, invocation.message);
      writeDiagnosticLine(streams, `Run 'falryn --help' for usage.`);
      return EXIT_CODES.INVALID_USAGE;

    case "help":
      // Help is the result of asking for help, so it goes to stdout. It
      // constructs no service: the provider is never called on this path.
      writeResultLine(streams, await helpText(invocation.topic));
      return EXIT_CODES.COMPLETED;

    case "version":
      writeResultLine(streams, versionText());
      return EXIT_CODES.COMPLETED;

    case "run":
      return runCommand(invocation, options);

    default:
      return assertNever(invocation, "unhandled invocation");
  }
}

async function runCommand(
  invocation: Extract<Invocation, { kind: "run" }>,
  options: DispatchOptions,
): Promise<ExitCode> {
  const { streams } = options;
  const { command, options: globals } = invocation;

  if (command === "default") {
    // The no-argument invocation prints help and exits 0 until #21 lands the
    // interactive shell. Help text says so rather than leaving it implied.
    writeResultLine(streams, await helpText(null));
    return EXIT_CODES.COMPLETED;
  }

  // Built here and not before: every path above returns without a service.
  const services = (options.services ?? defaultProvider(options))(globals);
  const overrides = configurationOverridesFor(globals);

  const result = await governed(command, services, overrides, globals, options);
  emit(streams, await render(result, globals, streams, services));
  return resolveExitCode({
    outcome: result.outcome,
    error: result.errors[0] ?? null,
  });
}

/**
 * The command's result, or the invocation's if it stopped first.
 *
 * The scope is opened here rather than at the entry because `--timeout` is not
 * known until the tree has parsed, and a deadline applied before parsing would
 * govern the parse rather than the work. Help, version, and an invalid
 * invocation never reach this: they are answered above, and a run that opened
 * a scope to print help would be governing nothing.
 *
 * A tree that refused to derive leaves `scope` null, and the command runs
 * ungoverned rather than the invocation failing over a diagnostic facility.
 */
async function governed(
  command: Exclude<RunnableCommand, "default">,
  services: ServiceProvider,
  overrides: Readonly<Record<string, string>>,
  globals: GlobalOptions,
  options: DispatchOptions,
): Promise<RunCommandResult> {
  const governance = options.governance ?? createInvocationGovernance();
  const scope = openInvocationScope(governance, globals.timeoutMs);
  if (scope === null) {
    return produce(command, services, overrides, globals);
  }

  const run = await runUnderScope(governance, scope, () =>
    produce(command, services, overrides, globals),
  );
  // A stopped invocation still answers, in the format the caller asked for.
  // Emitting nothing would leave a reader waiting for a record that is not
  // coming, which is the failure the single-terminal-record contract exists to
  // prevent.
  return run.kind === "finished" ? run.value : stoppedResult(command, run.outcome);
}

/**
 * The selected format's lines.
 *
 * One switch over the four declared contracts. The human projections produce a
 * single text and the machine ones produce a record per line, so both are
 * carried as a list — which is also what lets the writer stop cleanly when a
 * reader leaves partway through a stream.
 */
async function render(
  result: RunCommandResult,
  globals: GlobalOptions,
  streams: CliStreams,
  services: ServiceProvider,
): Promise<RenderedRecords> {
  switch (globals.format) {
    case "human":
      return asRecords(
        renderHuman({
          result,
          // Keyed to stdout, which is the handle the result lands on. A format
          // that is not `human` never gets colour at all, and `--color`
          // overrides the derived fact rather than replacing the derivation.
          color: allowsColor(globals.format)
            ? resolveColor(globals.color, streams.capabilities.stdout.color)
            : "none",
          symbols: streams.capabilities.stdout.symbols,
          columns: streams.capabilities.stdout.columns,
          verbose: globals.verbose,
        }),
      );
    case "quiet":
      return asRecords(renderQuiet(result));
    case "json":
      return renderJson({ result, occurredAt: nowFor(services) });
    case "jsonl":
      return renderJsonl({
        result,
        occurredAt: nowFor(services),
        events: await lifecycleEvents(services),
      });
    default:
      return assertNever(globals.format, "unhandled output format");
  }
}

/** A single rendered text as the one-line list the writer takes. */
function asRecords(text: {
  readonly result: string;
  readonly diagnostics: string;
}): RenderedRecords {
  return {
    result: text.result === "" ? [] : [text.result],
    diagnostics: text.diagnostics,
  };
}

/** When the run finished, in the canonical form every record carries. */
function nowFor(services: ServiceProvider): Timestamp {
  return timestampFromEpochMilliseconds(services().clock.now());
}

/**
 * The events this run appended, in sequence order.
 *
 * Read back from the in-memory store the service graph already writes to, so a
 * JSON Lines run reports the lifecycle it actually produced rather than one
 * staged for it. A read that fails yields no events: a lifecycle this build
 * could not recover is detail, and the terminal record still carries the answer.
 */
async function lifecycleEvents(services: ServiceProvider): Promise<readonly RuntimeEvent[]> {
  const { eventStore } = services();
  const read = await eventStore.readFrom(
    { streamId: streamId.from(CLI_EVENT_STREAM), afterSequence: null },
    MAX_STREAM_READ_LIMIT,
  );
  return read.ok ? read.value : [];
}

/**
 * Writes each line to the handle that owns it.
 *
 * An empty list writes nothing at all, rather than a blank line: a run whose
 * format has no primary result must leave stdout untouched, and a newline is not
 * nothing to a consumer counting records.
 *
 * Writing stops as soon as the stream reports the reader is gone. A consumer
 * running `falryn ... --format jsonl | head -1` gets whole lines and no partial
 * one, and the run does not go on producing records nobody is reading.
 */
function emit(streams: CliStreams, records: RenderedRecords): void {
  for (const line of records.result) {
    if (writeResultLine(streams, line).status === "closed") {
      break;
    }
  }
  if (records.diagnostics !== "") {
    writeDiagnosticLine(streams, records.diagnostics);
  }
}

function defaultProvider(options: DispatchOptions): (globals: GlobalOptions) => ServiceProvider {
  return (globals) => createServiceProvider(globals, options.serviceOverrides ?? {});
}

async function produce(
  command: Exclude<RunnableCommand, "default">,
  services: ServiceProvider,
  overrides: Readonly<Record<string, string>>,
  globals: GlobalOptions,
): Promise<RunCommandResult> {
  switch (command) {
    case "config.show":
      return runConfigShow(services, overrides, globals);
    case "config.validate":
      return runConfigValidate(services, overrides, globals);
    case "config.path":
      return runConfigPath(services, globals);
    case "doctor":
      return runDoctor(services);
    default:
      // `default`, `help`, and `version` are answered before this is reached,
      // so a new command reaching here without a branch fails to compile.
      return assertNever(command, "unhandled command");
  }
}
