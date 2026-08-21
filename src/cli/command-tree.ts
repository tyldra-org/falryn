/**
 * The yargs command tree, and the parse that never prints and never exits.
 *
 * yargs is given no authority over the process. `help(false)` and
 * `version(false)` stop it registering its own output, help text is pulled as a
 * string from `getHelp()`, `--help` and `--version` are ordinary booleans, and
 * `.fail()` throws so a failure cannot fall through. That last one is not
 * defensive style: with `exitProcess(false)` yargs calls a fail handler and
 * then *resolves normally*, so a handler that merely recorded the failure would
 * let an invalid invocation continue into application work. The packaging probe
 * reproduced exactly that before this shape was chosen.
 *
 * The result is that every byte this CLI emits goes through the streams #20
 * owns, and every exit status comes from #20's table.
 *
 * Only groups whose capability exists are declared. A tree advertising
 * `provider` in `--help` would promise behavior nothing implements.
 */

import yargs from "yargs";

import { isLegalProfileName } from "../config/index.ts";
import {
  type ArtifactId,
  artifactId,
  type BackupName,
  backupName,
  DEFAULT_ARTIFACT_LIST_LIMIT,
  DEFAULT_SESSION_LIST_LIMIT,
  DEFAULT_WORKSPACE_LAYOUT_LIST_LIMIT,
  type ExportName,
  type ExportSelection,
  exportName,
  type GcPlanId,
  isGcPlanId,
  isLegalWorkspaceLayoutName,
  isOwnershipClass,
  isPlanId,
  localPathTextError,
  MAX_ARTIFACT_CATALOG,
  MAX_LOCAL_PATH_LENGTH,
  MAX_SESSION_CATALOG,
  MAX_WORKSPACE_LAYOUT_CATALOG,
  type OwnershipClass,
  type PlanId,
  parseLocalPath,
  parseTimestamp,
  SESSION_CATALOG_FILTERS,
  type SessionCatalogFilter,
  type SessionId,
  type StreamId,
  sessionId,
  streamId,
  TERMINAL_OUTCOME_PROJECTION_GENERATION,
  type WorkspaceId,
  workspaceId,
} from "../domain/index.ts";
import { createHostFileSystem } from "../integrations/index.ts";
import type { CodingRunArguments } from "./coding-run.ts";
import {
  COLOR_CHOICES,
  type ColorChoice,
  type GlobalOptions,
  MAX_TIMEOUT_MS,
  OUTPUT_FORMATS,
  type OutputFormat,
} from "./options.ts";
import type { CommandId } from "./result.ts";
import {
  type TaskCommitPlanArguments,
  taskCommitPlanArgumentsFor,
} from "./task-commit-plan-commands.ts";
import {
  MAX_TASK_INPUT_FILE_BYTES,
  type TaskCommandArguments,
  taskArgumentsFor,
} from "./task-intelligence-parse.ts";

/** The name the tree reports itself as, whatever the executable is called. */
export const SCRIPT_NAME = "falryn";

/**
 * A command the tree can dispatch.
 *
 * `help` and `version` are answered by their own invocation kinds, so they are
 * excluded here rather than being reachable as a run — which is what lets the
 * dispatch switch be exhaustive without branches that cannot happen.
 */
export type RunnableCommand = Exclude<CommandId, "help" | "version">;

/** Command-specific inputs for one local-data removal command. */
export type DataCommandArguments = {
  readonly classes: readonly OwnershipClass[];
  /** The exact plan identity supplied by the caller, or `null` for preview. */
  readonly confirmation: PlanId | null;
};

/** Command-specific inputs for backup, restore, inspect, and local diagnostics. */
export type DataLifecycleArguments =
  | { readonly action: "backup"; readonly name: BackupName }
  | {
      readonly action: "restore";
      readonly name: BackupName;
      /** The backup name from a prior preview, or `null` to preview only. */
      readonly confirmation: BackupName | null;
    }
  | { readonly action: "inspect"; readonly name: BackupName }
  | { readonly action: "diagnostics" }
  | { readonly action: "retention" }
  | {
      readonly action: "gc";
      readonly confirmation: GcPlanId | null;
      readonly pinnedSessions: readonly string[];
    };

/** Command-specific inputs for `falryn export`. */
export type ExportCommandArguments = {
  readonly selection: ExportSelection;
  readonly write: boolean;
  readonly name: ExportName | null;
};

/** Command-specific inputs for `falryn import`. */
export type ImportCommandArguments = {
  readonly name: ExportName;
};

/** Command-specific inputs for `falryn replay`. */
export type ReplayCommandArguments = {
  readonly sessionId: SessionId;
};

/** Command-specific inputs for `falryn artifact`. */
export type ArtifactCommandArguments =
  | {
      readonly action: "list";
      readonly limit: number;
    }
  | {
      readonly action: "show";
      readonly artifactId: ArtifactId;
    }
  | {
      readonly action: "get";
      readonly artifactId: ArtifactId;
      readonly outputPath: string | null;
    };

/** Replay control verbs accepted by `falryn session replay`. */
export const SESSION_REPLAY_ACTIONS = ["play", "pause", "step", "seek"] as const;
export type SessionReplayAction = (typeof SESSION_REPLAY_ACTIONS)[number];

/** Command-specific inputs for `falryn session`. */
export type SessionCommandArguments =
  | {
      readonly action: "list";
      readonly workspaceId: WorkspaceId;
      readonly filter: SessionCatalogFilter;
      readonly search: string | undefined;
      readonly limit: number;
    }
  | {
      readonly action: "show";
      readonly workspaceId: WorkspaceId;
      readonly sessionId: SessionId;
    }
  | {
      readonly action: "resume";
      readonly workspaceId: WorkspaceId;
      readonly sessionId: SessionId;
      readonly afterSequence: number | null;
      readonly schemaGeneration: number;
    }
  | {
      readonly action: "fork";
      readonly workspaceId: WorkspaceId;
      readonly sessionId: SessionId;
      readonly newSessionId: SessionId | undefined;
      readonly newStreamId: StreamId | undefined;
    }
  | {
      readonly action: "rewind";
      readonly workspaceId: WorkspaceId;
      readonly sessionId: SessionId;
      readonly atTurnId: string;
      readonly newSessionId: SessionId | undefined;
      readonly newStreamId: StreamId | undefined;
    }
  | {
      readonly action: "replay";
      readonly workspaceId: WorkspaceId;
      readonly sessionId: SessionId;
      readonly replayCommand:
        | { readonly kind: "play" }
        | { readonly kind: "pause" }
        | { readonly kind: "step" }
        | { readonly kind: "seek"; readonly sequence: number };
    };

/** Command-specific inputs for `falryn workspace`. */
export type WorkspaceCommandArguments =
  | {
      readonly action: "list";
      readonly limit: number;
    }
  | {
      readonly action: "show";
    }
  | {
      readonly action: "save";
      readonly name: string;
      readonly force: boolean;
    }
  | {
      readonly action: "load";
      readonly name: string;
    };

