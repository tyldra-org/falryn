/** Compare every non-ls/tree Hush projection with pinned RTK on controlled output. */

import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HushProjectionKind } from "../src/domain/hush/catalog/index.ts";
import { matchHushCommand } from "../src/domain/hush/catalog/index.ts";
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
import { type HushLsMeasurement, measureText } from "./hush-ls-scorecard.ts";

export const HUSH_PROJECTION_CORPUS_VERSION = "hush-projections.v2";

type ProjectionCase = Readonly<{
  id: string;
  projection: HushProjectionKind;
  executable: string;
  argv: readonly string[];
  rtkArgv: readonly string[];
  requiredMarkers: readonly string[];
  forbiddenMarkers?: readonly string[];
}>;

export const HUSH_PROJECTION_CASES = [
  {
    id: "listing-find",
    projection: "listing",
    executable: "find",
    argv: ["corpus", "-type", "f"],
    rtkArgv: ["find", "corpus", "-type", "f"],
    requiredMarkers: ["src/main.ts", "src/domain/hush.ts", "docs/README.md"],
  },
  {
    id: "read-cat",
    projection: "read",
    executable: "cat",
    argv: ["fixture.txt"],
    rtkArgv: ["read", "fixture.txt"],
    requiredMarkers: ["# Falryn", "Do more with less context.", "Keep every useful fact."],
  },
  {
    id: "json-structure",
    projection: "json",
    executable: "json",
    argv: ["config.json"],
    rtkArgv: ["json", "--keys-only", "config.json"],
    requiredMarkers: ["serviceName", "enabled", "targets", "arch", "os", "metadata", "ports"],
    forbiddenMarkers: [
      "falryn-private-value",
      "darwin-private",
      "arm64-private",
      "owner-private",
      "3000",
    ],
  },
  {
    id: "search-rg",
    projection: "search",
    executable: "rg",
    argv: ["marker", "."],
    rtkArgv: ["rg", "marker", "."],
    requiredMarkers: ["first marker", "second marker", "third marker", "fourth marker"],
  },
  {
    id: "git-status",
    projection: "git-status",
    executable: "git",
    argv: ["status", "--short", "--branch"],
    rtkArgv: ["git", "status", "--short", "--branch"],
    requiredMarkers: [
      "main",
      "src/domain/hush.ts",
      "reducers/semantic.ts",
      "hush-projection-scorecard.ts",
    ],
  },
  {
    id: "git-diff",
    projection: "git-diff",
    executable: "git",
    argv: ["diff"],
    rtkArgv: ["git", "diff"],
    requiredMarkers: ["src/a.ts", "mode = 'sample'", "mode = 'complete'", "marker = 736"],
  },
  {
    id: "git-log",
    projection: "git-log",
    executable: "git",
    argv: ["log", "-1"],
    rtkArgv: ["git", "log", "-1"],
    requiredMarkers: ["1111111", "Preserve complete context"],
  },
  {
    id: "git-mutation",
    projection: "git-mutation",
    executable: "git",
    argv: ["push"],
    rtkArgv: ["git", "push"],
    requiredMarkers: ["feature", "1111111", "2222222"],
  },
  {
    id: "forge-gh",
    projection: "forge",
    executable: "gh",
    argv: ["issue", "list"],
    rtkArgv: ["gh", "issue", "list"],
    requiredMarkers: ["128", "736", "784", "Do more with less context"],
  },
  {
    id: "test-pytest",
    projection: "test",
    executable: "pytest",
    argv: [],
    rtkArgv: ["pytest"],
    requiredMarkers: ["2 passed", "0.12s"],
  },
  {
    id: "diagnostic-tsc",
    projection: "diagnostic",
    executable: "tsc",
    argv: ["--noEmit"],
    rtkArgv: ["tsc", "--noEmit"],
    requiredMarkers: ["src/a.ts", "TS2322", "src/b.ts", "TS2304", "Found 2 errors"],
  },
  {
    id: "build-cargo",
    projection: "build",
    executable: "cargo",
    argv: ["build", "--release"],
    rtkArgv: ["cargo", "build", "--release"],
    requiredMarkers: ["Finished release target", "0.42s"],
  },
  {
    id: "package-npm",
    projection: "package",
    executable: "npm",
    argv: ["install"],
    rtkArgv: ["npm", "install"],
    requiredMarkers: ["added 12 packages", "audited 13 packages", "0 vulnerabilities"],
  },
  {
    id: "table-docker",
    projection: "table",
    executable: "docker",
    argv: ["ps"],
    rtkArgv: ["docker", "ps"],
    requiredMarkers: ["abc123", "falryn-dev", "def456", "falryn-db"],
  },
  {
    id: "log-docker",
    projection: "log",
    executable: "docker",
    argv: ["logs", "falryn-dev"],
    rtkArgv: ["docker", "logs", "falryn-dev"],
    requiredMarkers: ["service started", "req-736", "req-784"],
  },
  {
    id: "curl-json",
    projection: "curl",
    executable: "curl",
    argv: ["https://example.test/status"],
    rtkArgv: ["curl", "https://example.test/status"],
    requiredMarkers: ["req-736", "reducers", "81", "complete", "true"],
    forbiddenMarkers: ["% Total", "Dload", "1020"],
  },
  {
    id: "wget-download",
    projection: "wget",
    executable: "wget",
    argv: ["https://example.test/releases/falryn.tar.gz"],
    rtkArgv: ["wget", "https://example.test/releases/falryn.tar.gz"],
    requiredMarkers: ["200", "example.test/releases/falryn.tar.gz", "falryn.tar.gz", "1.5KB"],
    forbiddenMarkers: ["Resolving", "Connecting", "100%", "saved ["],
  },
  {
    id: "network-ssh",
    projection: "network",
    executable: "ssh",
    argv: ["example.test", "echo", "connected"],
    rtkArgv: ["ssh", "example.test", "echo", "connected"],
    requiredMarkers: ["connected", "example.test", "remote command: ok"],
  },
  {
    id: "operation-terraform",
    projection: "operation",
    executable: "terraform",
    argv: ["plan"],
    rtkArgv: ["terraform", "plan"],
    requiredMarkers: ["falryn_context.primary", "0 to add", "1 to change", "0 to destroy"],
  },
  {
    id: "structured-aws",
    projection: "structured",
    executable: "aws",
    argv: ["sts", "get-caller-identity"],
    rtkArgv: ["aws", "sts", "get-caller-identity"],
    requiredMarkers: ["123456789012", "user=falryn", "AIDAEXAMPLE"],
  },
] as const satisfies readonly ProjectionCase[];

