/**
 * Compare the bounded benchmark reports produced by the gated measurement suite.
 *
 * This is repository tooling, not a product import. It owns the report shape,
 * compatibility policy, and bounded diagnostics; measurement ownership remains
 * with `src/data/measurement.test.ts`.
 */

import { appendFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const BENCHMARK_REPORT_SCHEMA = "falryn.benchmark-report/v1";

export const BENCHMARK_METRIC_IDS = [
  "migration-time",
  "transaction-latency",
  "range-read-latency",
  "startup-to-first-draw",
] as const;

export type BenchmarkMetricId = (typeof BENCHMARK_METRIC_IDS)[number];

export type BenchmarkState = "cold" | "warm" | "cold and warm";

export type BenchmarkDistribution = Readonly<{
  count: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
}>;

export type BenchmarkMeasurement = Readonly<{
  id: BenchmarkMetricId;
  unit: "milliseconds";
  datasetRevision: string;
  state: BenchmarkState;
  samples: readonly number[];
  distribution: BenchmarkDistribution;
}>;

export type BenchmarkEnvironment = Readonly<{
  platform: string;
  architecture: string;
  bunVersion: string;
}>;

export type BenchmarkReport = Readonly<{
  schemaVersion: string;
  environment: BenchmarkEnvironment;
  measurements: readonly BenchmarkMeasurement[];
}>;

export const BENCHMARK_COMPARISON_REASONS = [
  "base-report-missing",
  "candidate-report-missing",
  "base-report-unreadable",
  "candidate-report-unreadable",
  "base-report-invalid",
  "candidate-report-invalid",
  "schema-mismatch",
  "unsupported-schema",
  "platform-mismatch",
  "architecture-mismatch",
  "bun-version-mismatch",
  "metric-missing",
  "metric-unit-mismatch",
  "dataset-revision-mismatch",
  "state-mismatch",
  "sample-count-mismatch",
  "insufficient-samples",
  "nonpositive-baseline",
  "one-sided-deterioration",
] as const;

export type BenchmarkComparisonReason = (typeof BENCHMARK_COMPARISON_REASONS)[number];

export type BenchmarkMetricComparison = Readonly<{
  id: BenchmarkMetricId;
  base: Pick<BenchmarkDistribution, "p50" | "p95">;
  candidate: Pick<BenchmarkDistribution, "p50" | "p95">;
  classification: "pass" | "regression" | "one-sided-deterioration";
}>;

export type BenchmarkComparison =
  | Readonly<{
      kind: "pass";
      metrics: readonly BenchmarkMetricComparison[];
    }>
  | Readonly<{
      kind: "regression";
      metrics: readonly BenchmarkMetricComparison[];
    }>
  | Readonly<{
      kind: "inconclusive";
      reason: BenchmarkComparisonReason;
      metrics: readonly BenchmarkMetricComparison[];
    }>;

type JsonRecord = Readonly<Record<string, unknown>>;

type ParseResult =
  | Readonly<{ ok: true; value: BenchmarkReport }>
  | Readonly<{ ok: false; reason: string }>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asState(value: unknown): BenchmarkState | null {
  return value === "cold" || value === "warm" || value === "cold and warm" ? value : null;
}

function asMetricId(value: unknown): BenchmarkMetricId | null {
  return BENCHMARK_METRIC_IDS.includes(value as BenchmarkMetricId)
    ? (value as BenchmarkMetricId)
    : null;
}

function distributionOf(samples: readonly number[]): BenchmarkDistribution {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const p50 =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);

  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    p50,
    p95: sorted[p95Index] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function distributionsEqual(left: BenchmarkDistribution, right: BenchmarkDistribution): boolean {
  return (
    left.count === right.count &&
    left.min === right.min &&
    left.p50 === right.p50 &&
    left.p95 === right.p95 &&
    left.max === right.max
  );
}

function parseDistribution(value: unknown): BenchmarkDistribution | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }

  const count = asFiniteNumber(record.count);
  const min = asFiniteNumber(record.min);
  const p50 = asFiniteNumber(record.p50);
  const p95 = asFiniteNumber(record.p95);
  const max = asFiniteNumber(record.max);
  if (
    count === null ||
    !Number.isInteger(count) ||
    count < 1 ||
    min === null ||
    p50 === null ||
    p95 === null ||
    max === null
  ) {
    return null;
  }

  return { count, min, p50, p95, max };
}

