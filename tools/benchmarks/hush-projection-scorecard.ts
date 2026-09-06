/** Compare every non-ls/tree Hush projection with pinned RTK on controlled output. */

export {
  HUSH_FIND_LISTING_PATHS,
  HUSH_PROJECTION_CASES,
} from "./hush-projection-scorecard/corpus.ts";

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareHushCaptureRequest } from "../../src/application/compression/hush-capture-command.ts";
import { classifyCommand } from "../../src/domain/compression/hush/routing/classify.ts";
import type { HushProjectionKind } from "../../src/domain/compression/hush/routing/index.ts";
import { HUSH_REDUCER_VERSION, reduceHush } from "../../src/domain/compression/index.ts";
import { duration, instant, processCaptureId } from "../../src/domain/foundation/index.ts";
import {
  MAX_COMMAND_OUTPUT_BYTES,
  type ProcessCaptureReport,
} from "../../src/domain/process/index.ts";
import { HUSH_RTK_BASELINE } from "./hush-command-coverage.ts";
import { type HushLsMeasurement, measureText } from "./hush-ls-scorecard.ts";
import type { ProjectionCase } from "./hush-projection-case.ts";
import {
  HUSH_FIND_LISTING_PATHS,
  HUSH_PROJECTION_CASES,
} from "./hush-projection-scorecard/corpus.ts";
import { createFixtureCommands } from "./hush-projection-scorecard/fixture-commands.ts";

export const HUSH_PROJECTION_CORPUS_VERSION = "hush-projections.v33";

type CommandRun = Readonly<{ stdout: string; stderr: string; exitCode: number }>;

export type HushProjectionScore = Readonly<{
  id: string;
  projection: HushProjectionKind;
  gate: "rtk" | "raw" | "rewrite" | "rtk-log";
  raw: HushLsMeasurement;
  rtk: HushLsMeasurement;
  hush: HushLsMeasurement;
  competitiveTarget: "tie" | "win";
  competitiveResult: "loss" | "tie" | "win";
  meetsCompetitiveTarget: boolean;
  withinRtkBudget: boolean;
  retainsRequiredContext: boolean;
  excludesKnownNoise: boolean;
  noArbitraryCap: boolean;
  recognized: boolean;
  result: "PASS" | "FAIL";
}>;

export type HushProjectionScorecard = Readonly<{
  corpusVersion: typeof HUSH_PROJECTION_CORPUS_VERSION;
  hushVersion: typeof HUSH_REDUCER_VERSION;
  rtkVersion: string;
  rtkCommit: typeof HUSH_RTK_BASELINE.commit;
  scores: readonly HushProjectionScore[];
  passes: boolean;
}>;

