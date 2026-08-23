/**
 * Hush command-output reduction over exact process-capture facts.
 *
 * Capture already recorded stdout, stderr, exit, signal, timing, truncation,
 * and artifact handles. This module projects a bounded, command-family-aware
 * view for later model and UI consumers. It never rewrites terminal facts,
 * never spawns a process, and never chooses a reducer by executing output.
 */

import type { ArtifactId } from "./artifact.ts";
import type { DurationMs } from "./clock.ts";
import type { ProcessCaptureId } from "./identity.ts";
import { type CommandMode, type CommandRequest, commandMode } from "./process.ts";
import type {
  ProcessCaptureEncoding,
  ProcessCaptureExit,
  ProcessCaptureReport,
  ProcessCaptureStop,
  ProcessStreamCapture,
  ProcessStreamName,
} from "./process-capture.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const HUSH_REDUCER_VERSION = "hush.v1";

/** Longest reduced projection Hush may emit. */
export const MAX_HUSH_REDUCED_BYTES = 64 * 1_024;
export const DEFAULT_HUSH_REDUCED_BYTES = 8 * 1_024;

/** Specialized ls projection cap; the exact capture remains recoverable. */
const LS_MAX_REDUCED_BYTES = 384;
const LS_MAX_RETAINED_LINES = 10;
const LS_MAX_RETAINED_ANCHORS = 4;

export const HUSH_FAMILIES = [
  "git",
  "github",
  "test",
  "lint",
  "typecheck",
  "build",
  "package",
  "container",
  "kubernetes",
  "cloud",
  "data",
  "log",
  "http",
  "search",
  "listing",
  "generic",
] as const;
export type HushFamily = (typeof HUSH_FAMILIES)[number];

export const HUSH_STRATEGIES = ["specialized", "generic", "passthrough"] as const;
export type HushStrategy = (typeof HUSH_STRATEGIES)[number];

export const HUSH_FIDELITIES = ["exact", "deterministic-reduction", "raw-fallback"] as const;
export type HushFidelity = (typeof HUSH_FIDELITIES)[number];

export type HushCommandIdentity = {
  readonly mode: CommandMode;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly command: string | null;
  readonly cwd: string | null;
};

export type HushOmissionKind =
  | "capped-lines"
  | "capped-bytes"
  | "duplicate-run"
  | "binary-stream"
  | "reducer-failure";

export type HushOmission = {
  readonly kind: HushOmissionKind;
  readonly stream: ProcessStreamName | "both";
  readonly count: number;
  readonly detail: string | null;
};

export type HushExpansion = {
  readonly stdoutInline: boolean;
  readonly stderrInline: boolean;
  readonly stdoutArtifact: ArtifactId | null;
  readonly stderrArtifact: ArtifactId | null;
};

export type HushRequest = {
  readonly command: CommandRequest;
  readonly capture: ProcessCaptureReport;
  readonly expectedFamilies?: readonly HushFamily[];
  readonly importantPatterns?: readonly string[];
  readonly strategy?: HushStrategy;
  readonly maxReducedBytes?: number;
};

export type HushResult = {
  readonly captureId: ProcessCaptureId;
  readonly command: HushCommandIdentity;
  readonly family: HushFamily;
  readonly reducerId: string;
  readonly strategy: HushStrategy;
  readonly reducerVersion: typeof HUSH_REDUCER_VERSION;
  readonly fidelity: HushFidelity;
  readonly stop: ProcessCaptureStop;
  readonly exit: ProcessCaptureExit;
  readonly durationMs: DurationMs;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutEncoding: ProcessCaptureEncoding;
  readonly stderrEncoding: ProcessCaptureEncoding;
  readonly truncated: boolean;
  readonly reducedText: string;
  readonly omissions: readonly HushOmission[];
  readonly expansion: HushExpansion;
  readonly fallbackReason: "unknown-family" | "expected-family-miss" | "reducer-failure" | null;
};

export type HushError = {
  readonly kind: "hush";
  readonly code: "invalid-request";
  readonly reason: "invalid-reduced-limit" | "invalid-pattern";
};

export type HushPort = {
  reduce(request: HushRequest): Result<HushResult, HushError>;
};

export function createHushPort(): HushPort {
  return { reduce: reduceHush };
}

