/**
 * Context pack composition: primary/support roles, citations, and uncertainty.
 */

import { describe, expect, test } from "bun:test";

import { CONTENT_DIGEST_ALGORITHM } from "./artifact.ts";
import {
  composeContextPack,
  DEFAULT_SUPPORT_EXCERPT_BYTES,
  describeContextComposeError,
  HARD_SUPPORT_EXCERPT_BYTES,
} from "./context-compose.ts";
import {
  admitEvidenceCandidate,
  type EvidenceCandidate,
  type EvidenceCandidateInput,
} from "./context-evidence.ts";

const DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(64)}`;
const SECRET = "sk-live-SECRET-MUST-NOT-ESCAPE";
const TEXT = "export const ok = true;\n";
const TEXT_BYTES = new TextEncoder().encode(TEXT).byteLength;

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

describe("composeContextPack", () => {
  test("assigns primary to the first included item and support to later items", () => {
    const instruction = admit({
      id: "ev-instruction",
      sourceKind: "instruction",
      origin: "AGENTS.md",
    });
    const file = admit({ id: "ev-file", sourceKind: "file", origin: "src/a.ts" });
    const packed = composeContextPack([file, instruction]);
    expect(packed.ok).toBe(true);
    if (!packed.ok) {
      return;
    }
    expect(packed.value.items.map((item) => item.candidate.id)).toEqual([instruction.id, file.id]);
    expect(packed.value.items[0]?.role).toBe("primary");
    expect(packed.value.items[1]?.role).toBe("support");
    expect(packed.value.items[0]?.claimsExact).toBe(true);
    expect(packed.value.truncated).toBe(false);
  });

  test("records citations without copying payload text into omissions or errors", () => {
    const file = admit({
      id: "ev-secret",
      origin: "src/secret.ts",
      payload: { kind: "inline", text: SECRET },
      exactSource: {
        kind: "inline",
        digest: DIGEST,
        byteLength: new TextEncoder().encode(SECRET).byteLength,
      },
    });
    const packed = composeContextPack([file]);
    expect(packed.ok).toBe(true);
    if (!packed.ok) {
      return;
    }
    const citation = packed.value.items[0]?.citation;
    expect(citation?.id).toBe(file.id);
    expect(citation?.origin).toBe("src/secret.ts");
    expect(citation?.sourceKind).toBe("file");
    expect(citation?.exactSource?.kind).toBe("inline");
    expect(JSON.stringify(packed.value.omitted)).not.toContain(SECRET);
    expect(JSON.stringify(packed.value.uncertainty)).not.toContain(SECRET);
  });

  test("narrows oversized support inline text and does not claim exact source", () => {
    const primary = admit({
      id: "ev-primary",
      sourceKind: "instruction",
      origin: "AGENTS.md",
    });
    const longText = `${"a".repeat(DEFAULT_SUPPORT_EXCERPT_BYTES + 32)}${SECRET}`;
    const support = admit({
      id: "ev-support",
      origin: "src/long.ts",
      payload: { kind: "inline", text: longText },
      estimatedTokens: 2_048,
      exactSource: {
        kind: "inline",
        digest: DIGEST,
        byteLength: new TextEncoder().encode(longText).byteLength,
      },
    });
    const packed = composeContextPack([primary, support]);
    expect(packed.ok).toBe(true);
    if (!packed.ok) {
      return;
    }
    const supportItem = packed.value.items[1];
    expect(supportItem?.role).toBe("support");
    expect(supportItem?.narrowed).toBe(true);
    expect(supportItem?.fidelity).toBe("bounded-excerpt");
    expect(supportItem?.claimsExact).toBe(false);
    expect(supportItem?.excerpt?.length).toBeLessThan(longText.length);
    expect(supportItem?.excerptBytes).toBeLessThanOrEqual(DEFAULT_SUPPORT_EXCERPT_BYTES);
    expect(supportItem?.citation.fidelity).toBe("exact-source");
    expect(supportItem?.citation.exactSource).not.toBeNull();
    expect(supportItem?.uncertainty).toContain("narrowed");
    expect(
      supportItem?.candidate.payload.kind === "inline" && supportItem.candidate.payload.text,
    ).toBe(longText);
    expect(packed.value.truncated).toBe(true);
    expect(packed.value.items[0]?.narrowed).toBe(false);
    expect(packed.value.items[0]?.excerpt).toBe(TEXT);
  });

  test("does not rewrite primary inline text even when it exceeds the support bound", () => {
    const longText = "p".repeat(DEFAULT_SUPPORT_EXCERPT_BYTES + 8);
    const primary = admit({
      id: "ev-long-primary",
      sourceKind: "instruction",
      origin: "AGENTS.md",
      payload: { kind: "inline", text: longText },
      estimatedTokens: 1_024,
      exactSource: {
        kind: "inline",
        digest: DIGEST,
        byteLength: new TextEncoder().encode(longText).byteLength,
      },
    });
    const packed = composeContextPack([primary]);
    expect(packed.ok).toBe(true);
    if (!packed.ok) {
      return;
    }
    expect(packed.value.items[0]?.role).toBe("primary");
    expect(packed.value.items[0]?.narrowed).toBe(false);
    expect(packed.value.items[0]?.excerpt).toBe(longText);
    expect(packed.value.items[0]?.fidelity).toBe("exact-source");
    expect(packed.value.truncated).toBe(false);
  });

  test("does not rewrite artifact support payloads", () => {
    const primary = admit({
      id: "ev-primary",
      sourceKind: "instruction",
      origin: "AGENTS.md",
    });
    const artifact = admit({
      id: "ev-artifact",
      sourceKind: "artifact",
      origin: "artifact:source-1",
      payload: {
        kind: "artifact",
        artifactId: "source-1",
        digest: DIGEST,
        byteLength: DEFAULT_SUPPORT_EXCERPT_BYTES + 64,
      },
      estimatedTokens: 512,
      exactSource: {
        kind: "artifact",
        artifactId: "source-1",
        digest: DIGEST,
        byteLength: DEFAULT_SUPPORT_EXCERPT_BYTES + 64,
      },
    });
    const packed = composeContextPack([primary, artifact], {
      maxSupportExcerptBytes: 32,
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) {
      return;
    }
    const supportItem = packed.value.items[1];
    expect(supportItem?.role).toBe("support");
    expect(supportItem?.narrowed).toBe(false);
    expect(supportItem?.excerpt).toBeNull();
    expect(supportItem?.excerptBytes).toBe(DEFAULT_SUPPORT_EXCERPT_BYTES + 64);
    expect(supportItem?.fidelity).toBe("exact-source");
    expect(supportItem?.claimsExact).toBe(true);
  });

  test("labels stale, untrusted, and lossy items as uncertainty", () => {
    const stale = admit({
      id: "ev-stale",
      sourceKind: "instruction",
      origin: "AGENTS.md",
      freshness: "stale",
    });
    const untrusted = admit({
      id: "ev-untrusted",
      origin: "src/guess.ts",
      trust: "untrusted",
    });
    const lossy = admit({
      id: "ev-lossy",
      origin: "src/summary.ts",
      fidelity: "lossy-synthesis",
      exactSource: null,
      lineage: ["compact"],
      expansion: {
        kind: "artifact",
        artifactId: "source-1",
        digest: DIGEST,
        byteLength: 2048,
      },
    });
    const packed = composeContextPack([stale, untrusted, lossy]);
    expect(packed.ok).toBe(true);
    if (!packed.ok) {
      return;
    }
    expect(packed.value.items[0]?.uncertainty).toEqual(["stale"]);
    expect(packed.value.items[1]?.uncertainty).toEqual(["untrusted"]);
    expect(packed.value.items[2]?.uncertainty).toEqual(["lossy"]);
    expect(packed.value.uncertainty).toEqual(["stale", "untrusted", "lossy"]);
  });

  test("forwards insufficient context when a required item cannot be included", () => {
    const required = admit({
      id: "ev-required",
      origin: "src/huge.ts",
      estimatedTokens: 8_000,
    });
    const packed = composeContextPack([required], {
      requiredIds: [required.id],
      budget: {
        maxTotalTokens: 4_200,
        reservedOutputTokens: 4_096,
        reservedToolFramingTokens: 64,
      },
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) {
      return;
    }
    expect(packed.value.items).toEqual([]);
    expect(packed.value.insufficient?.kind).toBe("insufficient-context");
    expect(packed.value.uncertainty).toContain("insufficient");
    expect(packed.value.omitted.some((entry) => entry.stage === "budget")).toBe(true);
  });

  test("forwards rank omissions without echoing origin or payload", () => {
    const first = admit({ id: "ev-a", origin: `src/${SECRET}.ts` });
    const second = admit({ id: "ev-b", origin: `src/${SECRET}.ts` });
    const third = admit({ id: "ev-c", origin: `src/${SECRET}.ts` });
    const packed = composeContextPack([first, second, third], {
      rank: { maxPerOrigin: 1 },
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) {
      return;
    }
    expect(packed.value.omitted.map((entry) => entry.reason)).toEqual(["diversity", "diversity"]);
    expect(packed.value.omitted.every((entry) => entry.stage === "rank")).toBe(true);
    expect(JSON.stringify(packed.value.omitted)).not.toContain(SECRET);
  });

  test("refuses an unknown destination without echoing the value", () => {
    const packed = composeContextPack([admit()], {
      rank: { destination: "remote-lab" },
    });
    expect(packed.ok).toBe(false);
    if (packed.ok) {
      return;
    }
    expect(packed.error).toEqual({
      kind: "context-compose",
      code: "unsupported",
      field: "destination",
    });
    expect(describeContextComposeError(packed.error)).toBe("unsupported destination");
    expect(describeContextComposeError(packed.error)).not.toContain("remote-lab");
  });

  test("refuses an oversized support excerpt bound", () => {
    const packed = composeContextPack([admit()], {
      maxSupportExcerptBytes: HARD_SUPPORT_EXCERPT_BYTES + 1,
    });
    expect(packed.ok).toBe(false);
    if (packed.ok) {
      return;
    }
    expect(packed.error.code).toBe("oversized");
    expect(packed.error.field).toBe("maxSupportExcerptBytes");
  });
});
