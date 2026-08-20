/**
 * Include a transcript pick onto the composer draft (#621).
 */

import { describe, expect, test } from "bun:test";
import { digestBytes } from "../../application/index.ts";
import { blockKey } from "../../presentation/index.ts";
import { everyBlockKind } from "../../presentation/transcript/fixtures.ts";
import { includeTranscriptInDraft } from "./include.ts";

const encoder = new TextEncoder();

const CORPUS = everyBlockKind();

function ofKind(kind: (typeof CORPUS)[number]["kind"]) {
  const block = CORPUS.find((candidate) => candidate.kind === kind);
  if (block === undefined) {
    throw new Error(`no fixture for ${kind}`);
  }
  return block;
}

describe("includeTranscriptInDraft", () => {
  test("attaches a selected block body without a payload field on the descriptor", () => {
    const block = ofKind("user-input");
    const result = includeTranscriptInDraft({
      selected: blockKey(block.anchor),
      expanded: new Set(),
      blocks: [block],
      attachments: [],
      nextId: "att-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.attachment.kind).toBe("transcript");
    expect(result.attachment.identity).toBe(`transcript:${blockKey(block.anchor)}`);
    expect(result.attachment).not.toHaveProperty("payload");
    expect(new TextDecoder().decode(result.bytes)).toBe("Rename the port and update every caller.");
  });

  test("includes an expanded disclosed region", () => {
    const block = ofKind("process-stream");
    const key = blockKey(block.anchor);
    const result = includeTranscriptInDraft({
      selected: key,
      expanded: new Set([key]),
      blocks: [block],
      attachments: [],
      nextId: "att-2",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(new TextDecoder().decode(result.bytes)).toBe("compiling 3 modules");
  });

  test("refuses a secret entry", () => {
    const block = ofKind("tool-request");
    const result = includeTranscriptInDraft({
      selected: blockKey(block.anchor),
      expanded: new Set([blockKey(block.anchor)]),
      blocks: [block],
      attachments: [],
      nextId: "att-3",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "This entry is secret and cannot be included.",
      attachments: [],
    });
  });

  test("reports already-included instead of adding a second chip", () => {
    const block = ofKind("user-input");
    const first = includeTranscriptInDraft({
      selected: blockKey(block.anchor),
      expanded: new Set(),
      blocks: [block],
      attachments: [],
      nextId: "att-4",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const again = includeTranscriptInDraft({
      selected: blockKey(block.anchor),
      expanded: new Set(),
      blocks: [block],
      attachments: first.attachments,
      nextId: "att-5",
    });
    expect(again.ok).toBe(false);
    if (again.ok) {
      return;
    }
    expect(again.reason).toContain("already included");
    expect(again.attachments).toEqual(first.attachments);
  });

  test("does nothing when no entry is selected", () => {
    const result = includeTranscriptInDraft({
      selected: null,
      expanded: new Set(),
      blocks: CORPUS,
      attachments: [],
      nextId: "att-6",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("There is no entry to include.");
  });

  test("includes a native range with a range digest identity", () => {
    const block = ofKind("user-input");
    const key = blockKey(block.anchor);
    const ranged = "the port";
    const result = includeTranscriptInDraft({
      selected: key,
      expanded: new Set([key]),
      blocks: [block],
      attachments: [],
      nextId: "att-7",
      nativeRange: { start: 7, end: 15 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(new TextDecoder().decode(result.bytes)).toBe(ranged);
    expect(result.attachment.identity).toBe(
      `transcript:${key}:${digestBytes(encoder.encode(ranged))}`,
    );
  });
});
