/** Command identity and ordered rule selection for Hush. */

import type { CommandRequest } from "../../process.ts";
import { commandMode } from "../../process.ts";
import type { ProcessCaptureReport, ProcessStreamCapture } from "../../process-capture.ts";
import { assertNever } from "../../result.ts";
import type { HushCommandIdentity, HushFamily } from "../contracts.ts";
import {
  GENERIC_RULE,
  type HushCommandClassification,
  type HushReductionRule,
  matchHushCommand,
  OUTPUT_GIT_DIFF_RULE,
  OUTPUT_GIT_LOG_RULE,
  OUTPUT_SEARCH_RULE,
  SHELL_COMPOUND_RULE,
} from "../rules/index.ts";
import { commandShape, normalizeCommandTokens } from "./normalize.ts";

export function classifyCommand(
  command: CommandRequest,
  capture: ProcessCaptureReport,
): HushCommandClassification {
  const shape = commandShape(command);
  if (shape.compound) {
    return { ...SHELL_COMPOUND_RULE, ...shape, matched: true, matchedBy: "shell-compound" };
  }
  const matched = matchHushCommand(shape.tokens);
  if (matched !== null) {
    return { ...matched, ...shape, matched: true, matchedBy: "command-rule" };
  }
  const outputPolicy = policyFromOutputShape(capture.stdout);
  if (outputPolicy === null) {
    return { ...GENERIC_RULE, ...shape, matched: false, matchedBy: "fallback" };
  }
  return { ...outputPolicy, ...shape, matched: true, matchedBy: "output-shape" };
}

export function classifyFamily(command: CommandRequest, capture: ProcessCaptureReport): HushFamily {
  return classifyCommand(command, capture).family;
}

export function classifyReducerId(tokens: readonly string[], family: HushFamily): string {
  const normalized = normalizeCommandTokens(tokens);
  const matched = matchHushCommand(normalized);
  if (matched !== null) {
    return matched.reducerId;
  }
  const executable = normalized[0] ?? "";
  switch (family) {
    case "git":
      return "git.status";
    case "github":
      return normalized.includes("view") ? "gh.view" : "gh.list";
    case "search":
      return executable === "rg" || executable === "ripgrep" ? "files.rg" : "files.grep";
    case "listing":
      return "files.read";
    case "test":
      return "test.summary";
    case "lint":
    case "typecheck":
      return "lint.summary";
    case "build":
      return "build.summary";
    case "package":
    case "container":
    case "kubernetes":
    case "cloud":
    case "data":
    case "log":
    case "http":
    case "generic":
      return "generic";
    default:
      return assertNever(family, "unhandled hush family");
  }
}

export function commandIdentity(command: CommandRequest): HushCommandIdentity {
  if (command.mode === "bash") {
    return {
      mode: "bash",
      executable: command.executable,
      argv: [],
      command: command.command,
      cwd: command.cwd ?? null,
    };
  }
  return {
    mode: commandMode(command),
    executable: command.executable,
    argv: command.argv,
    command: null,
    cwd: command.cwd ?? null,
  };
}

export function commandTokens(command: CommandRequest): readonly string[] {
  return commandShape(command).tokens;
}

function policyFromOutputShape(stdout: ProcessStreamCapture): HushReductionRule | null {
  const text = stdout.inlineText;
  if (text === null || text.length === 0) {
    return null;
  }
  const first = text.split("\n", 1)[0] ?? "";
  if (/^[^:\n]+:\d+[::]/.test(first)) {
    return OUTPUT_SEARCH_RULE;
  }
  if (first.startsWith("diff --git ")) {
    return OUTPUT_GIT_DIFF_RULE;
  }
  if (first.startsWith("commit ")) {
    return OUTPUT_GIT_LOG_RULE;
  }
  return null;
}
