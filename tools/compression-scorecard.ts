#!/usr/bin/env bun
/** Aggregate live-product qualification report for Brief, Hush, and Loom (#828). */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  COMPRESSION_PRODUCT_PATH_TESTS,
  COMPRESSION_SCORECARD_MANIFEST,
  COMPRESSION_SCORECARD_MANIFEST_VERSION,
  COMPRESSION_SCORECARD_SCHEMA_VERSION,
} from "./compression-scorecard-manifest.ts";
import qualification from "./fixtures/brief-qualification-commandcode-minimax-m3.json";
import {
  createHushCommandCoverageScorecard,
  type HushCommandCoverageScorecard,
} from "./hush-command-coverage.ts";
import { createHushLsScorecard, type HushLsScorecard } from "./hush-ls-scorecard.ts";
import {
  createHushProjectionScorecard,
  type HushProjectionScorecard,
} from "./hush-projection-scorecard.ts";
import { createHushTreeScorecard, type HushTreeScorecard } from "./hush-tree-scorecard.ts";
import { createLoomScorecard, type LoomScorecard } from "./loom-scorecard.ts";

type QualificationStatus = "pass" | "tie" | "loss" | "invalid" | "skipped" | "cancelled";
type TokenKind = "estimated" | "provider-reported";

export type CompressionQualificationRow = {
  readonly id: string;
  readonly lane: "hush" | "loom" | "brief";
  readonly baseline: string;
  readonly tokenKind: TokenKind;
  readonly sourceTokens: number | null;
  readonly baselineTokens: number;
  readonly falrynTokens: number;
  readonly requiredFactsPreserved: boolean;
  readonly exactRecoverable: boolean | null;
  readonly recoveryCalls: number;
  readonly modelVisibleToolCalls: number | null;
  readonly status: QualificationStatus;
  readonly reason: string;
};

export type CompressionLaneReport = {
  readonly lane: CompressionQualificationRow["lane"];
  readonly tokenKind: TokenKind;
  readonly baseline: Readonly<Record<string, unknown>>;
  readonly rows: readonly CompressionQualificationRow[];
  readonly summary: {
    readonly rows: number;
    readonly passed: number;
    readonly tied: number;
    readonly lost: number;
    readonly invalid: number;
    readonly skipped: number;
    readonly cancelled: number;
    readonly sourceTokens: number | null;
    readonly baselineTokens: number;
    readonly falrynTokens: number;
  };
  readonly passes: boolean;
};

export type ProductPathCheck = {
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly status: "pass" | "fail" | "cancelled" | "timed-out";
};

export type ReviewedBriefQualification = typeof qualification;

export type CompressionQualificationInput = {
  readonly generatedAt: string;
  readonly repository: {
    readonly revision: string;
    readonly dirty: boolean;
    readonly platform: NodeJS.Platform;
    readonly architecture: string;
    readonly bunVersion: string;
  };
  readonly hush: {
    readonly coverage: HushCommandCoverageScorecard;
    readonly projections: HushProjectionScorecard;
    readonly ls: HushLsScorecard;
    readonly tree: HushTreeScorecard;
  };
  readonly loom: LoomScorecard;
  readonly brief: ReviewedBriefQualification;
  readonly productPath: readonly ProductPathCheck[];
};

export type CompressionQualificationReport = {
  readonly schemaVersion: typeof COMPRESSION_SCORECARD_SCHEMA_VERSION;
  readonly manifestVersion: typeof COMPRESSION_SCORECARD_MANIFEST_VERSION;
  readonly generatedAt: string;
  readonly repository: CompressionQualificationInput["repository"];
  readonly lanes: readonly [CompressionLaneReport, CompressionLaneReport, CompressionLaneReport];
  readonly productPath: readonly ProductPathCheck[];
  readonly comparability: {
    readonly crossLaneTotal: null;
    readonly reason: "estimated and provider-reported token kinds remain separate";
  };
  readonly overall: {
    readonly status: "pass" | "fail";
    readonly reasons: readonly string[];
  };
};