export type { TaskCommandArguments };

/**
 * What parsing an argument vector produced.
 *
 * A closed union rather than a partly-filled record: an invocation that failed
 * to parse has no command and no options, and a shape that carried both would
 * let a caller read them anyway.
 */
export type Invocation =
  /** Run this command with these options. */
  | {
      readonly kind: "run";
      readonly command: RunnableCommand;
      readonly options: GlobalOptions;
      readonly data: DataCommandArguments | null;
      readonly dataLifecycleArgs: DataLifecycleArguments | null;
      readonly exportArgs: ExportCommandArguments | null;
      readonly importArgs: ImportCommandArguments | null;
      readonly replayArgs: ReplayCommandArguments | null;
      readonly sessionArgs: SessionCommandArguments | null;
      readonly artifactArgs: ArtifactCommandArguments | null;
      readonly workspaceArgs: WorkspaceCommandArguments | null;
      readonly runArgs: CodingRunArguments | null;
      readonly taskArgs: TaskCommandArguments | null;
      readonly commitPlanArgs: TaskCommitPlanArguments | null;
    }
  /** Show help. `topic` is `null` for the root, or the subcommand asked about. */
  | { readonly kind: "help"; readonly topic: string | null; readonly options: GlobalOptions }
  | { readonly kind: "version"; readonly options: GlobalOptions }
  /**
   * The invocation was not usable. Exits with #20's invalid-usage code.
   *
   * `message` is yargs' own text or a conflict this module detected; it is
   * actionable and safe to print, and it never carries a secret because the
   * only values in it are the flags the caller typed.
   */
  | { readonly kind: "invalid"; readonly message: string };

/** The shape yargs parses into. Narrowed into `GlobalOptions` after validation. */
type RawArguments = {
  readonly _: readonly (string | number)[];
  /** Bound by name from `config <action>`; it never appears in `_`. */
  readonly action: string | undefined;
  readonly class: readonly string[] | undefined;
  readonly confirm: string | undefined;
  readonly "pinned-session": readonly string[] | undefined;
  readonly session: readonly string[] | undefined;
  readonly after: string | undefined;
  readonly before: string | undefined;
  readonly name: string | undefined;
  readonly write: boolean | undefined;
  readonly "include-sensitive": boolean | undefined;
  readonly id: string | undefined;
  readonly filter: string | undefined;
  readonly search: string | undefined;
  readonly limit: number | undefined;
  readonly "workspace-id": string | undefined;
  readonly "after-sequence": number | undefined;
  readonly "schema-generation": number | undefined;
  readonly "at-turn": string | undefined;
  readonly "new-session-id": string | undefined;
  readonly "new-stream-id": string | undefined;
  readonly "replay-action": string | undefined;
  readonly "seek-sequence": number | undefined;
  readonly output: string | undefined;
  readonly force: boolean | undefined;
  readonly "add-dir": readonly string[] | undefined;
  readonly prompt: readonly string[] | undefined;
  readonly brief: string | undefined;
  readonly statement: string | undefined;
  readonly "outcome-id": string | undefined;
  readonly "task-id": string | undefined;
  readonly scope: readonly string[] | undefined;
  readonly cwd: string | undefined;
  readonly goal: readonly string[] | undefined;
  readonly "non-goal": readonly string[] | undefined;
  readonly proposed: readonly string[] | undefined;
  readonly task: readonly string[] | undefined;
  readonly depends: readonly string[] | undefined;
  readonly observe: readonly string[] | undefined;
  readonly blocker: readonly string[] | undefined;
  readonly criterion: readonly string[] | undefined;
  readonly input: string | undefined;
  readonly format: string;
  readonly color: string;
  readonly quiet: boolean;
  readonly verbose: boolean;
  readonly "non-interactive": boolean;
  readonly "no-color": boolean;
  readonly workspace: string | undefined;
  readonly profile: string | undefined;
  readonly timeout: number | undefined;
  readonly help: boolean;
  readonly version: boolean;
};

/**
 * Builds the parser for one argument vector.
 *
 * Rebuilt per parse rather than shared: yargs parsers carry state across
 * `parse` calls, and a shared one makes a second invocation in the same process
 * depend on the first — which a test suite notices before a user does.
 */
