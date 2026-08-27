/** Raw parser validation, global option conflicts, and error projection. */

import { isLegalProfileName } from "../../config/index.ts";
import {
  isLegalWorkspaceLayoutName,
  localPathTextError,
  MAX_LOCAL_PATH_LENGTH,
} from "../../domain/index.ts";
import {
  type ColorChoice,
  type GlobalOptions,
  MAX_TIMEOUT_MS,
  type OutputFormat,
} from "../options.ts";

import type { RawArguments } from "./contracts.ts";

export function isRawArguments(value: unknown): value is RawArguments {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const field = (key: PropertyKey): unknown => Reflect.get(value, key);
  const positional = field("_");
  const classes = field("class");
  const sessions = field("session");
  const models = field("model");
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
    optionalString(field("mode")) &&
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
    optionalString(field("provider")) &&
    optionalString(field("adapter")) &&
    optionalString(field("endpoint")) &&
    (models === undefined ||
      (Array.isArray(models) && models.every((item) => typeof item === "string"))) &&
    optionalString(field("discovery")) &&
    optionalString(field("organization")) &&
    optionalString(field("project")) &&
    (field("connect-timeout") === undefined || typeof field("connect-timeout") === "number") &&
    (field("request-timeout") === undefined || typeof field("request-timeout") === "number") &&
    optionalString(field("auth-method")) &&
    optionalBoolean(field("api-key-stdin")) &&
    optionalString(field("account-label")) &&
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

export function conflictIn(parsed: RawArguments): string | null {
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

export function optionsFrom(parsed: RawArguments): GlobalOptions {
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
export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "The invocation could not be parsed.";
}
