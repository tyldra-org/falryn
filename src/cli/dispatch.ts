/**
 * One invocation, start to finish.
 *
 * This is the only place that turns an argument vector into bytes and a number,
 * and it is deliberately small: parse, run, write, flush, resolve. Everything
 * it composes already exists — #20's streams and exit table, the command tree,
 * and the two commands.
 *
 * Rendering is #18's and #19's. Until they land, a result is written as one
 * placeholder line so the tree is runnable in between; the line is JSON so it
 * is at least parseable, and it is explicitly not the JSON *contract* those
 * issues will define.
 */

import { assertNever } from "../domain/index.ts";
import {
  helpText,
  type Invocation,
  parseInvocation,
  type RunnableCommand,
} from "./command-tree.ts";
import { runConfigPath, runConfigShow, runConfigValidate, runDoctor } from "./commands.ts";
import { EXIT_CODES, type ExitCode, resolveExitCode } from "./exit.ts";
import { configurationOverridesFor, type GlobalOptions } from "./options.ts";
import type { CommandResult } from "./result.ts";
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
  writeResultLine(streams, placeholderLine(result));
  return resolveExitCode({
    outcome: result.outcome,
    error: result.errors[0] ?? null,
  });
}

function defaultProvider(options: DispatchOptions): (globals: GlobalOptions) => ServiceProvider {
  return (globals) => createServiceProvider(globals, options.serviceOverrides ?? {});
}

async function produce(
  command: Exclude<RunnableCommand, "default">,
  services: ServiceProvider,
  overrides: Readonly<Record<string, string>>,
  globals: GlobalOptions,
): Promise<CommandResult<unknown>> {
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
function placeholderLine(result: CommandResult<unknown>): string {
  return JSON.stringify({
    command: result.command,
    outcome: result.outcome,
    payload: result.payload,
    errors: result.errors.map((error) => ({ code: error.code, message: error.message })),
  });
}
