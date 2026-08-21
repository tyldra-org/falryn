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

import { createFileAttachmentProbe, createGitDashboard } from "../application/index.ts";
import {
  assertNever,
  type EnvironmentPort,
  MAX_STREAM_READ_LIMIT,
  parseLocalPath,
  primaryWorkspaceRoot,
  type RuntimeEvent,
  streamId,
  type Timestamp,
  timestampFromEpochMilliseconds,
  workspaceId as workspaceIdCodec,
} from "../domain/index.ts";
import {
  createHostEnvironment,
  createHostGitPort,
  createHostProcessCapturePort,
} from "../integrations/index.ts";
import {
  decideLaunch,
  nonLaunchNotice,
  type RendererFactory,
  SHELL_OVERRIDE_VALUES,
  SHELL_OVERRIDE_VARIABLE,
  type ShellCapabilities,
  shellCapabilities,
} from "../tui/index.ts";
import {
  helpText,
  type Invocation,
  parseInvocation,
  type RunnableCommand,
} from "./command-tree.ts";
import {
  type RunCommandResult,
  runArtifactGet,
  runArtifactList,
  runArtifactShow,
  runCoding,
  runConfigPath,
  runConfigShow,
  runConfigValidate,
  runDataReset,
  runDataUninstall,
  runDoctor,
  runExport,
  runSessionList,
  runSessionShow,
  runWorkspaceList,
  runWorkspaceLoad,
  runWorkspaceSave,
  runWorkspaceShow,
  stoppedResult,
} from "./commands.ts";
import { composeSessionNavigationController } from "./compose-session-navigation-controller.ts";
import {
  runDataBackup,
  runDataDiagnostics,
  runDataInspect,
  runDataRestore,
} from "./data-backup-commands.ts";
import { runDataGc, runDataRetention } from "./data-retention-gc-commands.ts";
import { EXIT_CODES, type ExitCode, resolveExitCode } from "./exit.ts";
import { runImport, runReplay } from "./import-replay-commands.ts";
import {
  createInvocationGovernance,
  type InvocationGovernance,
  openInvocationScope,
  runUnderScope,
  untilScopeStops,
} from "./invocation-scope.ts";
import {
  allowsColor,
  configurationOverridesFor,
  type GlobalOptions,
  resolveColor,
} from "./options.ts";
import { composeProductShellAttachments } from "./product-shell-attachments.ts";
import { createOverBoundArtifactWriter } from "./refusal-artifact.ts";
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
  runSessionForkOrRewind,
  runSessionReplay,
  runSessionResume,
} from "./session-navigation.ts";
import { resolveShellConfiguration } from "./shell-configuration.ts";
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
  /**
   * Supplied by tests, so a launch decision never reads the developer's shell.
   *
   * Read before any service graph exists, which is what makes the launch
   * decision free: a run that will not open a shell answers from this and
   * returns. A run that *will* open one goes on to build the same graph a
   * command builds — see {@link launchShell} — so this is the environment the
   * decision is taken from rather than the only one an interactive run has.
   */
  readonly environment?: EnvironmentPort;
  /**
   * Supplied by tests, so a shell run needs no terminal and no native library.
   *
   * Typed as the factory the session takes rather than as `unknown`, and
   * declared here rather than threaded through an options bag, because the
   * control that proves a refused run creates no renderer works by handing over
   * a factory that throws when it is called.
   */
  readonly createRenderer?: RendererFactory;
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
  const {
    command,
    data,
    dataLifecycleArgs,
    exportArgs,
    importArgs,
    replayArgs,
    sessionArgs,
    artifactArgs,
    workspaceArgs,
    runArgs,
    options: globals,
  } = invocation;

  if (command === "default") {
    return runDefault(globals, options);
  }

  // Built here and not before: every path above returns without a service.
  const services = (options.services ?? defaultProvider(options))(globals);
  const overrides = configurationOverridesFor(globals);

  const result = await governed(
    command,
    data,
    dataLifecycleArgs,
    exportArgs,
    importArgs,
    replayArgs,
    sessionArgs,
    artifactArgs,
    workspaceArgs,
    runArgs,
    services,
    overrides,
    globals,
    options,
  );
  const rendered = await render(result, globals, streams, services);
  if (
    result.command === "artifact.get" &&
    "stdoutDelivery" in result &&
    result.stdoutDelivery?.kind === "stdout-bytes"
  ) {
    emit(streams, { result: [], diagnostics: rendered.diagnostics });
  } else {
    emit(streams, rendered);
  }
  return resolveExitCode({
    outcome: result.outcome,
    error: result.errors[0] ?? null,
  });
}

