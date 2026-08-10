import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BenchmarkGateReports, BenchmarkTrial } from "./benchmark-regression.ts";
import {
  BENCHMARK_METRIC_IDS,
  BENCHMARK_REPORT_SCHEMA,
  BENCHMARK_SETTLING_WARMUP_RUNS,
  compareBenchmarkGate,
  compareBenchmarkReports,
  compareCompletedBenchmarkGate,
  createBenchmarkMeasurement,
  createBenchmarkReport,
  formatBenchmarkComparison,
  formatBenchmarkGateComparison,
  validateBenchmarkReportDestination,
  writeBenchmarkReport,
} from "./benchmark-regression.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true })));
});

function report(samples: readonly number[] = [10, 11, 12, 13, 14]) {
  return createBenchmarkReport(
    BENCHMARK_METRIC_IDS.map((id) =>
      createBenchmarkMeasurement({
        id,
        datasetRevision: `${id}-dataset-v1`,
        state: id === "migration-time" || id === "startup-to-first-draw" ? "cold" : "warm",
        samples,
      }),
    ),
    { platform: "darwin", architecture: "arm64", bunVersion: "1.3.14" },
  );
}

function changedReport(
  mutate: (value: ReturnType<typeof report>) => ReturnType<typeof report>,
): ReturnType<typeof report> {
  return mutate(report());
}

const gateTrials = {
  baseFirst: "base-first",
  candidateFirst: "candidate-first",
  candidateSecond: "candidate-second",
  baseSecond: "base-second",
  candidateThird: "candidate-third",
  baseThird: "base-third",
  baseFourth: "base-fourth",
  candidateFourth: "candidate-fourth",
} as const satisfies Record<string, BenchmarkTrial>;

type GateReportKey = keyof typeof gateTrials;

function gateReport(
  revision: string,
  trial: BenchmarkTrial,
  samples: readonly number[] = [10, 11, 12, 13, 14],
  warmupRuns = BENCHMARK_SETTLING_WARMUP_RUNS,
) {
  return createBenchmarkReport(
    BENCHMARK_METRIC_IDS.map((id) =>
      createBenchmarkMeasurement({
        id,
        datasetRevision: `${id}-dataset-v1`,
        state: id === "migration-time" || id === "startup-to-first-draw" ? "cold" : "warm",
        samples,
      }),
    ),
    { platform: "darwin", architecture: "arm64", bunVersion: "1.3.14" },
    { revision, trial, warmupRuns },
  );
}

function gateReports(
  samples: Partial<Record<GateReportKey, readonly number[]>> = {},
  warmupRuns: Partial<Record<GateReportKey, number>> = {},
): BenchmarkGateReports {
  const base = "base-sha";
  const candidate = "candidate-sha";
  const defaults = [10, 11, 12, 13, 14] as const;
  const value = (key: GateReportKey) => samples[key] ?? defaults;
  const warmup = (key: GateReportKey) => warmupRuns[key] ?? BENCHMARK_SETTLING_WARMUP_RUNS;

  return {
    baseFirst: gateReport(base, gateTrials.baseFirst, value("baseFirst"), warmup("baseFirst")),
    candidateFirst: gateReport(
      candidate,
      gateTrials.candidateFirst,
      value("candidateFirst"),
      warmup("candidateFirst"),
    ),
    candidateSecond: gateReport(
      candidate,
      gateTrials.candidateSecond,
      value("candidateSecond"),
      warmup("candidateSecond"),
    ),
    baseSecond: gateReport(base, gateTrials.baseSecond, value("baseSecond"), warmup("baseSecond")),
    candidateThird: gateReport(
      candidate,
      gateTrials.candidateThird,
      value("candidateThird"),
      warmup("candidateThird"),
    ),
    baseThird: gateReport(base, gateTrials.baseThird, value("baseThird"), warmup("baseThird")),
    baseFourth: gateReport(base, gateTrials.baseFourth, value("baseFourth"), warmup("baseFourth")),
    candidateFourth: gateReport(
      candidate,
      gateTrials.candidateFourth,
      value("candidateFourth"),
      warmup("candidateFourth"),
    ),
  };
}