type CommandRun = Readonly<{ stdout: string; stderr: string; exitCode: number }>;

export type HushProjectionScore = Readonly<{
  id: string;
  projection: HushProjectionKind;
  raw: HushLsMeasurement;
  rtk: HushLsMeasurement;
  hush: HushLsMeasurement;
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

async function createScorecard(): Promise<HushProjectionScorecard> {
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
    const versionRun = runCommand([rtk, "--version"], root, fixtureBin);
    if (versionRun.exitCode !== 0) {
      throw new Error(`rtk --version failed: ${versionRun.stderr.trim()}`);
    }

    const scores: HushProjectionScore[] = [];
    const cases: readonly ProjectionCase[] = HUSH_PROJECTION_CASES;
    for (const [index, fixture] of cases.entries()) {
      const executable =
        fixture.executable === "find"
          ? (Bun.which("find") ?? join(fixtureBin, fixture.executable))
          : join(fixtureBin, fixture.executable);
      const raw = runCommand([executable, ...fixture.argv], root, fixtureBin);
      const baseline = runCommand([rtk, ...fixture.rtkArgv], root, fixtureBin);
      if (raw.exitCode !== 0 || baseline.exitCode !== 0) {
        throw new Error(
          `${fixture.id} failed: raw=${raw.exitCode} rtk=${baseline.exitCode}\n${raw.stderr}${baseline.stderr}`,
        );
      }
      const reduced = reduceHush({
        command: {
          executable,
          argv: fixture.argv,
          environment: {},
          cwd: root,
          timeoutMs: duration(10_000),
          maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
        },
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
        matchHushCommand([fixture.executable, ...fixture.argv])?.projection === fixture.projection;
      const passes =
        withinRtkBudget &&
        retainsRequiredContext &&
        excludesKnownNoise &&
        noArbitraryCap &&
        recognized;
      scores.push({
        id: fixture.id,
        projection: fixture.projection,
        raw: rawMeasurement,
        rtk: rtkMeasurement,
        hush: hushMeasurement,
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
  await Promise.all([
    mkdir(join(root, "corpus", "src", "domain"), { recursive: true }),
    mkdir(join(root, "corpus", "docs"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "corpus", "src", "main.ts"), "export {};\n"),
    writeFile(join(root, "corpus", "src", "domain", "hush.ts"), "export {};\n"),
    writeFile(join(root, "corpus", "docs", "README.md"), "# Corpus\n"),
  ]);
}

export function formatHushProjectionScorecard(scorecard: HushProjectionScorecard): string {
  const headings = ["projection", "raw", "rtk", "hush", "delta", "context", "result"];
  const rows = scorecard.scores.map((score) => [
    score.projection,
    formatMeasurement(score.raw),
    formatMeasurement(score.rtk),
    formatMeasurement(score.hush),
    `${score.rtk.estimatedTokens - score.hush.estimatedTokens}t`,
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

async function createFixtureCommands(root: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const source = join(import.meta.dir, "fixtures", "hush-projection-command.ts");
  await Promise.all(
    [...new Set(HUSH_PROJECTION_CASES.map((fixture) => fixture.executable))].map(
      async (executable) => {
        const target = join(bin, executable);
        await copyFile(source, target);
        await chmod(target, 0o755);
      },
    ),
  );
  return bin;
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
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    exitCode: result.exitCode,
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

function stream(name: "stdout" | "stderr", text: string) {
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
  const scorecard = await createScorecard();
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify(scorecard, null, 2)
      : formatHushProjectionScorecard(scorecard),
  );
  if (!scorecard.passes) {
    process.exitCode = 1;
  }
}
