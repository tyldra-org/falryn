import { describe, expect, test } from "bun:test";

import {
  baseName,
  isInside,
  joinPath,
  localPath,
  MAX_LOCAL_PATH_LENGTH,
  parseLocalPath,
} from "./filesystem.ts";

describe("parsing a path", () => {
  test("accepts an absolute POSIX path", () => {
    const parsed = parseLocalPath("/usr/local/share");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value as string).toBe("/usr/local/share");
    }
  });

  test("accepts a drive-letter path and forward-slashes it", () => {
    const parsed = parseLocalPath("C:\\Users\\example\\AppData");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value as string).toBe("C:/Users/example/AppData");
    }
  });

  test("normalizes redundant separators, dots, and trailing slashes", () => {
    for (const [input, expected] of [
      ["/a//b", "/a/b"],
      ["/a/./b/", "/a/b"],
      ["/a/b/../c", "/a/c"],
      ["/a/../../b", "/b"],
    ] as const) {
      const parsed = parseLocalPath(input);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value as string).toBe(expected);
      }
    }
  });

  test("refuses a relative path", () => {
    expect(parseLocalPath("relative/path")).toEqual({
      ok: false,
      error: { kind: "local-path", code: "path-not-absolute" },
    });
  });

  test("refuses an empty, oversized, or non-string path", () => {
    expect(parseLocalPath("").ok).toBe(false);
    expect(parseLocalPath(`/${"x".repeat(MAX_LOCAL_PATH_LENGTH)}`)).toEqual({
      ok: false,
      error: { kind: "local-path", code: "path-too-long" },
    });
    expect(parseLocalPath(42).ok).toBe(false);
  });

  test("refuses an embedded NUL, which truncates at every syscall below", () => {
    expect(parseLocalPath("/tmp/safe\0/etc/passwd")).toEqual({
      ok: false,
      error: { kind: "local-path", code: "path-illegal-character" },
    });
  });

  test("never echoes the rejected text", () => {
    const secret = "sk-live-0123456789";
    expect(JSON.stringify(parseLocalPath(secret))).not.toContain(secret);
  });

  test("the throwing form is for literals only", () => {
    expect(localPath("/tmp") as string).toBe("/tmp");
    expect(() => localPath("nope")).toThrow(/path-not-absolute/);
  });
});

describe("naming a child", () => {
  test("appends plain segments", () => {
    const joined = joinPath(localPath("/tmp/root"), "a", "b");
    expect(joined.ok).toBe(true);
    if (joined.ok) {
      expect(joined.value as string).toBe("/tmp/root/a/b");
    }
  });

  test("refuses any segment that could climb out", () => {
    const root = localPath("/tmp/root");
    for (const segment of ["..", ".", "", "nested/deep", "back\\slash"]) {
      expect(joinPath(root, segment).ok).toBe(false);
    }
  });

  test("refuses a NUL inside a segment", () => {
    expect(joinPath(localPath("/tmp/root"), "a\0b").ok).toBe(false);
  });
});

describe("containment", () => {
  test("a path is inside itself and inside its ancestors", () => {
    expect(isInside(localPath("/d/logs"), localPath("/d/logs"))).toBe(true);
    expect(isInside(localPath("/d/logs"), localPath("/d/logs/today/run.log"))).toBe(true);
  });

  test("a sibling sharing a prefix is not inside", () => {
    // The whole-segment comparison is what stops `/data/falryn-old` from being
    // treated as part of `/data/falryn`.
    expect(isInside(localPath("/data/falryn"), localPath("/data/falryn-old"))).toBe(false);
  });

  test("an ancestor is not inside its descendant", () => {
    expect(isInside(localPath("/d/logs/today"), localPath("/d/logs"))).toBe(false);
  });
});

describe("base name", () => {
  test("returns the last segment", () => {
    expect(baseName(localPath("/d/logs/run.log"))).toBe("run.log");
    expect(baseName(localPath("/d"))).toBe("d");
  });
});