function parseMeasurement(value: unknown): BenchmarkMeasurement | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }

  const id = asMetricId(record.id);
  const datasetRevision = asNonEmptyString(record.datasetRevision);
  const state = asState(record.state);
  const samples = Array.isArray(record.samples) ? record.samples.map(asFiniteNumber) : null;
  const distribution = parseDistribution(record.distribution);
  if (
    id === null ||
    record.unit !== "milliseconds" ||
    datasetRevision === null ||
    state === null ||
    samples === null ||
    samples.some((sample) => sample === null || sample < 0) ||
    distribution === null
  ) {
    return null;
  }

  const numericSamples = samples.filter((sample): sample is number => sample !== null);
  const calculated = distributionOf(numericSamples);
  if (!distributionsEqual(distribution, calculated)) {
    return null;
  }

  return {
    id,
    unit: "milliseconds",
    datasetRevision,
    state,
    samples: numericSamples,
    distribution,
  };
}

/** Parse a report without treating an incompatible peer as a passing result. */
export function parseBenchmarkReport(value: unknown): ParseResult {
  const record = asRecord(value);
  if (record === null) {
    return { ok: false, reason: "report is not an object" };
  }

  const environmentRecord = asRecord(record.environment);
  const schemaVersion = asNonEmptyString(record.schemaVersion);
  if (environmentRecord === null || schemaVersion === null || !Array.isArray(record.measurements)) {
    return { ok: false, reason: "report is missing a required top-level field" };
  }

  const platform = asNonEmptyString(environmentRecord.platform);
  const architecture = asNonEmptyString(environmentRecord.architecture);
  const bunVersion = asNonEmptyString(environmentRecord.bunVersion);
  if (platform === null || architecture === null || bunVersion === null) {
    return { ok: false, reason: "report environment is incomplete" };
  }

  const measurements: BenchmarkMeasurement[] = [];
  const ids = new Set<BenchmarkMetricId>();
  for (const value of record.measurements) {
    const measurement = parseMeasurement(value);
    if (measurement === null || ids.has(measurement.id)) {
      return { ok: false, reason: "report has an invalid or duplicate measurement" };
    }
    ids.add(measurement.id);
    measurements.push(measurement);
  }

  return {
    ok: true,
    value: {
      schemaVersion,
      environment: { platform, architecture, bunVersion },
      measurements,
    },
  };
}

export function createBenchmarkMeasurement(
  input: Readonly<{
    id: BenchmarkMetricId;
    datasetRevision: string;
    state: BenchmarkState;
    samples: readonly number[];
  }>,
): BenchmarkMeasurement {
  if (
    input.datasetRevision.trim().length === 0 ||
    input.samples.length === 0 ||
    input.samples.some((sample) => !Number.isFinite(sample) || sample < 0)
  ) {
    throw new Error("benchmark measurement input is incomplete");
  }

  return {
    id: input.id,
    unit: "milliseconds",
    datasetRevision: input.datasetRevision,
    state: input.state,
    samples: [...input.samples],
    distribution: distributionOf(input.samples),
  };
}

export function createBenchmarkReport(
  measurements: readonly BenchmarkMeasurement[],
  environment: BenchmarkEnvironment = {
    platform: process.platform,
    architecture: process.arch,
    bunVersion: Bun.version,
  },
): BenchmarkReport {
  return {
    schemaVersion: BENCHMARK_REPORT_SCHEMA,
    environment,
    measurements: [...measurements],
  };
}

