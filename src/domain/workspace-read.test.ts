import { describe, expect, test } from "bun:test";

import {
  applyByteRange,
  applyLineRange,
  decodeWorkspaceText,
  describeWorkspaceReadError,
  detectNewline,
  isBinaryText,
  numberLines,
  parseReadLimits,
} from "./workspace-read.ts";

describe("workspace read helpers", () => {
  test("numbers lines and detects newline style", () => {
    expect(numberLines("a\nb\n")).toEqual([
      { number: 1, text: "a" },
      { number: 2, text: "b" },
    ]);
    expect(detectNewline("a\r\nb")).toBe("crlf");
    expect(detectNewline("a\nb")).toBe("lf");
    expect(detectNewline("a\r\nb\nc")).toBe("mixed");
  });

  test("applies a 1-based line range", () => {
    const sliced = applyLineRange("a\nb\nc\n", { start: 2, end: 3 });
    expect(sliced).toEqual({
      lines: [
        { number: 2, text: "b" },
        { number: 3, text: "c" },
      ],
      truncated: false,
    });
  });

  test("refuses an inverted line range", () => {
    expect(applyLineRange("a", { start: 2, end: 1 })).toEqual({ error: "malformed-range" });
  });

  test("applies a byte range", () => {
    const sliced = applyByteRange("abcdef", { start: 1, end: 4 });
    expect(sliced).toEqual({ text: "bcd", truncated: true });
  });

  test("detects NUL as binary", () => {
    expect(isBinaryText("ok\0nope")).toBe(true);
    expect(isBinaryText("ok")).toBe(false);
  });

  test("decodes UTF-8 and UTF-16 BOMs without replacement characters", () => {
    expect(decodeWorkspaceText(Uint8Array.from([0xef, 0xbb, 0xbf, 0x6f, 0x6b]))).toEqual({
      ok: true,
      value: { text: "ok", encoding: "utf-8-bom" },
    });
    expect(decodeWorkspaceText(Uint8Array.from([0xff, 0xfe, 0x6f, 0x00, 0x6b, 0x00]))).toEqual({
      ok: true,
      value: { text: "ok", encoding: "utf-16le" },
    });
    expect(decodeWorkspaceText(Uint8Array.from([0xfe, 0xff, 0x00, 0x6f, 0x00, 0x6b]))).toEqual({
      ok: true,
      value: { text: "ok", encoding: "utf-16be" },
    });
  });

  test("rejects malformed read limits", () => {
    expect(parseReadLimits({ maxConcurrency: 0 })).toEqual({
      ok: false,
      error: { code: "malformed-limit", field: "maxConcurrency", reason: "not-positive" },
    });
  });

  test("describes every read error code", () => {
    expect(describeWorkspaceReadError({ code: "binary" })).toBe("binary");
    expect(describeWorkspaceReadError({ code: "not-a-file" })).toBe("not-a-file");
    expect(describeWorkspaceReadError({ code: "oversized", byteLength: 12 })).toBe("oversized:12");
    expect(describeWorkspaceReadError({ code: "too-many-targets" })).toBe("too-many-targets");
    expect(
      describeWorkspaceReadError({
        code: "malformed-limit",
        field: "maxFileBytes",
        reason: "not-positive",
      }),
    ).toBe("malformed-limit:maxFileBytes:not-positive");
    expect(describeWorkspaceReadError({ code: "stale", attempts: 2 })).toBe("stale:2");
    expect(
      describeWorkspaceReadError({ code: "malformed", reason: "path-illegal-character" }),
    ).toBe("malformed:path-illegal-character");
  });
});
