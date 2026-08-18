/**
 * Brief, Hush, Loom, and compression parent seam (#101) through #107 eval.
 *
 * Compact-model, structural, and history observations are produced by the
 * verified lane ports, then scored together. Mixed estimated/provider tokens
 * remain forbidden. Product tools stay later.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { CONTENT_DIGEST_ALGORITHM, contentDigest } from "./artifact.ts";
import type { ContentHasherPort } from "./blob.ts";
import { type CompactModelPort, reduceCompact } from "./compact-model.ts";
import { evaluateCompressionRun } from "./compression-eval.ts";
import { checkpointHistory } from "./history-checkpoint.ts";
import { ok } from "./result.ts";
import { reduceStructural } from "./structural-reduce.ts";

function hasher(): ContentHasherPort {
  return {
    create() {
      const hash = createHash("sha256");
      return {
        update(chunk) {
          hash.update(chunk);
        },
        digest() {
          return contentDigest.from(`${CONTENT_DIGEST_ALGORITHM}:${hash.digest("hex")}`);
        },
      };
    },
  };
}

describe("compression engine scenarios", () => {
  test("compact, structural, and history observations score as one estimated run", () => {
    const port: CompactModelPort = {
      compact() {
        return ok({ kind: "extractive", text: "folded narration" });
      },
    };
    const compact = reduceCompact(
      { text: "alpha ".repeat(400).trim(), compactUse: "evaluated" },
      hasher(),
      port,
    );
    expect(compact.ok).toBe(true);
    if (!compact.ok) {
      return;
    }
    const structural = reduceStructural(
      { family: "file", text: '{"keep":true,"drop":1}' },
      hasher(),
    );
    expect(structural.ok).toBe(true);
    if (!structural.ok) {
      return;
    }
    const checkpoint = checkpointHistory(
      {
        checkpointId: "chk-seam",
        items: [
          { id: "evt-commit", kind: "user-commitment", text: "keep the required fact" },
          { id: "evt-prose", kind: "turn-prose", text: "beta ".repeat(400).trim() },
        ],
        compactUse: "evaluated",
      },
      hasher(),
      port,
    );
    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok || checkpoint.value.folded === null) {
      return;
    }

    const tokens = (bytes: number) => Math.ceil(bytes / 4);
    const run = evaluateCompressionRun({
      observations: [
        {
          lane: "compact-model",
          fidelity: compact.value.evidenceFidelity,
          claimsExact: compact.value.claimsExact,
          complete: compact.value.complete,
          sourceBytes: compact.value.sourceBytes,
          reducedBytes: compact.value.reducedBytes,
          originalDigest: compact.value.expansion?.digest,
          expansionDigest: compact.value.expansion?.digest,
          tokenKind: "estimated",
          sourceTokens: tokens(compact.value.sourceBytes),
          reducedTokens: tokens(compact.value.reducedBytes),
          latencyMs: 5,
        },
        {
          lane: "structural",
          fidelity: structural.value.evidenceFidelity,
          claimsExact: structural.value.claimsExact,
          complete: structural.value.complete,
          sourceBytes: structural.value.sourceBytes,
          reducedBytes: structural.value.reducedBytes,
          originalDigest: structural.value.expansion?.digest,
          expansionDigest: structural.value.expansion?.digest,
          tokenKind: "estimated",
          sourceTokens: tokens(structural.value.sourceBytes),
          reducedTokens: tokens(structural.value.reducedBytes),
          latencyMs: 4,
        },
        {
          lane: "history-checkpoint",
          fidelity: checkpoint.value.folded.evidenceFidelity,
          claimsExact: checkpoint.value.folded.claimsExact,
          complete: checkpoint.value.folded.complete,
          sourceBytes: checkpoint.value.folded.sourceBytes,
          reducedBytes: checkpoint.value.folded.reducedBytes,
          originalDigest: checkpoint.value.folded.expansion?.digest,
          expansionDigest: checkpoint.value.folded.expansion?.digest,
          tokenKind: "estimated",
          sourceTokens: tokens(checkpoint.value.folded.sourceBytes),
          reducedTokens: tokens(checkpoint.value.folded.reducedBytes),
          latencyMs: 6,
        },
      ],
    });
    expect(run.ok).toBe(true);
    if (!run.ok) {
      return;
    }
    expect(run.value.observationCount).toBe(3);
    expect(run.value.tokenKind).toBe("estimated");
    expect(run.value.results.every((item) => item.reversible)).toBe(true);
    expect(
      run.value.results.some((item) => item.lane === "compact-model" && !item.claimsExact),
    ).toBe(true);
  });
});
