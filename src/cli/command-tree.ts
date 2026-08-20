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
 * `run` or `provider` in `--help` would promise behavior nothing implements.
 */

import yargs from "yargs";

import { isLegalProfileName } from "../config/index.ts";
import {
  type ExportName,
  type ExportSelection,
  exportName,
  isOwnershipClass,
  isPlanId,
  localPathTextError,
  MAX_LOCAL_PATH_LENGTH,
  type OwnershipClass,
  type PlanId,
  parseTimestamp,
  type SessionId,
  sessionId,
} from "../domain/index.ts";
import {
  COLOR_CHOICES,
  type ColorChoice,
  type GlobalOptions,
  MAX_TIMEOUT_MS,
  OUTPUT_FORMATS,
  type OutputFormat,
} from "./options.ts";
import type { CommandId } from "./result.ts";

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

/** Command-specific inputs for `falryn export`. */
export type ExportCommandArguments = {
  readonly selection: ExportSelection;
  readonly write: boolean;
  readonly name: ExportName | null;
};

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
      readonly exportArgs: ExportCommandArguments | null;
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
  readonly session: readonly string[] | undefined;
  readonly after: string | undefined;
  readonly before: string | undefined;
  readonly name: string | undefined;
  readonly write: boolean | undefined;
  readonly "include-sensitive": boolean | undefined;
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
  const dataCommand = lenientPositionals ? "data [action]" : "data <action>";
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
      .command(dataCommand, "Preview or remove Falryn-owned local data.", (group) =>
        group
          .positional("action", {
            type: "string",
            choices: ["reset", "uninstall"] as const,
            describe: "selectively reset classes, or uninstall registered local data",
          })
          .option("class", {
            type: "string",
            array: true,
            describe: "ownership class to include in a reset (repeatable)",
          })
          .option("confirm", {
            type: "string",
            describe: "execute only the exact removal plan identity previously previewed",
          }),
      )
      .command("doctor", "Run bounded environment and storage diagnostics.", (group) => group)
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
        describe: "Workspace root to operate on (default: current directory)",
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
  const exportArgs = exportArgumentsFor(command, parsed);
  if (typeof exportArgs === "string") {
    return { kind: "invalid", message: exportArgs };
  }
  return { kind: "run", command, options, data, exportArgs };
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
  if (group === "export") {
    return action === null ? "export" : null;
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
      default:
        return null;
    }
  }
  return null;
}

function dataArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): DataCommandArguments | null | string {
  if (command !== "data.reset" && command !== "data.uninstall") {
    return null;
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
 * Why a `--workspace` could never name a directory, or `null` when it can.
 *
 * Relative is not a reason: `--workspace ./site` resolves against the current
 * directory in `src/cli/services.ts`. What is refused here is text no
 * resolution can rescue — and it is refused rather than resolved to "no
 * workspace", because a run that silently drops the project configuration layer
 * answers a different question than the one asked, which is the same reason a
 * mistyped key in a file is reported instead of ignored.
 */
function workspaceIssue(value: string): string | null {
  if (value.trim() === "") {
    return "Argument workspace: a workspace root cannot be empty.";
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