export function reduceHush(request: HushRequest): Result<HushResult, HushError> {
  const invalid = validateHushRequest(request);
  if (invalid !== null) {
    return err({ kind: "hush", code: "invalid-request", reason: invalid });
  }
  const maxBytes = request.maxReducedBytes ?? DEFAULT_HUSH_REDUCED_BYTES;
  const command = commandIdentity(request.command);
  const tokens = commandTokens(request.command);
  const family = classifyFamily(request.command, request.capture);
  const reducerId = classifyReducerId(tokens, family);
  const requested = request.strategy ?? "specialized";
  const patterns = request.importantPatterns ?? [];
  const originalBytes =
    request.capture.stdout.inlineBytes.byteLength + request.capture.stderr.inlineBytes.byteLength;

  let strategy: HushStrategy = requested;
  let fallbackReason: HushResult["fallbackReason"] = null;
  let projection: StreamProjection;
  let selectedReducerId = reducerId;

  if (requested === "passthrough") {
    selectedReducerId = "safe.passthrough";
    projection = passthroughProjection(request.capture, maxBytes, patterns);
  } else if (
    requested === "generic" ||
    family === "generic" ||
    (request.expectedFamilies !== undefined && !request.expectedFamilies.includes(family))
  ) {
    strategy = "generic";
    selectedReducerId = "generic";
    fallbackReason =
      family === "generic"
        ? "unknown-family"
        : request.expectedFamilies !== undefined && !request.expectedFamilies.includes(family)
          ? "expected-family-miss"
          : null;
    projection = genericProjection(request.capture, maxBytes, patterns);
  } else {
    try {
      projection = specializedProjection(family, reducerId, request.capture, maxBytes, patterns);
    } catch {
      strategy = "generic";
      selectedReducerId = "generic";
      fallbackReason = "reducer-failure";
      projection = rawFallbackProjection(request.capture, maxBytes);
    }
  }

  const reducedBytes = new TextEncoder().encode(projection.text).byteLength;
  if (strategy !== "passthrough" && reducedBytes >= originalBytes && originalBytes > 0) {
    strategy = "passthrough";
    selectedReducerId = "safe.passthrough";
    projection = passthroughProjection(request.capture, maxBytes, patterns);
  }

  const truncated =
    request.capture.stdout.truncated ||
    request.capture.stderr.truncated ||
    projection.omissions.some(
      (omission) => omission.kind === "capped-bytes" || omission.kind === "capped-lines",
    );

  return ok({
    captureId: request.capture.captureId,
    command,
    family,
    reducerId: selectedReducerId,
    strategy,
    reducerVersion: HUSH_REDUCER_VERSION,
    fidelity: fidelityFor(
      strategy === "passthrough" ? "passthrough" : requested,
      fallbackReason,
      projection,
      request.capture,
    ),
    stop: request.capture.stop,
    exit: request.capture.exit,
    durationMs: request.capture.durationMs,
    stdoutBytes: request.capture.stdout.byteCount,
    stderrBytes: request.capture.stderr.byteCount,
    stdoutEncoding: request.capture.stdout.encoding,
    stderrEncoding: request.capture.stderr.encoding,
    truncated,
    reducedText: projection.text,
    omissions: projection.omissions,
    expansion: {
      stdoutInline: request.capture.stdout.inlineBytes.byteLength > 0,
      stderrInline: request.capture.stderr.inlineBytes.byteLength > 0,
      stdoutArtifact: request.capture.stdout.artifact?.artifactId ?? null,
      stderrArtifact: request.capture.stderr.artifact?.artifactId ?? null,
    },
    fallbackReason,
  });
}

export function validateHushRequest(request: HushRequest): HushError["reason"] | null {
  if (
    request.maxReducedBytes !== undefined &&
    (!Number.isSafeInteger(request.maxReducedBytes) ||
      request.maxReducedBytes < 0 ||
      request.maxReducedBytes > MAX_HUSH_REDUCED_BYTES)
  ) {
    return "invalid-reduced-limit";
  }
  for (const pattern of request.importantPatterns ?? []) {
    if (pattern.length === 0 || pattern.length > 256) {
      return "invalid-pattern";
    }
  }
  return null;
}

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

