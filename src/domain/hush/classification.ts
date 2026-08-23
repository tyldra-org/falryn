/** Command identity and reducer selection for Hush. */

import type { CommandRequest } from "../process.ts";
import { commandMode } from "../process.ts";
import type { ProcessCaptureReport, ProcessStreamCapture } from "../process-capture.ts";
import { assertNever } from "../result.ts";
import type { HushCommandIdentity, HushFamily } from "./contracts.ts";

export function classifyReducerId(tokens: readonly string[], family: HushFamily): string {
  const executable = tokens[0] ?? "";
  const subcommand = tokens[1] ?? "";
  switch (family) {
    case "git":
      switch (subcommand) {
        case "diff":
          return "git.diff";
        case "log":
          return "git.log";
        case "show":
          return "git.show";
        default:
          return "git.status";
      }
    case "github":
      return subcommand === "view" || tokens[2] === "view" ? "gh.view" : "gh.list";
    case "search":
      return executable === "rg" || executable === "ripgrep" ? "files.rg" : "files.grep";
    case "listing":
      switch (executable) {
        case "ls":
          return "files.ls";
        case "tree":
          return "files.tree";
        case "find":
          return "files.find";
        default:
          return "files.read";
      }
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

export function classifyFamily(command: CommandRequest, capture: ProcessCaptureReport): HushFamily {
  const tokens = commandTokens(command);
  const fromCommand = familyFromTokens(tokens);
  if (fromCommand !== "generic") {
    return fromCommand;
  }
  return familyFromOutputShape(capture.stdout) ?? "generic";
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
  if (command.mode === "bash") {
    return tokenize(command.command);
  }
  return [baseName(command.executable), ...command.argv];
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  for (const token of command.trim().split(/\s+/)) {
    if (token.length === 0 || token.includes("=")) {
      continue;
    }
    tokens.push(token);
  }
  return tokens.map((token) => baseName(token));
}

function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  const last = parts[parts.length - 1] ?? path;
  return last.toLowerCase();
}

function familyFromTokens(tokens: readonly string[]): HushFamily {
  const executable = tokens[0] ?? "";
  const rest = tokens.slice(1);
  switch (executable) {
    case "git":
      return "git";
    case "gh":
      return "github";
    case "docker":
    case "podman":
      return "container";
    case "kubectl":
      return "kubernetes";
    case "aws":
    case "gcloud":
    case "az":
      return "cloud";
    case "npm":
    case "pnpm":
    case "yarn":
      return "package";
    case "bun":
      return bunFamily(rest);
    case "cargo":
      return cargoFamily(rest);
    case "jest":
    case "vitest":
    case "mocha":
    case "pytest":
      return "test";
    case "biome":
    case "eslint":
    case "ruff":
    case "clippy":
      return "lint";
    case "tsc":
    case "mypy":
      return "typecheck";
    case "make":
      return "build";
    case "jq":
    case "sqlite3":
    case "psql":
      return "data";
    case "tail":
    case "journalctl":
      return "log";
    case "curl":
    case "wget":
      return "http";
    case "rg":
    case "grep":
    case "ag":
      return "search";
    case "ls":
    case "tree":
    case "find":
    case "cat":
    case "bat":
      return "listing";
    case "sh":
    case "bash":
      return familyFromTokens(rest);
    default:
      return "generic";
  }
}

function bunFamily(rest: readonly string[]): HushFamily {
  if (rest[0] === "test") {
    return "test";
  }
  if (rest[0] === "run" && rest[1] === "build") {
    return "build";
  }
  if (rest[0] === "run" && (rest[1] === "check" || rest[1] === "lint")) {
    return "lint";
  }
  if (rest[0] === "run" && rest[1] === "typecheck") {
    return "typecheck";
  }
  return "package";
}

function cargoFamily(rest: readonly string[]): HushFamily {
  if (rest[0] === "test") {
    return "test";
  }
  if (rest[0] === "build") {
    return "build";
  }
  if (rest[0] === "clippy") {
    return "lint";
  }
  return "build";
}

function familyFromOutputShape(stdout: ProcessStreamCapture): HushFamily | null {
  const text = stdout.inlineText;
  if (text === null || text.length === 0) {
    return null;
  }
  const first = text.split("\n", 1)[0] ?? "";
  if (/^[^:\n]+:\d+[::]/.test(first)) {
    return "search";
  }
  if (first.startsWith("diff --git ") || first.startsWith("commit ")) {
    return "git";
  }
  return null;
}
