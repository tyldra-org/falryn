/** Compare every non-ls/tree Hush projection with pinned RTK on controlled output. */

import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareHushCaptureRequest } from "../src/application/hush-capture-command.ts";
import type { HushProjectionKind } from "../src/domain/hush/catalog/index.ts";
import { classifyCommand } from "../src/domain/hush/classification.ts";
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

export const HUSH_PROJECTION_CORPUS_VERSION = "hush-projections.v11";

export const HUSH_FIND_LISTING_PATHS = [
  "bounds.ts",
  "catalog/contracts.ts",
  "catalog/files.ts",
  "catalog/index.ts",
  "catalog/javascript.ts",
  "catalog/languages.ts",
  "catalog/operations.ts",
  "catalog/version-control.ts",
  "classification.ts",
  "command-shape.ts",
  "contracts.ts",
  "git-command.test.ts",
  "git-command.ts",
  "github-command.ts",
  "reducers/compound/projection.test.ts",
  "reducers/compound/projection.ts",
  "reducers/forge/github/format.test.ts",
  "reducers/forge/github/issue-list.ts",
  "reducers/forge/github/json.ts",
  "reducers/forge/github/pr-list.ts",
  "reducers/forge/github/pr-view.ts",
  "reducers/forge/github/projection.ts",
  "reducers/forge/github/run-list.ts",
  "reducers/forge/projection.test.ts",
  "reducers/forge/projection.ts",
  "reducers/git/diff.ts",
  "reducers/git/index.ts",
  "reducers/git/mutation.ts",
  "reducers/git/mutation/add.ts",
  "reducers/git/mutation/commit.ts",
  "reducers/git/mutation/pull.ts",
  "reducers/git/mutation/push.ts",
  "reducers/git/mutation/shared.ts",
  "reducers/git/paths.ts",
  "reducers/git/status.ts",
  "reducers/http/curl.ts",
  "reducers/http/progress.ts",
  "reducers/http/wget.ts",
  "reducers/index.ts",
  "reducers/json/format.test.ts",
  "reducers/json/format.ts",
  "reducers/json/projection.ts",
  "reducers/listing.ts",
  "reducers/listing/format.test.ts",
  "reducers/listing/format.ts",
  "reducers/lossless-text.ts",
  "reducers/ls/block-format.ts",
  "reducers/ls/format.test.ts",
  "reducers/ls/long-format.ts",
  "reducers/ls/projection.ts",
  "reducers/search/format.test.ts",
  "reducers/search/format.ts",
  "reducers/search/projection.ts",
  "reducers/semantic.ts",
  "reducers/structured/projection.ts",
  "reducers/table/format.ts",
  "reducers/table/projection.ts",
  "reducers/transform/projection.ts",
  "reducers/tree/format.test.ts",
  "reducers/tree/format.ts",
  "reducers/tree/parser.ts",
  "reducers/tree/policy.ts",
  "reducers/tree/projection.ts",
  "reducers/tree/render.ts",
  "shell-command.test.ts",
  "shell-command.ts",
  "text-format.ts",
] as const;

const HUSH_FIND_LISTING_MARKERS = [
  "67 files (*.ts)",
  "./ bounds classification command-shape contracts git-command git-command.test github-command shell-command shell-command.test text-format",
  "catalog/ contracts files index javascript languages operations version-control",
  "reducers/ index listing lossless-text semantic",
  " compound/ projection projection.test",
  " forge/ projection projection.test",
  "  github/ format.test issue-list json pr-list pr-view projection run-list",
  " git/ diff index mutation paths status",
  "  mutation/ add commit pull push shared",
  " http/ curl progress wget",
  " json/ format format.test projection",
  " listing/ format format.test",
  " ls/ block-format format.test long-format projection",
  " search/ format format.test projection",
  " structured/ projection",
  " table/ format projection",
  " transform/ projection",
  " tree/ format format.test parser policy projection render",
] as const;

type ProjectionCase = Readonly<{
  id: string;
  projection: HushProjectionKind;
  executable: string;
  argv: readonly string[];
  rtkArgv?: readonly string[];
  shellCommand?: string;
  baseline?: "raw" | "rewrite" | "rtk-log";
  acceptedExitCodes?: readonly number[];
  requiredMarkers: readonly string[];
  forbiddenMarkers?: readonly string[];
}>;

