/** Compare bounded Loom retrieval with a pinned Headroom large-evidence result. */

import { createHash } from "node:crypto";

import {
  CONTENT_DIGEST_ALGORITHM,
  type ContentHasherPort,
  commitLoomManifest,
  completeLoomRetrieval,
  contentDigest,
  createLoomCache,
  type LoomArtifactReadPlan,
  type LoomProjectionResult,
  type LoomProjectionSource,
  planLoomRetrieval,
} from "../src/domain/index.ts";
import { HEADROOM_LOOM_BASELINE } from "./fixtures/headroom-loom-baseline.ts";
import {
  createLoomLargeEvidenceFixture,
  LOOM_EVIDENCE_CORPUS_VERSION,
  LOOM_HEAD_FACT,
  LOOM_RANGE_FACT,
  LOOM_TAIL_FACT,
} from "./fixtures/loom-large-evidence.ts";
import { estimateTokens } from "./hush-ls-scorecard.ts";

const encoder = new TextEncoder();

type LoomScore = {
  readonly projection: "range" | "head-tail";
  readonly storageBytesRead: number;
  readonly projectedBytes: number;
  readonly projectedTokens: number;
  readonly overheadBytes: number;
  readonly overheadTokens: number;
  readonly totalTokens: number;
  readonly headroomTotalTokens: number;
  readonly requiredFactsPreserved: boolean;
  readonly headroomRequiredFactsPreserved: boolean;
  readonly exactRecoverable: boolean;
  readonly withinHeadroomBudget: boolean;
};

export type LoomScorecard = {
  readonly corpusVersion: typeof LOOM_EVIDENCE_CORPUS_VERSION;
  readonly strategyVersion: "loom.v1";
  readonly headroom: typeof HEADROOM_LOOM_BASELINE;
  readonly sourceBytes: number;
  readonly sourceTokens: number;
  readonly sourceDigestMatches: boolean;
  readonly scores: readonly LoomScore[];
  readonly passes: boolean;
};

function digestOf(bytes: Uint8Array): ReturnType<typeof contentDigest.from> {
  return contentDigest.from(
    `${CONTENT_DIGEST_ALGORITHM}:${createHash("sha256").update(bytes).digest("hex")}`,
  );
}

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

function sourceForPlan(bytes: Uint8Array, plan: LoomArtifactReadPlan): LoomProjectionSource {
  switch (plan.kind) {
    case "complete":
      return { kind: "complete", artifactId: plan.artifactId, bytes };
    case "range":
      return {
        kind: "range",
        artifactId: plan.artifactId,
        offset: plan.offset,
        bytes: bytes.slice(plan.offset, plan.offset + plan.length),
      };
    case "head-tail":
      return {
        kind: "head-tail",
        artifactId: plan.artifactId,
        headOffset: plan.headOffset,
        headBytes: bytes.slice(plan.headOffset, plan.headOffset + plan.headLength),
        tailOffset: plan.tailOffset,
        tailBytes: bytes.slice(plan.tailOffset, plan.tailOffset + plan.tailLength),
      };
  }
}

function storageBytes(plan: LoomArtifactReadPlan): number {
  return plan.kind === "head-tail" ? plan.headLength + plan.tailLength : plan.length;
}

function score(
  projection: LoomScore["projection"],
  result: LoomProjectionResult,
  read: LoomArtifactReadPlan,
  requiredFacts: readonly string[],
  headroomRequiredFactsPreserved: boolean,
): LoomScore {
  const projectedBytes = encoder.encode(result.text).byteLength;
  const overhead = JSON.stringify({
    fidelity: result.fidelity,
    complete: result.complete,
    expansion: result.expansion,
    omissions: result.omissions,
  });
  const overheadBytes = encoder.encode(overhead).byteLength;
  const projectedTokens = estimateTokens(result.text);
  const overheadTokens = estimateTokens(overhead);
  const totalTokens = projectedTokens + overheadTokens;
  const headroomTotalTokens =
    HEADROOM_LOOM_BASELINE.estimatedTokensAfter + Math.ceil(HEADROOM_LOOM_BASELINE.ccrKeyBytes / 4);
  return {
    projection,
    storageBytesRead: storageBytes(read),
    projectedBytes,
    projectedTokens,
    overheadBytes,
    overheadTokens,
    totalTokens,
    headroomTotalTokens,
    requiredFactsPreserved: requiredFacts.every((fact) => result.text.includes(fact)),
    headroomRequiredFactsPreserved,
    exactRecoverable: result.exactRecoverable && result.expansion.digest === result.handle.digest,
    withinHeadroomBudget: totalTokens <= headroomTotalTokens,
  };
}

