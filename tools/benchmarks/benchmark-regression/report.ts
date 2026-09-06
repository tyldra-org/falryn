export const BENCHMARK_REPORT_SCHEMA = "falryn.benchmark-report/v4";

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
  warmupSamples: number;
  samples: readonly number[];
  distribution: BenchmarkDistribution;
}>;

export type BenchmarkEnvironment = Readonly<{
  platform: string;
  architecture: string;
  bunVersion: string;
}>;

export const BENCHMARK_TRIALS = [
  "manual",
  "base-first",
  "candidate-first",
  "candidate-second",
  "base-second",
  "candidate-third",
  "base-third",
  "base-fourth",
  "candidate-fourth",
] as const;

export type BenchmarkTrial = (typeof BENCHMARK_TRIALS)[number];

/**
 * A fixed same-revision settling period before every report prevents a first
 * post-build measurement from becoming the comparison sample. This is a
 * precondition, not a retry: either the required unreported run succeeds or the
 * gate fails closed.
 */

export const BENCHMARK_SETTLING_WARMUP_RUNS = 1;

export type BenchmarkRun = Readonly<{
  revision: string;
  trial: BenchmarkTrial;
  warmupRuns: number;
}>;

export type BenchmarkReport = Readonly<{
  schemaVersion: string;
  environment: BenchmarkEnvironment;
  run: BenchmarkRun;
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
  "warmup-sample-count-mismatch",
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

function asTrial(value: unknown): BenchmarkTrial | null {
  return BENCHMARK_TRIALS.includes(value as BenchmarkTrial) ? (value as BenchmarkTrial) : null;
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
  const warmupSamples = asFiniteNumber(record.warmupSamples);
  const samples = Array.isArray(record.samples) ? record.samples.map(asFiniteNumber) : null;
  const distribution = parseDistribution(record.distribution);
  if (
    id === null ||
    record.unit !== "milliseconds" ||
    datasetRevision === null ||
    state === null ||
    warmupSamples === null ||
    !Number.isInteger(warmupSamples) ||
    warmupSamples < 0 ||
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
    warmupSamples,
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
  const runRecord = asRecord(record.run);
  const schemaVersion = asNonEmptyString(record.schemaVersion);
  if (
    environmentRecord === null ||
    runRecord === null ||
    schemaVersion === null ||
    !Array.isArray(record.measurements)
  ) {
    return { ok: false, reason: "report is missing a required top-level field" };
  }

  const platform = asNonEmptyString(environmentRecord.platform);
  const architecture = asNonEmptyString(environmentRecord.architecture);
  const bunVersion = asNonEmptyString(environmentRecord.bunVersion);
  if (platform === null || architecture === null || bunVersion === null) {
    return { ok: false, reason: "report environment is incomplete" };
  }

  const revision = asNonEmptyString(runRecord.revision);
  const trial = asTrial(runRecord.trial);
  const warmupRuns = asFiniteNumber(runRecord.warmupRuns);
  if (
    revision === null ||
    trial === null ||
    warmupRuns === null ||
    !Number.isInteger(warmupRuns) ||
    warmupRuns < 0
  ) {
    return { ok: false, reason: "report run metadata is incomplete" };
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
      run: { revision, trial, warmupRuns },
      measurements,
    },
  };
}

export function createBenchmarkMeasurement(
  input: Readonly<{
    id: BenchmarkMetricId;
    datasetRevision: string;
    state: BenchmarkState;
    warmupSamples?: number;
    samples: readonly number[];
  }>,
): BenchmarkMeasurement {
  const warmupSamples = input.warmupSamples ?? 0;
  if (
    input.datasetRevision.trim().length === 0 ||
    !Number.isInteger(warmupSamples) ||
    warmupSamples < 0 ||
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
    warmupSamples,
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
  run: BenchmarkRun = { revision: "manual", trial: "manual", warmupRuns: 0 },
): BenchmarkReport {
  return {
    schemaVersion: BENCHMARK_REPORT_SCHEMA,
    environment,
    run,
    measurements: [...measurements],
  };
}

export function isCompleteBenchmarkReport(report: BenchmarkReport): boolean {
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
