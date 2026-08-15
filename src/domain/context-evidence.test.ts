/**
 * Evidence candidate admission: provenance, freshness, and exact-source handles.
 */

import { describe, expect, test } from "bun:test";

import { CONTENT_DIGEST_ALGORITHM } from "./artifact.ts";
import {
  admitEvidenceCandidate,
  admitEvidenceCandidates,
  claimsExactSource,
  describeEvidenceAdmissionError,
  type EvidenceCandidateInput,
  MAX_EVIDENCE_BATCH,
  MAX_EVIDENCE_ESTIMATED_TOKENS,
  MAX_EVIDENCE_INLINE_BYTES,
} from "./context-evidence.ts";
import { workspaceId } from "./identity.ts";

const DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(64)}`;
const SECRET = "sk-live-SECRET-MUST-NOT-ESCAPE";

function inlineInput(overrides: Partial<EvidenceCandidateInput> = {}): EvidenceCandidateInput {
  return {
    id: "ev-1",
    sourceKind: "file",
    origin: "src/main.ts",
    workspaceId: "ws-1",
    payload: { kind: "inline", text: "export const ok = true;\n" },
    estimatedTokens: 8,
    freshness: "live",
    sensitivity: "user-content",
    trust: "adapter-declared",
    fidelity: "exact-source",
    exactSource: {
      kind: "inline",
      digest: DIGEST,
      byteLength: new TextEncoder().encode("export const ok = true;\n").byteLength,
    },
    ...overrides,
  };
}

describe("admitEvidenceCandidate", () => {
  test("admits an exact-source inline candidate", () => {
    const result = admitEvidenceCandidate(inlineInput());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.fidelity).toBe("exact-source");
    expect(result.value.freshness).toBe("live");
    expect(result.value.exactSource?.kind).toBe("inline");
    expect(claimsExactSource(result.value)).toBe(true);
  });

  test("admits an artifact payload with a matching exact-source handle", () => {
    const result = admitEvidenceCandidate(
      inlineInput({
        sourceKind: "artifact",
        origin: "artifact:capture-1",
        payload: {
          kind: "artifact",
          artifactId: "capture-1",
          digest: DIGEST,
          byteLength: 128,
        },
        exactSource: {
          kind: "artifact",
          artifactId: "capture-1",
          digest: DIGEST,
          byteLength: 128,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.payload.kind).toBe("artifact");
    expect(claimsExactSource(result.value)).toBe(true);
  });

  test("keeps stale freshness labeled stale", () => {
    const result = admitEvidenceCandidate(inlineInput({ freshness: "stale" }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.freshness).toBe("stale");
    expect(result.value.freshness).not.toBe("live");
  });

  test("admits a lossy projection with an expansion handle and does not claim exact source", () => {
    const result = admitEvidenceCandidate(
      inlineInput({
        fidelity: "lossy-synthesis",
        exactSource: null,
        lineage: ["compact"],
        expansion: {
          kind: "artifact",
          artifactId: "source-1",
          digest: DIGEST,
          byteLength: 2048,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.fidelity).toBe("lossy-synthesis");
    expect(result.value.exactSource).toBeNull();
    expect(result.value.expansion?.kind).toBe("artifact");
    expect(claimsExactSource(result.value)).toBe(false);
  });

  test("refuses restricted sensitivity as secret", () => {
    const result = admitEvidenceCandidate(
      inlineInput({
        sensitivity: "restricted",
        origin: SECRET,
        payload: { kind: "inline", text: SECRET },
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "evidence-admission", code: "secret", field: "sensitivity" },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    if (!result.ok) {
      expect(describeEvidenceAdmissionError(result.error)).toBe("secret evidence");
    }
  });

  test("refuses an oversized inline payload", () => {
    const result = admitEvidenceCandidate(
      inlineInput({
        fidelity: "bounded-excerpt",
        exactSource: null,
        payload: { kind: "inline", text: "x".repeat(MAX_EVIDENCE_INLINE_BYTES + 1) },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toEqual({
      kind: "evidence-admission",
      code: "oversized",
      field: "payload",
    });
  });

  test("refuses oversized estimated tokens", () => {
    const result = admitEvidenceCandidate(
      inlineInput({ estimatedTokens: MAX_EVIDENCE_ESTIMATED_TOKENS + 1 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("oversized");
    expect(result.error.field).toBe("estimatedTokens");
  });

  test("refuses exact-source fidelity without a handle", () => {
    const result = admitEvidenceCandidate(inlineInput({ exactSource: null }));
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "evidence-admission",
        code: "exact-source-missing",
        field: "exactSource",
      },
    });
  });

  test("refuses claiming exact-source after a transformation lineage", () => {
    const result = admitEvidenceCandidate(inlineInput({ lineage: ["excerpt"] }));
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "evidence-admission",
        code: "fidelity-upgrade",
        field: "fidelity",
      },
    });
  });

  test("refuses an exact-source handle on a non-exact fidelity", () => {
    const result = admitEvidenceCandidate(
      inlineInput({
        fidelity: "extractive-summary",
        lineage: ["extract"],
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "evidence-admission",
        code: "fidelity-upgrade",
        field: "exactSource",
      },
    });
  });

  test("refuses an unsupported source kind", () => {
    const result = admitEvidenceCandidate(inlineInput({ sourceKind: "rss" }));
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "evidence-admission",
        code: "unsupported",
        field: "sourceKind",
      },
    });
  });

  test("refuses a candidate from the wrong workspace", () => {
    const result = admitEvidenceCandidate(inlineInput({ workspaceId: "ws-other" }), {
      expectedWorkspaceId: workspaceId.from("ws-1"),
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "evidence-admission",
        code: "wrong-workspace",
        field: "workspaceId",
      },
    });
  });

  test("refuses a missing workspace when one is required", () => {
    const result = admitEvidenceCandidate(inlineInput({ workspaceId: null }), {
      expectedWorkspaceId: workspaceId.from("ws-1"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("wrong-workspace");
  });

  test("never echoes rejected payload text", () => {
    const result = admitEvidenceCandidate(
      inlineInput({
        id: "",
        payload: { kind: "inline", text: SECRET },
        origin: SECRET,
      }),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("admitEvidenceCandidates", () => {
  test("admits a bounded batch", () => {
    const result = admitEvidenceCandidates([
      inlineInput({ id: "ev-1" }),
      inlineInput({
        id: "ev-2",
        sourceKind: "conversation",
        origin: "turn:3",
        fidelity: "bounded-excerpt",
        exactSource: null,
        lineage: ["excerpt"],
      }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toHaveLength(2);
    const support = result.value[1];
    expect(support).toBeDefined();
    if (support !== undefined) {
      expect(claimsExactSource(support)).toBe(false);
    }
  });

  test("stops on the first refusal", () => {
    const result = admitEvidenceCandidates([
      inlineInput({ id: "ev-1" }),
      inlineInput({ id: "ev-2", sourceKind: "rss" }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("unsupported");
  });

  test("refuses an oversized batch", () => {
    const inputs = Array.from({ length: MAX_EVIDENCE_BATCH + 1 }, (_, index) =>
      inlineInput({ id: `ev-${index + 1}` }),
    );
    const result = admitEvidenceCandidates(inputs);
    expect(result).toEqual({
      ok: false,
      error: { kind: "evidence-admission", code: "oversized", field: "batch" },
    });
  });
});
