import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  BENCHMARK_METRIC_IDS,
  BENCHMARK_REPORT_SCHEMA,
  compareBenchmarkGate,
  compareBenchmarkReports,
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

function gateReport(
  revision: string,
  trial: "base-first" | "candidate-first" | "candidate-second" | "base-second",
  samples: readonly number[] = [10, 11, 12, 13, 14],
  warmupRuns = 1,
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

  test("passes only when bracketing controls and both relative orders agree", () => {
    const comparison = compareBenchmarkGate({
      baseFirst: gateReport("base-sha", "base-first"),
      candidateFirst: gateReport("candidate-sha", "candidate-first"),
      candidateSecond: gateReport("candidate-sha", "candidate-second"),
      baseSecond: gateReport("base-sha", "base-second"),
    });

    expect(comparison).toMatchObject({
      kind: "pass",
      details: {
        baseControl: { kind: "pass" },
        candidateControl: { kind: "pass" },
        baseFirstCandidateFirst: { kind: "pass" },
        baseSecondCandidateSecond: { kind: "pass" },
      },
    });
    expect(formatBenchmarkGateComparison(comparison)).toStartWith("benchmark gate: PASS");
  });

  test("passes a no-difference bracket with sub-threshold order variation", () => {
    const comparison = compareBenchmarkGate({
      baseFirst: gateReport("base-sha", "base-first", [10, 11, 12, 13, 14]),
      candidateFirst: gateReport("candidate-sha", "candidate-first", [11, 12, 13, 14, 15]),
      candidateSecond: gateReport("candidate-sha", "candidate-second", [11, 12, 13, 14, 15]),
      baseSecond: gateReport("base-sha", "base-second", [12, 13, 14, 15, 16]),
    });

    expect(comparison).toMatchObject({
      kind: "pass",
      details: {
        baseControl: { kind: "pass" },
        candidateControl: { kind: "pass" },
        baseFirstCandidateFirst: { kind: "pass" },
        baseSecondCandidateSecond: { kind: "pass" },
      },
    });
  });

  test("rejects a synthetic p50 and p95 regression in both relative orders", () => {
    const comparison = compareBenchmarkGate({
      baseFirst: gateReport("base-sha", "base-first"),
      candidateFirst: gateReport("candidate-sha", "candidate-first", [15, 16, 18, 19, 21]),
      candidateSecond: gateReport("candidate-sha", "candidate-second", [15, 16, 18, 19, 21]),
      baseSecond: gateReport("base-sha", "base-second"),
    });

    expect(comparison).toMatchObject({
      kind: "regression",
      details: {
        baseFirstCandidateFirst: { kind: "regression" },
        baseSecondCandidateSecond: { kind: "regression" },
      },
    });
  });

  test("fails inconclusively when an equal-revision control is unstable", () => {
    const comparison = compareBenchmarkGate({
      baseFirst: gateReport("base-sha", "base-first"),
      candidateFirst: gateReport("candidate-sha", "candidate-first"),
      candidateSecond: gateReport("candidate-sha", "candidate-second"),
      baseSecond: gateReport("base-sha", "base-second", [20, 21, 22, 23, 24]),
    });

    expect(comparison).toMatchObject({ kind: "inconclusive", reason: "base-control-unstable" });
  });

  test("fails inconclusively when the two relative-order verdicts disagree", () => {
    const comparison = compareBenchmarkGate({
      baseFirst: gateReport("base-sha", "base-first", [10, 10, 10, 10, 10]),
      candidateFirst: gateReport("candidate-sha", "candidate-first", [15, 15, 15, 15, 15]),
      candidateSecond: gateReport("candidate-sha", "candidate-second", [14, 14, 14, 14, 14]),
      baseSecond: gateReport("base-sha", "base-second", [10, 10, 10, 10, 10]),
    });

    expect(comparison).toMatchObject({
      kind: "inconclusive",
      reason: "paired-verdict-disagreement",
    });
  });

  test("fails inconclusively when a trial did not receive a warm-up run", () => {
    const comparison = compareBenchmarkGate({
      baseFirst: gateReport("base-sha", "base-first"),
      candidateFirst: gateReport("candidate-sha", "candidate-first"),
      candidateSecond: gateReport("candidate-sha", "candidate-second", undefined, 0),
      baseSecond: gateReport("base-sha", "base-second"),
    });

    expect(comparison).toEqual({
      kind: "inconclusive",
      reason: "warmup-incomplete",
      details: {
        baseControl: null,
        candidateControl: null,
        baseFirstCandidateFirst: null,
        baseSecondCandidateSecond: null,
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
      ["schema-mismatch", { ...report(), schemaVersion: "falryn.benchmark-report/v4" }],
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