function commandIdentity(command: CommandRequest): HushCommandIdentity {
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

function commandTokens(command: CommandRequest): readonly string[] {
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

type StreamProjection = {
  readonly text: string;
  readonly omissions: readonly HushOmission[];
};

function fidelityFor(
  requested: HushStrategy,
  fallback: HushResult["fallbackReason"],
  projection: StreamProjection,
  capture: ProcessCaptureReport,
): HushFidelity {
  if (fallback === "reducer-failure") {
    return "raw-fallback";
  }
  if (
    requested === "passthrough" &&
    projection.omissions.length === 0 &&
    !capture.stdout.truncated &&
    !capture.stderr.truncated
  ) {
    return "exact";
  }
  return "deterministic-reduction";
}

function specializedProjection(
  family: HushFamily,
  reducerId: string,
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): StreamProjection {
  switch (family) {
    case "search":
      return searchProjection(capture, maxBytes, patterns);
    case "git":
      if (reducerId === "git.diff") {
        return gitDiffProjection(capture, maxBytes, patterns);
      }
      return gitStatusProjection(capture, maxBytes, patterns);
    case "github":
      return groupedProjection(capture, maxBytes, patterns, gitGroupKey, 12);
    case "listing":
      if (reducerId === "files.ls") {
        return lsProjection(capture, maxBytes, patterns);
      }
      return listingProjection(capture, maxBytes, patterns);
    case "test":
    case "lint":
    case "typecheck":
    case "build":
      return summaryProjection(capture, maxBytes, patterns);
    case "package":
    case "container":
    case "kubernetes":
    case "cloud":
    case "data":
    case "log":
    case "http":
    case "generic":
      return genericProjection(capture, maxBytes, patterns);
    default:
      return assertNever(family, "unhandled hush family");
  }
}

function passthroughProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): StreamProjection {
  return joinStreams(
    boundStream("stdout", capture.stdout, maxBytes, patterns, false),
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, false),
    maxBytes,
  );
}

function genericProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): StreamProjection {
  return joinStreams(
    boundStream("stdout", capture.stdout, maxBytes, patterns, true),
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
    maxBytes,
  );
}

function rawFallbackProjection(capture: ProcessCaptureReport, maxBytes: number): StreamProjection {
  const fallback = passthroughProjection(capture, maxBytes, []);
  return {
    text: fallback.text,
    omissions: [
      ...fallback.omissions,
      { kind: "reducer-failure", stream: "both", count: 1, detail: null },
    ],
  };
}

function gitDiffProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): StreamProjection {
  const text = capture.stdout.inlineText;
  if (text === null || capture.stdout.encoding === "binary") {
    return genericProjection(capture, maxBytes, patterns);
  }
  const stats: string[] = [];
  let file: string | null = null;
  let plus = 0;
  let minus = 0;
  let files = 0;
  const flush = (): void => {
    if (file !== null) {
      stats.push(`${file}: +${plus} -${minus}`);
      file = null;
      plus = 0;
      minus = 0;
    }
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      files += 1;
      if (files > 24) {
        continue;
      }
      file = pathFromDiffGit(line.slice("diff --git ".length));
    } else if (line.startsWith("Binary files ")) {
      flush();
      stats.push(summarizeBinaryDiffLine(line));
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      plus += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      minus += 1;
    }
  }
  flush();
  if (files > 24) {
    stats.push(`… and ${files - 24} more files`);
  }
  const stdout =
    stats.length === 0
      ? boundStream("stdout", capture.stdout, maxBytes, patterns, true)
      : boundText(stats.join("\n"), "stdout", maxBytes);
  const omittedHunks = Math.max(0, text.split("\n").length - stats.length);
  return joinStreams(
    {
      text: stdout.text,
      omissions: [
        ...(omittedHunks > 0
          ? [
              {
                kind: "capped-lines" as const,
                stream: "stdout" as const,
                count: omittedHunks,
                detail: "hunks",
              },
            ]
          : []),
        ...stdout.omissions,
      ],
    },
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
    maxBytes,
  );
}

function gitStatusProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): StreamProjection {
  const text = capture.stdout.inlineText;
  if (text === null || capture.stdout.encoding === "binary") {
    return genericProjection(capture, maxBytes, patterns);
  }
  const groups = new Map<string, number>();
  const kept: string[] = [];
  let omitted = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ") || matchesPattern(line, patterns)) {
      kept.push(line);
      continue;
    }
    const path = porcelainPath(line);
    if (path === null) {
      kept.push(line);
      continue;
    }
    const key = statusGroupKey(path);
    const seen = groups.get(key) ?? 0;
    if (seen < 8) {
      kept.push(line);
      groups.set(key, seen + 1);
    } else {
      omitted += 1;
    }
  }
  const bounded = boundText(kept.join("\n"), "stdout", maxBytes);
  return joinStreams(
    {
      text: bounded.text,
      omissions: [
        ...(omitted > 0
          ? [
              {
                kind: "capped-lines" as const,
                stream: "stdout" as const,
                count: omitted,
                detail: null,
              },
            ]
          : []),
        ...bounded.omissions,
      ],
    },
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
    maxBytes,
  );
}

function pathFromDiffGit(rest: string): string {
  const parts = rest.split(/\s+/);
  const left = parts[0] ?? rest;
  const right = parts[1] ?? left;
  const from = stripDiffPath(left);
  const to = stripDiffPath(right);
  return from === to ? from : `${from} → ${to}`;
}

function summarizeBinaryDiffLine(line: string): string {
  const rest = line.startsWith("Binary files ") ? line.slice("Binary files ".length) : null;
  if (rest === null) {
    return line;
  }
  const splitAt = rest.indexOf(" and ");
  if (splitAt < 0) {
    return line;
  }
  const left = rest.slice(0, splitAt).trim();
  const right = rest
    .slice(splitAt + " and ".length)
    .replace(/ differ$/, "")
    .trim();
  return `Binary: ${stripDiffPath(left)} → ${stripDiffPath(right)}`;
}

function stripDiffPath(value: string): string {
  return value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
}

const PORCELAIN_CODES = new Set([" ", "M", "A", "D", "R", "C", "U", "?", "!"]);

function porcelainPath(line: string): string | null {
  const x = line[0];
  const y = line[1];
  if (x === undefined || y === undefined || line[2] !== " " || line.length < 4) {
    return null;
  }
  if (!PORCELAIN_CODES.has(x) || !PORCELAIN_CODES.has(y)) {
    return null;
  }
  const renamed = line.slice(3).trim().split(" -> ");
  const path = renamed[renamed.length - 1];
  return path === undefined || path.length === 0 ? null : path;
}

const TWO_LEVEL_STATUS_ROOTS = new Set([
  "crates",
  "src",
  "docs",
  "tests",
  "packages",
  "apps",
  "libs",
]);

function statusGroupKey(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  const first = parts[0];
  const second = parts[1];
  if (first === undefined) {
    return ".";
  }
  if (second === undefined) {
    return ".";
  }
  if (TWO_LEVEL_STATUS_ROOTS.has(first)) {
    return `${first}/${second}`;
  }
  return first;
}

function searchProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): StreamProjection {
  return joinStreams(
    groupLines("stdout", capture.stdout, maxBytes, patterns, searchGroupKey, 8),
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
    maxBytes,
  );
}

function listingProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): StreamProjection {
  return joinStreams(
    groupLines("stdout", capture.stdout, maxBytes, patterns, () => "entry", 32),
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
    maxBytes,
  );
}

function lsProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): StreamProjection {
  return joinStreams(
    sampleLsOutput("stdout", capture.stdout, maxBytes, patterns),
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
    maxBytes,
  );
}

function sampleLsOutput(
  stream: ProcessStreamName,
  capture: ProcessStreamCapture,
  maxBytes: number,
  patterns: readonly string[],
): StreamProjection {
  if (capture.encoding === "binary" || capture.inlineText === null) {
    return binaryOmission(stream, capture);
  }

  const lines = listingLines(capture.inlineText);
  const listingBudget = patterns.length > 0 ? maxBytes : Math.min(maxBytes, LS_MAX_REDUCED_BYTES);
  const sample = fitLsSample(lines, patterns, listingBudget);
  if (
    sample.omitted === 0 &&
    new TextEncoder().encode(capture.inlineText).byteLength <= listingBudget
  ) {
    return { text: capture.inlineText, omissions: [] };
  }
  const bounded = boundText(sample.text, stream, listingBudget);
  return {
    text: bounded.text,
    omissions: [
      ...(sample.omitted > 0
        ? [
            {
              kind: "capped-lines" as const,
              stream,
              count: sample.omitted,
              detail: "deterministic ls sample",
            },
          ]
        : []),
      ...bounded.omissions,
    ],
  };
}

