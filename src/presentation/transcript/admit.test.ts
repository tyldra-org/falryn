/**
 * Untrusted transcript-record admission.
 *
 * Known kinds stay with the reducer. This gate only constructs the unknown
 * fallback, and it does so without copying payload or inferring an outcome.
 */

import { describe, expect, test } from "bun:test";
import {
  admitTranscriptRecord,
  describeTranscriptBlockAdmissionError,
  MAX_OBSERVED_KIND_CHARS,
  TRANSCRIPT_BLOCK_ADMISSION_ERROR_CODES,
  type TranscriptBlockAdmissionError,
  type TranscriptRecordInput,
} from "./admit.ts";
import {
  boundedTextsOf,
  describeBlock,
  expansionRoutesFor,
  outcomeOf,
  TRANSCRIPT_BLOCK_KINDS,
  UNKNOWN_TRANSCRIPT_BLOCK_KIND,
} from "./blocks.ts";
import { FIXTURE_AT } from "./fixtures.ts";

const SECRET = "sk-live-SECRET-MUST-NOT-ESCAPE";

function record(overrides: TranscriptRecordInput = {}): TranscriptRecordInput {
  return {
    kind: "future-widget",
    order: 0,
    occurredAt: FIXTURE_AT,
    ...overrides,
  };
}

function admitted(overrides: TranscriptRecordInput = {}) {
  const result = admitTranscriptRecord(record(overrides));
  if (!result.ok) {
    throw new Error(`expected admission, got ${result.error.code}`);
  }
  return result.value;
}

describe("admitTranscriptRecord", () => {
  test("admits an unrecognized kind as a typed unknown fallback", () => {
    const block = admitted();
    expect(block.kind).toBe(UNKNOWN_TRANSCRIPT_BLOCK_KIND);
    expect(describeBlock(block)).toBe("Unrecognized block");
    expect(block.summary.text).toBe("Unrecognized block");
    expect(block.observedKind.text).toBe("future-widget");
    expect(block.anchor).toEqual({ of: "declared", key: "unknown:0" });
    expect(block.source).toBe("runtime");
    expect(block.status).toBe("final");
    expect(block.sensitivity).toBe("ordinary");
    expect(outcomeOf(block)).toBe(null);
    expect(expansionRoutesFor(block)).toEqual([]);
  });

  test("refuses a known kind rather than mapping it onto a notice", () => {
    const result = admitTranscriptRecord(record({ kind: "notice", text: SECRET }));
    expect(result).toEqual({
      ok: false,
      error: { kind: "transcript-block-admission", code: "unsupported", field: "kind" },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    if (!result.ok) {
      expect(describeTranscriptBlockAdmissionError(result.error)).toBe("unsupported kind");
    }
  });

  test("drops extra payload instead of copying it", () => {
    const result = admitTranscriptRecord(
      record({
        text: SECRET,
        summary: SECRET,
        note: SECRET,
        output: SECRET,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect("text" in result.value).toBe(false);
    expect("note" in result.value).toBe(false);
    expect(JSON.stringify(result.value)).not.toContain(SECRET);
    expect(describeBlock(result.value)).not.toContain(SECRET);
    expect(boundedTextsOf(result.value).map((value) => value.text)).toEqual([
      "Unrecognized block",
      "future-widget",
    ]);
  });

  test("keeps a secret kind off the headline and off admission errors", () => {
    const result = admitTranscriptRecord(record({ kind: SECRET }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(describeBlock(result.value)).toBe("Unrecognized block");
    expect(describeBlock(result.value)).not.toContain(SECRET);
    const refused = admitTranscriptRecord(record({ kind: "diagnostic", payload: SECRET }));
    expect(JSON.stringify(refused)).not.toContain(SECRET);
  });

  test("refuses a malformed spine without echoing payload", () => {
    const result = admitTranscriptRecord(record({ order: -1, text: SECRET }));
    expect(result).toEqual({
      ok: false,
      error: { kind: "transcript-block-admission", code: "malformed", field: "order" },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("refuses an oversized kind without echoing it", () => {
    const kind = `${SECRET}${"x".repeat(MAX_OBSERVED_KIND_CHARS)}`;
    const result = admitTranscriptRecord(record({ kind }));
    expect(result).toEqual({
      ok: false,
      error: { kind: "transcript-block-admission", code: "oversized", field: "kind" },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("uses valid source status and sensitivity when they are declared", () => {
    const block = admitted({ source: "tool", status: "in-progress", sensitivity: "sensitive" });
    expect(block.source).toBe("tool");
    expect(block.status).toBe("in-progress");
    expect(block.sensitivity).toBe("sensitive");
  });
});

describe("describeTranscriptBlockAdmissionError", () => {
  test("is exhaustive over the declared codes", () => {
    const described = TRANSCRIPT_BLOCK_ADMISSION_ERROR_CODES.map((code) =>
      describeTranscriptBlockAdmissionError({
        kind: "transcript-block-admission",
        code,
        field: "kind",
      } satisfies TranscriptBlockAdmissionError),
    );
    expect(described).toEqual(["malformed kind", "unsupported kind", "oversized kind"]);
  });
});

describe("the semantic kind list", () => {
  test("stays sixteen closed kinds and does not include the fallback", () => {
    expect(TRANSCRIPT_BLOCK_KINDS).toHaveLength(16);
    expect(TRANSCRIPT_BLOCK_KINDS).not.toContain(UNKNOWN_TRANSCRIPT_BLOCK_KIND);
  });
});
