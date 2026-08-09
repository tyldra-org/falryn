import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  BENCHMARK_METRIC_IDS,
  BENCHMARK_REPORT_SCHEMA,
  compareBenchmarkReports,
  createBenchmarkMeasurement,
  createBenchmarkReport,
  formatBenchmarkComparison,
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
      ["schema-mismatch", { ...report(), schemaVersion: "falryn.benchmark-report/v2" }],
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
