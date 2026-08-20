/**
 * Include/copy pick body from transcript blocks (#621).
 */

import { describe, expect, test } from "bun:test";
import { blockKey } from "./blocks.ts";
import { bound, complete, omitted } from "./disclosure.ts";
import { everyBlockKind } from "./fixtures.ts";
import {
  includeBodiesOf,
  pickTranscriptCopyIdentity,
  pickTranscriptIncludeBody,
  resolveTranscriptPick,
} from "./picks.ts";

const CORPUS = everyBlockKind();

function ofKind(kind: (typeof CORPUS)[number]["kind"]) {
  const block = CORPUS.find((candidate) => candidate.kind === kind);
  if (block === undefined) {
    throw new Error(`no fixture for ${kind}`);
  }
  return block;
}

describe("pickTranscriptIncludeBody", () => {
  test("includes a selected block's message, not its summary", () => {
    const block = ofKind("user-input");
    expect(pickTranscriptIncludeBody(block, false)).toEqual({
      ok: true,
      blockKey: blockKey(block.anchor),
      text: "Rename the port and update every caller.",
      rangeDigest: null,
    });
    expect(includeBodiesOf(block).map((item) => item.label)).toEqual(["message"]);
  });

  test("includes an expanded region's disclosed body", () => {
    const block = ofKind("process-stream");
    expect(pickTranscriptIncludeBody(block, true)).toEqual({
      ok: true,
      blockKey: blockKey(block.anchor),
      text: "compiling 3 modules",
      rangeDigest: null,
    });
  });

  test("refuses a secret block even when expanded", () => {
    const block = ofKind("tool-request");
    expect(pickTranscriptIncludeBody(block, true)).toEqual({
      ok: false,
      reason: "This entry is secret and cannot be included.",
    });
  });

  test("refuses redacted content", () => {
    const block = ofKind("model-reasoning");
    const pick = pickTranscriptIncludeBody(block, false);
    expect(pickTranscriptIncludeBody(block, true).ok).toBe(false);
    expect(pick.ok).toBe(false);
    if (pick.ok) {
      return;
    }
    expect(pick.reason).toContain("withheld");
  });

  test("refuses a truncated prefix as if it were complete", () => {
    const block = ofKind("tool-result");
    const collapsed = pickTranscriptIncludeBody(block, false);
    const expanded = pickTranscriptIncludeBody(block, true);
    expect(collapsed.ok).toBe(false);
    expect(expanded.ok).toBe(false);
    if (collapsed.ok || expanded.ok) {
      return;
    }
    expect(collapsed.reason).toContain("displayed prefix");
    expect(expanded.reason).toContain("disclosed prefix");
  });

  test("skips a path-only header on file-change", () => {
    const block = ofKind("file-change");
    expect(includeBodiesOf(block).map((item) => item.label)).toEqual(["detail"]);
    expect(pickTranscriptIncludeBody(block, true)).toEqual({
      ok: true,
      blockKey: blockKey(block.anchor),
      text: "2 insertions, 2 deletions",
      rangeDigest: null,
    });
  });

  test("refuses kinds with no includeable body", () => {
    expect(pickTranscriptIncludeBody(ofKind("model-outcome"), false)).toEqual({
      ok: false,
      reason: "This entry has no includeable body.",
    });
    expect(pickTranscriptIncludeBody(ofKind("artifact"), true).ok).toBe(false);
  });

  test("refuses omitted content", () => {
    const block = {
      ...ofKind("notice"),
      note: omitted("never collected"),
    };
    expect(pickTranscriptIncludeBody(block, false)).toEqual({
      ok: false,
      reason: "This entry was not collected and cannot be included.",
    });
  });

  test("does not treat a complete bounded prefix helper as truncated", () => {
    const block = {
      ...ofKind("model-text"),
      text: complete("short enough"),
    };
    expect(pickTranscriptIncludeBody(block, false)).toEqual({
      ok: true,
      blockKey: blockKey(block.anchor),
      text: "short enough",
      rangeDigest: null,
    });
    expect(bound("abc", { bytes: 64, lines: 8 }).disclosure.kind).toBe("complete");
  });
});

describe("resolveTranscriptPick", () => {
  test("prefers a non-empty native range over the whole block", () => {
    const block = ofKind("user-input");
    const pick = resolveTranscriptPick(block, true, { start: 7, end: 11 }, () => "range-digest");
    expect(pick).toEqual({
      ok: true,
      blockKey: blockKey(block.anchor),
      text: "the ",
      rangeDigest: "range-digest",
    });
  });

  test("falls back when the native range is empty", () => {
    const block = ofKind("user-input");
    const pick = resolveTranscriptPick(block, false, { start: 3, end: 3 }, () => "unused");
    expect(pick.ok).toBe(true);
    if (!pick.ok) {
      return;
    }
    expect(pick.text).toBe("Rename the port and update every caller.");
    expect(pick.rangeDigest).toBeNull();
  });
});

describe("pickTranscriptCopyIdentity", () => {
  test("returns a file path, not the detail body", () => {
    const block = ofKind("file-change");
    expect(pickTranscriptCopyIdentity(block)).toEqual({
      ok: true,
      text: "src/domain/port.ts",
    });
  });

  test("returns a tool capability line", () => {
    const block = ofKind("tool-result");
    if (block.kind !== "tool-result") {
      throw new Error("expected tool-result");
    }
    expect(pickTranscriptCopyIdentity(block)).toEqual({
      ok: true,
      text: block.capability,
    });
  });

  test("returns an artifact id", () => {
    const block = ofKind("artifact");
    if (block.kind !== "artifact") {
      throw new Error("expected artifact");
    }
    expect(pickTranscriptCopyIdentity(block)).toEqual({
      ok: true,
      text: block.artifactId,
    });
  });

  test("refuses secret entries", () => {
    const block = ofKind("tool-request");
    expect(pickTranscriptCopyIdentity(block)).toEqual({
      ok: false,
      reason: "This entry is secret and cannot be copied.",
    });
  });

  test("refuses entries without a copyable identity", () => {
    expect(pickTranscriptCopyIdentity(ofKind("user-input"))).toEqual({
      ok: false,
      reason: "This entry has no copyable identity.",
    });
  });
});