export async function createHushProjectionScorecard(): Promise<HushProjectionScorecard> {
  const rtk = Bun.which("rtk");
  if (rtk === null) {
    throw new Error("hush projection scorecard requires a local rtk binary");
  }
  const root = await mkdtemp(join(tmpdir(), "falryn-hush-projections-"));
  try {
    const fixtureBin = await createFixtureCommands(root);
    await createListingCorpus(root);
    await writeFile(
      join(root, "fixture.txt"),
      "# Falryn\n\nDo more with less context.\nKeep every useful fact.\n",
    );
    await writeFile(
      join(root, "config.json"),
      `${JSON.stringify(
        {
          serviceName: "falryn-private-value",
          enabled: true,
          targets: [
            { os: "darwin-private", arch: "arm64-private" },
            { os: "linux-private", arch: "x64-private" },
          ],
          metadata: { owner: "owner-private", nested: { marker: "deep-private" } },
          ports: [3000, 3001, 3002],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(root, "diff-before.ts"),
      [
        "export function project() {",
        '  const mode = "sample";',
        "  const marker = 736;",
        "  return mode;",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "diff-after.ts"),
      [
        "export function project() {",
        '  const mode = "complete";',
        "  const marker = 736;",
        "  const exact = true;",
        '  return exact ? mode : "sample";',
        "}",
        "",
      ].join("\n"),
    );
    const versionRun = runCommand([rtk, "--version"], root, fixtureBin);
    if (versionRun.exitCode !== 0) {
      throw new Error(`rtk --version failed: ${versionRun.stderr.trim()}`);
    }

    const scores: HushProjectionScore[] = [];
    const cases: readonly ProjectionCase[] = HUSH_PROJECTION_CASES;
    for (const [index, fixture] of cases.entries()) {
      const executable = projectionExecutable(fixture, fixtureBin);
      const command =
        fixture.shellCommand === undefined
          ? ({
              executable,
              argv: fixture.argv,
              environment: {},
              cwd: root,
              timeoutMs: duration(10_000),
              maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
            } as const)
          : ({
              mode: "bash",
              executable,
              command: fixture.shellCommand,
              environment: {},
              cwd: root,
              timeoutMs: duration(10_000),
              maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
            } as const);
      const prepared = prepareHushCaptureRequest(command);
      const raw =
        prepared.mode === "bash"
          ? runCommand([prepared.executable, "-c", prepared.command], root, fixtureBin)
          : runCommand([prepared.executable, ...prepared.argv], root, fixtureBin);
      const baseline = runBaseline(fixture, raw, rtk, executable, root, fixtureBin);
      const acceptedExitCodes = fixture.acceptedExitCodes ?? [0];
      if (
        !acceptedExitCodes.includes(raw.exitCode) ||
        !acceptedExitCodes.includes(baseline.exitCode)
      ) {
        throw new Error(
          `${fixture.id} failed: raw=${raw.exitCode} rtk=${baseline.exitCode}\n${raw.stderr}${baseline.stderr}`,
        );
      }
      const reduced = reduceHush({
        command,
        capture: capture(`hush-projection-${index}`, raw),
      });
      if (!reduced.ok) {
        throw new Error(`${fixture.id} Hush reduction failed: ${reduced.error.reason}`);
      }
      const rawMeasurement = measureText(combinedOutput(raw));
      const rtkMeasurement = measureText(combinedOutput(baseline));
      const hushMeasurement = measureText(reduced.value.reducedText);
      const withinRtkBudget =
        hushMeasurement.bytes <= rtkMeasurement.bytes &&
        hushMeasurement.estimatedTokens <= rtkMeasurement.estimatedTokens;
      const competitiveTarget = fixture.competitiveTarget ?? "tie";
      const competitiveResult = !withinRtkBudget
        ? "loss"
        : hushMeasurement.bytes < rtkMeasurement.bytes &&
            hushMeasurement.estimatedTokens < rtkMeasurement.estimatedTokens
          ? "win"
          : "tie";
      const meetsCompetitiveTarget =
        competitiveTarget === "win" ? competitiveResult === "win" : competitiveResult !== "loss";
      const retainsRequiredContext = fixture.requiredMarkers.every((marker) =>
        reduced.value.reducedText.includes(marker),
      );
      const excludesKnownNoise = (fixture.forbiddenMarkers ?? []).every(
        (marker) => !reduced.value.reducedText.includes(marker),
      );
      const noArbitraryCap =
        !reduced.value.truncated &&
        !reduced.value.omissions.some((omission) => omission.kind === "capped-bytes");
      const recognized =
        classifyCommand(command, capture(`classify-${index}`, raw)).projection ===
        fixture.projection;
      const passes =
        meetsCompetitiveTarget &&
        retainsRequiredContext &&
        excludesKnownNoise &&
        noArbitraryCap &&
        recognized;
      scores.push({
        id: fixture.id,
        projection: fixture.projection,
        gate: fixture.baseline ?? "rtk",
        raw: rawMeasurement,
        rtk: rtkMeasurement,
        hush: hushMeasurement,
        competitiveTarget,
        competitiveResult,
        meetsCompetitiveTarget,
        withinRtkBudget,
        retainsRequiredContext,
        excludesKnownNoise,
        noArbitraryCap,
        recognized,
        result: passes ? "PASS" : "FAIL",
      });
    }
    return {
      corpusVersion: HUSH_PROJECTION_CORPUS_VERSION,
      hushVersion: HUSH_REDUCER_VERSION,
      rtkVersion: versionRun.stdout.trim(),
      rtkCommit: HUSH_RTK_BASELINE.commit,
      scores,
      passes: scores.every((score) => score.result === "PASS"),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createListingCorpus(root: string): Promise<void> {
  await Promise.all(
    HUSH_FIND_LISTING_PATHS.map(async (path) => {
      const target = join(root, "corpus", "src", "domain", "hush", path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "export {};\n");
    }),
  );
}

export function formatHushProjectionScorecard(scorecard: HushProjectionScorecard): string {
  const headings = [
    "case",
    "gate",
    "goal",
    "raw",
    "ceiling",
    "hush",
    "delta",
    "race",
    "context",
    "result",
  ];
  const rows = scorecard.scores.map((score) => [
    score.id,
    score.gate,
    score.competitiveTarget,
    formatMeasurement(score.raw),
    formatMeasurement(score.rtk),
    formatMeasurement(score.hush),
    `${score.rtk.estimatedTokens - score.hush.estimatedTokens}t`,
    score.competitiveResult,
    score.retainsRequiredContext && score.excludesKnownNoise && score.noArbitraryCap
      ? "all"
      : "loss",
    score.result,
  ]);
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const formatRow = (row: readonly string[]): string =>
    row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("  ");
  return [
    `Hush projection scorecard ${scorecard.corpusVersion}`,
    `Hush ${scorecard.hushVersion} vs ${scorecard.rtkVersion} (${scorecard.rtkCommit})`,
    formatRow(headings),
    formatRow(widths.map((width) => "-".repeat(width))),
    ...rows.map(formatRow),
    `scorecard: ${scorecard.passes ? "PASS" : "FAIL"}`,
  ].join("\n");
}

function projectionExecutable(fixture: ProjectionCase, fixtureBin: string): string {
  if (fixture.shellCommand !== undefined) {
    const bash = Bun.which("bash");
    if (bash === null) {
      throw new Error(`${fixture.id} requires bash`);
    }
    return bash;
  }
  return fixture.executable === "find"
    ? (Bun.which("find") ?? join(fixtureBin, fixture.executable))
    : join(fixtureBin, fixture.executable);
}

function runBaseline(
  fixture: ProjectionCase,
  raw: CommandRun,
  rtk: string,
  executable: string,
  cwd: string,
  fixtureBin: string,
): CommandRun {
  if (fixture.baseline === "raw") {
    return raw;
  }
  if (fixture.baseline === "rewrite") {
    const source = fixture.shellCommand;
    if (source === undefined) {
      throw new Error(`${fixture.id} rewrite baseline requires a shell command`);
    }
    const rewritten = runCommand([rtk, "rewrite", source], cwd, fixtureBin);
    if (rewritten.exitCode === 1) {
      return runCommand([executable, "-c", source], cwd, fixtureBin);
    }
    if (![0, 3].includes(rewritten.exitCode) || rewritten.stdout.trim().length === 0) {
      throw new Error(
        `${fixture.id} RTK rewrite failed: exit=${rewritten.exitCode} stdout=${JSON.stringify(rewritten.stdout)} stderr=${JSON.stringify(rewritten.stderr)}`,
      );
    }
    return runCommand([executable, "-c", rewritten.stdout.trim()], cwd, fixtureBin);
  }
  if (fixture.baseline === "rtk-log") {
    return runCommand([rtk, "log"], cwd, fixtureBin, raw.stdout);
  }
  if (fixture.rtkArgv === undefined) {
    throw new Error(`${fixture.id} requires RTK argv`);
  }
  return runCommand([rtk, ...fixture.rtkArgv], cwd, fixtureBin);
}

function runCommand(
  command: readonly string[],
  cwd: string,
  fixtureBin: string,
  stdin?: string,
): CommandRun {
  const result = Bun.spawnSync([...command], {
    cwd,
    env: {
      COLUMNS: "120",
      LC_ALL: "C",
      NO_COLOR: "1",
      PATH: `${fixtureBin}:${process.env.PATH ?? ""}`,
      FALRYN_HUSH_FIXTURE_CWD: cwd,
      ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
    },
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    exitCode: result.exitCode,
  };
}

export function capture(id: string, run: CommandRun): ProcessCaptureReport {
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

export function stream(name: "stdout" | "stderr", text: string) {
  const bytes = new TextEncoder().encode(text);
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

function formatMeasurement(measurement: HushLsMeasurement): string {
  return `${measurement.bytes}B/${measurement.estimatedTokens}t`;
}

function combinedOutput(run: CommandRun): string {
  const parts: string[] = [];
  if (run.stdout.length > 0) {
    parts.push(run.stdout);
  }
  if (run.stderr.length > 0) {
    parts.push(`stderr:\n${run.stderr}`);
  }
  return parts.join("\n");
}

if (import.meta.main) {
  const scorecard = await createHushProjectionScorecard();
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify(scorecard, null, 2)
      : formatHushProjectionScorecard(scorecard),
  );
  if (!scorecard.passes) {
    process.exitCode = 1;
  }
}
