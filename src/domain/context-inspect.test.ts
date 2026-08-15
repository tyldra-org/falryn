/**
 * Context inspection: stale labels, conflicts, batch limits, and long sessions.
 */

import { describe, expect, test } from "bun:test";

import { CONTENT_DIGEST_ALGORITHM } from "./artifact.ts";
import {
  admitEvidenceCandidate,
  type EvidenceCandidate,
  type EvidenceCandidateInput,
  MAX_EVIDENCE_BATCH,
} from "./context-evidence.ts";
import {
  DEFAULT_LONG_SESSION_CONVERSATION_ITEMS,
  describeContextInspectError,
  inspectContextEvidence,
} from "./context-inspect.ts";

const DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(64)}`;
const OTHER_DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"b".repeat(64)}`;
const SECRET = "sk-live-SECRET-MUST-NOT-ESCAPE";
const TEXT = "export const ok = true;\n";
const OTHER_TEXT = "export const ok = false;\n";
const TEXT_BYTES = new TextEncoder().encode(TEXT).byteLength;
const OTHER_BYTES = new TextEncoder().encode(OTHER_TEXT).byteLength;
const SECRET_TEXT = `token ${SECRET}\n`;
const SECRET_BYTES = new TextEncoder().encode(SECRET_TEXT).byteLength;

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

describe("inspectContextEvidence", () => {
  test("reports a digest mismatch for the same origin without merging payloads", () => {
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
    expect(JSON.stringify(inspected.value)).not.toContain(TEXT);
    expect(JSON.stringify(inspected.value)).not.toContain(OTHER_TEXT);
  });

  test("reports live versus stale on the same origin as a freshness mismatch", () => {
    const live = admit({ id: "ev-live", origin: "src/main.ts", freshness: "live" });
    const stale = admit({ id: "ev-stale", origin: "src/main.ts", freshness: "stale" });
    const inspected = inspectContextEvidence([live, stale]);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) {
      return;
    }
    expect(inspected.value.conflicts).toEqual([
      { ids: [live.id, stale.id], reason: "freshness-mismatch" },
    ]);
    expect(inspected.value.staleIds).toEqual([stale.id]);
  });

  test("does not treat the same digest on one origin as a conflict", () => {
    const first = admit({ id: "ev-a", origin: "src/main.ts" });
    const second = admit({ id: "ev-b", origin: "src/main.ts" });
    const inspected = inspectContextEvidence([first, second]);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) {
      return;
    }
    expect(inspected.value.conflicts).toEqual([]);
  });

  test("lists stale ids without rewriting freshness", () => {
    const stale = admit({ id: "ev-stale", origin: "src/old.ts", freshness: "stale" });
    const live = admit({ id: "ev-live", origin: "src/new.ts", freshness: "live" });
    const inspected = inspectContextEvidence([stale, live]);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) {
      return;
    }
    expect(inspected.value.staleIds).toEqual([stale.id]);
    expect(stale.freshness).toBe("stale");
    expect(live.freshness).toBe("live");
  });

  test("marks a full batch as at-limit", () => {
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
    expect(inspected.value.conflicts).toEqual([]);
  });

  test("refuses an oversized batch without dropping items", () => {
    const candidates = Array.from({ length: MAX_EVIDENCE_BATCH + 1 }, (_, index) =>
      admit({
        id: `ev-${index}`,
        origin: `src/f${index}.ts`,
      }),
    );
    const inspected = inspectContextEvidence(candidates);
    expect(inspected.ok).toBe(false);
    if (inspected.ok) {
      return;
    }
    expect(inspected.error.code).toBe("oversized");
    expect(describeContextInspectError(inspected.error)).toBe("oversized batch");
  });

  test("flags a long session once conversation items reach the default", () => {
    const conversations = Array.from(
      { length: DEFAULT_LONG_SESSION_CONVERSATION_ITEMS },
      (_, index) =>
        admit({
          id: `ev-turn-${index}`,
          sourceKind: "conversation",
          origin: `turn/${index}`,
        }),
    );
    const inspected = inspectContextEvidence(conversations);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) {
      return;
    }
    expect(inspected.value.conversationCount).toBe(DEFAULT_LONG_SESSION_CONVERSATION_ITEMS);
    expect(inspected.value.longSession).toBe(true);
  });

  test("never echoes origin or payload in reports or errors", () => {
    const secret = admit({
      id: "ev-secret",
      origin: `src/${SECRET}.ts`,
      payload: { kind: "inline", text: SECRET_TEXT },
      exactSource: { kind: "inline", digest: DIGEST, byteLength: SECRET_BYTES },
    });
    const other = admit({
      id: "ev-other",
      origin: `src/${SECRET}.ts`,
      payload: { kind: "inline", text: OTHER_TEXT },
      exactSource: { kind: "inline", digest: OTHER_DIGEST, byteLength: OTHER_BYTES },
    });
    const inspected = inspectContextEvidence([secret, other]);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) {
      return;
    }
    expect(JSON.stringify(inspected.value)).not.toContain(SECRET);
    const oversized = inspectContextEvidence(
      Array.from({ length: MAX_EVIDENCE_BATCH + 1 }, (_, index) =>
        admit({
          id: `ev-${index}`,
          origin: `src/${SECRET}-${index}.ts`,
          payload: { kind: "inline", text: SECRET_TEXT },
          exactSource: { kind: "inline", digest: DIGEST, byteLength: SECRET_BYTES },
        }),
      ),
    );
    expect(oversized.ok).toBe(false);
    if (oversized.ok) {
      return;
    }
    expect(JSON.stringify(oversized.error)).not.toContain(SECRET);
    expect(describeContextInspectError(oversized.error)).not.toContain(SECRET);
  });
});