export const HUSH_PROJECTION_CASES = [
  {
    id: "listing-find",
    projection: "listing",
    executable: "find",
    argv: ["corpus/src/domain/hush", "-type", "f"],
    rtkArgv: ["find", "corpus/src/domain/hush", "-type", "f"],
    requiredMarkers: HUSH_FIND_LISTING_MARKERS,
    forbiddenMarkers: ["+17 more", "omitted", "…"],
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
    id: "data-psql-table",
    projection: "structured",
    executable: "psql",
    argv: ["-c", "select id, task, status, token_savings from work_items order by id"],
    rtkArgv: ["psql", "-c", "select id, task, status, token_savings from work_items order by id"],
    requiredMarkers: [
      "id\ttask\tstatus\ttoken_savings",
      "1\tOptimize nested JSON\tdone\t32",
      "2\tPreserve database rows\tactive\t0",
      "3\tVerify model context\tpending\t18",
    ],
    forbiddenMarkers: ["----+", "(3 rows)", "omitted", "…"],
  },
  {
    id: "data-psql-expanded",
    projection: "structured",
    executable: "psql",
    argv: ["-x", "-c", "select id, task, status from work_items order by id"],
    rtkArgv: ["psql", "-x", "-c", "select id, task, status from work_items order by id"],
    requiredMarkers: [
      "record\tid\ttask\tstatus",
      "1\t101\tInvestigate latency\tactive",
      "2\t102\tVerify recovery\tdone",
    ],
    forbiddenMarkers: ["-[ RECORD", "(2 rows)", "omitted", "…"],
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
    id: "transform-sed",
    projection: "transform",
    executable: "sed",
    argv: ["-n", "1,3p", "fixture.txt"],
    baseline: "raw",
    requiredMarkers: ["# Falryn", "Do more with less context."],
  },
  {
    id: "compound-rg-sed-pipe",
    projection: "compound",
    executable: "bash",
    argv: [],
    shellCommand: "rg marker . | sed -n '1,3p'",
    baseline: "rewrite",
    requiredMarkers: ["first marker", "second marker", "third marker"],
    forbiddenMarkers: ["fourth marker", "omitted", "…"],
  },
  {
    id: "compound-pipe-rg",
    projection: "compound",
    executable: "bash",
    argv: [],
    shellCommand: "cat fixture.txt | rg marker",
    baseline: "rewrite",
    requiredMarkers: ["first marker", "second marker", "third marker", "fourth marker"],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "compound-rg-and-sed",
    projection: "compound",
    executable: "bash",
    argv: [],
    shellCommand: "rg marker . && sed -n '1,3p' fixture.txt",
    baseline: "rewrite",
    requiredMarkers: [
      "first marker",
      "second marker",
      "third marker",
      "fourth marker",
      "# Falryn",
      "Do more with less context.",
    ],
    forbiddenMarkers: ["omitted", "…"],
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
    id: "external-diff",
    projection: "git-diff",
    executable: "diff",
    argv: ["-u", "diff-before.ts", "diff-after.ts"],
    rtkArgv: ["diff", "diff-before.ts", "diff-after.ts"],
    acceptedExitCodes: [1],
    requiredMarkers: [
      "diff-before.ts -> diff-after.ts",
      "@@ -1,5 +1,6 @@",
      'const mode = "sample"',
      'const mode = "complete"',
      "const exact = true",
      'return exact ? mode : "sample"',
    ],
    forbiddenMarkers: ["2026-08-23", "unchanged", "omitted", "…"],
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
    id: "git-add",
    projection: "git-mutation",
    executable: "git",
    argv: ["add", "."],
    rtkArgv: ["git", "add", "."],
    requiredMarkers: ["ok"],
    forbiddenMarkers: ["file changed", "insertion", "deletion"],
  },
  {
    id: "git-commit",
    projection: "git-mutation",
    executable: "git",
    argv: ["commit", "-m", "Preserve complete context"],
    rtkArgv: ["git", "commit", "-m", "Preserve complete context"],
    requiredMarkers: ["ok", "2222222"],
    forbiddenMarkers: ["file changed", "insertion", "deletion"],
  },
  {
    id: "git-push",
    projection: "git-mutation",
    executable: "git",
    argv: ["push"],
    rtkArgv: ["git", "push"],
    requiredMarkers: ["github.com:yogeshprasad098/falryn.git", "feature", "1111111", "2222222"],
    forbiddenMarkers: ["Enumerating objects", "Writing objects"],
  },
  {
    id: "git-pull",
    projection: "git-mutation",
    executable: "git",
    argv: ["pull", "--ff-only"],
    rtkArgv: ["git", "pull", "--ff-only"],
    requiredMarkers: ["ok", "3 files", "+10", "-2"],
    forbiddenMarkers: ["Fast-forward", "src/a.ts", "src/b.ts", "src/c.ts"],
  },
  {
    id: "gh-pr-list",
    projection: "forge",
    executable: "gh",
    argv: ["pr", "list"],
    rtkArgv: ["gh", "pr", "list"],
    requiredMarkers: ["#128", "#736", "#784", "Do more with less context", "@yogeshprasad098"],
    forbiddenMarkers: ['"number"', "Pull Requests"],
  },
  {
    id: "gh-pr-view",
    projection: "forge",
    executable: "gh",
    argv: ["pr", "view", "784"],
    rtkArgv: ["gh", "pr", "view", "784"],
    requiredMarkers: [
      "#784",
      "Complete Hush projections",
      "@yogeshprasad098",
      "mergeable",
      "checks 2/3 passed, 1 failed",
      "https://github.com/tyldra-org/falryn/pull/784",
      "Preserve every useful PR fact.",
      "No list truncation",
    ],
    forbiddenMarkers: ['"statusCheckRollup"', "???"],
  },
  {
    id: "gh-issue-list",
    projection: "forge",
    executable: "gh",
    argv: ["issue", "list"],
    rtkArgv: ["gh", "issue", "list"],
    requiredMarkers: ["#128", "#736", "#784", "Do more with less context"],
    forbiddenMarkers: ['"labels"', "Issues\n"],
  },
  {
    id: "gh-run-list",
    projection: "forge",
    executable: "gh",
    argv: ["run", "list"],
    rtkArgv: ["gh", "run", "list"],
    requiredMarkers: ["ok 32601 CI", "fail 32602 CodeQL", "run 32603 Platform tests"],
    forbiddenMarkers: ['"databaseId"', "Workflow Runs"],
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
    id: "count-wc-single",
    projection: "count",
    executable: "wc",
    argv: ["-l", "-w", "-c", "src/domain/hush/reducers/log/format.ts"],
    rtkArgv: ["wc", "-l", "-w", "-c", "src/domain/hush/reducers/log/format.ts"],
    requiredMarkers: ["127", "384", "3268"],
    forbiddenMarkers: ["src/domain", "omitted", "…"],
  },
  {
    id: "count-wc-multi",
    projection: "count",
    executable: "wc",
    argv: ["src/domain/hush/reducers/log/format.ts", "src/domain/hush/reducers/log/projection.ts"],
    rtkArgv: [
      "wc",
      "src/domain/hush/reducers/log/format.ts",
      "src/domain/hush/reducers/log/projection.ts",
    ],
    requiredMarkers: [
      "127L 384W 3268B format.ts",
      "32L 131W 1251B projection.ts",
      "Σ 159L 515W 4519B",
    ],
    forbiddenMarkers: ["src/domain", "omitted", "…"],
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
    id: "log-journalctl",
    projection: "log",
    executable: "journalctl",
    argv: ["-u", "falryn", "-n", "20"],
    baseline: "rtk-log",
    requiredMarkers: [
      "Aug 24 10:00 falryn-host falryn[736]",
      "00 [I] session started session=demo",
      "01 [I] context engine ready reducers=82",
      "02 [I] waiting for provider ×3",
      "03 [W] reducer fallback command=unknown",
      "04 [E] capture unavailable id=cap-42",
      "05 [I] request complete tokens=219",
    ],
    forbiddenMarkers: ["Log Summary", "omitted", "…"],
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
  await Promise.all(
    HUSH_FIND_LISTING_PATHS.map(async (path) => {
      const target = join(root, "corpus", "src", "domain", "hush", path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "export {};\n");
    }),
  );
}

export function formatHushProjectionScorecard(scorecard: HushProjectionScorecard): string {
  const headings = ["case", "raw", "rtk", "hush", "delta", "context", "result"];
  const rows = scorecard.scores.map((score) => [
    score.id,
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
    [...new Set(HUSH_PROJECTION_CASES.map((fixture) => fixture.executable))]
      .filter((executable) => executable !== "bash")
      .map(async (executable) => {
        const target = join(bin, executable);
        await copyFile(source, target);
        await chmod(target, 0o755);
      }),
  );
  return bin;
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