function build(argv: readonly string[], lenientPositionals = false): ReturnType<typeof yargs> {
  // `config <action>` demands its subcommand; `config [action]` does not. The
  // lenient form exists for one reason: a help request must not be rejected
  // for omitting the very thing it is asking about.
  const configCommand = lenientPositionals ? "config [action]" : "config <action>";
  const dataCommand = lenientPositionals ? "data [action] [name]" : "data <action> [name]";
  const sessionCommand = lenientPositionals ? "session [action] [id]" : "session <action> [id]";
  const artifactCommand = lenientPositionals ? "artifact [action] [id]" : "artifact <action> [id]";
  const workspaceCommand = lenientPositionals
    ? "workspace [action] [name]"
    : "workspace <action> [name]";
  const taskCommand = lenientPositionals ? "task [action]" : "task <action>";
  return (
    yargs([...argv])
      .scriptName(SCRIPT_NAME)
      .strict()
      // `--no-color` is its own declared flag, not a negation of `--color`.
      // With negation on, yargs rewrites it to `color: false`, which then fails
      // `--color`'s own string choices with a message about the wrong flag.
      .parserConfiguration({ "boolean-negation": false })
      // Never ends the process. #20 owns the exit, and a library that called
      // `process.exit()` would skip the flush that delivers buffered output.
      .exitProcess(false)
      // yargs prints nothing. Everything goes through #20's streams.
      .help(false)
      .version(false)
      .wrap(null)
      .usage(
        `${SCRIPT_NAME} [command] [options]\n\n` +
          "Falryn is a local terminal coding agent. Running it with no command opens\n" +
          "the interactive shell on a capable terminal, and prints this help with a\n" +
          "reason on any run that cannot host one.",
      )
      .command(configCommand, "Inspect and validate effective configuration.", (group) =>
        group.positional("action", {
          type: "string",
          choices: ["show", "validate", "path"] as const,
          describe: "show the effective values, validate them, or print source paths",
        }),
      )
      .command(
        dataCommand,
        "Preview, back up, inspect, or remove Falryn-owned local data.",
        (group) =>
          group
            .positional("action", {
              type: "string",
              choices: [
                "reset",
                "uninstall",
                "backup",
                "restore",
                "inspect",
                "diagnostics",
                "retention",
                "gc",
              ] as const,
              describe:
                "reset or uninstall classes, back up or restore SQLite, diagnose, report retention, or GC unreachable data",
            })
            .positional("name", {
              type: "string",
              describe: "backup name (required for backup, restore, and inspect)",
            })
            .option("class", {
              type: "string",
              array: true,
              describe: "ownership class to include in a reset (repeatable)",
            })
            .option("pinned-session", {
              type: "string",
              array: true,
              describe: "session identity treated as pinned for reachability GC (repeatable)",
            })
            .option("confirm", {
              type: "string",
              describe:
                "execute a reset or GC plan identity from a prior preview, or confirm a restore with the backup name",
            }),
      )
      .command("doctor", "Run bounded environment and storage diagnostics.", (group) => group)
      .command(
        "run [prompt..]",
        "Execute a coding task headlessly with text or structured output.",
        (group) =>
          group
            .positional("prompt", {
              type: "string",
              describe: "task text; omit to read UTF-8 from stdin (never prompts)",
            })
            .option("brief", {
              type: "string",
              choices: ["compact", "balanced", "detailed", "auto"] as const,
              describe: "Brief response-style verbosity for the live turn (#717)",
            }),
      )
      .command("export", "Preview or write a versioned export bundle.", (group) =>
        group
          .option("session", {
            type: "string",
            array: true,
            describe: "session identity to include (repeatable)",
          })
          .option("after", {
            type: "string",
            describe: "include sessions started at or after this canonical UTC timestamp",
          })
          .option("before", {
            type: "string",
            describe: "include sessions started at or before this canonical UTC timestamp",
          })
          .option("include-sensitive", {
            type: "boolean",
            default: false,
            describe: "include sensitive artifacts; restricted artifacts are never exported",
          })
          .option("name", {
            type: "string",
            describe: "file-safe name of the package to write (required with --write)",
          })
          .option("write", {
            type: "boolean",
            default: false,
            describe: "write the bundle; omit this flag to preview only",
          }),
      )
      .command(
        "import <name>",
        "Import a verified export package from the exports root.",
        (group) =>
          group.positional("name", {
            type: "string",
            describe: "file-safe export package name under the exports root",
          }),
      )
      .command(
        "replay <id>",
        "Rebuild a session from stored facts without repeating effects.",
        (group) =>
          group.positional("id", {
            type: "string",
            describe: "session identity to rebuild (not `session replay`, which is cursor control)",
          }),
      )
      .command(
        taskCommand,
        "Decompose outcomes, recommend validation, project progress, or plan commits.",
        (group) =>
          group
            .positional("action", {
              type: "string",
              choices: ["decompose", "validate", "progress", "commit-plan"] as const,
              describe: "decompose, validate, progress, or commit-plan",
            })
            .option("statement", {
              type: "string",
              describe: "declared outcome statement (decompose)",
            })
            .option("outcome-id", {
              type: "string",
              describe: "outcome identity (default cli-outcome)",
            })
            .option("task-id", {
              type: "string",
              describe: "optional task identity (commit-plan)",
            })
            .option("scope", {
              type: "string",
              array: true,
              describe: "optional path scope for commit-plan (repeatable)",
            })
            .option("cwd", {
              type: "string",
              describe: "repository start path for commit-plan (default cwd)",
            })
            .option("confirm", {
              type: "string",
              describe: "exact plan-commit-… token to apply a commit plan",
            })
            .option("goal", {
              type: "string",
              array: true,
              describe: "declared goal (decompose; repeatable)",
            })
            .option("non-goal", {
              type: "string",
              array: true,
              describe: "declared non-goal (decompose; repeatable)",
            })
            .option("proposed", {
              type: "string",
              array: true,
              describe: "proposed taskId:objective split (decompose; repeatable)",
            })
            .option("task", {
              type: "string",
              array: true,
              describe: "task id or taskId:criterion pair (validate/progress; repeatable)",
            })
            .option("depends", {
              type: "string",
              array: true,
              describe: "predecessor:successor edge (progress; repeatable)",
            })
            .option("observe", {
              type: "string",
              array: true,
              describe: "taskId:status[:note] observation (progress; repeatable)",
            })
            .option("blocker", {
              type: "string",
              array: true,
              describe: "taskId:reason external blocker (progress; repeatable)",
            })
            .option("criterion", {
              type: "string",
              array: true,
              describe: "taskId:criterion completion criterion (progress; repeatable)",
            })
            .option("input", {
              type: "string",
              describe: "bounded JSON input file as an alternate to explicit flags",
            }),
      )
      .command(
        sessionCommand,
        "List, inspect, resume, fork, rewind, or replay sessions.",
        (group) =>
          group
            .positional("action", {
              type: "string",
              choices: ["list", "show", "resume", "fork", "rewind", "replay"] as const,
              describe: "list, show, resume, fork, rewind, or replay a session",
            })
            .positional("id", {
              type: "string",
              describe: "session identity (required except list)",
            })
            .option("filter", {
              type: "string",
              choices: SESSION_CATALOG_FILTERS,
              default: "all" satisfies SessionCatalogFilter,
              describe: "catalog filter (list only)",
            })
            .option("search", {
              type: "string",
              describe: "title search (list only)",
            })
            .option("limit", {
              type: "number",
              describe: `maximum listed sessions (default ${DEFAULT_SESSION_LIST_LIMIT}, max ${MAX_SESSION_CATALOG})`,
            })
            .option("workspace-id", {
              type: "string",
              describe: "bound workspace identity (default: cli)",
            })
            .option("after-sequence", {
              type: "number",
              describe: "resume cursor after this sequence (resume only)",
            })
            .option("schema-generation", {
              type: "number",
              describe: "resume cursor schema generation (resume only; default 1)",
            })
            .option("at-turn", {
              type: "string",
              describe: "turn identity to rewind to (rewind only)",
            })
            .option("new-session-id", {
              type: "string",
              describe: "identity for the forked session (fork/rewind)",
            })
            .option("new-stream-id", {
              type: "string",
              describe: "stream identity for the forked session (fork/rewind)",
            })
            .option("replay-action", {
              type: "string",
              choices: SESSION_REPLAY_ACTIONS,
              default: "play" satisfies SessionReplayAction,
              describe: "replay control verb (replay only)",
            })
            .option("seek-sequence", {
              type: "number",
              describe: "sequence to seek to (replay --replay-action seek)",
            }),
      )
      .command(artifactCommand, "List, inspect, or retrieve stored artifacts.", (group) =>
        group
          .positional("action", {
            type: "string",
            choices: ["list", "show", "get"] as const,
            describe: "list matching artifacts, show metadata, or retrieve bytes",
          })
          .positional("id", {
            type: "string",
            describe: "artifact identity (required with show and get)",
          })
          .option("limit", {
            type: "number",
            describe: `maximum listed artifacts (default ${DEFAULT_ARTIFACT_LIST_LIMIT}, max ${MAX_ARTIFACT_CATALOG})`,
          })
          .option("output", {
            type: "string",
            describe: "destination path for get (default: stdout when not a terminal)",
          }),
      )
      .command(
        workspaceCommand,
        "List, show, save, or load multi-root workspace layouts.",
        (group) =>
          group
            .positional("action", {
              type: "string",
              choices: ["list", "show", "save", "load"] as const,
              describe: "list saved layouts, show the current set, save, or load",
            })
            .positional("name", {
              type: "string",
              describe: "layout name (required with save and load)",
            })
            .option("limit", {
              type: "number",
              describe: `maximum listed layouts (default ${DEFAULT_WORKSPACE_LAYOUT_LIST_LIMIT}, max ${MAX_WORKSPACE_LAYOUT_CATALOG})`,
            })
            .option("force", {
              type: "boolean",
              default: false,
              describe: "overwrite an existing saved layout (save only)",
            }),
      )
      .option("format", {
        type: "string",
        choices: OUTPUT_FORMATS,
        default: "human" satisfies OutputFormat,
        describe: "Output contract for the result",
      })
      .option("color", {
        type: "string",
        choices: COLOR_CHOICES,
        default: "auto" satisfies ColorChoice,
        describe: "Override the detected colour capability",
      })
      .option("no-color", {
        type: "boolean",
        default: false,
        describe: `Alias for --color never`,
      })
      .option("quiet", {
        type: "boolean",
        alias: "q",
        default: false,
        describe: "Lower diagnostics to errors only (diagnostics.level)",
      })
      .option("verbose", {
        type: "boolean",
        alias: "v",
        default: false,
        describe: "Raise diagnostics to debug (diagnostics.level)",
      })
      .option("non-interactive", {
        type: "boolean",
        default: false,
        describe: "Never prompt; fail instead of waiting for input",
      })
      .option("workspace", {
        type: "string",
        describe: "Workspace directory or saved layout name (default: current directory)",
      })
      .option("add-dir", {
        type: "string",
        array: true,
        nargs: 1,
        describe: "Extra workspace root for this invocation (repeatable)",
      })
      .option("profile", {
        type: "string",
        describe: "Configuration profile to layer over the project settings",
      })
      .option("timeout", {
        type: "number",
        describe: "Total deadline for this invocation, in milliseconds",
      })
      .option("help", { type: "boolean", alias: "h", default: false, describe: "Show help" })
      .option("version", { type: "boolean", default: false, describe: "Show version information" })
      .fail((message, error) => {
        // Throws rather than records. With `exitProcess(false)` a recording
        // handler lets `parse` resolve and the invalid invocation continues.
        throw error ?? new Error(message);
      })
  );
}

