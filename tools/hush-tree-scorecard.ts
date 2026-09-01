/** Compare Hush tree projection with the pinned RTK filter on one controlled corpus. */

import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treeEntryFacts } from "../src/domain/hush/reducers/tree/format.ts";
import {
  duration,
  HUSH_REDUCER_VERSION,
  instant,
  MAX_COMMAND_OUTPUT_BYTES,
  type ProcessCaptureReport,
  processCaptureId,
  reduceHush,
} from "../src/domain/index.ts";
import { HUSH_RTK_BASELINE } from "./hush-command-coverage.ts";

export const HUSH_TREE_CORPUS_VERSION = "hush-tree.v2";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CORPUS_CASES = [
  { id: "default", argv: [] },
  { id: "depth", argv: ["-L", "2"] },
  { id: "directories", argv: ["-d"] },
  { id: "show-all", argv: ["-a", "-L", "3"] },
  { id: "caller-ignore", argv: ["-I", "vendor", "-L", "4"] },
  { id: "full-path", argv: ["-f", "-L", "5"] },
  { id: "permissions", argv: ["-p", "-L", "5"] },
  { id: "classify", argv: ["-F", "-L", "5"] },
  { id: "ascii", argv: ["--charset", "ASCII", "-L", "5"] },
  { id: "no-report", argv: ["--noreport"] },
  { id: "empty", argv: ["empty"] },
] as const;

type CommandRun = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export type HushTreeMeasurement = Readonly<{
  bytes: number;
  estimatedTokens: number;
  text: string;
}>;

export type HushTreeScore = Readonly<{
  id: string;
  argv: readonly string[];
  raw: HushTreeMeasurement;
  rtk: HushTreeMeasurement;
  hush: HushTreeMeasurement;
  fidelity: "exact" | "deterministic-reduction" | "raw-fallback";
  omissionRecords: number;
  sameInformation: boolean;
  truncated: boolean;
  recoverable: boolean;
  withinRtkBudget: boolean;
}>;

export type HushTreeScorecard = Readonly<{
  corpusVersion: typeof HUSH_TREE_CORPUS_VERSION;
  hushVersion: typeof HUSH_REDUCER_VERSION;
  rtkVersion: string;
  rtkCommit: typeof HUSH_RTK_BASELINE.commit;
  estimator: "ceil(utf8-bytes/4)";
  scores: readonly HushTreeScore[];
  passes: boolean;
}>;

export function estimateTreeTokens(text: string): number {
  return Math.ceil(encoder.encode(text).byteLength / 4);
}

export function measureTreeText(text: string): HushTreeMeasurement {
  return {
    bytes: encoder.encode(text).byteLength,
    estimatedTokens: estimateTreeTokens(text),
    text,
  };
}

export function scoreHushTree(input: {
  readonly id: string;
  readonly argv: readonly string[];
  readonly raw: string;
  readonly rtk: string;
  readonly hush: string;
  readonly fidelity: HushTreeScore["fidelity"];
  readonly omissionRecords: number;
  readonly truncated: boolean;
  readonly recoverable: boolean;
}): HushTreeScore {
  const raw = measureTreeText(input.raw);
  const rtk = measureTreeText(input.rtk);
  const hush = measureTreeText(input.hush);
  const parseOptions = { directoriesOnly: input.argv.includes("-d") };
  const rtkFacts = treeEntryFacts(rtk.text, parseOptions);
  const hushFacts = treeEntryFacts(hush.text, parseOptions);
  return {
    id: input.id,
    argv: input.argv,
    raw,
    rtk,
    hush,
    fidelity: input.fidelity,
    omissionRecords: input.omissionRecords,
    sameInformation: rtkFacts !== null && hushFacts !== null && arraysEqual(rtkFacts, hushFacts),
    truncated: input.truncated,
    recoverable: input.recoverable,
    withinRtkBudget: hush.bytes <= rtk.bytes && hush.estimatedTokens <= rtk.estimatedTokens,
  };
}

export function passesHushTreeScorecard(scores: readonly HushTreeScore[]): boolean {
  return scores.length > 0 && scores.every(passesHushTreeScore);
}

export function formatHushTreeScorecard(scorecard: HushTreeScorecard): string {
  const headings = ["case", "raw", "rtk", "hush", "delta", "info", "result"] as const;
  const rows = scorecard.scores.map((score) => [
    score.id,
    formatMeasurement(score.raw),
    formatMeasurement(score.rtk),
    formatMeasurement(score.hush),
    `${score.rtk.estimatedTokens - score.hush.estimatedTokens}t`,
    score.sameInformation ? "all" : "loss",
    passesHushTreeScore(score) ? "PASS" : "FAIL",
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
    scorecard.scores.every((score) => score.sameInformation) ? "all" : "loss",
    scorecard.passes ? "PASS" : "FAIL",
  ]);
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const formatRow = (row: readonly string[]): string =>
    row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("  ");
  return [
    `Hush tree scorecard ${scorecard.corpusVersion}`,
    `Hush ${scorecard.hushVersion} vs ${scorecard.rtkVersion} (${scorecard.rtkCommit}); tokens=${scorecard.estimator}`,
    formatRow(headings),
    formatRow(widths.map((width) => "-".repeat(width))),
    ...rows.map(formatRow),
    `scorecard: ${scorecard.passes ? "PASS" : "FAIL"}`,
  ].join("\n");
}