/* -------------------------------------------------------------------------- */
/* The no-argument invocation                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `falryn`, with nothing after it.
 *
 * The decision is taken from observed facts rather than guessed, and it is taken
 * *here* — before anything OpenTUI-shaped is loaded. `src/tui/index.ts` is the
 * pure half of the interface area: a capability record and a launch decision,
 * neither of which touches a renderer. Only a decision to launch
 * reaches for `src/tui/shell.tsx`, and only that import pulls in the native
 * library. A run that was never going to open a shell pays nothing to find out.
 *
 * A refusal keeps exactly the behavior this invocation had before the shell
 * existed — help on stdout, exit zero — and names its reason on the diagnostic
 * handle, because "falryn printed help at me" and "falryn printed help at me
 * because stdout is a pipe" are different things to the person reading it.
 */
async function runDefault(globals: GlobalOptions, options: DispatchOptions): Promise<ExitCode> {
  const { streams } = options;
  const environment = options.environment ?? createHostEnvironment();
  const capabilities = shellCapabilities({ handles: streams.capabilities, environment });

  if (capabilities.override.kind === "unrecognized") {
    // Reported rather than obeyed or silently dropped. A misspelled override
    // that changed nothing and said nothing would look exactly like an override
    // that was honoured.
    writeDiagnosticLine(
      streams,
      `${SHELL_OVERRIDE_VARIABLE}=${capabilities.override.value} is not recognized; expected one of: ${SHELL_OVERRIDE_VALUES.join(", ")}.`,
    );
  }

  const decision = decideLaunch(capabilities, globals);
  if (decision.kind === "declined") {
    writeDiagnosticLine(streams, nonLaunchNotice(decision.reason));
    writeResultLine(streams, await helpText(null));
    return EXIT_CODES.COMPLETED;
  }

  return launchShell(capabilities, globals, environment, options);
}

/**
 * Runs the shell under this invocation's scope.
 *
 * The scope is opened the same way a command's is, and for the same reasons:
 * `--timeout` becomes its deadline, and an interrupt on the root reaches it. It
 * is not run through {@link runUnderScope} though, and that difference is the
 * point — see {@link untilScopeStops}. The shell has no completion of its own in
 * this build, so the scope stopping is not something to race against the work,
 * it *is* the work ending.
 */
