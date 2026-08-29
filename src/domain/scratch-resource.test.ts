import { describe, expect, test } from "bun:test";

import { sessionId } from "./identity.ts";
import {
  MAX_SCRATCH_LIST_LIMIT,
  MAX_SCRATCH_NAME_BYTES,
  MAX_SCRATCH_TEXT_BYTES,
  parseScratchHandle,
  parseScratchListLimit,
  parseScratchMediaType,
  parseScratchName,
  scratchHandle,
  scratchRevision,
  validateScratchText,
} from "./scratch-resource.ts";

describe("scratch resource contracts", () => {
  test("round-trips a canonical session handle", () => {
    const owner = sessionId.from("session-one");
    const name = parseScratchName("PR draft 1.md");
    expect(name.ok).toBe(true);
    if (!name.ok) return;

    const handle = scratchHandle(owner, name.value);
    expect(String(handle)).toBe("scratch://session/session-one/PR%20draft%201.md");
    expect(parseScratchHandle(handle, owner)).toEqual({
      ok: true,
      value: { owner, name: name.value },
    });
  });

  test("rejects traversal, separators, controls, oversized names, and foreign sessions", () => {
    for (const name of [
      "",
      " ",
      " draft.md",
      "draft.md ",
      ".",
      "..",
      "a/b",
      "a\\b",
      "a\n",
      "x".repeat(MAX_SCRATCH_NAME_BYTES + 1),
    ]) {
      expect(parseScratchName(name).ok).toBe(false);
    }
    const owner = sessionId.from("session-one");
    const other = sessionId.from("session-two");
    const name = parseScratchName("draft.md");
    if (!name.ok) throw new Error("fixture name invalid");
    expect(parseScratchHandle(scratchHandle(owner, name.value), other)).toMatchObject({
      ok: false,
      error: { code: "cross-session" },
    });
    expect(parseScratchHandle("scratch://session/session-one/draft%2emd", owner).ok).toBe(false);
  });

  test("bounds revisions, list limits, text, and media types", () => {
    expect(scratchRevision(1).ok).toBe(true);
    expect(scratchRevision(0).ok).toBe(false);
    expect(parseScratchListLimit(MAX_SCRATCH_LIST_LIMIT).ok).toBe(true);
    expect(parseScratchListLimit(MAX_SCRATCH_LIST_LIMIT + 1).ok).toBe(false);
    expect(parseScratchMediaType("text/markdown").ok).toBe(true);
    expect(parseScratchMediaType("application/octet-stream").ok).toBe(false);
    expect(validateScratchText("x".repeat(MAX_SCRATCH_TEXT_BYTES)).ok).toBe(true);
    expect(validateScratchText("x".repeat(MAX_SCRATCH_TEXT_BYTES + 1)).ok).toBe(false);
  });
});