function isCompleteBenchmarkReport(report: BenchmarkReport): boolean {
  if (report.schemaVersion !== BENCHMARK_REPORT_SCHEMA) {
    return false;
  }
  const ids = new Set(report.measurements.map((measurement) => measurement.id));
  return (
    ids.size === BENCHMARK_METRIC_IDS.length &&
    BENCHMARK_METRIC_IDS.every(
      (id) =>
        ids.has(id) &&
        (report.measurements.find((measurement) => measurement.id === id)?.samples.length ?? 0) >=
          5,
    )
  );
}

function inconclusive(reason: BenchmarkComparisonReason): BenchmarkComparison {
  return { kind: "inconclusive", reason, metrics: [] };
}

function incompatibleEnvironment(
  base: BenchmarkReport,
  candidate: BenchmarkReport,
): BenchmarkComparisonReason | null {
  if (base.schemaVersion !== candidate.schemaVersion) {
    return "schema-mismatch";
  }
  if (base.schemaVersion !== BENCHMARK_REPORT_SCHEMA) {
    return "unsupported-schema";
  }
  if (base.environment.platform !== candidate.environment.platform) {
    return "platform-mismatch";
  }
  if (base.environment.architecture !== candidate.environment.architecture) {
    return "architecture-mismatch";
  }
  return base.environment.bunVersion !== candidate.environment.bunVersion
    ? "bun-version-mismatch"
    : null;
}

function measurementById(
  report: BenchmarkReport,
  id: BenchmarkMetricId,
): BenchmarkMeasurement | null {
  return report.measurements.find((measurement) => measurement.id === id) ?? null;
}

function compareMetric(
  base: BenchmarkMeasurement,
  candidate: BenchmarkMeasurement,
): BenchmarkMetricComparison {
  const p50Regression = candidate.distribution.p50 >= base.distribution.p50 * 1.5;
  const p95Regression = candidate.distribution.p95 >= base.distribution.p95 * 1.5;
  return {
    id: base.id,
    base: { p50: base.distribution.p50, p95: base.distribution.p95 },
    candidate: { p50: candidate.distribution.p50, p95: candidate.distribution.p95 },
    classification:
      p50Regression && p95Regression
        ? "regression"
        : p50Regression || p95Regression
          ? "one-sided-deterioration"
          : "pass",
  };
}

/**
 * Compare two parsed reports. Every signature mismatch is inconclusive; no
 * incomplete or cross-machine comparison can appear as a benchmark pass.
 */
export function compareBenchmarkReports(
  baseValue: unknown,
  candidateValue: unknown,
): BenchmarkComparison {
  const baseResult = parseBenchmarkReport(baseValue);
  if (!baseResult.ok) {
    return inconclusive("base-report-invalid");
  }
  const candidateResult = parseBenchmarkReport(candidateValue);
  if (!candidateResult.ok) {
    return inconclusive("candidate-report-invalid");
  }

  const environmentReason = incompatibleEnvironment(baseResult.value, candidateResult.value);
  if (environmentReason !== null) {
    return inconclusive(environmentReason);
  }

  const comparisons: BenchmarkMetricComparison[] = [];
  for (const id of BENCHMARK_METRIC_IDS) {
    const base = measurementById(baseResult.value, id);
    const candidate = measurementById(candidateResult.value, id);
    if (base === null || candidate === null) {
      return inconclusive("metric-missing");
    }
    if (base.unit !== candidate.unit) {
      return inconclusive("metric-unit-mismatch");
    }
    if (base.datasetRevision !== candidate.datasetRevision) {
      return inconclusive("dataset-revision-mismatch");
    }
    if (base.state !== candidate.state) {
      return inconclusive("state-mismatch");
    }
    if (base.samples.length !== candidate.samples.length) {
      return inconclusive("sample-count-mismatch");
    }
    if (base.samples.length < 5) {
      return inconclusive("insufficient-samples");
    }
    if (base.distribution.p50 <= 0 || base.distribution.p95 <= 0) {
      return inconclusive("nonpositive-baseline");
    }
    comparisons.push(compareMetric(base, candidate));
  }

  if (comparisons.some((comparison) => comparison.classification === "regression")) {
    return { kind: "regression", metrics: comparisons };
  }
  if (comparisons.some((comparison) => comparison.classification === "one-sided-deterioration")) {
    return { kind: "inconclusive", reason: "one-sided-deterioration", metrics: comparisons };
  }
  return { kind: "pass", metrics: comparisons };
}