describe("benchmark regression comparison", () => {
  test("accepts equal reports", () => {
    const comparison = compareBenchmarkReports(report(), report());

    expect(comparison).toEqual({
      kind: "pass",
      metrics: expect.arrayContaining([
        expect.objectContaining({ id: "migration-time", classification: "pass" }),
      ]),
    });
    expect(formatBenchmarkComparison(comparison)).toStartWith("benchmark comparison: PASS");
  });

  test("fails a metric only when both p50 and p95 regress by fifty percent", () => {
    const candidate = report([15, 16, 18, 19, 21]);
    const comparison = compareBenchmarkReports(report(), candidate);

    expect(comparison).toEqual({
      kind: "regression",
      metrics: expect.arrayContaining([
        expect.objectContaining({ id: "migration-time", classification: "regression" }),
      ]),
    });
  });

  test("treats one-sided deterioration as inconclusive", () => {
    const candidate = report([10, 11, 18, 19, 19]);
    const comparison = compareBenchmarkReports(report(), candidate);

    expect(comparison).toEqual({
      kind: "inconclusive",
      reason: "one-sided-deterioration",
      metrics: expect.arrayContaining([
        expect.objectContaining({
          id: "migration-time",
          classification: "one-sided-deterioration",
        }),
      ]),
    });
  });

  test("passes two stable balanced brackets", () => {
    const comparison = compareBenchmarkGate(gateReports());

    expect(comparison).toMatchObject({
      kind: "pass",
      details: {
        baseControl: { kind: "pass" },
        candidateControl: { kind: "pass" },
        firstBalancedBracket: { kind: "pass" },
        secondBalancedBracket: { kind: "pass" },
      },
    });
    expect(formatBenchmarkGateComparison(comparison)).toStartWith("benchmark gate: PASS");
  });

  test("pools temporally symmetric outer and inner brackets", () => {
    const comparison = compareBenchmarkGate(
      gateReports({
        baseFirst: [1, 1, 1, 1, 1],
        candidateFirst: [2, 2, 2, 2, 2],
        candidateSecond: [2, 2, 2, 2, 2],
        baseSecond: [1, 1, 1, 1, 1],
        baseThird: [9, 9, 9, 9, 9],
        candidateThird: [8, 8, 8, 8, 8],
        candidateFourth: [8, 8, 8, 8, 8],
        baseFourth: [9, 9, 9, 9, 9],
      }),
    );

    expect(comparison).toMatchObject({
      kind: "pass",
      details: {
        baseControl: { kind: "pass" },
        candidateControl: { kind: "pass" },
        firstBalancedBracket: { kind: "pass" },
        secondBalancedBracket: { kind: "pass" },
      },
    });
  });

  test("rejects a synthetic p50 and p95 regression in both balanced brackets", () => {
    const regression = [15, 16, 18, 19, 21];
    const comparison = compareBenchmarkGate(
      gateReports({
        candidateFirst: regression,
        candidateSecond: regression,
        candidateThird: regression,
        candidateFourth: regression,
      }),
    );

    expect(comparison).toMatchObject({
      kind: "regression",
      details: {
        firstBalancedBracket: { kind: "regression" },
        secondBalancedBracket: { kind: "regression" },
      },
    });
  });

  test("fails closed when an aggregated same-revision control regresses", () => {
    const comparison = compareBenchmarkGate(
      gateReports({
        baseSecond: [20, 21, 22, 23, 24],
        baseThird: [20, 21, 22, 23, 24],
      }),
    );

    expect(comparison).toMatchObject({
      kind: "inconclusive",
      reason: "base-control-unstable",
      details: {
        baseControl: { kind: "regression" },
      },
    });
  });

  test("fails closed when an aggregated control has a one-sided deterioration", () => {
    const comparison = compareBenchmarkGate(
      gateReports({
        baseSecond: [10, 11, 12, 13, 22],
        baseThird: [10, 11, 12, 13, 22],
      }),
    );

    expect(comparison).toMatchObject({
      kind: "inconclusive",
      reason: "base-control-unstable",
      details: {
        baseControl: { kind: "inconclusive", reason: "one-sided-deterioration" },
      },
    });
  });

  test("fails inconclusively when the two balanced bracket verdicts disagree", () => {
    const comparison = compareBenchmarkGate(
      gateReports({
        baseFirst: [10, 10, 10, 10, 10],
        baseSecond: [10, 10, 10, 10, 10],
        candidateFirst: [15, 15, 15, 15, 15],
        candidateSecond: [14.1, 14.1, 14.1, 14.1, 14.1],
        baseThird: [10, 10, 10, 10, 10],
        baseFourth: [10, 10, 10, 10, 10],
        candidateThird: [14.1, 14.1, 14.1, 14.1, 14.1],
        candidateFourth: [15, 15, 15, 15, 15],
      }),
    );

    expect(comparison).toMatchObject({
      kind: "inconclusive",
      reason: "paired-verdict-disagreement",
    });
  });

  test("fails inconclusively on a one-sided balanced bracket result", () => {
    const comparison = compareBenchmarkGate(
      gateReports({
        baseFirst: [10, 10, 10, 10, 10],
        candidateFirst: [10, 10, 10, 10, 20],
        baseFourth: [10, 10, 10, 10, 10],
        candidateFourth: [10, 10, 10, 10, 10],
      }),
    );

    expect(comparison).toMatchObject({
      kind: "inconclusive",
      reason: "paired-comparison-inconclusive",
    });
  });

  test("fails inconclusively when a trial lacks both settling warm-up runs", () => {
    const comparison = compareBenchmarkGate(gateReports({}, { candidateFourth: 1 }));

    expect(comparison).toEqual({
      kind: "inconclusive",
      reason: "warmup-incomplete",
      details: {
        baseControl: null,
        candidateControl: null,
        firstBalancedBracket: null,
        secondBalancedBracket: null,
      },
    });
  });

  test("fails inconclusively when a measurement command failed after writing a report", () => {
    const comparison = compareCompletedBenchmarkGate(gateReports(), {
      baseFirst: true,
      candidateFirst: true,
      candidateSecond: true,
      baseSecond: true,
      candidateThird: true,
      baseThird: true,
      baseFourth: true,
      candidateFourth: false,
    });

    expect(comparison).toEqual({
      kind: "inconclusive",
      reason: "measurement-incomplete",
      details: {
        baseControl: null,
        candidateControl: null,
        firstBalancedBracket: null,
        secondBalancedBracket: null,
      },
    });
  });

  test("rejects malformed and incomplete reports", () => {
    const incomplete = report();
    const missingMetric = {
      ...incomplete,
      measurements: incomplete.measurements.slice(1),
    };
    const malformed = {
      ...report(),
      measurements: [
        {
          ...report().measurements[0],
          samples: [10, Number.NaN, 12, 13, 14],
        },
      ],
    };

    expect(compareBenchmarkReports(incomplete, missingMetric)).toEqual({
      kind: "inconclusive",
      reason: "metric-missing",
      metrics: [],
    });
    expect(compareBenchmarkReports(incomplete, malformed)).toEqual({
      kind: "inconclusive",
      reason: "candidate-report-invalid",
      metrics: [],
    });
  });

  test("rejects each comparison signature mismatch", () => {
    const base = report();
    const signatures = [
      ["schema-mismatch", { ...report(), schemaVersion: "falryn.benchmark-report/v5" }],
      [
        "platform-mismatch",
        createBenchmarkReport(report().measurements, {
          platform: "linux",
          architecture: "arm64",
          bunVersion: "1.3.14",
        }),
      ],
      [
        "architecture-mismatch",
        createBenchmarkReport(report().measurements, {
          platform: "darwin",
          architecture: "x64",
          bunVersion: "1.3.14",
        }),
      ],
      [
        "bun-version-mismatch",
        createBenchmarkReport(report().measurements, {
          platform: "darwin",
          architecture: "arm64",
          bunVersion: "1.3.15",
        }),
      ],
      [
        "dataset-revision-mismatch",
        changedReport((value) => ({
          ...value,
          measurements: value.measurements.map((measurement, index) =>
            index === 0 ? { ...measurement, datasetRevision: "changed-v1" } : measurement,
          ),
        })),
      ],
      [
        "state-mismatch",
        changedReport((value) => ({
          ...value,
          measurements: value.measurements.map((measurement, index) =>
            index === 0 ? { ...measurement, state: "warm" } : measurement,
          ),
        })),
      ],
      [
        "warmup-sample-count-mismatch",
        changedReport((value) => ({
          ...value,
          measurements: value.measurements.map((measurement, index) =>
            index === 0 ? { ...measurement, warmupSamples: 1 } : measurement,
          ),
        })),
      ],
      [
        "sample-count-mismatch",
        changedReport((value) => ({
          ...value,
          measurements: value.measurements.map((measurement, index) =>
            index === 0
              ? createBenchmarkMeasurement({
                  ...measurement,
                  samples: [10, 11, 12, 13, 14, 15],
                })
              : measurement,
          ),
        })),
      ],
    ] as const;

    for (const [reason, candidate] of signatures) {
      expect(compareBenchmarkReports(base, candidate)).toEqual({
        kind: "inconclusive",
        reason,
        metrics: [],
      });
    }

    const insufficient = createBenchmarkReport(
      BENCHMARK_METRIC_IDS.map((id) =>
        createBenchmarkMeasurement({
          id,
          datasetRevision: `${id}-dataset-v1`,
          state: id === "migration-time" || id === "startup-to-first-draw" ? "cold" : "warm",
          samples: [10, 11, 12, 13],
        }),
      ),
      { platform: "darwin", architecture: "arm64", bunVersion: "1.3.14" },
    );
    expect(compareBenchmarkReports(insufficient, insufficient)).toEqual({
      kind: "inconclusive",
      reason: "insufficient-samples",
      metrics: [],
    });

    const zeroBaseline = report([0, 0, 0, 0, 0]);
    expect(compareBenchmarkReports(zeroBaseline, zeroBaseline)).toEqual({
      kind: "inconclusive",
      reason: "nonpositive-baseline",
      metrics: [],
    });
  });

  test("writes an atomically validated report only to a new absolute destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "falryn-benchmark-report-"));
    temporaryRoots.push(root);
    const destination = join(root, "report.json");

    await writeBenchmarkReport(destination, report());

    const written = JSON.parse(await readFile(destination, "utf8")) as {
      schemaVersion: string;
      measurements: readonly unknown[];
    };
    expect(written.schemaVersion).toBe(BENCHMARK_REPORT_SCHEMA);
    expect(written.measurements).toHaveLength(4);
    await expect(validateBenchmarkReportDestination(destination)).rejects.toThrow("already exists");
    await expect(validateBenchmarkReportDestination("report.json")).rejects.toThrow(
      "absolute file path",
    );
    await expect(
      validateBenchmarkReportDestination(join(dirname(dirname(import.meta.path)), "report.json")),
    ).rejects.toThrow("outside the repository");
  });

  test("refuses an incomplete report without creating its destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "falryn-benchmark-report-"));
    temporaryRoots.push(root);
    const destination = join(root, "incomplete.json");
    const incomplete = createBenchmarkReport(report().measurements.slice(1));

    await expect(writeBenchmarkReport(destination, incomplete)).rejects.toThrow("incomplete");
    await expect(stat(destination)).rejects.toThrow();
  });
});