/** The help text for the root, or for one subcommand. */
export async function helpText(topic: string | null): Promise<string> {
  const parser = build(topic === null ? [] : [topic, "--help"]);
  return parser.getHelp();
}

/**
 * Parses an argument vector into an invocation, or reports why it is not one.
 *
 * Never throws, never writes, never exits. Every failure — yargs' own and this
 * module's conflict rules — comes back as `invalid` so one caller maps all of
 * them onto one exit code.
 */
export async function parseInvocation(argv: readonly string[]): Promise<Invocation> {
  // Answered before the tree parses, because a group that demands a
  // subcommand rejects `falryn config --help` for the missing positional —
  // and a request for help is not an invocation of the thing it asks about.
  // The remaining flags are still parsed and still validated, so
  // `--format bogus --help` is invalid usage rather than silent help.
  if (argv.some((token) => token === "--help" || token === "-h")) {
    const forHelp = await parseForHelp(argv);
    return forHelp.kind === "invalid"
      ? forHelp
      : { kind: "help", topic: forHelp.topic, options: forHelp.options };
  }

  let parsed: RawArguments;
  try {
    const candidate: unknown = await build(argv).parse();
    if (!isRawArguments(candidate)) {
      return { kind: "invalid", message: "The argument parser returned an invalid result." };
    }
    parsed = candidate;
  } catch (error) {
    return { kind: "invalid", message: messageOf(error) };
  }

  const conflict = conflictIn(parsed);
  if (conflict !== null) {
    return { kind: "invalid", message: conflict };
  }

  const options = optionsFrom(parsed);
  const positional = parsed._.map(String);

  // Checked before the command, because `falryn config --help` is a request for
  // that subcommand's help rather than a run of it.
  if (options.help) {
    return { kind: "help", topic: positional[0] ?? null, options };
  }
  if (options.version) {
    return { kind: "version", options };
  }

  const command = commandFrom(positional, parsed.action ?? null);
  if (command === null) {
    return { kind: "invalid", message: `Unknown command: ${positional.join(" ")}` };
  }
  const data = dataArgumentsFor(command, parsed);
  if (typeof data === "string") {
    return { kind: "invalid", message: data };
  }
  const dataLifecycleArgs = dataLifecycleArgumentsFor(command, parsed);
  if (typeof dataLifecycleArgs === "string") {
    return { kind: "invalid", message: dataLifecycleArgs };
  }
  const exportArgs = exportArgumentsFor(command, parsed);
  if (typeof exportArgs === "string") {
    return { kind: "invalid", message: exportArgs };
  }
  const importArgs = importArgumentsFor(command, parsed);
  if (typeof importArgs === "string") {
    return { kind: "invalid", message: importArgs };
  }
  const replayArgs = replayArgumentsFor(command, parsed);
  if (typeof replayArgs === "string") {
    return { kind: "invalid", message: replayArgs };
  }
  const sessionArgs = sessionArgumentsFor(command, parsed);
  if (typeof sessionArgs === "string") {
    return { kind: "invalid", message: sessionArgs };
  }
  const artifactArgs = artifactArgumentsFor(command, parsed);
  if (typeof artifactArgs === "string") {
    return { kind: "invalid", message: artifactArgs };
  }
  const workspaceArgs = workspaceArgumentsFor(command, parsed);
  if (typeof workspaceArgs === "string") {
    return { kind: "invalid", message: workspaceArgs };
  }
  const runArgs = runArgumentsFor(command, parsed);
  let taskArgs: TaskCommandArguments | null = null;
  if (command === "task.decompose" || command === "task.validate" || command === "task.progress") {
    const action =
      command === "task.decompose"
        ? "decompose"
        : command === "task.validate"
          ? "validate"
          : "progress";
    let inputText: string | null = null;
    if (parsed.input !== undefined) {
      const loaded = await loadTaskInputFile(parsed.input);
      if (!loaded.ok) {
        return { kind: "invalid", message: loaded.error };
      }
      inputText = loaded.value;
    }
    const built = taskArgumentsFor(action, parsed, inputText);
    if (typeof built === "string") {
      return { kind: "invalid", message: built };
    }
    taskArgs = built;
  }
  const commitPlanArgs = command === "task.commit-plan" ? taskCommitPlanArgumentsFor(parsed) : null;
  if (typeof commitPlanArgs === "string") {
    return { kind: "invalid", message: commitPlanArgs };
  }
  return {
    kind: "run",
    command,
    options,
    data,
    dataLifecycleArgs,
    exportArgs,
    importArgs,
    replayArgs,
    sessionArgs,
    artifactArgs,
    workspaceArgs,
    runArgs,
    taskArgs,
    commitPlanArgs,
  };
}

async function loadTaskInputFile(
  pathText: string,
): Promise<
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string }
> {
  const parsed = parseLocalPath(pathText);
  if (!parsed.ok) {
    return { ok: false, error: "Argument input must be a local path." };
  }
  const read = await createHostFileSystem().readText(parsed.value, MAX_TASK_INPUT_FILE_BYTES);
  if (!read.ok) {
    return { ok: false, error: "Argument input must name a readable JSON file." };
  }
  return { ok: true, value: read.value };
}