function fixed(value: number): string {
  return value.toFixed(3);
}

/** Bounded, plain-text output for local use and the GitHub Actions summary. */
export function formatBenchmarkComparison(comparison: BenchmarkComparison): string {
  const headline =
    comparison.kind === "pass"
      ? "benchmark comparison: PASS"
      : comparison.kind === "regression"
        ? "benchmark comparison: REGRESSION"
        : `benchmark comparison: INCONCLUSIVE (${comparison.reason})`;
  const details = comparison.metrics.map(
    (metric) =>
      `${metric.id}: ${metric.classification}; ` +
      `p50 ${fixed(metric.base.p50)}→${fixed(metric.candidate.p50)} ms; ` +
      `p95 ${fixed(metric.base.p95)}→${fixed(metric.candidate.p95)} ms`,
  );
  return [headline, ...details].join("\n");
}

/** Reject a malformed or already-existing destination before writing. */
export async function validateBenchmarkReportDestination(destination: string): Promise<void> {
  if (
    destination.trim().length === 0 ||
    destination !== destination.trim() ||
    !isAbsolute(destination) ||
    basename(destination) === "." ||
    basename(destination) === ".."
  ) {
    throw new Error("benchmark report destination must be a non-empty absolute file path");
  }

  const repositoryRoot = dirname(dirname(import.meta.path));
  const destinationWithinRepository = relative(repositoryRoot, resolve(destination));
  if (
    destinationWithinRepository === "" ||
    (!destinationWithinRepository.startsWith(`..${sep}`) && destinationWithinRepository !== "..")
  ) {
    throw new Error("benchmark report destination must be outside the repository");
  }

  const directory = dirname(destination);
  const directoryStatus = await stat(directory);
  if (!directoryStatus.isDirectory()) {
    throw new Error("benchmark report destination parent is not a directory");
  }

  try {
    await stat(destination);
  } catch (error) {
    if (isMissingPath(error)) {
      return;
    }
    throw error;
  }
  throw new Error("benchmark report destination already exists");
}

/** Atomically write a report only after its own parser accepts the exact shape. */
export async function writeBenchmarkReport(
  destination: string,
  report: BenchmarkReport,
): Promise<void> {
  const parsed = parseBenchmarkReport(report);
  if (!parsed.ok || !isCompleteBenchmarkReport(parsed.value)) {
    throw new Error("benchmark report is invalid or incomplete and cannot be written");
  }
  await validateBenchmarkReportDestination(destination);

  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${crypto.randomUUID()}.partial`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as Readonly<{ code?: unknown }>).code === "ENOENT"
  );
}

async function readReport(
  path: string | undefined,
  side: "base" | "candidate",
): Promise<
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; reason: BenchmarkComparisonReason }>
> {
  if (path === undefined || path.trim().length === 0) {
    return { ok: false, reason: `${side}-report-missing` };
  }
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: isMissingPath(error) ? `${side}-report-missing` : `${side}-report-unreadable`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch {
    return { ok: false, reason: `${side}-report-invalid` };
  }
}

async function compareFromEnvironment(): Promise<BenchmarkComparison> {
  const base = await readReport(process.env.FALRYN_BENCHMARK_BASE_REPORT, "base");
  if (!base.ok) {
    return inconclusive(base.reason);
  }
  const candidate = await readReport(process.env.FALRYN_BENCHMARK_CANDIDATE_REPORT, "candidate");
  if (!candidate.ok) {
    return inconclusive(candidate.reason);
  }
  return compareBenchmarkReports(base.value, candidate.value);
}

async function run(): Promise<void> {
  const comparison = await compareFromEnvironment();
  const output = `${formatBenchmarkComparison(comparison)}\n`;
  process.stdout.write(output);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary.trim().length > 0) {
    await appendFile(summary, output);
  }
  if (comparison.kind !== "pass") {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await run();
}