async function launchShell(
  capabilities: ShellCapabilities,
  globals: GlobalOptions,
  environment: EnvironmentPort,
  options: DispatchOptions,
): Promise<ExitCode> {
  const { streams } = options;
  const governance = options.governance ?? createInvocationGovernance();
  const scope = openInvocationScope(governance, globals.timeoutMs);

  // Read here and nowhere earlier. `decideLaunch` has already said launch, so a
  // run that was never going to open a shell still builds nothing — which is the
  // property `runDefault` exists to hold and this must not spend. And it is read
  // before the renderer, because the diagnostic handle is an ordinary terminal
  // until one is up; after that it is not, which is why the unrecognized-override
  // notice is written where it is.
  const services = options.services ?? defaultProvider(options);
  const configuration = await resolveShellConfiguration(globals, {
    streams,
    services,
  });
  const graph = services(globals)();
  const fileProbe = createFileAttachmentProbe({
    fileSystem: graph.fileSystem,
    workspace: graph.workspaceRoot,
  });
  const gitExecutable = Bun.which("git");
  const gitDashboard =
    gitExecutable === null || graph.workspaceRoot === null
      ? undefined
      : createGitDashboard({
          git: createHostGitPort({ capture: createHostProcessCapturePort() }),
          gitExecutable,
          startPath: graph.workspaceRoot,
        });

  // Aborts when the shell is done, so a run given a long `--timeout` does not
  // leave a timer armed over a process with nothing left to govern.
  const finished = new AbortController();
  const stopped = new AbortController();
  if (scope !== null) {
    void untilScopeStops(governance, scope, finished.signal).then(() => stopped.abort());
  }

  const resolvedWorkspace = await graph.ensureWorkspaceSet(stopped.signal);

  // Workspace controller is OpenTUI-free but lives under `tui/`, so it loads on
  // the same dynamic seam the launch boundary requires for the shell.
  const { createWorkspaceController } = await import("../tui/workspace/index.ts");
  const workspaceController =
    resolvedWorkspace.ok === true
      ? createWorkspaceController({
          fileSystem: graph.fileSystem,
          configurationRoot: graph.configurationRoot,
          currentDirectory: (() => {
            const cwd = parseLocalPath(process.cwd());
            return cwd.ok ? cwd.value : null;
          })(),
          initial: resolvedWorkspace.value.set,
        })
      : undefined;
  const workspace = workspaceController?.initial;

  const sessionNavigationWorkspaceId =
    resolvedWorkspace.ok === true
      ? workspaceIdCodec.from(primaryWorkspaceRoot(resolvedWorkspace.value.set).rootId)
      : workspaceIdCodec.from("workspace-unbound");
  const sessionNavigationBundle = await composeSessionNavigationController(
    services(globals),
    sessionNavigationWorkspaceId,
    stopped.signal,
  );

  const productAttachments = await composeProductShellAttachments({
    eventStore: graph.eventStore,
    clock: graph.clock,
    environment,
    fileSystem: graph.fileSystem,
    workspaceSet: resolvedWorkspace.ok === true ? resolvedWorkspace.value.set : null,
    signal: stopped.signal,
  });

  // Loaded here and nowhere earlier: this is the first line of the whole
  // invocation that requires OpenTUI to exist.
  const { runShell } = await import("../tui/shell.tsx");

  let run: Awaited<ReturnType<typeof runShell>>;
  try {
    run = await runShell({
      streams,
      capabilities,
      clock: governance.clock,
      options: globals,
      environment,
      configuration,
      stop: stopped.signal,
      // The rail's source. Handed over read-only: the shell folds the tree's
      // ordered events into its activity projection and never asks it to do
      // anything. Before #370 nothing supplied this, so the interface reported
      // that no runtime was attached while running inside one.
      scopes: governance.scopes,
      ...(fileProbe === null ? {} : { fileProbe }),
      ...(gitDashboard === undefined ? {} : { gitDashboard }),
      ...(workspaceController === undefined ? {} : { workspaceController }),
      ...(workspace === undefined ? {} : { workspace }),
      ...(sessionNavigationBundle === undefined
        ? {}
        : { sessionNavigationController: sessionNavigationBundle.controller }),
      ...(governance.shutdown === undefined ? {} : { shutdown: governance.shutdown }),
      ...(options.createRenderer === undefined ? {} : { createRenderer: options.createRenderer }),
      ...(productAttachments === null
        ? {}
        : {
            submission: productAttachments.submission,
            transcriptFeed: productAttachments.transcriptFeed,
          }),
    });
  } finally {
    finished.abort();
    if (sessionNavigationBundle !== undefined) {
      await sessionNavigationBundle.close(stopped.signal);
    }
  }

  if (run.kind === "failed") {
    // Plain text on the diagnostic handle. The renderer is already gone by the
    // time this runs, so this is an ordinary line into an ordinary terminal.
    //
    // With its cause, when there is one. The message alone says the interface
    // could not start and nothing about why — which is what made #351 take a
    // pseudo-terminal and three experiments to locate, for a failure whose cause
    // was a complete sentence the renderer had already handed over. The detail
    // is the bounded, redacted one the error carries; the raw thrown value never
    // reaches here.
    const detail = run.error.cause?.detail ?? null;
    writeDiagnosticLine(
      streams,
      detail === null ? run.error.message : `${run.error.message} ${detail}`,
    );
    return resolveExitCode({
      outcome: { kind: "failed", effect: run.error.effect },
      error: run.error,
    });
  }

  if (scope === null) {
    // The tree refused to derive, so nothing governed the run. It ended, and
    // there is no scope to read an outcome from.
    return EXIT_CODES.COMPLETED;
  }

  if (run.kind === "closed") {
    governance.scopes.complete(scope.scopeId);
    return EXIT_CODES.COMPLETED;
  }

  // Stopped. `acknowledge` decides between `cancelled` and `timed-out` from the
  // reason the tree recorded, so an interrupt and a deadline are told apart by
  // the owner of that distinction rather than re-derived here.
  const settled = governance.scopes.acknowledge(scope.scopeId);
  return resolveExitCode({
    outcome: settled.ok ? settled.value : { kind: "uncertain", effect: "uncertain" },
    error: null,
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
  data: Extract<Invocation, { kind: "run" }>["data"],
  dataLifecycleArgs: Extract<Invocation, { kind: "run" }>["dataLifecycleArgs"],
  exportArgs: Extract<Invocation, { kind: "run" }>["exportArgs"],
  importArgs: Extract<Invocation, { kind: "run" }>["importArgs"],
  replayArgs: Extract<Invocation, { kind: "run" }>["replayArgs"],
  sessionArgs: Extract<Invocation, { kind: "run" }>["sessionArgs"],
  artifactArgs: Extract<Invocation, { kind: "run" }>["artifactArgs"],
  workspaceArgs: Extract<Invocation, { kind: "run" }>["workspaceArgs"],
  runArgs: Extract<Invocation, { kind: "run" }>["runArgs"],
  services: ServiceProvider,
  overrides: Readonly<Record<string, string>>,
  globals: GlobalOptions,
  options: DispatchOptions,
): Promise<RunCommandResult> {
  const governance = options.governance ?? createInvocationGovernance();
  const scope = openInvocationScope(governance, globals.timeoutMs);
  if (scope === null) {
    return produce(
      command,
      data,
      dataLifecycleArgs,
      exportArgs,
      importArgs,
      replayArgs,
      sessionArgs,
      artifactArgs,
      workspaceArgs,
      runArgs,
      services,
      overrides,
      globals,
      options,
    );
  }

  const run = await runUnderScope(governance, scope, (signal) =>
    produce(
      command,
      data,
      dataLifecycleArgs,
      exportArgs,
      importArgs,
      replayArgs,
      sessionArgs,
      artifactArgs,
      workspaceArgs,
      runArgs,
      services,
      overrides,
      globals,
      options,
      signal,
      () => {
        // The executor has begun a destructive operation. If an interrupt wins
        // the race from here, the scope must not report a retry-safe cancellation.
        governance.scopes.recordEffect(scope.scopeId, "uncertain");
      },
    ),
  );
  // A stopped invocation still answers, in the format the caller asked for.
  // Emitting nothing would leave a reader waiting for a record that is not
  // coming, which is the failure the single-terminal-record contract exists to
  // prevent.
  return run.kind === "finished"
    ? run.value
    : stoppedResult(
        command,
        run.outcome,
        stoppedCommandIntent(command, data, dataLifecycleArgs, exportArgs, importArgs),
      );
}

/** The declared effect remains true even if the invocation stops mid-command. */
function stoppedCommandIntent(
  command: Exclude<RunnableCommand, "default">,
  data: Extract<Invocation, { kind: "run" }>["data"],
  dataLifecycleArgs: Extract<Invocation, { kind: "run" }>["dataLifecycleArgs"],
  exportArgs: Extract<Invocation, { kind: "run" }>["exportArgs"],
  importArgs: Extract<Invocation, { kind: "run" }>["importArgs"],
): "none" | "mutate" {
  if (
    (command === "data.reset" || command === "data.uninstall") &&
    data !== null &&
    data.confirmation !== null
  ) {
    return "mutate";
  }
  if (
    command === "data.restore" &&
    dataLifecycleArgs !== null &&
    dataLifecycleArgs.action === "restore" &&
    dataLifecycleArgs.confirmation !== null
  ) {
    return "mutate";
  }
  if (
    command === "data.gc" &&
    dataLifecycleArgs !== null &&
    dataLifecycleArgs.action === "gc" &&
    dataLifecycleArgs.confirmation !== null
  ) {
    return "mutate";
  }
  if (command === "data.backup") {
    return "mutate";
  }
  if (command === "export" && exportArgs !== null && exportArgs.write) {
    return "mutate";
  }
  if (command === "import" && importArgs !== null) {
    return "mutate";
  }
  if (command === "workspace.save") {
    return "mutate";
  }
  return "none";
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
      return renderJson({
        result,
        occurredAt: nowFor(services),
        storeOverBound: createOverBoundArtifactWriter(services),
      });
    case "jsonl":
      return renderJsonl({
        result,
        occurredAt: nowFor(services),
        events: await lifecycleEvents(services),
        storeOverBound: createOverBoundArtifactWriter(services),
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
  data: Extract<Invocation, { kind: "run" }>["data"],
  dataLifecycleArgs: Extract<Invocation, { kind: "run" }>["dataLifecycleArgs"],
  exportArgs: Extract<Invocation, { kind: "run" }>["exportArgs"],
  importArgs: Extract<Invocation, { kind: "run" }>["importArgs"],
  replayArgs: Extract<Invocation, { kind: "run" }>["replayArgs"],
  sessionArgs: Extract<Invocation, { kind: "run" }>["sessionArgs"],
  artifactArgs: Extract<Invocation, { kind: "run" }>["artifactArgs"],
  workspaceArgs: Extract<Invocation, { kind: "run" }>["workspaceArgs"],
  runArgs: Extract<Invocation, { kind: "run" }>["runArgs"],
  services: ServiceProvider,
  overrides: Readonly<Record<string, string>>,
  globals: GlobalOptions,
  options: DispatchOptions,
  signal?: AbortSignal,
  onMutationStart?: () => void,
): Promise<RunCommandResult> {
  switch (command) {
    case "config.show":
      return runConfigShow(services, overrides, globals, signal);
    case "config.validate":
      return runConfigValidate(services, overrides, globals, signal);
    case "config.path":
      return runConfigPath(services, globals, signal);
    case "data.reset":
      if (data === null) {
        throw new Error("Missing parsed data reset arguments.");
      }
      return runDataReset(services, data, signal, onMutationStart);
    case "data.uninstall":
      if (data === null) {
        throw new Error("Missing parsed data uninstall arguments.");
      }
      return runDataUninstall(services, data, signal, onMutationStart);
    case "data.backup":
      if (dataLifecycleArgs === null || dataLifecycleArgs.action !== "backup") {
        throw new Error("Missing parsed data backup arguments.");
      }
      return runDataBackup(services, dataLifecycleArgs, signal, onMutationStart);
    case "data.restore":
      if (dataLifecycleArgs === null || dataLifecycleArgs.action !== "restore") {
        throw new Error("Missing parsed data restore arguments.");
      }
      return runDataRestore(services, dataLifecycleArgs, signal, onMutationStart);
    case "data.inspect":
      if (dataLifecycleArgs === null || dataLifecycleArgs.action !== "inspect") {
        throw new Error("Missing parsed data inspect arguments.");
      }
      return runDataInspect(services, dataLifecycleArgs, signal);
    case "data.diagnostics":
      if (dataLifecycleArgs === null || dataLifecycleArgs.action !== "diagnostics") {
        throw new Error("Missing parsed data diagnostics arguments.");
      }
      return runDataDiagnostics(services, signal);
    case "data.retention":
      if (dataLifecycleArgs === null || dataLifecycleArgs.action !== "retention") {
        throw new Error("Missing parsed data retention arguments.");
      }
      return runDataRetention(services, signal);
    case "data.gc":
      if (dataLifecycleArgs === null || dataLifecycleArgs.action !== "gc") {
        throw new Error("Missing parsed data gc arguments.");
      }
      return runDataGc(services, dataLifecycleArgs, signal, onMutationStart);
    case "doctor":
      return runDoctor(services);
    case "export":
      if (exportArgs === null) {
        throw new Error("Missing parsed export arguments.");
      }
      return runExport(services, exportArgs, signal, onMutationStart);
    case "import":
      if (importArgs === null) {
        throw new Error("Missing parsed import arguments.");
      }
      return runImport(services, importArgs, signal, onMutationStart);
    case "replay":
      if (replayArgs === null) {
        throw new Error("Missing parsed replay arguments.");
      }
      return runReplay(services, replayArgs, signal);
    case "session.list":
      if (sessionArgs === null || sessionArgs.action !== "list") {
        throw new Error("Missing parsed session list arguments.");
      }
      return runSessionList(services, sessionArgs, signal);
    case "session.show":
      if (sessionArgs === null || sessionArgs.action !== "show") {
        throw new Error("Missing parsed session show arguments.");
      }
      return runSessionShow(services, sessionArgs, signal);
    case "session.resume":
      if (sessionArgs === null || sessionArgs.action !== "resume") {
        throw new Error("Missing parsed session resume arguments.");
      }
      return runSessionResume(services, sessionArgs, signal);
    case "session.fork":
      if (sessionArgs === null || sessionArgs.action !== "fork") {
        throw new Error("Missing parsed session fork arguments.");
      }
      return runSessionForkOrRewind(services, sessionArgs, signal);
    case "session.rewind":
      if (sessionArgs === null || sessionArgs.action !== "rewind") {
        throw new Error("Missing parsed session rewind arguments.");
      }
      return runSessionForkOrRewind(services, sessionArgs, signal);
    case "session.replay":
      if (sessionArgs === null || sessionArgs.action !== "replay") {
        throw new Error("Missing parsed session replay arguments.");
      }
      return runSessionReplay(services, sessionArgs, signal);
    case "artifact.list":
      if (artifactArgs === null || artifactArgs.action !== "list") {
        throw new Error("Missing parsed artifact list arguments.");
      }
      return runArtifactList(services, artifactArgs, signal);
    case "artifact.show":
      if (artifactArgs === null || artifactArgs.action !== "show") {
        throw new Error("Missing parsed artifact show arguments.");
      }
      return runArtifactShow(services, artifactArgs, signal);
    case "artifact.get":
      if (artifactArgs === null || artifactArgs.action !== "get") {
        throw new Error("Missing parsed artifact get arguments.");
      }
      return runArtifactGet(
        services,
        artifactArgs,
        {
          resultStream: options.streams.result,
          stdoutIsTty: options.streams.capabilities.stdout.isTty,
        },
        signal,
      );
    case "workspace.list":
      if (workspaceArgs === null || workspaceArgs.action !== "list") {
        throw new Error("Missing parsed workspace list arguments.");
      }
      return runWorkspaceList(services, workspaceArgs, signal);
    case "workspace.show":
      return runWorkspaceShow(services, signal);
    case "workspace.save":
      if (workspaceArgs === null || workspaceArgs.action !== "save") {
        throw new Error("Missing parsed workspace save arguments.");
      }
      onMutationStart?.();
      return runWorkspaceSave(services, workspaceArgs, signal);
    case "workspace.load":
      if (workspaceArgs === null || workspaceArgs.action !== "load") {
        throw new Error("Missing parsed workspace load arguments.");
      }
      return runWorkspaceLoad(services, workspaceArgs, signal);
    case "run":
      if (runArgs === null) {
        throw new Error("Missing parsed coding run arguments.");
      }
      return runCoding(services, runArgs, {
        input: options.streams.input,
        ...(signal === undefined ? {} : { signal }),
      });
    default:
      // `default`, `help`, and `version` are answered before this is reached,
      // so a new command reaching here without a branch fails to compile.
      return assertNever(command, "unhandled command");
  }
}
