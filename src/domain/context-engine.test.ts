/**
 * Context-engine child-seam scenarios across #82–#87.
 *
 * Large-repository overflow, long-session conversation pressure, stale
 * preservation, and conflicting same-origin evidence run through admit,
 * inspect, rank, budget, compose, and expand without merging facts or
 * rewriting stale to live.
 */

import { describe, expect, test } from "bun:test";

import { CONTENT_DIGEST_ALGORITHM, contentDigest } from "./artifact.ts";
import type { ContentHasherPort } from "./blob.ts";
import { composeContextPack } from "./context-compose.ts";
import {
  admitEvidenceCandidate,
  admitEvidenceCandidates,
  type EvidenceCandidate,
  type EvidenceCandidateInput,
  MAX_EVIDENCE_BATCH,
} from "./context-evidence.ts";
import { expandContextEvidence } from "./context-expand.ts";
import {
  DEFAULT_LONG_SESSION_CONVERSATION_ITEMS,
  inspectContextEvidence,
} from "./context-inspect.ts";

const DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(64)}`;
const OTHER_DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"b".repeat(64)}`;
const SECRET = "sk-live-SECRET-MUST-NOT-ESCAPE";
const TEXT = "export const ok = true;\n";
const OTHER_TEXT = "export const ok = false;\n";
const TEXT_BYTES = new TextEncoder().encode(TEXT).byteLength;
const OTHER_BYTES = new TextEncoder().encode(OTHER_TEXT).byteLength;

function hasherReturning(digest: string): ContentHasherPort {
  return {
    create() {
      return {
        update() {},
        digest() {
          return contentDigest.from(digest);
        },
      };
    },
  };
}

function admit(overrides: Partial<EvidenceCandidateInput> = {}): EvidenceCandidate {
  const result = admitEvidenceCandidate({
    id: "ev-1",
    sourceKind: "file",
    origin: "src/main.ts",
    workspaceId: "ws-1",
    payload: { kind: "inline", text: TEXT },
    estimatedTokens: 8,
    freshness: "live",
    sensitivity: "user-content",
    trust: "adapter-declared",
    fidelity: "exact-source",
    exactSource: { kind: "inline", digest: DIGEST, byteLength: TEXT_BYTES },
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(`admit failed: ${result.error.code}`);
  }
  return result.value;
}

describe("context engine scenarios", () => {
  test("large-repository batches stay partial with rank-limit continuation", () => {
    const candidates = Array.from({ length: MAX_EVIDENCE_BATCH }, (_, index) =>
      admit({
        id: `ev-${index}`,
        origin: `src/f${index}.ts`,
      }),
    );
    const inspected = inspectContextEvidence(candidates);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) {
      return;
    }
    expect(inspected.value.batch).toBe("at-limit");

    const packed = composeContextPack(candidates, { rank: { maxSelected: 8 } });
    expect(packed.ok).toBe(true);
    if (!packed.ok) {
      return;
    }
    expect(packed.value.items).toHaveLength(8);
    expect(packed.value.omitted.some((item) => item.reason === "rank-limit")).toBe(true);

    const overflow = admitEvidenceCandidates(
      Array.from({ length: MAX_EVIDENCE_BATCH + 1 }, (_, index) => ({
        id: `ev-${index}`,
        sourceKind: "file" as const,
        origin: `src/f${index}.ts`,
        workspaceId: "ws-1",
        payload: { kind: "inline" as const, text: TEXT },
        estimatedTokens: 8,
        freshness: "live" as const,
        sensitivity: "user-content" as const,
        trust: "adapter-declared" as const,
        fidelity: "exact-source" as const,
        exactSource: { kind: "inline" as const, digest: DIGEST, byteLength: TEXT_BYTES },
      })),
    );
    expect(overflow.ok).toBe(false);
    if (overflow.ok) {
      return;
    }
    expect(overflow.error.code).toBe("oversized");
  });

  test("long-session conversation keeps a pinned instruction as primary", () => {
    const instruction = admit({
      id: "ev-instruction",
      sourceKind: "instruction",
      origin: "system",
    });
    const conversations = Array.from(
      { length: DEFAULT_LONG_SESSION_CONVERSATION_ITEMS },
      (_, index) =>
        admit({
          id: `ev-turn-${index}`,
          sourceKind: "conversation",
          origin: `turn/${index}`,
        }),
    );
    const recent = conversations[conversations.length - 1];
    if (recent === undefined) {
      throw new Error("expected conversation items");
    }
    const inspected = inspectContextEvidence([instruction, ...conversations]);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) {
      return;
    }
    expect(inspected.value.longSession).toBe(true);

    const packed = composeContextPack([instruction, ...conversations], {
      rank: {
        pinnedIds: [instruction.id],
        recentlyAcceptedIds: [recent.id],
        maxSelected: 8,
      },
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) {
      return;
    }
    expect(packed.value.items[0]?.candidate.id).toBe(instruction.id);
    expect(packed.value.items[0]?.role).toBe("primary");
    expect(packed.value.items.some((item) => item.candidate.id === recent.id)).toBe(true);
  });

  test("stale evidence stays stale through compose and expand", () => {
    const stale = admit({
      id: "ev-stale",
      origin: "src/old.ts",
      freshness: "stale",
    });
    const live = admit({
      id: "ev-live",
      origin: "src/new.ts",
      freshness: "live",
    });
    const inspected = inspectContextEvidence([stale, live]);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) {
      return;
    }
    expect(inspected.value.staleIds).toEqual([stale.id]);

    const packed = composeContextPack([stale, live]);
    expect(packed.ok).toBe(true);
    if (!packed.ok) {
      return;
    }
    const staleItem = packed.value.items.find((item) => item.candidate.id === stale.id);
    expect(staleItem?.citation.freshness).toBe("stale");
    expect(packed.value.uncertainty).toContain("stale");

    const expanded = expandContextEvidence(
      {
        id: stale.id,
        freshness: stale.freshness,
        sensitivity: stale.sensitivity,
        source: {
          kind: "inline",
          text: TEXT,
          digest: DIGEST,
          byteLength: TEXT_BYTES,
        },
      },
      hasherReturning(DIGEST),
    );
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) {
      return;
    }
    expect(expanded.value.freshness).toBe("stale");
  });

  test("conflicting same-origin evidence stays separate and is not merged", () => {
    const first = admit({
      id: "ev-a",
      origin: "src/main.ts",
      payload: { kind: "inline", text: TEXT },
      exactSource: { kind: "inline", digest: DIGEST, byteLength: TEXT_BYTES },
    });
    const second = admit({
      id: "ev-b",
      origin: "src/main.ts",
      payload: { kind: "inline", text: OTHER_TEXT },
      exactSource: { kind: "inline", digest: OTHER_DIGEST, byteLength: OTHER_BYTES },
    });
    const inspected = inspectContextEvidence([first, second]);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) {
      return;
    }
    expect(inspected.value.conflicts).toEqual([
      { ids: [first.id, second.id], reason: "digest-mismatch" },
    ]);

    const packed = composeContextPack([first, second], {
      rank: { maxPerOrigin: 2, maxSelected: 2 },
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) {
      return;
    }
    const texts = packed.value.items.map((item) =>
      item.candidate.payload.kind === "inline" ? item.candidate.payload.text : "",
    );
    expect(texts).toContain(TEXT);
    expect(texts).toContain(OTHER_TEXT);
    expect(texts.some((text) => text.includes(TEXT) && text.includes(OTHER_TEXT))).toBe(false);
    expect(JSON.stringify(inspected.value)).not.toContain(SECRET);
  });
});
