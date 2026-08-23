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

import {
  DEFAULT_ARTIFACT_LIST_LIMIT,
  DEFAULT_SESSION_LIST_LIMIT,
  DEFAULT_WORKSPACE_LAYOUT_LIST_LIMIT,
  MAX_ARTIFACT_CATALOG,
  MAX_SESSION_CATALOG,
  MAX_WORKSPACE_LAYOUT_CATALOG,
  parseLocalPath,
  SESSION_CATALOG_FILTERS,
  type SessionCatalogFilter,
} from "../domain/index.ts";
import { createHostFileSystem } from "../integrations/index.ts";
import {
  COLOR_CHOICES,
  type ColorChoice,
  type GlobalOptions,
  OUTPUT_FORMATS,
  type OutputFormat,
} from "./options.ts";
import { taskCommitPlanArgumentsFor } from "./task-commit-plan-commands.ts";
import { MAX_TASK_INPUT_FILE_BYTES, taskArgumentsFor } from "./task-intelligence-parse.ts";

/** The name the tree reports itself as, whatever the executable is called. */

import { artifactArgumentsFor, workspaceArgumentsFor } from "./command-tree/catalog.ts";
import {
  type Invocation,
  type RawArguments,
  SCRIPT_NAME,
  SESSION_REPLAY_ACTIONS,
  type SessionReplayAction,
  type TaskCommandArguments,
} from "./command-tree/contracts.ts";
import { dataArgumentsFor, dataLifecycleArgumentsFor } from "./command-tree/data.ts";
import {
  commandFrom,
  completionArgumentsFor,
  configSetArgumentsFor,
  runArgumentsFor,
} from "./command-tree/routing.ts";
import { sessionArgumentsFor } from "./command-tree/session.ts";
import {
  exportArgumentsFor,
  importArgumentsFor,
  replayArgumentsFor,
} from "./command-tree/transfer.ts";
import { conflictIn, isRawArguments, messageOf, optionsFrom } from "./command-tree/validation.ts";

export * from "./command-tree/contracts.ts";

function build(argv: readonly string[], lenientPositionals = false): ReturnType<typeof yargs> {
  // `config <action>` demands its subcommand; `config [action]` does not. The
  // lenient form exists for one reason: a help request must not be rejected
  // for omitting the very thing it is asking about.
  const configCommand = lenientPositionals
    ? "config [action] [key] [value]"
    : "config <action> [key] [value]";
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
        group
          .positional("action", {
            type: "string",
            choices: ["show", "validate", "path", "set"] as const,
            describe: "show the effective values, validate them, print source paths, or set a key",
          })
          .positional("key", {
            type: "string",
            describe: "configuration key path (set only)",
          })
          .positional("value", {
            type: "string",
            describe: "value to write (set only)",
          })
          .option("file-scope", {
            type: "string",
            choices: ["user", "project", "profile"] as const,
            describe: "which configuration file to write (set only; default user)",
          })
          .option("revision", {
            type: "string",
            describe: "expected file revision before write (set only)",
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
      .command("completion <shell>", "Print a shell completion script for installation.", (group) =>
        group.positional("shell", {
          type: "string",
          choices: ["bash", "zsh", "fish"] as const,
          describe: "target shell (bash, zsh, or fish)",
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

  const command = commandFrom(positional, parsed.action ?? null, parsed.shell);
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
  const configSetArgs = configSetArgumentsFor(command, parsed);
  if (typeof configSetArgs === "string") {
    return { kind: "invalid", message: configSetArgs };
  }
  const completionArgs = completionArgumentsFor(command, parsed);
  if (typeof completionArgs === "string") {
    return { kind: "invalid", message: completionArgs };
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
    configSetArgs,
    completionArgs,
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