function fitLsSample(
  lines: readonly string[],
  patterns: readonly string[],
  maxBytes: number,
): Readonly<{ text: string; omitted: number }> {
  if (lines.length <= 1) {
    return { text: lines[0] ?? "", omitted: 0 };
  }
  for (
    let retainedLimit = Math.min(LS_MAX_RETAINED_LINES, lines.length);
    retainedLimit >= 0;
    retainedLimit -= 1
  ) {
    const selected = selectLsLineIndices(lines, patterns, retainedLimit);
    const retained = selected.map((index) => lines[index]);
    const omitted = Math.max(0, lines.length - retained.length);
    const summary = omitted > 0 ? [`ls: ${lines.length} lines, ${omitted} omitted`] : [];
    const text = [...summary, ...retained].join("\n");
    if (new TextEncoder().encode(text).byteLength <= maxBytes || retainedLimit === 0) {
      return { text, omitted };
    }
  }
  return { text: "", omitted: lines.length };
}

function selectLsLineIndices(
  lines: readonly string[],
  patterns: readonly string[],
  retainedLimit: number,
): readonly number[] {
  const important = lineIndices(lines, (line) => matchesPattern(line, patterns));
  const anchors = lineIndices(lines, isLsAnchor);
  const selected = new Set(important);
  const anchorBudget = Math.min(
    LS_MAX_RETAINED_ANCHORS,
    Math.max(0, retainedLimit - selected.size),
  );
  addEvenlySpaced(selected, anchors, anchorBudget);
  addEvenlySpaced(
    selected,
    lines.map((_, index) => index),
    Math.max(0, retainedLimit - selected.size),
  );
  return [...selected].sort((left, right) => left - right);
}

function listingLines(text: string): readonly string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function lineIndices(
  lines: readonly string[],
  predicate: (line: string) => boolean,
): readonly number[] {
  const indices: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (predicate(line)) {
      indices.push(index);
    }
  }
  return indices;
}

function isLsAnchor(line: string): boolean {
  return line.endsWith(":") || /^total\s+\d+$/.test(line);
}

function addEvenlySpaced(
  selected: Set<number>,
  candidates: readonly number[],
  limit: number,
): void {
  if (limit <= 0) {
    return;
  }
  const available = candidates.filter((candidate) => !selected.has(candidate));
  if (available.length <= limit) {
    for (const candidate of available) {
      selected.add(candidate);
    }
    return;
  }
  if (limit === 1) {
    const first = available[0];
    if (first !== undefined) {
      selected.add(first);
    }
    return;
  }
  for (let index = 0; index < limit; index += 1) {
    const position = Math.round((index * (available.length - 1)) / (limit - 1));
    const candidate = available[position];
    if (candidate !== undefined) {
      selected.add(candidate);
    }
  }
}

function summaryProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): StreamProjection {
  const stdout = capture.stdout;
  if (stdout.encoding === "binary" || stdout.inlineText === null) {
    return genericProjection(capture, maxBytes, patterns);
  }
  const lines = stdout.inlineText.split("\n");
  const kept: string[] = [];
  let omitted = 0;
  for (const line of lines) {
    if (isSummaryLine(line) || matchesPattern(line, patterns) || kept.length < 16) {
      kept.push(line);
    } else {
      omitted += 1;
    }
  }
  const stdoutBound = boundText(kept.join("\n"), "stdout", maxBytes);
  return joinStreams(
    {
      text: stdoutBound.text,
      omissions: [
        ...(omitted > 0
          ? [
              {
                kind: "capped-lines" as const,
                stream: "stdout" as const,
                count: omitted,
                detail: null,
              },
            ]
          : []),
        ...stdoutBound.omissions,
      ],
    },
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
    maxBytes,
  );
}

function groupedProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  keyFor: (line: string) => string,
  perGroup: number,
): StreamProjection {
  return joinStreams(
    groupLines("stdout", capture.stdout, maxBytes, patterns, keyFor, perGroup),
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
    maxBytes,
  );
}

