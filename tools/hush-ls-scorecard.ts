/**
 * Compare Falryn's ls-family Hush projection with a pinned local rtk binary.
 *
 * The corpus is generated outside the repository, uses identical cwd/argv for
 * native ls and rtk ls, and estimates tokens consistently from UTF-8 bytes.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  duration,
  HUSH_REDUCER_VERSION,
  instant,
  MAX_COMMAND_OUTPUT_BYTES,
  type ProcessCaptureReport,
  processCaptureId,
  reduceHush,
} from "../src/domain/index.ts";

export const HUSH_LS_CORPUS_VERSION = "hush-ls.v2";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const FLAT_MODULE_NAMES = Array.from(
  { length: 96 },
  (_, index) => `module-${String(index).padStart(3, "0")}.ts`,
);
const FLAT_VISIBLE_NAMES = [
  "README.md",
  "comma,name.csv",
  "file with spaces.txt",
  ...FLAT_MODULE_NAMES,
  "package.json",
  "unicode-λ.txt",
] as const;
const FLAT_ALL_NAMES = [".hidden-config", ...FLAT_VISIBLE_NAMES] as const;
const NESTED_ENTRY_NAMES = Array.from(
  { length: 32 },
  (_, index) => `entry-${String(index).padStart(2, "0")}.ts`,
);
const NESTED_ALL_NAMES = [
  "assets",
  "docs",
  "src",
  "tests",
  "components",
  "manifest.json",
  "guide.md",
  ...NESTED_ENTRY_NAMES,
] as const;
const NESTED_TOP_LEVEL_NAMES = ["assets", "docs", "src", "tests"] as const;

const CORPUS_CASES = [
  { id: "one-per-line", argv: ["-1", "flat"], expectedEntries: FLAT_VISIBLE_NAMES },
  { id: "long-all", argv: ["-la", "flat"], expectedEntries: FLAT_ALL_NAMES },
  { id: "long-human", argv: ["-lah", "flat"], expectedEntries: FLAT_ALL_NAMES },
  { id: "long-empty", argv: ["-la", "empty"], expectedEntries: [] },
  { id: "recursive", argv: ["-R", "nested"], expectedEntries: NESTED_ALL_NAMES },
  {
    id: "multi-path",
    argv: ["-la", "flat", "nested"],
    expectedEntries: [...FLAT_ALL_NAMES, ...NESTED_TOP_LEVEL_NAMES],
  },
  { id: "columns", argv: ["-C", "flat"], expectedEntries: FLAT_VISIBLE_NAMES },
  { id: "comma-separated", argv: ["-m", "flat"], expectedEntries: FLAT_VISIBLE_NAMES },
  { id: "inode-blocks", argv: ["-is", "flat"], expectedEntries: FLAT_VISIBLE_NAMES },
] as const;

type CommandRun = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export type HushLsMeasurement = Readonly<{
  bytes: number;
  estimatedTokens: number;
  text: string;
}>;

export type HushLsScore = Readonly<{
  id: string;
  argv: readonly string[];
  raw: HushLsMeasurement;
  rtk: HushLsMeasurement;
  hush: HushLsMeasurement;
  fidelity: "exact" | "deterministic-reduction" | "raw-fallback";
  omissionRecords: number;
  retainsEveryEntry: boolean;
  truncated: boolean;
  recoverable: boolean;
  withinRtkBudget: boolean;
}>;

export type HushLsScorecard = Readonly<{
  corpusVersion: typeof HUSH_LS_CORPUS_VERSION;
  hushVersion: typeof HUSH_REDUCER_VERSION;
  rtkVersion: string;
  estimator: "ceil(utf8-bytes/4)";
  scores: readonly HushLsScore[];
  passes: boolean;
}>;

export function estimateTokens(text: string): number {
  return Math.ceil(encoder.encode(text).byteLength / 4);
}

export function measureText(text: string): HushLsMeasurement {
  return {
    bytes: encoder.encode(text).byteLength,
    estimatedTokens: estimateTokens(text),
    text,
  };
}

export function scoreHushLs(input: {
  readonly id: string;
  readonly argv: readonly string[];
  readonly raw: string;
  readonly rtk: string;
  readonly hush: string;
  readonly fidelity: HushLsScore["fidelity"];
  readonly omissionRecords: number;
  readonly retainsEveryEntry: boolean;
  readonly truncated: boolean;
  readonly recoverable: boolean;
}): HushLsScore {
  const raw = measureText(input.raw);
  const rtk = measureText(input.rtk);
  const hush = measureText(input.hush);
  return {
    id: input.id,
    argv: input.argv,
    raw,
    rtk,
    hush,
    fidelity: input.fidelity,
    omissionRecords: input.omissionRecords,
    retainsEveryEntry: input.retainsEveryEntry,
    truncated: input.truncated,
    recoverable: input.recoverable,
    withinRtkBudget: hush.bytes <= rtk.bytes && hush.estimatedTokens <= rtk.estimatedTokens,
  };
}

export function passesHushLsScorecard(scores: readonly HushLsScore[]): boolean {
  return scores.length > 0 && scores.every(passesHushLsScore);
}

function passesHushLsScore(score: HushLsScore): boolean {
  return (
    score.withinRtkBudget &&
    score.fidelity !== "raw-fallback" &&
    score.omissionRecords === 0 &&
    score.retainsEveryEntry &&
    !score.truncated &&
    score.recoverable
  );
}

export function formatHushLsScorecard(scorecard: HushLsScorecard): string {
  const headings = ["case", "raw", "rtk", "hush", "delta", "coverage", "result"] as const;
  const rows = scorecard.scores.map((score) => [
    score.id,
    formatMeasurement(score.raw),
    formatMeasurement(score.rtk),
    formatMeasurement(score.hush),
    `${score.rtk.estimatedTokens - score.hush.estimatedTokens}t`,
    completeCoverage(score) ? "all" : "loss",
    passesHushLsScore(score) ? "PASS" : "FAIL",
  ]);
  const totalRaw = totalMeasurement(scorecard.scores, "raw");
  const totalRtk = totalMeasurement(scorecard.scores, "rtk");
  const totalHush = totalMeasurement(scorecard.scores, "hush");
  rows.push([
    "TOTAL",
    formatMeasurement(totalRaw),
    formatMeasurement(totalRtk),
    formatMeasurement(totalHush),
    `${totalRtk.estimatedTokens - totalHush.estimatedTokens}t`,
    scorecard.scores.every(completeCoverage) ? "all" : "loss",
    scorecard.passes ? "PASS" : "FAIL",
  ]);
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const formatRow = (row: readonly string[]): string =>
    row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("  ");
  return [
    `Hush ls scorecard ${scorecard.corpusVersion}`,
    `Hush ${scorecard.hushVersion} vs ${scorecard.rtkVersion}; tokens=${scorecard.estimator}`,
    formatRow(headings),
    formatRow(widths.map((width) => "-".repeat(width))),
    ...rows.map(formatRow),
    `scorecard: ${scorecard.passes ? "PASS" : "FAIL"}`,
  ].join("\n");
}

function formatMeasurement(measurement: HushLsMeasurement): string {
  return `${measurement.bytes}B/${measurement.estimatedTokens}t`;
}

function completeCoverage(score: HushLsScore): boolean {
  return score.retainsEveryEntry && score.omissionRecords === 0 && !score.truncated;
}

function totalMeasurement(
  scores: readonly HushLsScore[],
  lane: "raw" | "rtk" | "hush",
): HushLsMeasurement {
  return {
    bytes: scores.reduce((total, score) => total + score[lane].bytes, 0),
    estimatedTokens: scores.reduce((total, score) => total + score[lane].estimatedTokens, 0),
    text: "",
  };
}

async function createCorpus(root: string): Promise<void> {
  const flat = join(root, "flat");
  const nested = join(root, "nested");
  const empty = join(root, "empty");
  await Promise.all([
    mkdir(flat, { recursive: true }),
    mkdir(empty, { recursive: true }),
    mkdir(join(nested, "src", "components"), { recursive: true }),
    mkdir(join(nested, "tests"), { recursive: true }),
    mkdir(join(nested, "docs"), { recursive: true }),
    mkdir(join(nested, "assets"), { recursive: true }),
  ]);

  const flatWrites = FLAT_MODULE_NAMES.map((name, index) =>
    writeFile(join(flat, name), `export const value${index} = ${index};\n`),
  );
  const namedFiles = [
    [".hidden-config", "hidden\n"],
    ["README.md", "# Fixture\n"],
    ["package.json", '{"private":true}\n'],
    ["file with spaces.txt", "spaces\n"],
    ["comma,name.csv", "comma\n"],
    ["unicode-λ.txt", "unicode\n"],
  ] as const;
  const namedWrites = namedFiles.map(([name, content]) => writeFile(join(flat, name), content));
  const nestedWrites = NESTED_ENTRY_NAMES.map((name, index) => {
    const parent = index % 2 === 0 ? join(nested, "src", "components") : join(nested, "tests");
    return writeFile(join(parent, name), `export const entry${index} = true;\n`);
  });
  await Promise.all([
    ...flatWrites,
    ...namedWrites,
    ...nestedWrites,
    writeFile(join(nested, "docs", "guide.md"), "# Guide\n"),
    writeFile(join(nested, "assets", "manifest.json"), "{}\n"),
  ]);
}

function runCommand(command: readonly string[], cwd: string): CommandRun {
  const result = Bun.spawnSync([...command], {
    cwd,
    env: {
      COLUMNS: "120",
      LC_ALL: "C",
      NO_COLOR: "1",
      PATH: process.env.PATH ?? "",
      ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
    exitCode: result.exitCode,
  };
}

function stream(name: "stdout" | "stderr", text: string) {
  const bytes = encoder.encode(text);
  return {
    stream: name,
    byteCount: bytes.byteLength,
    inlineBytes: bytes,
    inlineText: text,
    encoding: "utf-8" as const,
    truncated: false,
    omittedBytes: 0,
    maxLineExceeded: false,
    artifact: null,
  };
}

function capture(id: string, run: CommandRun): ProcessCaptureReport {
  return {
    captureId: processCaptureId.from(id),
    pid: 1,
    startedAt: instant(1),
    endedAt: instant(2),
    durationMs: duration(1),
    stop: { kind: "exited" },
    killStage: "none",
    exit: { exitCode: run.exitCode, signal: null },
    stdout: stream("stdout", run.stdout),
    stderr: stream("stderr", run.stderr),
    events: [],
  };
}

export async function createHushLsScorecard(): Promise<HushLsScorecard> {
  const ls = Bun.which("ls");
  const rtk = Bun.which("rtk");
  if (ls === null || rtk === null) {
    throw new Error("hush ls scorecard requires local ls and rtk binaries");
  }
  const versionRun = runCommand([rtk, "--version"], process.cwd());
  if (versionRun.exitCode !== 0) {
    throw new Error(`rtk --version failed: ${versionRun.stderr.trim()}`);
  }

  const root = await mkdtemp(join(tmpdir(), "falryn-hush-ls-"));
  try {
    await createCorpus(root);
    const scores: HushLsScore[] = [];
    for (const [index, fixture] of CORPUS_CASES.entries()) {
      const raw = runCommand([ls, ...fixture.argv], root);
      const baseline = runCommand([rtk, "ls", ...fixture.argv], root);
      if (raw.exitCode !== 0 || baseline.exitCode !== 0) {
        throw new Error(
          `${fixture.id} failed: ls=${raw.exitCode} rtk=${baseline.exitCode} ${raw.stderr}${baseline.stderr}`,
        );
      }
      const reduced = reduceHush({
        command: {
          executable: ls,
          argv: fixture.argv,
          environment: {},
          cwd: root,
          timeoutMs: duration(10_000),
          maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
        },
        capture: capture(`hush-ls-${index}`, raw),
      });
      if (!reduced.ok) {
        throw new Error(`${fixture.id} Hush reduction failed: ${reduced.error.reason}`);
      }
      scores.push(
        scoreHushLs({
          id: fixture.id,
          argv: fixture.argv,
          raw: raw.stdout,
          rtk: baseline.stdout,
          hush: reduced.value.reducedText,
          fidelity: reduced.value.fidelity,
          omissionRecords: reduced.value.omissions.length,
          retainsEveryEntry: fixture.expectedEntries.every((entry) =>
            reduced.value.reducedText.includes(entry),
          ),
          truncated: reduced.value.truncated,
          recoverable:
            reduced.value.expansion.stdoutInline &&
            reduced.value.exit.exitCode === raw.exitCode &&
            reduced.value.command.cwd === root,
        }),
      );
    }
    return {
      corpusVersion: HUSH_LS_CORPUS_VERSION,
      hushVersion: HUSH_REDUCER_VERSION,
      rtkVersion: versionRun.stdout.trim(),
      estimator: "ceil(utf8-bytes/4)",
      scores,
      passes: passesHushLsScorecard(scores),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function formatOutputComparisons(scorecard: HushLsScorecard): string {
  return scorecard.scores
    .map(
      (score) =>
        `\n## ${score.id}: ls ${score.argv.join(" ")}\nrtk:\n${score.rtk.text}\nHush:\n${score.hush.text}`,
    )
    .join("\n");
}

async function main(): Promise<void> {
  const scorecard = await createHushLsScorecard();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(scorecard, null, 2));
  } else {
    console.log(formatHushLsScorecard(scorecard));
    if (process.argv.includes("--show-output")) {
      console.log(formatOutputComparisons(scorecard));
    }
  }
  if (!scorecard.passes) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
