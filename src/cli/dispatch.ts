/**
 * One invocation, start to finish.
 *
 * This is the only place that turns an argument vector into bytes and a number,
 * and it is deliberately small: parse, run, write, flush, resolve. Everything
 * it composes already exists — #20's streams and exit table, the command tree,
 * and the two commands.
 *
 * The human and quiet formats render through `render-human.ts`. The machine
 * formats are #19's: until they land, their arm writes one placeholder line so
 * the tree stays runnable, and the line is explicitly not the JSON *contract*
 * that issue will define.
 */

import { assertNever } from "../domain/index.ts";
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
} from "./commands.ts";
import { EXIT_CODES, type ExitCode, resolveExitCode } from "./exit.ts";
import {
  allowsColor,
  configurationOverridesFor,
  type GlobalOptions,
  resolveColor,
} from "./options.ts";
import { type RenderedText, renderHuman, renderQuiet } from "./render-human.ts";
import {
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

  const result = await produce(command, services, overrides, globals);
  emit(streams, render(result, globals, streams));
  return resolveExitCode({
    outcome: result.outcome,
    error: result.errors[0] ?? null,
  });
}

/**
 * The selected format's text.
 *
 * The switch is shared with #19: this issue implements `human` and `quiet`, and
 * the machine arms stay on the placeholder until #19 replaces them. Neither
 * issue changes the other's arm.
 */
function render(
  result: RunCommandResult,
  globals: GlobalOptions,
  streams: CliStreams,
): RenderedText {
  switch (globals.format) {
    case "human":
      return renderHuman({
        result,
        // Keyed to stdout, which is the handle the result lands on. A format
        // that is not `human` never gets colour at all, and `--color` overrides
        // the derived fact rather than replacing the derivation.
        color: allowsColor(globals.format)
          ? resolveColor(globals.color, streams.capabilities.stdout.color)
          : "none",
        symbols: streams.capabilities.stdout.symbols,
        columns: streams.capabilities.stdout.columns,
        verbose: globals.verbose,
      });
    case "quiet":
      return renderQuiet(result);
    case "json":
    case "jsonl":
      // #19. One JSON line so the tree stays runnable and machine-checkable
      // while the schemas are unwritten; no schema is promised here, and the
      // machine projections replace this rather than extending it.
      return { result: placeholderLine(result), diagnostics: "" };
    default:
      return assertNever(globals.format, "unhandled output format");
  }
}

/**
 * Writes each text to the handle that owns it.
 *
 * An empty text writes nothing at all, rather than a blank line: a run whose
 * format has no primary result must leave stdout untouched, and a newline is
 * not nothing to a consumer counting records.
 */
function emit(streams: CliStreams, text: RenderedText): void {
  if (text.result !== "") {
    writeResultLine(streams, text.result);
  }
  if (text.diagnostics !== "") {
    writeDiagnosticLine(streams, text.diagnostics);
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

/**
 * The stand-in for a rendered result.
 *
 * One JSON line, so it is parseable and machine-checkable while #18 and #19 are
 * unwritten. It is not their contract: no schema is promised here, and the
 * projections replace this entirely rather than extending it.
 */
function placeholderLine(result: RunCommandResult): string {
  return JSON.stringify({
    command: result.command,
    outcome: result.outcome,
    payload: result.payload,
    errors: result.errors.map((error) => ({ code: error.code, message: error.message })),
  });
}