/**
 * Parses an argument vector that carries no command.
 *
 * Used only for a help request, where the command demand must not fire but the
 * flags around it still have to be valid.
 */
async function parseForHelp(
  argv: readonly string[],
): Promise<
  | { kind: "ok"; topic: string | null; options: GlobalOptions }
  | { kind: "invalid"; message: string }
> {
  try {
    const candidate: unknown = await build(argv, true).parse();
    if (!isRawArguments(candidate)) {
      return { kind: "invalid", message: "The argument parser returned an invalid result." };
    }
    const parsed = candidate;
    const conflict = conflictIn(parsed);
    if (conflict !== null) {
      return { kind: "invalid", message: conflict };
    }
    // The topic comes from the parsed positionals, never from scanning the raw
    // vector: a bare word in `--format json --help` is an option's value, and a
    // scan would report `json` as a subcommand that does not exist.
    const topic = parsed._.map(String)[0] ?? null;
    return { kind: "ok", topic, options: optionsFrom(parsed) };
  } catch (error) {
    return { kind: "invalid", message: messageOf(error) };
  }
}

function isRawArguments(value: unknown): value is RawArguments {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const field = (key: PropertyKey): unknown => Reflect.get(value, key);
  const positional = field("_");
  const classes = field("class");
  const sessions = field("session");
  return (
    Array.isArray(positional) &&
    positional.every((item) => typeof item === "string" || typeof item === "number") &&
    optionalString(field("action")) &&
    (classes === undefined ||
      (Array.isArray(classes) && classes.every((item) => typeof item === "string"))) &&
    optionalString(field("confirm")) &&
    (sessions === undefined ||
      (Array.isArray(sessions) && sessions.every((item) => typeof item === "string"))) &&
    optionalString(field("after")) &&
    optionalString(field("before")) &&
    optionalString(field("name")) &&
    optionalBoolean(field("write")) &&
    optionalBoolean(field("include-sensitive")) &&
    optionalString(field("id")) &&
    optionalString(field("filter")) &&
    optionalString(field("search")) &&
    (field("limit") === undefined || typeof field("limit") === "number") &&
    optionalString(field("workspace-id")) &&
    (field("after-sequence") === undefined || typeof field("after-sequence") === "number") &&
    (field("schema-generation") === undefined || typeof field("schema-generation") === "number") &&
    optionalString(field("at-turn")) &&
    optionalString(field("new-session-id")) &&
    optionalString(field("new-stream-id")) &&
    optionalString(field("replay-action")) &&
    (field("seek-sequence") === undefined || typeof field("seek-sequence") === "number") &&
    optionalString(field("output")) &&
    optionalBoolean(field("force")) &&
    (field("add-dir") === undefined ||
      (Array.isArray(field("add-dir")) &&
        (field("add-dir") as unknown[]).every((item) => typeof item === "string"))) &&
    (field("prompt") === undefined ||
      (Array.isArray(field("prompt")) &&
        (field("prompt") as unknown[]).every((item) => typeof item === "string"))) &&
    optionalString(field("brief")) &&
    optionalString(field("statement")) &&
    optionalString(field("outcome-id")) &&
    optionalString(field("task-id")) &&
    (field("scope") === undefined ||
      (Array.isArray(field("scope")) &&
        (field("scope") as unknown[]).every((item) => typeof item === "string"))) &&
    optionalString(field("cwd")) &&
    (field("goal") === undefined ||
      (Array.isArray(field("goal")) &&
        (field("goal") as unknown[]).every((item) => typeof item === "string"))) &&
    (field("non-goal") === undefined ||
      (Array.isArray(field("non-goal")) &&
        (field("non-goal") as unknown[]).every((item) => typeof item === "string"))) &&
    (field("proposed") === undefined ||
      (Array.isArray(field("proposed")) &&
        (field("proposed") as unknown[]).every((item) => typeof item === "string"))) &&
    (field("task") === undefined ||
      (Array.isArray(field("task")) &&
        (field("task") as unknown[]).every((item) => typeof item === "string"))) &&
    (field("depends") === undefined ||
      (Array.isArray(field("depends")) &&
        (field("depends") as unknown[]).every((item) => typeof item === "string"))) &&
    (field("observe") === undefined ||
      (Array.isArray(field("observe")) &&
        (field("observe") as unknown[]).every((item) => typeof item === "string"))) &&
    (field("blocker") === undefined ||
      (Array.isArray(field("blocker")) &&
        (field("blocker") as unknown[]).every((item) => typeof item === "string"))) &&
    (field("criterion") === undefined ||
      (Array.isArray(field("criterion")) &&
        (field("criterion") as unknown[]).every((item) => typeof item === "string"))) &&
    optionalString(field("input")) &&
    typeof field("format") === "string" &&
    typeof field("color") === "string" &&
    typeof field("quiet") === "boolean" &&
    typeof field("verbose") === "boolean" &&
    typeof field("non-interactive") === "boolean" &&
    typeof field("no-color") === "boolean" &&
    optionalString(field("workspace")) &&
    optionalString(field("profile")) &&
    (field("timeout") === undefined || typeof field("timeout") === "number") &&
    typeof field("help") === "boolean" &&
    typeof field("version") === "boolean"
  );
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

/** The command a positional vector names, or `null` when it names none. */
function commandFrom(positional: readonly string[], action: string | null): RunnableCommand | null {
  const [group] = positional;
  if (group === undefined) {
    // The no-argument invocation. `src/cli/dispatch.ts` decides from observed
    // facts whether it opens the shell or falls back to help, and this module
    // does not know the difference — parsing names the command, nothing more.
    return "default";
  }
  if (group === "doctor") {
    return action === null ? "doctor" : null;
  }
  if (group === "run") {
    // Remaining positionals are the prompt; there is no nested action.
    return "run";
  }
  if (group === "export") {
    return action === null ? "export" : null;
  }
  if (group === "import") {
    return action === null ? "import" : null;
  }
  if (group === "replay") {
    return action === null ? "replay" : null;
  }
  if (group === "task") {
    switch (action) {
      case "decompose":
        return "task.decompose";
      case "validate":
        return "task.validate";
      case "progress":
        return "task.progress";
      case "commit-plan":
        return "task.commit-plan";
      default:
        return null;
    }
  }
  if (group === "config") {
    switch (action) {
      case "show":
        return "config.show";
      case "validate":
        return "config.validate";
      case "path":
        return "config.path";
      default:
        return null;
    }
  }
  if (group === "data") {
    switch (action) {
      case "reset":
        return "data.reset";
      case "uninstall":
        return "data.uninstall";
      case "backup":
        return "data.backup";
      case "restore":
        return "data.restore";
      case "inspect":
        return "data.inspect";
      case "diagnostics":
        return "data.diagnostics";
      case "retention":
        return "data.retention";
      case "gc":
        return "data.gc";
      default:
        return null;
    }
  }
  if (group === "session") {
    switch (action) {
      case "list":
        return "session.list";
      case "show":
        return "session.show";
      case "resume":
        return "session.resume";
      case "fork":
        return "session.fork";
      case "rewind":
        return "session.rewind";
      case "replay":
        return "session.replay";
      default:
        return null;
    }
  }
  if (group === "artifact") {
    switch (action) {
      case "list":
        return "artifact.list";
      case "show":
        return "artifact.show";
      case "get":
        return "artifact.get";
      default:
        return null;
    }
  }
  if (group === "workspace") {
    switch (action) {
      case "list":
        return "workspace.list";
      case "show":
        return "workspace.show";
      case "save":
        return "workspace.save";
      case "load":
        return "workspace.load";
      default:
        return null;
    }
  }
  return null;
}

function runArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): CodingRunArguments | null {
  if (command !== "run") {
    return null;
  }
  // yargs puts `run [prompt..]` into `prompt`, not into `_`.
  const brief = parsed.brief;
  if (brief !== undefined) {
    return {
      promptParts: parsed.prompt ?? [],
      brief: brief as "compact" | "balanced" | "detailed" | "auto",
    };
  }
  return { promptParts: parsed.prompt ?? [] };
}

function dataArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): DataCommandArguments | null | string {
  if (command !== "data.reset" && command !== "data.uninstall") {
    return null;
  }

  if (parsed.name !== undefined) {
    return "Argument name is only valid with data backup, restore, or inspect.";
  }

  const classes = parsed.class ?? [];
  if (command === "data.reset" && classes.length === 0) {
    return "Argument class is required for data reset; name at least one ownership class.";
  }
  if (command === "data.uninstall" && classes.length > 0) {
    return "Argument class is only valid with data reset.";
  }
  const ownershipClasses: OwnershipClass[] = [];
  for (const ownershipClass of classes) {
    if (!isOwnershipClass(ownershipClass)) {
      return "Argument class must name a declared Falryn ownership class.";
    }
    ownershipClasses.push(ownershipClass);
  }
  if (parsed.confirm !== undefined && !isPlanId(parsed.confirm)) {
    return "Argument confirm must be a removal plan identity from a prior preview.";
  }
  return { classes: ownershipClasses, confirmation: parsed.confirm ?? null };
}

function dataLifecycleArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): DataLifecycleArguments | null | string {
  if (
    command !== "data.backup" &&
    command !== "data.restore" &&
    command !== "data.inspect" &&
    command !== "data.diagnostics" &&
    command !== "data.retention" &&
    command !== "data.gc"
  ) {
    return null;
  }

  if ((parsed.class?.length ?? 0) > 0) {
    return "Argument class is only valid with data reset.";
  }

  if (command === "data.retention") {
    if (parsed.name !== undefined) {
      return "Argument name is only valid with data backup, restore, or inspect.";
    }
    if (parsed.confirm !== undefined) {
      return "Argument confirm is only valid with data reset, restore, or gc.";
    }
    if ((parsed["pinned-session"]?.length ?? 0) > 0) {
      return "Argument pinned-session is only valid with data gc.";
    }
    return { action: "retention" };
  }

  if (command === "data.gc") {
    if (parsed.name !== undefined) {
      return "Argument name is only valid with data backup, restore, or inspect.";
    }
    let confirmation: GcPlanId | null = null;
    if (parsed.confirm !== undefined) {
      if (!isGcPlanId(parsed.confirm)) {
        return "Argument confirm must be a garbage-collection plan identity from a prior preview.";
      }
      confirmation = parsed.confirm;
    }
    return {
      action: "gc",
      confirmation,
      pinnedSessions: parsed["pinned-session"] ?? [],
    };
  }

  if ((parsed["pinned-session"]?.length ?? 0) > 0) {
    return "Argument pinned-session is only valid with data gc.";
  }

  if (command === "data.diagnostics") {
    if (parsed.name !== undefined) {
      return "Argument name is only valid with data backup, restore, or inspect.";
    }
    if (parsed.confirm !== undefined) {
      return "Argument confirm is only valid with data reset, restore, or gc.";
    }
    return { action: "diagnostics" };
  }

  if (parsed.name === undefined) {
    return "Argument name is required for data backup, restore, and inspect.";
  }
  const parsedName = backupName.parse(parsed.name);
  if (!parsedName.ok) {
    return "Argument name must be a file-safe backup name.";
  }

  if (command === "data.backup") {
    if (parsed.confirm !== undefined) {
      return "Argument confirm is only valid with data reset or restore.";
    }
    return { action: "backup", name: parsedName.value };
  }

  if (command === "data.inspect") {
    if (parsed.confirm !== undefined) {
      return "Argument confirm is only valid with data reset or restore.";
    }
    return { action: "inspect", name: parsedName.value };
  }

  let confirmation: BackupName | null = null;
  if (parsed.confirm !== undefined) {
    const parsedConfirm = backupName.parse(parsed.confirm);
    if (!parsedConfirm.ok) {
      return "Argument confirm must be the backup name from a prior restore preview.";
    }
    confirmation = parsedConfirm.value;
  }
  return { action: "restore", name: parsedName.value, confirmation };
}

function exportArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): ExportCommandArguments | null | string {
  if (command !== "export") {
    return null;
  }

  const sessionValues = parsed.session ?? [];
  const hasSessions = sessionValues.length > 0;
  const hasRange = parsed.after !== undefined || parsed.before !== undefined;
  if (hasSessions && hasRange) {
    return "Arguments session and after/before are mutually exclusive: choose session identities or a time range.";
  }
  if (!hasSessions && !hasRange) {
    return "Export requires --session, or a --after/--before range.";
  }

  const write = parsed.write === true;
  if (write && parsed.name === undefined) {
    return "Argument name is required with --write.";
  }
  if (!write && parsed.name !== undefined) {
    return "Argument name is only valid with --write.";
  }

  let name: ExportName | null = null;
  if (parsed.name !== undefined) {
    const parsedName = exportName.parse(parsed.name);
    if (!parsedName.ok) {
      return "Argument name must be a file-safe export package name.";
    }
    name = parsedName.value;
  }

  const includeSensitive = parsed["include-sensitive"] === true;

  if (hasSessions) {
    const sessionIds: SessionId[] = [];
    for (const value of sessionValues) {
      const parsedId = sessionId.parse(value);
      if (!parsedId.ok) {
        return "Argument session must be a session identity.";
      }
      sessionIds.push(parsedId.value);
    }
    return {
      selection: { kind: "sessions", sessionIds, includeSensitive },
      write,
      name,
    };
  }

  const startedAfter = parsed.after === undefined ? null : parseTimestamp(parsed.after);
  if (startedAfter !== null && !startedAfter.ok) {
    return "Argument after must be a canonical UTC timestamp (YYYY-MM-DDTHH:MM:SS.sssZ).";
  }
  const startedBefore = parsed.before === undefined ? null : parseTimestamp(parsed.before);
  if (startedBefore !== null && !startedBefore.ok) {
    return "Argument before must be a canonical UTC timestamp (YYYY-MM-DDTHH:MM:SS.sssZ).";
  }

  return {
    selection: {
      kind: "range",
      startedAfter: startedAfter === null ? null : startedAfter.value,
      startedBefore: startedBefore === null ? null : startedBefore.value,
      includeSensitive,
    },
    write,
    name,
  };
}

function importArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): ImportCommandArguments | null | string {
  if (command !== "import") {
    return null;
  }
  if (
    (parsed.session !== undefined && parsed.session.length > 0) ||
    parsed.after !== undefined ||
    parsed.before !== undefined ||
    parsed.write === true ||
    parsed["include-sensitive"] === true
  ) {
    return "Import accepts only a package name.";
  }
  if (parsed.name === undefined) {
    return "Import requires a package name.";
  }
  const parsedName = exportName.parse(parsed.name);
  if (!parsedName.ok) {
    return "Argument name must be a file-safe export package name.";
  }
  return { name: parsedName.value };
}

function replayArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): ReplayCommandArguments | null | string {
  if (command !== "replay") {
    return null;
  }
  if (parsed.id === undefined) {
    return "Argument id is required for replay.";
  }
  const parsedId = sessionId.parse(parsed.id);
  if (!parsedId.ok) {
    return "Argument id must be a session identity.";
  }
  if (parsed["replay-action"] !== undefined && parsed["replay-action"] !== "play") {
    return "Replay does not accept replay control flags; use `falryn session replay` instead.";
  }
  return { sessionId: parsedId.value };
}

function sessionArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): SessionCommandArguments | null | string {
  if (
    command !== "session.list" &&
    command !== "session.show" &&
    command !== "session.resume" &&
    command !== "session.fork" &&
    command !== "session.rewind" &&
    command !== "session.replay"
  ) {
    return null;
  }

  const bound = parsed["workspace-id"] ?? "cli";
  const parsedWorkspace = workspaceId.parse(bound);
  if (!parsedWorkspace.ok) {
    return "Argument workspace-id must be a workspace identity.";
  }

  const listOnly =
    (parsed.filter !== undefined && parsed.filter !== "all") ||
    parsed.search !== undefined ||
    parsed.limit !== undefined;
  if (command !== "session.list" && listOnly) {
    return "Arguments filter, search, and limit are only valid with session list.";
  }

  if (command === "session.list") {
    if (parsed.id !== undefined) {
      return "Argument id is only valid with session show, resume, fork, rewind, or replay.";
    }
    const filter = parsed.filter ?? "all";
    if (!(SESSION_CATALOG_FILTERS as readonly string[]).includes(filter)) {
      return "Argument filter must be one of: all, open, closed, pinned.";
    }
    const limit = parsed.limit ?? DEFAULT_SESSION_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SESSION_CATALOG) {
      return `Argument limit must be a whole number from 1 to ${MAX_SESSION_CATALOG}.`;
    }
    return {
      action: "list",
      workspaceId: parsedWorkspace.value,
      filter: filter as SessionCatalogFilter,
      search: parsed.search,
      limit,
    };
  }

  if (parsed.id === undefined) {
    return `Argument id is required for session ${command.slice("session.".length)}.`;
  }
  const parsedId = sessionId.parse(parsed.id);
  if (!parsedId.ok) {
    return "Argument id must be a session identity.";
  }

  if (command === "session.show") {
    return { action: "show", workspaceId: parsedWorkspace.value, sessionId: parsedId.value };
  }

  if (command === "session.resume") {
    const afterSequence = parsed["after-sequence"] ?? null;
    if (afterSequence !== null && (!Number.isInteger(afterSequence) || afterSequence < 0)) {
      return "Argument after-sequence must be a whole number >= 0.";
    }
    const schemaGeneration = parsed["schema-generation"] ?? TERMINAL_OUTCOME_PROJECTION_GENERATION;
    if (!Number.isInteger(schemaGeneration) || schemaGeneration < 1) {
      return "Argument schema-generation must be a whole number >= 1.";
    }
    return {
      action: "resume",
      workspaceId: parsedWorkspace.value,
      sessionId: parsedId.value,
      afterSequence,
      schemaGeneration,
    };
  }

  if (command === "session.fork" || command === "session.rewind") {
    let newSessionId: SessionId | undefined;
    if (parsed["new-session-id"] !== undefined) {
      const parsedNew = sessionId.parse(parsed["new-session-id"]);
      if (!parsedNew.ok) {
        return "Argument new-session-id must be a session identity.";
      }
      newSessionId = parsedNew.value;
    }
    let newStreamId: StreamId | undefined;
    if (parsed["new-stream-id"] !== undefined) {
      const parsedStream = streamId.parse(parsed["new-stream-id"]);
      if (!parsedStream.ok) {
        return "Argument new-stream-id must be a stream identity.";
      }
      newStreamId = parsedStream.value;
    }
    if (command === "session.fork") {
      if (parsed["at-turn"] !== undefined) {
        return "Argument at-turn is only valid with session rewind.";
      }
      return {
        action: "fork",
        workspaceId: parsedWorkspace.value,
        sessionId: parsedId.value,
        newSessionId,
        newStreamId,
      };
    }
    if (parsed["at-turn"] === undefined || parsed["at-turn"].length === 0) {
      return "Argument at-turn is required for session rewind.";
    }
    return {
      action: "rewind",
      workspaceId: parsedWorkspace.value,
      sessionId: parsedId.value,
      atTurnId: parsed["at-turn"],
      newSessionId,
      newStreamId,
    };
  }

  const replayAction = parsed["replay-action"] ?? "play";
  if (!(SESSION_REPLAY_ACTIONS as readonly string[]).includes(replayAction)) {
    return "Argument replay-action must be one of: play, pause, step, seek.";
  }
  if (replayAction === "seek") {
    const seekSequence = parsed["seek-sequence"];
    if (seekSequence === undefined || !Number.isInteger(seekSequence) || seekSequence < 0) {
      return "Argument seek-sequence is required for replay --replay-action seek.";
    }
    return {
      action: "replay",
      workspaceId: parsedWorkspace.value,
      sessionId: parsedId.value,
      replayCommand: { kind: "seek", sequence: seekSequence },
    };
  }
  return {
    action: "replay",
    workspaceId: parsedWorkspace.value,
    sessionId: parsedId.value,
    replayCommand: { kind: replayAction as Exclude<SessionReplayAction, "seek"> },
  };
}

function artifactArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): ArtifactCommandArguments | null | string {
  if (command !== "artifact.list" && command !== "artifact.show" && command !== "artifact.get") {
    return null;
  }

  if (command === "artifact.list") {
    if (parsed.id !== undefined) {
      return "Argument id is only valid with artifact show or get.";
    }
    if (parsed.output !== undefined) {
      return "Argument output is only valid with artifact get.";
    }
    const limit = parsed.limit ?? DEFAULT_ARTIFACT_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ARTIFACT_CATALOG) {
      return `Argument limit must be a whole number from 1 to ${MAX_ARTIFACT_CATALOG}.`;
    }
    return { action: "list", limit };
  }

  if (parsed.limit !== undefined) {
    return "Argument limit is only valid with artifact list.";
  }

  if (parsed.id === undefined) {
    return "Argument id is required for artifact show and get.";
  }
  const parsedId = artifactId.parse(parsed.id);
  if (!parsedId.ok) {
    return "Argument id must be an artifact identity.";
  }

  if (command === "artifact.show") {
    if (parsed.output !== undefined) {
      return "Argument output is only valid with artifact get.";
    }
    return { action: "show", artifactId: parsedId.value };
  }

  const outputPath = parsed.output ?? null;
  if (outputPath !== null) {
    const pathIssue = outputPathIssue(outputPath);
    if (pathIssue !== null) {
      return pathIssue;
    }
  }
  return { action: "get", artifactId: parsedId.value, outputPath };
}

function workspaceArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): WorkspaceCommandArguments | null | string {
  if (
    command !== "workspace.list" &&
    command !== "workspace.show" &&
    command !== "workspace.save" &&
    command !== "workspace.load"
  ) {
    return null;
  }

  if (command === "workspace.list") {
    if (parsed.name !== undefined) {
      return "Argument name is only valid with workspace save or load.";
    }
    if (parsed.force === true) {
      return "Argument force is only valid with workspace save.";
    }
    const limit = parsed.limit ?? DEFAULT_WORKSPACE_LAYOUT_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WORKSPACE_LAYOUT_CATALOG) {
      return `Argument limit must be a whole number from 1 to ${MAX_WORKSPACE_LAYOUT_CATALOG}.`;
    }
    return { action: "list", limit };
  }

  if (command === "workspace.show") {
    if (parsed.name !== undefined) {
      return "Argument name is only valid with workspace save or load.";
    }
    if (parsed.limit !== undefined) {
      return "Argument limit is only valid with workspace list.";
    }
    if (parsed.force === true) {
      return "Argument force is only valid with workspace save.";
    }
    return { action: "show" };
  }

  if (parsed.limit !== undefined) {
    return "Argument limit is only valid with workspace list.";
  }
  if (parsed.name === undefined) {
    return "Argument name is required for workspace save and load.";
  }
  if (!isLegalWorkspaceLayoutName(parsed.name)) {
    return "Argument name must be a legal layout name (same rule as --profile).";
  }

  if (command === "workspace.save") {
    return { action: "save", name: parsed.name, force: parsed.force === true };
  }

  if (parsed.force === true) {
    return "Argument force is only valid with workspace save.";
  }
  return { action: "load", name: parsed.name };
}

function outputPathIssue(value: string): string | null {
  const error = localPathTextError(value);
  if (error === null) {
    return null;
  }
  return error.code === "path-too-long"
    ? `Argument output: a destination path cannot exceed ${MAX_LOCAL_PATH_LENGTH} characters.`
    : "Argument output: the path contains a character that cannot appear in one.";
}

/**
 * The first conflicting combination, or `null` when there is none.
 *
 * Checked before dispatch, because `reference/CLI.md` requires incompatible
 * options to fail before application work. Each message names both flags, so
 * the reader does not have to guess which one to drop.
 */
function conflictIn(parsed: RawArguments): string | null {
  if (parsed.quiet && parsed.verbose) {
    return "Arguments quiet and verbose are mutually exclusive: they set diagnostics.level to different values.";
  }
  if (parsed["no-color"] && parsed.color === "always") {
    return "Arguments no-color and color are mutually exclusive.";
  }
  if (parsed.color === "always" && parsed.format !== "human") {
    return `Argument color: "always" is not valid with format: "${parsed.format}". Machine output never contains ANSI.`;
  }
  if (parsed.profile !== undefined && !isLegalProfileName(parsed.profile)) {
    // Validated against the configuration area's own rule, never a second one
    // written here.
    return `Argument profile: "${parsed.profile}" is not a legal profile name.`;
  }
  if (parsed.workspace !== undefined) {
    const issue = workspaceIssue(parsed.workspace);
    if (issue !== null) {
      return issue;
    }
  }
  for (const addDir of parsed["add-dir"] ?? []) {
    const issue = addDirIssue(addDir);
    if (issue !== null) {
      return issue;
    }
  }
  if (parsed.timeout !== undefined) {
    if (!Number.isInteger(parsed.timeout) || parsed.timeout <= 0) {
      return `Argument timeout: "${parsed.timeout}" must be a positive whole number of milliseconds.`;
    }
    if (parsed.timeout > MAX_TIMEOUT_MS) {
      return `Argument timeout: "${parsed.timeout}" exceeds the maximum of ${MAX_TIMEOUT_MS} ms.`;
    }
  }
  return null;
}

/**
 * Why a `--workspace` could never name a directory or layout, or `null` when it can.
 *
 * Relative is not a reason: `--workspace ./site` resolves against the current
 * directory in `src/cli/services.ts`. Layout names use the same character class
 * as profiles and never contain path separators.
 */
function workspaceIssue(value: string): string | null {
  if (value.trim() === "") {
    return "Argument workspace: a workspace root cannot be empty.";
  }
  if (isLegalWorkspaceLayoutName(value)) {
    return null;
  }
  const error = localPathTextError(value);
  if (error === null) {
    return null;
  }
  // The rejected text is never echoed; it is untrusted and may carry control
  // sequences, and the caller already knows what they typed.
  return error.code === "path-too-long"
    ? `Argument workspace: a workspace root cannot exceed ${MAX_LOCAL_PATH_LENGTH} characters.`
    : "Argument workspace: the path contains a character that cannot appear in one.";
}

function addDirIssue(value: string): string | null {
  if (value.trim() === "") {
    return "Argument add-dir: a workspace root cannot be empty.";
  }
  const error = localPathTextError(value);
  if (error === null) {
    return null;
  }
  return error.code === "path-too-long"
    ? `Argument add-dir: a workspace root cannot exceed ${MAX_LOCAL_PATH_LENGTH} characters.`
    : "Argument add-dir: the path contains a character that cannot appear in one.";
}

function optionsFrom(parsed: RawArguments): GlobalOptions {
  return {
    // Both are constrained by `choices`, so yargs has already refused anything
    // outside the union before this narrows it.
    format: parsed.format as OutputFormat,
    color: parsed["no-color"] ? "never" : (parsed.color as ColorChoice),
    quiet: parsed.quiet,
    verbose: parsed.verbose,
    nonInteractive: parsed["non-interactive"],
    workspace: parsed.workspace ?? null,
    addDirs: parsed["add-dir"] ?? [],
    profile: parsed.profile ?? null,
    timeoutMs: parsed.timeout ?? null,
    help: parsed.help,
    version: parsed.version,
  };
}

/**
 * A parse failure's text.
 *
 * yargs throws `YError` with a usable message; anything else is reported
 * structurally rather than by stringifying an unknown object into the output.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "The invocation could not be parsed.";
}
