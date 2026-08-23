/** Safe command-shape normalization for Hush classification. */

import type { CommandRequest } from "../process.ts";

export type HushCommandShape = {
  readonly tokens: readonly string[];
  readonly compound: boolean;
};

const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PYTHON_EXECUTABLE = /^python(?:\d+(?:\.\d+)*)?$/;
const PHP_TOOLS = new Set(["ecs", "paratest", "pest", "phpstan", "phpunit", "pint"]);
const RUBY_TOOLS = new Set(["rake", "rails", "rspec", "rubocop"]);
const PACKAGE_TOOLS = new Set([
  "basedpyright",
  "biome",
  "eslint",
  "jest",
  "next",
  "nx",
  "oxlint",
  "playwright",
  "prettier",
  "prisma",
  "tsc",
  "turbo",
  "ty",
  "vitest",
]);
const SCRIPT_ALIASES = new Map<string, string>([
  ["build", "build"],
  ["check", "lint"],
  ["lint", "lint"],
  ["test", "test"],
  ["typecheck", "tsc"],
]);

export function commandShape(command: CommandRequest): HushCommandShape {
  if (command.mode === "bash") {
    const parsed = tokenizeFirstCommand(command.command);
    return {
      tokens: normalizeCommandTokens(parsed.tokens),
      compound: parsed.compound,
    };
  }
  return {
    tokens: normalizeCommandTokens([baseName(command.executable), ...command.argv]),
    compound: false,
  };
}

export function normalizeCommandTokens(tokens: readonly string[]): readonly string[] {
  let normalized = stripLeadingPrefixes(tokens);
  for (let depth = 0; depth < 4; depth += 1) {
    const unwrapped = unwrapCommand(normalized);
    if (unwrapped === normalized) {
      break;
    }
    normalized = stripLeadingPrefixes(unwrapped);
  }
  const executable = normalized[0];
  if (executable === undefined) {
    return [];
  }
  return [baseName(executable), ...normalized.slice(1)];
}

function stripLeadingPrefixes(tokens: readonly string[]): readonly string[] {
  let index = 0;
  let previous = -1;
  while (index !== previous) {
    previous = index;
    while (index < tokens.length && ENVIRONMENT_ASSIGNMENT.test(tokens[index] ?? "")) {
      index += 1;
    }
    if (tokens[index] === "env") {
      const wrapperIndex = envCommandIndex(tokens, index + 1);
      if (wrapperIndex !== null) {
        index = wrapperIndex;
        continue;
      }
    }
    if (tokens[index] === "sudo") {
      index += 1;
      while (index < tokens.length) {
        const token = tokens[index] ?? "";
        if (token === "-u" || token === "-g" || token === "-h" || token === "-p") {
          index += 2;
          continue;
        }
        if (token.startsWith("-")) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (["builtin", "command", "nohup", "time"].includes(tokens[index] ?? "")) {
      index += 1;
    }
  }
  return tokens.slice(index);
}

function envCommandIndex(tokens: readonly string[], start: number): number | null {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (ENVIRONMENT_ASSIGNMENT.test(token)) {
      index += 1;
      continue;
    }
    if (token === "-u" || token === "--unset") {
      index += 2;
      continue;
    }
    if (token.startsWith("-")) {
      return null;
    }
    return index;
  }
  return null;
}

function unwrapCommand(tokens: readonly string[]): readonly string[] {
  const executable = baseName(tokens[0] ?? "");
  const subcommand = (tokens[1] ?? "").toLowerCase();
  if (PYTHON_EXECUTABLE.test(executable) && subcommand === "-m" && tokens[2] !== undefined) {
    return tokens.slice(2);
  }
  if (executable === "bundle" && subcommand === "exec" && tokens[2] !== undefined) {
    return RUBY_TOOLS.has(baseName(tokens[2])) ? tokens.slice(2) : tokens;
  }
  if (executable === "php" && tokens[1] !== undefined) {
    const tool = baseName(tokens[1]);
    if (PHP_TOOLS.has(tool)) {
      return [tool, ...tokens.slice(2)];
    }
  }
  if ((executable === "npx" || executable === "pnpx") && tokens[1] !== undefined) {
    return PACKAGE_TOOLS.has(baseName(tokens[1])) ? tokens.slice(1) : tokens;
  }
  if (executable === "npm" || executable === "pnpm") {
    if (["exec", "x", "dlx"].includes(subcommand) && tokens[2] !== undefined) {
      return PACKAGE_TOOLS.has(baseName(tokens[2])) ? tokens.slice(2) : tokens;
    }
    if ((subcommand === "run" || subcommand === "run-script") && tokens[2] !== undefined) {
      const alias = SCRIPT_ALIASES.get(tokens[2].toLowerCase());
      return alias === undefined ? tokens : [alias, ...tokens.slice(3)];
    }
    if (PACKAGE_TOOLS.has(subcommand)) {
      return tokens.slice(1);
    }
  }
  if (executable === "uv" && subcommand === "run" && tokens[2] !== undefined) {
    const tool = baseName(tokens[2]);
    if (["mypy", "pytest", "ruff"].includes(tool)) {
      return tokens.slice(2);
    }
  }
  return tokens;
}

function tokenizeFirstCommand(command: string): HushCommandShape {
  const tokens: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let compound = false;
  let index = 0;
  const push = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };
  while (index < command.length) {
    const character = command[index] ?? "";
    if (character === "\\" && quote !== "single") {
      const next = command[index + 1];
      if (next !== undefined) {
        current += next;
        index += 2;
        continue;
      }
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? null : "single";
      index += 1;
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? null : "double";
      index += 1;
      continue;
    }
    if (quote === null && (character === "|" || character === "&" || character === ";")) {
      push();
      compound = true;
      break;
    }
    if (quote === null && (character === "\n" || character === "\r")) {
      push();
      if (command.slice(index).trim().length > 0) {
        compound = true;
      }
      break;
    }
    if (quote === null && (character === ">" || character === "<")) {
      push();
      break;
    }
    if (quote === null && /\s/.test(character)) {
      push();
      index += 1;
      continue;
    }
    if (quote === null && character === "#" && current.length === 0) {
      break;
    }
    current += character;
    index += 1;
  }
  push();
  return { tokens, compound };
}

function baseName(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  return (parts.at(-1) ?? path).toLowerCase();
}