export function createLoomScorecard(): LoomScorecard {
  const fixture = createLoomLargeEvidenceFixture();
  const source = encoder.encode(fixture.source);
  const digest = digestOf(source);
  const unrelated = encoder.encode("unrelated evidence\n".repeat(512));
  const committed = commitLoomManifest({
    id: "loom-scorecard",
    workspaceId: "ws-scorecard",
    sessionId: "sess-scorecard",
    members: [
      {
        artifactId: "large-evidence",
        digest,
        byteLength: source.byteLength,
        mediaType: "text/plain",
        encoding: "identity",
        sensitivity: "user-content",
        availability: "available",
        required: true,
        protectedFacts: [LOOM_HEAD_FACT, LOOM_RANGE_FACT, LOOM_TAIL_FACT],
        summary: null,
      },
      {
        artifactId: "unrelated",
        digest: digestOf(unrelated),
        byteLength: unrelated.byteLength,
        mediaType: "text/plain",
        encoding: "identity",
        sensitivity: "user-content",
        availability: "available",
        required: true,
        protectedFacts: [],
        summary: null,
      },
    ],
  });
  if (!committed.ok) {
    throw new Error(`failed to commit Loom scorecard manifest: ${committed.error.code}`);
  }
  const members = committed.value.members.map((member) => ({
    artifactId: member.artifactId,
    availability: member.availability,
    digest: member.digest,
    byteLength: member.byteLength,
  }));
  const cache = createLoomCache();
  const projections = [
    {
      projection: "range" as const,
      request: {
        kind: "range" as const,
        member: "large-evidence",
        offset: fixture.rangeOffset,
        length: fixture.rangeLength,
      },
      requiredFacts: [LOOM_RANGE_FACT],
      headroomFacts: HEADROOM_LOOM_BASELINE.requiredFacts.range,
    },
    {
      projection: "head-tail" as const,
      request: {
        kind: "head-tail" as const,
        member: "large-evidence",
        headBytes: fixture.headBytes,
        tailBytes: fixture.tailBytes,
      },
      requiredFacts: [LOOM_HEAD_FACT, LOOM_TAIL_FACT],
      headroomFacts:
        HEADROOM_LOOM_BASELINE.requiredFacts.head && HEADROOM_LOOM_BASELINE.requiredFacts.tail,
    },
  ];
  const scores = projections.map((candidate) => {
    const planned = planLoomRetrieval(
      {
        id: `ev-${candidate.projection}`,
        manifest: committed.value,
        expectedWorkspaceId: "ws-scorecard",
        expectedSessionId: "sess-scorecard",
        members,
        projection: candidate.request,
      },
      cache,
    );
    if (!planned.ok) {
      throw new Error(`failed to plan ${candidate.projection}: ${planned.error.code}`);
    }
    const completed = completeLoomRetrieval(
      planned.value,
      sourceForPlan(source, planned.value.read),
      hasher(),
      cache,
    );
    if (!completed.ok) {
      throw new Error(`failed to retrieve ${candidate.projection}: ${completed.error.code}`);
    }
    return score(
      candidate.projection,
      completed.value,
      planned.value.read,
      candidate.requiredFacts,
      candidate.headroomFacts,
    );
  });
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const passes =
    source.byteLength === HEADROOM_LOOM_BASELINE.sourceBytes &&
    sourceSha256 === HEADROOM_LOOM_BASELINE.sourceSha256 &&
    scores.every(
      (entry) =>
        entry.requiredFactsPreserved && entry.exactRecoverable && entry.withinHeadroomBudget,
    );
  return {
    corpusVersion: LOOM_EVIDENCE_CORPUS_VERSION,
    strategyVersion: "loom.v1",
    headroom: HEADROOM_LOOM_BASELINE,
    sourceBytes: source.byteLength,
    sourceTokens: estimateTokens(fixture.source),
    sourceDigestMatches: sourceSha256 === HEADROOM_LOOM_BASELINE.sourceSha256,
    scores,
    passes,
  };
}

export function formatLoomScorecard(scorecard: LoomScorecard): string {
  const rows = scorecard.scores.map(
    (entry) =>
      `${entry.projection.padEnd(10)} ${String(entry.storageBytesRead).padStart(7)}B read  ${String(entry.totalTokens).padStart(5)}t Loom  ${String(entry.headroomTotalTokens).padStart(5)}t Headroom  facts=Loom:${entry.requiredFactsPreserved ? "all" : "loss"}/Headroom:${entry.headroomRequiredFactsPreserved ? "all" : "loss"}  ${entry.withinHeadroomBudget ? "PASS" : "FAIL"}`,
  );
  return [
    `Loom scorecard ${scorecard.corpusVersion}`,
    `Loom ${scorecard.strategyVersion} vs Headroom ${scorecard.headroom.version}; tokens=ceil(utf8-bytes/4)`,
    `Headroom baseline: handler=noop target=0.3 CCR=${scorecard.headroom.ccrKeyBytes}B`,
    `source: ${scorecard.sourceBytes}B / ${scorecard.sourceTokens}t; digest=${scorecard.sourceDigestMatches ? "match" : "mismatch"}`,
    ...rows,
    `scorecard: ${scorecard.passes ? "PASS" : "FAIL"}`,
  ].join("\n");
}

if (import.meta.main) {
  const scorecard = createLoomScorecard();
  console.log(
    process.argv.includes("--format=json")
      ? JSON.stringify(scorecard, null, 2)
      : formatLoomScorecard(scorecard),
  );
  if (!scorecard.passes) {
    process.exitCode = 1;
  }
}
