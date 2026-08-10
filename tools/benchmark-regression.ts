/**
 * Compare the bounded benchmark reports produced by the gated measurement suite.
 *
 * This is repository tooling, not a product import. It owns the report shape,
 * compatibility policy, and bounded diagnostics; measurement ownership remains
 * with `src/data/measurement.test.ts`.
 */

import { appendFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
 * precondition, not a retry: either both unreported runs succeed or the gate
 * fails closed.
 */
export const BENCHMARK_SETTLING_WARMUP_RUNS = 2;

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
    if (base.warmupSamples !== candidate.warmupSamples) {
      return inconclusive("warmup-sample-count-mismatch");
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

export const BENCHMARK_GATE_REASONS = [
  "measurement-incomplete",
  "base-first-report-invalid",
  "candidate-first-report-invalid",
  "candidate-second-report-invalid",
  "base-second-report-invalid",
  "candidate-third-report-invalid",
  "base-third-report-invalid",
  "base-fourth-report-invalid",
  "candidate-fourth-report-invalid",
  "trial-mismatch",
  "revision-mismatch",
  "warmup-incomplete",
  "bracket-aggregation-invalid",
  "base-control-unstable",
  "candidate-control-unstable",
  "paired-comparison-inconclusive",
  "paired-verdict-disagreement",
] as const;

export type BenchmarkGateReason = (typeof BENCHMARK_GATE_REASONS)[number];

/** A report alone is insufficient: a failing test can still run its afterAll hook. */
export type BenchmarkGateMeasurementCompletion = Readonly<{
  baseFirst: boolean;
  candidateFirst: boolean;
  candidateSecond: boolean;
  baseSecond: boolean;
  candidateThird: boolean;
  baseThird: boolean;
  baseFourth: boolean;
  candidateFourth: boolean;
}>;

type BenchmarkGateDetails = Readonly<{
  baseControl: BenchmarkComparison | null;
  candidateControl: BenchmarkComparison | null;
  firstBalancedBracket: BenchmarkComparison | null;
  secondBalancedBracket: BenchmarkComparison | null;
}>;

export type BenchmarkGateComparison =
  | Readonly<{
      kind: "pass" | "regression";
      details: BenchmarkGateDetails;
    }>
  | Readonly<{
      kind: "inconclusive";
      reason: BenchmarkGateReason;
      details: BenchmarkGateDetails;
    }>;

export type BenchmarkGateReports = Readonly<{
  baseFirst: unknown;
  candidateFirst: unknown;
  candidateSecond: unknown;
  baseSecond: unknown;
  candidateThird: unknown;
  baseThird: unknown;
  baseFourth: unknown;
  candidateFourth: unknown;
}>;

function emptyGateDetails(): BenchmarkGateDetails {
  return {
    baseControl: null,
    candidateControl: null,
    firstBalancedBracket: null,
    secondBalancedBracket: null,
  };
}

function gateInconclusive(
  reason: BenchmarkGateReason,
  details: BenchmarkGateDetails,
): BenchmarkGateComparison {
  return { kind: "inconclusive", reason, details };
}

/**
 * A same-revision control must be non-regressing in both directions under the
 * documented p50-and-p95 rule. Preserve a one-sided tail shift in its metrics,
 * but do not turn it into a new threshold: it is not a regression in either
 * direction. An actual two-sided control regression or incompatible signature
 * remains nonzero.
 */
function compareControl(first: BenchmarkReport, second: BenchmarkReport): BenchmarkComparison {
  const forward = compareBenchmarkReports(first, second);
  const reverse = compareBenchmarkReports(second, first);
  if (forward.kind === "regression") {
    return forward;
  }
  if (reverse.kind === "regression") {
    return reverse;
  }
  if (forward.kind === "inconclusive" && forward.reason !== "one-sided-deterioration") {
    return forward;
  }
  if (reverse.kind === "inconclusive" && reverse.reason !== "one-sided-deterioration") {
    return reverse;
  }
  const diagnostic =
    forward.kind === "inconclusive" ? forward : reverse.kind === "inconclusive" ? reverse : forward;
  return { kind: "pass", metrics: diagnostic.metrics };
}

function aggregateBracketReports(
  first: BenchmarkReport,
  second: BenchmarkReport,
): BenchmarkReport | null {
  if (
    first.schemaVersion !== second.schemaVersion ||
    first.schemaVersion !== BENCHMARK_REPORT_SCHEMA ||
    first.run.revision !== second.run.revision ||
    first.run.warmupRuns !== second.run.warmupRuns ||
    first.environment.platform !== second.environment.platform ||
    first.environment.architecture !== second.environment.architecture ||
    first.environment.bunVersion !== second.environment.bunVersion
  ) {
    return null;
  }

  const measurements: BenchmarkMeasurement[] = [];
  for (const id of BENCHMARK_METRIC_IDS) {
    const firstMeasurement = measurementById(first, id);
    const secondMeasurement = measurementById(second, id);
    if (
      firstMeasurement === null ||
      secondMeasurement === null ||
      firstMeasurement.unit !== secondMeasurement.unit ||
      firstMeasurement.datasetRevision !== secondMeasurement.datasetRevision ||
      firstMeasurement.state !== secondMeasurement.state ||
      firstMeasurement.warmupSamples !== secondMeasurement.warmupSamples ||
      firstMeasurement.samples.length !== secondMeasurement.samples.length
    ) {
      return null;
    }
    measurements.push(
      createBenchmarkMeasurement({
        id,
        datasetRevision: firstMeasurement.datasetRevision,
        state: firstMeasurement.state,
        warmupSamples: firstMeasurement.warmupSamples,
        samples: [...firstMeasurement.samples, ...secondMeasurement.samples],
      }),
    );
  }

  return createBenchmarkReport(measurements, first.environment, {
    revision: first.run.revision,
    trial: "manual",
    warmupRuns: first.run.warmupRuns,
  });
}

/**
 * Compare two fixed, temporally symmetric measurement brackets. The outer
 * bracket pools the first and last report of each revision; the inner bracket
 * pools the middle pair. Both brackets therefore contain one base-before-
 * candidate and one candidate-before-base ordering, and their base and
 * candidate aggregates have the same temporal centre. The workflow always
 * runs all eight reports; aggregation is a declared statistic, never a
 * conditional retry or threshold bypass.
 */
export function compareBenchmarkGate(reports: BenchmarkGateReports): BenchmarkGateComparison {
  const baseFirstResult = parseBenchmarkReport(reports.baseFirst);
  if (!baseFirstResult.ok) {
    return gateInconclusive("base-first-report-invalid", emptyGateDetails());
  }
  const candidateFirstResult = parseBenchmarkReport(reports.candidateFirst);
  if (!candidateFirstResult.ok) {
    return gateInconclusive("candidate-first-report-invalid", emptyGateDetails());
  }
  const candidateSecondResult = parseBenchmarkReport(reports.candidateSecond);
  if (!candidateSecondResult.ok) {
    return gateInconclusive("candidate-second-report-invalid", emptyGateDetails());
  }
  const baseSecondResult = parseBenchmarkReport(reports.baseSecond);
  if (!baseSecondResult.ok) {
    return gateInconclusive("base-second-report-invalid", emptyGateDetails());
  }
  const candidateThirdResult = parseBenchmarkReport(reports.candidateThird);
  if (!candidateThirdResult.ok) {
    return gateInconclusive("candidate-third-report-invalid", emptyGateDetails());
  }
  const baseThirdResult = parseBenchmarkReport(reports.baseThird);
  if (!baseThirdResult.ok) {
    return gateInconclusive("base-third-report-invalid", emptyGateDetails());
  }
  const baseFourthResult = parseBenchmarkReport(reports.baseFourth);
  if (!baseFourthResult.ok) {
    return gateInconclusive("base-fourth-report-invalid", emptyGateDetails());
  }
  const candidateFourthResult = parseBenchmarkReport(reports.candidateFourth);
  if (!candidateFourthResult.ok) {
    return gateInconclusive("candidate-fourth-report-invalid", emptyGateDetails());
  }

  const baseFirst = baseFirstResult.value;
  const candidateFirst = candidateFirstResult.value;
  const candidateSecond = candidateSecondResult.value;
  const baseSecond = baseSecondResult.value;
  const candidateThird = candidateThirdResult.value;
  const baseThird = baseThirdResult.value;
  const baseFourth = baseFourthResult.value;
  const candidateFourth = candidateFourthResult.value;
  const allReports = [
    baseFirst,
    candidateFirst,
    candidateSecond,
    baseSecond,
    candidateThird,
    baseThird,
    baseFourth,
    candidateFourth,
  ];

  if (
    baseFirst.run.trial !== "base-first" ||
    candidateFirst.run.trial !== "candidate-first" ||
    candidateSecond.run.trial !== "candidate-second" ||
    baseSecond.run.trial !== "base-second" ||
    candidateThird.run.trial !== "candidate-third" ||
    baseThird.run.trial !== "base-third" ||
    baseFourth.run.trial !== "base-fourth" ||
    candidateFourth.run.trial !== "candidate-fourth"
  ) {
    return gateInconclusive("trial-mismatch", emptyGateDetails());
  }
  if (
    baseFirst.run.revision !== baseSecond.run.revision ||
    baseFirst.run.revision !== baseThird.run.revision ||
    baseFirst.run.revision !== baseFourth.run.revision ||
    candidateFirst.run.revision !== candidateSecond.run.revision ||
    candidateFirst.run.revision !== candidateThird.run.revision ||
    candidateFirst.run.revision !== candidateFourth.run.revision ||
    baseFirst.run.revision === candidateFirst.run.revision
  ) {
    return gateInconclusive("revision-mismatch", emptyGateDetails());
  }
  if (allReports.some((report) => report.run.warmupRuns < BENCHMARK_SETTLING_WARMUP_RUNS)) {
    return gateInconclusive("warmup-incomplete", emptyGateDetails());
  }

  const firstBase = aggregateBracketReports(baseFirst, baseFourth);
  const firstCandidate = aggregateBracketReports(candidateFirst, candidateFourth);
  const secondBase = aggregateBracketReports(baseSecond, baseThird);
  const secondCandidate = aggregateBracketReports(candidateSecond, candidateThird);
  if (
    firstBase === null ||
    firstCandidate === null ||
    secondBase === null ||
    secondCandidate === null
  ) {
    return gateInconclusive("bracket-aggregation-invalid", emptyGateDetails());
  }

  const baseControl = compareControl(firstBase, secondBase);
  const candidateControl = compareControl(firstCandidate, secondCandidate);
  const firstBalancedBracket = compareBenchmarkReports(firstBase, firstCandidate);
  const secondBalancedBracket = compareBenchmarkReports(secondBase, secondCandidate);
  const details: BenchmarkGateDetails = {
    baseControl,
    candidateControl,
    firstBalancedBracket,
    secondBalancedBracket,
  };

  if (baseControl.kind !== "pass") {
    return gateInconclusive("base-control-unstable", details);
  }
  if (candidateControl.kind !== "pass") {
    return gateInconclusive("candidate-control-unstable", details);
  }
  if (
    firstBalancedBracket.kind === "inconclusive" ||
    secondBalancedBracket.kind === "inconclusive"
  ) {
    return gateInconclusive("paired-comparison-inconclusive", details);
  }
  if (firstBalancedBracket.kind === "regression" || secondBalancedBracket.kind === "regression") {
    if (firstBalancedBracket.kind !== "regression" || secondBalancedBracket.kind !== "regression") {
      return gateInconclusive("paired-verdict-disagreement", details);
    }
    return { kind: "regression", details };
  }
  return { kind: "pass", details };
}

/**
 * Require every benchmark test command to exit successfully before its report
 * can contribute to a passing gate.
 */
export function compareCompletedBenchmarkGate(
  reports: BenchmarkGateReports,
  completion: BenchmarkGateMeasurementCompletion,
): BenchmarkGateComparison {
  if (
    !completion.baseFirst ||
    !completion.candidateFirst ||
    !completion.candidateSecond ||
    !completion.baseSecond ||
    !completion.candidateThird ||
    !completion.baseThird ||
    !completion.baseFourth ||
    !completion.candidateFourth
  ) {
    return gateInconclusive("measurement-incomplete", emptyGateDetails());
  }
  return compareBenchmarkGate(reports);
}

function fixed(value: number): string {
  return value.toFixed(3);
}

function formatMetricComparisons(comparisons: readonly BenchmarkMetricComparison[]): string[] {
  return comparisons.map(
    (metric) =>
      `${metric.id}: ${metric.classification}; ` +
      `p50 ${fixed(metric.base.p50)}→${fixed(metric.candidate.p50)} ms; ` +
      `p95 ${fixed(metric.base.p95)}→${fixed(metric.candidate.p95)} ms`,
  );
}

/** Bounded, plain-text output for local use and the GitHub Actions summary. */
export function formatBenchmarkComparison(comparison: BenchmarkComparison): string {
  const headline =
    comparison.kind === "pass"
      ? "benchmark comparison: PASS"
      : comparison.kind === "regression"
        ? "benchmark comparison: REGRESSION"
        : `benchmark comparison: INCONCLUSIVE (${comparison.reason})`;
  return [headline, ...formatMetricComparisons(comparison.metrics)].join("\n");
}

/** Bounded CI diagnostics for the aggregate controls and both balanced brackets. */
export function formatBenchmarkGateComparison(comparison: BenchmarkGateComparison): string {
  let headline: string;
  switch (comparison.kind) {
    case "pass":
      headline = "benchmark gate: PASS";
      break;
    case "regression":
      headline = "benchmark gate: REGRESSION";
      break;
    case "inconclusive":
      headline = `benchmark gate: INCONCLUSIVE (${comparison.reason})`;
      break;
  }
  const namedDetails: readonly [string, BenchmarkComparison | null][] = [
    ["base control", comparison.details.baseControl],
    ["candidate control", comparison.details.candidateControl],
    ["first balanced bracket", comparison.details.firstBalancedBracket],
    ["second balanced bracket", comparison.details.secondBalancedBracket],
  ];
  return [
    headline,
    ...namedDetails.flatMap(([name, detail]) =>
      detail === null
        ? []
        : [`${name}: ${detail.kind.toUpperCase()}`, ...formatMetricComparisons(detail.metrics)],
    ),
  ].join("\n");
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

async function readReport(path: string | undefined): Promise<unknown | null> {
  if (path === undefined || path.trim().length === 0) {
    return null;
  }
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPath(error)) {
      return null;
    }
    return null;
  }
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

async function compareFromEnvironment(): Promise<BenchmarkGateComparison> {
  const [
    baseFirst,
    candidateFirst,
    candidateSecond,
    baseSecond,
    candidateThird,
    baseThird,
    baseFourth,
    candidateFourth,
  ] = await Promise.all([
    readReport(process.env.FALRYN_BENCHMARK_BASE_FIRST_REPORT),
    readReport(process.env.FALRYN_BENCHMARK_CANDIDATE_FIRST_REPORT),
    readReport(process.env.FALRYN_BENCHMARK_CANDIDATE_SECOND_REPORT),
    readReport(process.env.FALRYN_BENCHMARK_BASE_SECOND_REPORT),
    readReport(process.env.FALRYN_BENCHMARK_CANDIDATE_THIRD_REPORT),
    readReport(process.env.FALRYN_BENCHMARK_BASE_THIRD_REPORT),
    readReport(process.env.FALRYN_BENCHMARK_BASE_FOURTH_REPORT),
    readReport(process.env.FALRYN_BENCHMARK_CANDIDATE_FOURTH_REPORT),
  ]);
  return compareCompletedBenchmarkGate(
    {
      baseFirst,
      candidateFirst,
      candidateSecond,
      baseSecond,
      candidateThird,
      baseThird,
      baseFourth,
      candidateFourth,
    },
    {
      baseFirst: process.env.FALRYN_BENCHMARK_BASE_FIRST_COMPLETED === "1",
      candidateFirst: process.env.FALRYN_BENCHMARK_CANDIDATE_FIRST_COMPLETED === "1",
      candidateSecond: process.env.FALRYN_BENCHMARK_CANDIDATE_SECOND_COMPLETED === "1",
      baseSecond: process.env.FALRYN_BENCHMARK_BASE_SECOND_COMPLETED === "1",
      candidateThird: process.env.FALRYN_BENCHMARK_CANDIDATE_THIRD_COMPLETED === "1",
      baseThird: process.env.FALRYN_BENCHMARK_BASE_THIRD_COMPLETED === "1",
      baseFourth: process.env.FALRYN_BENCHMARK_BASE_FOURTH_COMPLETED === "1",
      candidateFourth: process.env.FALRYN_BENCHMARK_CANDIDATE_FOURTH_COMPLETED === "1",
    },
  );
}

async function run(): Promise<void> {
  const comparison = await compareFromEnvironment();
  const output = `${formatBenchmarkGateComparison(comparison)}\n`;
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