function passesHushTreeScore(score: HushTreeScore): boolean {
  return (
    score.withinRtkBudget &&
    score.sameInformation &&
    score.fidelity !== "raw-fallback" &&
    score.omissionRecords === 0 &&
    !score.truncated &&
    score.recoverable
  );
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatMeasurement(measurement: HushTreeMeasurement): string {
  return `${measurement.bytes}B/${measurement.estimatedTokens}t`;
}

function totalMeasurement(
  scores: readonly HushTreeScore[],
  lane: "raw" | "rtk" | "hush",
): HushTreeMeasurement {
  return {
    bytes: scores.reduce((total, score) => total + score[lane].bytes, 0),
    estimatedTokens: scores.reduce((total, score) => total + score[lane].estimatedTokens, 0),
    text: "",
  };
}

function runCommand(command: readonly string[], cwd: string, fixtureBin: string): CommandRun {
  const result = Bun.spawnSync([...command], {
    cwd,
    env: {
      COLUMNS: "120",
      LC_ALL: "C",
      NO_COLOR: "1",
      PATH: `${fixtureBin}:${process.env.PATH ?? ""}`,
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

async function createFixtureCommand(
  root: string,
): Promise<Readonly<{ bin: string; tree: string }>> {
  const bin = join(root, "bin");
  const tree = join(bin, "tree");
  await mkdir(bin, { recursive: true });
  await copyFile(join(import.meta.dir, "fixtures", "hush-tree-command.ts"), tree);
  await chmod(tree, 0o755);
  return { bin, tree };
}

export async function createHushTreeScorecard(): Promise<HushTreeScorecard> {
  const rtk = Bun.which("rtk");
  if (rtk === null) {
    throw new Error("hush tree scorecard requires a local rtk binary");
  }
  const root = await mkdtemp(join(tmpdir(), "falryn-hush-tree-"));
  try {
    const fixture = await createFixtureCommand(root);
    const versionRun = runCommand([rtk, "--version"], root, fixture.bin);
    if (versionRun.exitCode !== 0) {
      throw new Error(`rtk --version failed: ${versionRun.stderr.trim()}`);
    }
    const scores: HushTreeScore[] = [];
    for (const [index, corpus] of CORPUS_CASES.entries()) {
      const raw = runCommand([fixture.tree, ...corpus.argv], root, fixture.bin);
      const baseline = runCommand([rtk, "tree", ...corpus.argv], root, fixture.bin);
      if (raw.exitCode !== 0 || baseline.exitCode !== 0) {
        throw new Error(
          `${corpus.id} failed: tree=${raw.exitCode} rtk=${baseline.exitCode} ${raw.stderr}${baseline.stderr}`,
        );
      }
      const reduced = reduceHush({
        command: {
          executable: fixture.tree,
          argv: corpus.argv,
          environment: {},
          cwd: root,
          timeoutMs: duration(10_000),
          maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
        },
        capture: capture(`hush-tree-${index}`, raw),
      });
      if (!reduced.ok) {
        throw new Error(`${corpus.id} Hush reduction failed: ${reduced.error.reason}`);
      }
      scores.push(
        scoreHushTree({
          id: corpus.id,
          argv: corpus.argv,
          raw: raw.stdout,
          rtk: baseline.stdout,
          hush: reduced.value.reducedText,
          fidelity: reduced.value.fidelity,
          omissionRecords: reduced.value.omissions.length,
          truncated: reduced.value.truncated,
          recoverable:
            reduced.value.expansion.stdoutInline &&
            reduced.value.exit.exitCode === raw.exitCode &&
            reduced.value.command.cwd === root,
        }),
      );
    }
    return {
      corpusVersion: HUSH_TREE_CORPUS_VERSION,
      hushVersion: HUSH_REDUCER_VERSION,
      rtkVersion: versionRun.stdout.trim(),
      rtkCommit: HUSH_RTK_BASELINE.commit,
      estimator: "ceil(utf8-bytes/4)",
      scores,
      passes: passesHushTreeScorecard(scores),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const scorecard = await createHushTreeScorecard();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(scorecard, null, 2));
  } else {
    console.log(formatHushTreeScorecard(scorecard));
  }
  if (!scorecard.passes) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