type Options = {
  readonly format: "human" | "json";
  readonly output: string | null;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function qualificationStatus(value: string): QualificationStatus {
  switch (value) {
    case "pass":
    case "tie":
    case "loss":
    case "invalid":
    case "skipped":
    case "cancelled":
      return value;
    default:
      return "invalid";
  }
}

function parseOptions(argv: readonly string[]): Options {
  let format: Options["format"] = "human";
  let output: string | null = null;
  for (const argument of argv) {
    if (argument === "--format=human") format = "human";
    else if (argument === "--format=json") format = "json";
    else if (argument.startsWith("--output=")) output = resolve(argument.slice(9));
    else throw new Error(`unsupported argument: ${argument}`);
  }
  return { format, output };
}

function summary(
  lane: CompressionQualificationRow["lane"],
  tokenKind: TokenKind,
  baseline: Readonly<Record<string, unknown>>,
  rows: readonly CompressionQualificationRow[],
  baselineMatches: boolean,
): CompressionLaneReport {
  const count = (status: QualificationStatus): number =>
    rows.filter((row) => row.status === status).length;
  return {
    lane,
    tokenKind,
    baseline,
    rows,
    summary: {
      rows: rows.length,
      passed: count("pass"),
      tied: count("tie"),
      lost: count("loss"),
      invalid: count("invalid"),
      skipped: count("skipped"),
      cancelled: count("cancelled"),
      sourceTokens: rows.every((row) => row.sourceTokens !== null)
        ? rows.reduce((total, row) => total + (row.sourceTokens ?? 0), 0)
        : null,
      baselineTokens: rows.reduce((total, row) => total + row.baselineTokens, 0),
      falrynTokens: rows.reduce((total, row) => total + row.falrynTokens, 0),
    },
    passes:
      baselineMatches &&
      rows.length > 0 &&
      rows.every((row) => row.status === "pass" || row.status === "tie"),
  };
}

function hushLane(input: CompressionQualificationInput["hush"]): CompressionLaneReport {
  const projectionRows: CompressionQualificationRow[] = input.projections.scores.map((row) => ({
    id: `projection:${row.id}`,
    lane: "hush",
    baseline: row.gate,
    tokenKind: "estimated",
    sourceTokens: row.raw.estimatedTokens,
    baselineTokens: row.rtk.estimatedTokens,
    falrynTokens: row.hush.estimatedTokens,
    requiredFactsPreserved:
      row.retainsRequiredContext && row.excludesKnownNoise && row.noArbitraryCap,
    exactRecoverable: null,
    recoveryCalls: 0,
    modelVisibleToolCalls: null,
    status: row.result === "PASS" ? (row.competitiveResult === "tie" ? "tie" : "pass") : "loss",
    reason:
      row.result === "PASS"
        ? `${row.competitiveResult}; required command facts retained`
        : "competitive ceiling or required-fact contract failed",
  }));
  const listingRows: CompressionQualificationRow[] = [
    ...input.ls.scores.map((row) => ({
      id: `ls:${row.id}`,
      lane: "hush" as const,
      baseline: "rtk",
      tokenKind: "estimated" as const,
      sourceTokens: row.raw.estimatedTokens,
      baselineTokens: row.rtk.estimatedTokens,
      falrynTokens: row.hush.estimatedTokens,
      requiredFactsPreserved: row.retainsEveryEntry && row.omissionRecords === 0 && !row.truncated,
      exactRecoverable: row.recoverable,
      recoveryCalls: 0,
      modelVisibleToolCalls: null,
      status: (row.withinRtkBudget
        ? row.hush.estimatedTokens < row.rtk.estimatedTokens
          ? "pass"
          : "tie"
        : "loss") as QualificationStatus,
      reason: row.withinRtkBudget
        ? "all entries retained within RTK ceiling"
        : "RTK ceiling exceeded",
    })),
    ...input.tree.scores.map((row) => ({
      id: `tree:${row.id}`,
      lane: "hush" as const,
      baseline: "rtk",
      tokenKind: "estimated" as const,
      sourceTokens: row.raw.estimatedTokens,
      baselineTokens: row.rtk.estimatedTokens,
      falrynTokens: row.hush.estimatedTokens,
      requiredFactsPreserved: row.sameInformation && row.omissionRecords === 0 && !row.truncated,
      exactRecoverable: row.recoverable,
      recoveryCalls: 0,
      modelVisibleToolCalls: null,
      status: (row.withinRtkBudget
        ? row.hush.estimatedTokens < row.rtk.estimatedTokens
          ? "pass"
          : "tie"
        : "loss") as QualificationStatus,
      reason: row.withinRtkBudget
        ? "tree facts retained within RTK ceiling"
        : "RTK ceiling exceeded",
    })),
  ];
  const baselineMatches =
    input.coverage.routingComplete &&
    input.coverage.baseline.version ===
      COMPRESSION_SCORECARD_MANIFEST.hush.inventoryBaseline.version &&
    input.coverage.baseline.commit ===
      COMPRESSION_SCORECARD_MANIFEST.hush.inventoryBaseline.commit &&
    input.projections.rtkVersion === COMPRESSION_SCORECARD_MANIFEST.hush.executableBaseline &&
    input.ls.rtkVersion === COMPRESSION_SCORECARD_MANIFEST.hush.executableBaseline &&
    input.tree.rtkVersion === COMPRESSION_SCORECARD_MANIFEST.hush.executableBaseline;
  return summary(
    "hush",
    "estimated",
    {
      inventoryVersion: input.coverage.baseline.version,
      inventoryCommit: input.coverage.baseline.commit,
      executableVersion: input.projections.rtkVersion,
      tokenizer: COMPRESSION_SCORECARD_MANIFEST.hush.tokenizer,
    },
    [...projectionRows, ...listingRows],
    baselineMatches && input.projections.passes && input.ls.passes && input.tree.passes,
  );
}

function loomLane(input: LoomScorecard): CompressionLaneReport {
  const rows: CompressionQualificationRow[] = input.scores.map((row) => ({
    id: row.projection,
    lane: "loom",
    baseline: `Headroom ${input.headroom.version}`,
    tokenKind: "estimated",
    sourceTokens: input.sourceTokens,
    baselineTokens: row.headroomTotalTokens,
    falrynTokens: row.totalTokens,
    requiredFactsPreserved: row.requiredFactsPreserved,
    exactRecoverable: row.exactRecoverable,
    recoveryCalls: 1,
    modelVisibleToolCalls: 1,
    status:
      row.withinHeadroomBudget && row.requiredFactsPreserved && row.exactRecoverable
        ? row.totalTokens < row.headroomTotalTokens
          ? "pass"
          : "tie"
        : "loss",
    reason:
      row.withinHeadroomBudget && row.requiredFactsPreserved && row.exactRecoverable
        ? "required bytes read, facts retained, digest-verified recovery"
        : "budget, fidelity, or recovery contract failed",
  }));
  const baselineMatches =
    input.headroom.package === COMPRESSION_SCORECARD_MANIFEST.loom.baseline.package &&
    input.headroom.version === COMPRESSION_SCORECARD_MANIFEST.loom.baseline.version &&
    input.headroom.sourceSha256 === COMPRESSION_SCORECARD_MANIFEST.loom.baseline.sourceSha256 &&
    input.sourceDigestMatches;
  return summary(
    "loom",
    "estimated",
    {
      package: input.headroom.package,
      version: input.headroom.version,
      sourceSha256: input.headroom.sourceSha256,
      tokenizer: COMPRESSION_SCORECARD_MANIFEST.loom.tokenizer,
    },
    rows,
    baselineMatches && input.passes,
  );
}

function briefLane(input: ReviewedBriefQualification): CompressionLaneReport {
  const rows: CompressionQualificationRow[] = input.rows.map((row) => ({
    id: row.pairId,
    lane: "brief",
    baseline: `Caveman ${input.baseline.commit}`,
    tokenKind: "provider-reported",
    sourceTokens: null,
    baselineTokens: row.cavemanComparableTokens,
    falrynTokens: row.briefComparableTokens,
    requiredFactsPreserved: row.briefFidelity === 1,
    exactRecoverable: null,
    recoveryCalls: 0,
    modelVisibleToolCalls: 0,
    status: qualificationStatus(row.verdict),
    reason: row.accepted
      ? "matched provider turn accepted with required facts retained"
      : "matched provider turn was not accepted",
  }));
  const expected = COMPRESSION_SCORECARD_MANIFEST.brief.baseline;
  const baselineMatches =
    input.baseline.commit === expected.commit &&
    input.baseline.sourceDigest === expected.sourceDigest &&
    input.baseline.adapterVersion === expected.adapterVersion &&
    input.summary.complete &&
    !input.summary.partial;
  return summary("brief", "provider-reported", input.baseline, rows, baselineMatches);
}

export function createCompressionQualificationReport(
  input: CompressionQualificationInput,
): CompressionQualificationReport {
  const lanes = [hushLane(input.hush), loomLane(input.loom), briefLane(input.brief)] as const;
  const reasons: string[] = [];
  if (input.repository.dirty) reasons.push("repository is dirty");
  if (input.repository.revision.length !== 40)
    reasons.push("repository revision is not a full commit");
  for (const lane of lanes) {
    if (!lane.passes) reasons.push(`${lane.lane} qualification failed`);
  }
  for (const check of input.productPath) {
    if (check.status !== "pass") reasons.push(`product path failed: ${check.command.join(" ")}`);
  }
  if (input.productPath.length !== 1) reasons.push("product-path validation is incomplete");
  return {
    schemaVersion: COMPRESSION_SCORECARD_SCHEMA_VERSION,
    manifestVersion: COMPRESSION_SCORECARD_MANIFEST_VERSION,
    generatedAt: input.generatedAt,
    repository: input.repository,
    lanes,
    productPath: input.productPath,
    comparability: {
      crossLaneTotal: null,
      reason: "estimated and provider-reported token kinds remain separate",
    },
    overall: { status: reasons.length === 0 ? "pass" : "fail", reasons },
  };
}

async function command(argv: readonly string[], signal?: AbortSignal) {
  const child = Bun.spawn([...argv], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    ...(signal === undefined ? {} : { signal }),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function repositoryFacts() {
  const [revision, status] = await Promise.all([
    command(["git", "rev-parse", "HEAD"]),
    command(["git", "status", "--porcelain=v1", "--untracked-files=normal"]),
  ]);
  if (revision.exitCode !== 0 || status.exitCode !== 0) {
    throw new Error("compression scorecard requires a Git checkout");
  }
  return {
    revision: revision.stdout.trim(),
    dirty: status.stdout.length > 0,
    platform: process.platform,
    architecture: process.arch,
    bunVersion: Bun.version,
  } as const;
}

async function productPathCheck(signal: AbortSignal): Promise<ProductPathCheck> {
  const argv = ["bun", "test", ...COMPRESSION_PRODUCT_PATH_TESTS];
  const startedAt = performance.now();
  try {
    const result = await command(argv, signal);
    return {
      command: argv,
      exitCode: result.exitCode,
      durationMs: performance.now() - startedAt,
      stdoutSha256: sha256(result.stdout),
      stderrSha256: sha256(result.stderr),
      status: result.exitCode === 0 ? "pass" : "fail",
    };
  } catch (error) {
    const timedOut = signal.reason === "scorecard-timeout";
    return {
      command: argv,
      exitCode: null,
      durationMs: performance.now() - startedAt,
      stdoutSha256: sha256(""),
      stderrSha256: sha256(error instanceof Error ? error.name : "unknown"),
      status: timedOut ? "timed-out" : "cancelled",
    };
  }
}

export async function collectCompressionQualification(
  signal: AbortSignal,
): Promise<CompressionQualificationReport> {
  const repository = await repositoryFacts();
  if (repository.dirty) {
    throw new Error("compression scorecard refuses a dirty checkout");
  }
  const [projections, ls, tree] = await Promise.all([
    createHushProjectionScorecard(),
    createHushLsScorecard(),
    createHushTreeScorecard(),
  ]);
  if (signal.aborted) throw new DOMException("cancelled", "AbortError");
  const productPath = await productPathCheck(signal);
  return createCompressionQualificationReport({
    generatedAt: new Date().toISOString(),
    repository,
    hush: {
      coverage: createHushCommandCoverageScorecard(),
      projections,
      ls,
      tree,
    },
    loom: createLoomScorecard(),
    brief: qualification,
    productPath: [productPath],
  });
}

function formatNumber(value: number | null): string {
  return value === null ? "n/a" : value.toLocaleString("en-US");
}

export function formatCompressionQualificationHuman(
  report: CompressionQualificationReport,
): string {
  const lines = [
    `Falryn compression live-path scorecard ${report.manifestVersion}`,
    `revision=${report.repository.revision} platform=${report.repository.platform}/${report.repository.architecture} bun=${report.repository.bunVersion}`,
  ];
  for (const lane of report.lanes) {
    lines.push(
      `${lane.lane} tokenKind=${lane.tokenKind} rows=${lane.summary.rows} pass=${lane.summary.passed} tie=${lane.summary.tied} loss=${lane.summary.lost} invalid=${lane.summary.invalid} source=${formatNumber(lane.summary.sourceTokens)} baseline=${formatNumber(lane.summary.baselineTokens)} falryn=${formatNumber(lane.summary.falrynTokens)} status=${lane.passes ? "PASS" : "FAIL"}`,
    );
    for (const row of lane.rows) {
      lines.push(
        `  ${row.id} ${row.status.toUpperCase()} baseline=${row.baseline} tokens=${row.falrynTokens}/${row.baselineTokens} facts=${row.requiredFactsPreserved ? "all" : "loss"} recovery=${row.exactRecoverable === null ? "n/a" : row.exactRecoverable ? "exact" : "missing"}`,
      );
    }
  }
  for (const check of report.productPath) {
    lines.push(
      `product-path ${check.status.toUpperCase()} exit=${check.exitCode ?? "none"} durationMs=${check.durationMs.toFixed(1)} command=${check.command.join(" ")}`,
    );
  }
  lines.push(`cross-lane total: n/a (${report.comparability.reason})`);
  lines.push(
    `scorecard: ${report.overall.status.toUpperCase()}${report.overall.reasons.length === 0 ? "" : ` (${report.overall.reasons.join("; ")})`}`,
  );
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2));
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("scorecard-timeout"),
    COMPRESSION_SCORECARD_MANIFEST.limits.productPathTimeoutMs,
  );
  const cancel = () => controller.abort("signal");
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const report = await collectCompressionQualification(controller.signal);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output !== null) await writeFile(options.output, json, { flag: "wx" });
    process.stdout.write(
      options.format === "json" ? json : formatCompressionQualificationHuman(report),
    );
    if (report.overall.status !== "pass") process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (import.meta.main) {
  await main();
}