function groupLines(
  stream: ProcessStreamName,
  capture: ProcessStreamCapture,
  maxBytes: number,
  patterns: readonly string[],
  keyFor: (line: string) => string,
  perGroup: number,
): StreamProjection {
  if (capture.encoding === "binary" || capture.inlineText === null) {
    return binaryOmission(stream, capture);
  }
  const counts = new Map<string, number>();
  const kept: string[] = [];
  let omitted = 0;
  for (const line of capture.inlineText.split("\n")) {
    if (line.length === 0) {
      kept.push(line);
      continue;
    }
    if (matchesPattern(line, patterns)) {
      kept.push(line);
      continue;
    }
    const key = keyFor(line);
    const seen = counts.get(key) ?? 0;
    if (seen < perGroup) {
      kept.push(line);
      counts.set(key, seen + 1);
    } else {
      omitted += 1;
    }
  }
  const bounded = boundText(kept.join("\n"), stream, maxBytes);
  return {
    text: bounded.text,
    omissions: [
      ...(omitted > 0
        ? [{ kind: "capped-lines" as const, stream, count: omitted, detail: null }]
        : []),
      ...bounded.omissions,
    ],
  };
}

function boundStream(
  stream: ProcessStreamName,
  capture: ProcessStreamCapture,
  maxBytes: number,
  patterns: readonly string[],
  collapseDuplicates: boolean,
): StreamProjection {
  if (capture.encoding === "binary" || capture.inlineText === null) {
    return binaryOmission(stream, capture);
  }
  const source = collapseDuplicates
    ? collapseDuplicateLines(capture.inlineText, stream, patterns)
    : { text: capture.inlineText, omissions: [] as HushOmission[] };
  const bounded = boundText(source.text, stream, maxBytes);
  return {
    text: bounded.text,
    omissions: [...source.omissions, ...bounded.omissions],
  };
}

function collapseDuplicateLines(
  text: string,
  stream: ProcessStreamName,
  patterns: readonly string[],
): StreamProjection {
  const kept: string[] = [];
  let omitted = 0;
  let previous: string | null = null;
  let run = 0;
  for (const line of text.split("\n")) {
    if (matchesPattern(line, patterns) || line !== previous) {
      kept.push(line);
      previous = line;
      run = 1;
      continue;
    }
    run += 1;
    if (run === 2) {
      kept.push(line);
    } else {
      omitted += 1;
    }
  }
  return {
    text: kept.join("\n"),
    omissions: omitted > 0 ? [{ kind: "duplicate-run", stream, count: omitted, detail: null }] : [],
  };
}

function boundText(
  text: string,
  stream: ProcessStreamName | "both",
  maxBytes: number,
): StreamProjection {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) {
    return { text, omissions: [] };
  }
  const decoder = new TextDecoder();
  const head = decoder.decode(encoded.slice(0, Math.floor(maxBytes * 0.6)));
  const tail = decoder.decode(encoded.slice(encoded.byteLength - Math.floor(maxBytes * 0.3)));
  return {
    text: `${head}\n…\n${tail}`,
    omissions: [
      {
        kind: "capped-bytes",
        stream,
        count: encoded.byteLength - maxBytes,
        detail: null,
      },
    ],
  };
}

function binaryOmission(
  stream: ProcessStreamName,
  capture: ProcessStreamCapture,
): StreamProjection {
  return {
    text: "",
    omissions: [
      {
        kind: "binary-stream",
        stream,
        count: capture.byteCount,
        detail: capture.artifact?.artifactId ?? null,
      },
    ],
  };
}

function joinStreams(
  stdout: StreamProjection,
  stderr: StreamProjection,
  maxBytes: number,
): StreamProjection {
  const parts: string[] = [];
  if (stdout.text.length > 0) {
    parts.push(stdout.text);
  }
  if (stderr.text.length > 0) {
    parts.push(`stderr:\n${stderr.text}`);
  }
  const joined = boundText(parts.join("\n"), "both", maxBytes);
  return {
    text: joined.text,
    omissions: [...stdout.omissions, ...stderr.omissions, ...joined.omissions],
  };
}

function searchGroupKey(line: string): string {
  const match = /^([^:]+):/.exec(line);
  return match?.[1] ?? "match";
}

function gitGroupKey(line: string): string {
  if (line.startsWith("diff --git ") || line.startsWith("+++ ") || line.startsWith("--- ")) {
    return line;
  }
  const path = /(?:^|\s)([^\s]+\/[^\s]+|[^\s]+\.[A-Za-z0-9]+)\s*$/.exec(line);
  return path?.[1] ?? "git";
}

function isSummaryLine(line: string): boolean {
  return /fail|error|pass|ok |tests?|warning|error TS/i.test(line);
}

function matchesPattern(line: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => line.includes(pattern));
}
