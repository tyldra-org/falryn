/** Regression contract for the aggregate Brief, Hush, and Loom qualification report. */

import { describe, expect, test } from "bun:test";

import { HUSH_REDUCER_VERSION } from "../src/domain/index.ts";
import {
  type CompressionQualificationInput,
  createCompressionQualificationReport,
  formatCompressionQualificationHuman,
  type ProductPathCheck,
  type ReviewedBriefQualification,
} from "./compression-scorecard.ts";
import qualification from "./fixtures/brief-qualification-commandcode-minimax-m3.json";
import { createHushCommandCoverageScorecard } from "./hush-command-coverage.ts";
import { HUSH_LS_CORPUS_VERSION } from "./hush-ls-scorecard.ts";
import { HUSH_PROJECTION_CORPUS_VERSION } from "./hush-projection-scorecard.ts";
import { HUSH_TREE_CORPUS_VERSION } from "./hush-tree-scorecard.ts";
import { createLoomScorecard } from "./loom-scorecard.ts";

const SECRET_SOURCE_TEXT = "raw-private-output-must-not-enter-report";

function productPath(status: ProductPathCheck["status"] = "pass"): ProductPathCheck {
  return {
    command: ["bun", "test", "product-path.test.ts"],
    exitCode: status === "pass" ? 0 : status === "fail" ? 1 : null,
    durationMs: 12,
    stdoutSha256: "a".repeat(64),
    stderrSha256: "b".repeat(64),
    status,
  };
}

function input(): CompressionQualificationInput {
  const measurement = (estimatedTokens: number) => ({
    bytes: estimatedTokens * 4,
    estimatedTokens,
    text: SECRET_SOURCE_TEXT,
  });
  return {
    generatedAt: "2026-08-30T00:00:00.000Z",
    repository: {
      revision: "1".repeat(40),
      dirty: false,
      platform: "darwin",
      architecture: "arm64",
      bunVersion: "1.4.0",
    },
    hush: {
      coverage: createHushCommandCoverageScorecard(),
      projections: {
        corpusVersion: HUSH_PROJECTION_CORPUS_VERSION,
        hushVersion: HUSH_REDUCER_VERSION,
        rtkVersion: "rtk 0.46.0",
        rtkCommit: "b34be37caf3796b69a50952a28e60e32b5daad43",
        scores: [
          {
            id: "projection",
            projection: "listing",
            gate: "rtk",
            raw: measurement(30),
            rtk: measurement(20),
            hush: measurement(10),
            competitiveTarget: "win",
            competitiveResult: "win",
            meetsCompetitiveTarget: true,
            withinRtkBudget: true,
            retainsRequiredContext: true,
            excludesKnownNoise: true,
            noArbitraryCap: true,
            recognized: true,
            result: "PASS",
          },
        ],
        passes: true,
      },
      ls: {
        corpusVersion: HUSH_LS_CORPUS_VERSION,
        hushVersion: HUSH_REDUCER_VERSION,
        rtkVersion: "rtk 0.46.0",
        estimator: "ceil(utf8-bytes/4)",
        scores: [
          {
            id: "listing",
            argv: ["-la"],
            raw: measurement(30),
            rtk: measurement(20),
            hush: measurement(10),
            fidelity: "deterministic-reduction",
            omissionRecords: 0,
            retainsEveryEntry: true,
            truncated: false,
            recoverable: true,
            withinRtkBudget: true,
          },
        ],
        passes: true,
      },
      tree: {
        corpusVersion: HUSH_TREE_CORPUS_VERSION,
        hushVersion: HUSH_REDUCER_VERSION,
        rtkVersion: "rtk 0.46.0",
        rtkCommit: "b34be37caf3796b69a50952a28e60e32b5daad43",
        estimator: "ceil(utf8-bytes/4)",
        scores: [
          {
            id: "tree",
            argv: [],
            raw: measurement(30),
            rtk: measurement(20),
            hush: measurement(10),
            fidelity: "deterministic-reduction",
            omissionRecords: 0,
            sameInformation: true,
            truncated: false,
            recoverable: true,
            withinRtkBudget: true,
          },
        ],
        passes: true,
      },
    },
    loom: createLoomScorecard(),
    brief: qualification,
    productPath: [productPath()],
  };
}

describe("compression live-path scorecard", () => {
  test("keeps all rows and token kinds separate in human and JSON projections", () => {
    const report = createCompressionQualificationReport(input());

    expect(report.overall).toEqual({ status: "pass", reasons: [] });
    expect(report.comparability.crossLaneTotal).toBeNull();
    expect(report.lanes.map((lane) => lane.tokenKind)).toEqual([
      "estimated",
      "estimated",
      "provider-reported",
    ]);
    expect(report.lanes.map((lane) => lane.rows.length)).toEqual([3, 2, 12]);
    expect(formatCompressionQualificationHuman(report)).toContain("scorecard: PASS");
    expect(formatCompressionQualificationHuman(report)).toContain("cross-lane total: n/a");
    expect(JSON.stringify(report)).not.toContain(SECRET_SOURCE_TEXT);
  });

  test("fails closed on dirty or incomplete product-path runs", () => {
    const dirty = input();
    const dirtyReport = createCompressionQualificationReport({
      ...dirty,
      repository: { ...dirty.repository, dirty: true },
    });
    expect(dirtyReport.overall).toMatchObject({
      status: "fail",
      reasons: expect.arrayContaining(["repository is dirty"]),
    });

    const cancelled = input();
    const cancelledReport = createCompressionQualificationReport({
      ...cancelled,
      productPath: [productPath("cancelled")],
    });
    expect(cancelledReport.overall.status).toBe("fail");
    expect(cancelledReport.productPath[0]?.status).toBe("cancelled");
  });

  test("rejects stale RTK metadata instead of normalizing baseline versions", () => {
    const stale = input();
    const report = createCompressionQualificationReport({
      ...stale,
      hush: {
        ...stale.hush,
        projections: { ...stale.hush.projections, rtkVersion: "rtk 0.45.0" },
      },
    });

    expect(report.lanes[0].baseline).toMatchObject({
      inventoryVersion: "rtk 0.45.0",
      executableVersion: "rtk 0.45.0",
    });
    expect(report.lanes[0].passes).toBe(false);
    expect(report.overall.reasons).toContain("hush qualification failed");
  });

  test("keeps missing Loom recovery and losing Brief rows visible", () => {
    const base = input();
    const loom = createLoomScorecard();
    const missingRecovery = {
      ...loom,
      scores: loom.scores.map((row, index) =>
        index === 0 ? { ...row, exactRecoverable: false } : row,
      ),
    };
    const reviewedBrief = {
      ...qualification,
      rows: qualification.rows.map((row, index) =>
        index === 0 ? { ...row, verdict: "loss", accepted: false } : row,
      ),
    } as ReviewedBriefQualification;
    const report = createCompressionQualificationReport({
      ...base,
      loom: missingRecovery,
      brief: reviewedBrief,
    });

    expect(report.lanes[1].rows.find((row) => row.id === "range")).toMatchObject({
      exactRecoverable: false,
      status: "loss",
    });
    expect(report.lanes[2].rows[0]).toMatchObject({ status: "loss" });
    expect(report.overall.status).toBe("fail");
  });
});
