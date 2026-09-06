import { describe, expect, test } from "bun:test";

import {
  compileGlobPattern,
  describeWorkspaceDiscoveryError,
  globMatchesAny,
  isExcludedByGlobs,
  kindAdmitted,
  matchGlob,
  parseWorkspaceDiscoveryRequest,
} from "./workspace-glob.ts";

function compiled(pattern: string) {
  const result = compileGlobPattern(pattern);
  if (!result.ok) {
    throw new Error(`expected glob ${pattern} to compile`);
  }
  return result.value;
}

describe("compileGlobPattern", () => {
  test("matches a basename glob at any depth", () => {
    const glob = compiled("*.ts");
    expect(matchGlob("a.ts", glob, "file")).toBe(true);
    expect(matchGlob("src/a.ts", glob, "file")).toBe(true);
    expect(matchGlob("src/nested/a.ts", glob, "file")).toBe(true);
    expect(matchGlob("a.ts.bak", glob, "file")).toBe(false);
    expect(matchGlob("a.js", glob, "file")).toBe(false);
  });

  test("anchors a slash-containing glob to the workspace root", () => {
    const glob = compiled("src/*.ts");
    expect(matchGlob("src/a.ts", glob, "file")).toBe(true);
    expect(matchGlob("src/nested/a.ts", glob, "file")).toBe(false);
    expect(matchGlob("a.ts", glob, "file")).toBe(false);
    expect(matchGlob("pkg/src/a.ts", glob, "file")).toBe(false);
  });

  test("crosses directories with **", () => {
    const glob = compiled("**/*.ts");
    expect(matchGlob("a.ts", glob, "file")).toBe(true);
    expect(matchGlob("src/nested/a.ts", glob, "file")).toBe(true);
    expect(matchGlob("src/a.js", glob, "file")).toBe(false);
  });

  test("matches a directory and its descendants with a trailing **", () => {
    const glob = compiled("src/**");
    expect(matchGlob("src", glob, "directory")).toBe(true);
    expect(matchGlob("src/a.ts", glob, "file")).toBe(true);
    expect(matchGlob("src/nested/a.ts", glob, "file")).toBe(true);
    expect(matchGlob("lib/a.ts", glob, "file")).toBe(false);
  });

  test("treats a trailing slash as directories only", () => {
    const glob = compiled("src/");
    expect(matchGlob("src", glob, "directory")).toBe(true);
    expect(matchGlob("src", glob, "file")).toBe(false);
    expect(matchGlob("src/a.ts", glob, "file")).toBe(false);
    expect(matchGlob("pkg/src", glob, "directory")).toBe(false);
  });

  test("anchors a leading slash to the workspace root", () => {
    const glob = compiled("/a.ts");
    expect(matchGlob("a.ts", glob, "file")).toBe(true);
    expect(matchGlob("src/a.ts", glob, "file")).toBe(false);
  });

  test("matches one non-slash character with ?", () => {
    const glob = compiled("fo?");
    expect(matchGlob("foo", glob, "file")).toBe(true);
    expect(matchGlob("src/fox", glob, "file")).toBe(true);
    expect(matchGlob("fo/o", glob, "file")).toBe(false);
  });

  test("matches a character class and rejects an unclosed class", () => {
    const glob = compiled("[ab].ts");
    expect(matchGlob("a.ts", glob, "file")).toBe(true);
    expect(matchGlob("c.ts", glob, "file")).toBe(false);
    expect(compileGlobPattern("[ab.ts")).toEqual({
      ok: false,
      error: { code: "malformed-glob", reason: "unclosed-class" },
    });
  });

  test("refuses empty, NUL, and over-long patterns without echoing them", () => {
    expect(compileGlobPattern("")).toEqual({
      ok: false,
      error: { code: "malformed-glob", reason: "empty" },
    });
    expect(compileGlobPattern("a\0.ts")).toEqual({
      ok: false,
      error: { code: "malformed-glob", reason: "illegal-character" },
    });
    expect(compileGlobPattern("x".repeat(257)).ok).toBe(false);
    expect(JSON.stringify(compileGlobPattern("sk-live-SECRET\0.ts"))).not.toContain(
      "sk-live-SECRET",
    );
  });
});

describe("exclude and kind filters", () => {
  test("excludes descendants of a directory glob", () => {
    const excludes = [compiled("secret/")];
    expect(isExcludedByGlobs("secret", "directory", excludes)).toBe(true);
    expect(isExcludedByGlobs("secret/a.ts", "file", excludes)).toBe(true);
    expect(isExcludedByGlobs("src/a.ts", "file", excludes)).toBe(false);
  });

  test("admits kinds exhaustively", () => {
    expect(kindAdmitted("file", "file")).toBe(true);
    expect(kindAdmitted("symlink", "file")).toBe(false);
    expect(kindAdmitted("directory", "directory")).toBe(true);
    expect(kindAdmitted("file", "all")).toBe(true);
  });

  test("matches any include glob", () => {
    const include = [compiled("*.ts"), compiled("*.tsx")];
    expect(globMatchesAny("a.tsx", "file", include)).toBe(true);
    expect(globMatchesAny("a.js", "file", include)).toBe(false);
  });
});

describe("parseWorkspaceDiscoveryRequest", () => {
  test("requires a non-empty include list and defaults hidden off", () => {
    const parsed = parseWorkspaceDiscoveryRequest({ include: ["*.ts"] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected request");
    }
    expect(parsed.value.start).toBe(".");
    expect(parsed.value.includeHidden).toBe(false);
    expect(parsed.value.kinds).toBe("all");
    expect(parseWorkspaceDiscoveryRequest({ include: [] })).toEqual({
      ok: false,
      error: { code: "malformed-glob", reason: "empty-include" },
    });
  });

  test("rejects malformed limits and kinds", () => {
    expect(parseWorkspaceDiscoveryRequest({ include: ["*"], maxMatches: 0 })).toEqual({
      ok: false,
      error: { code: "malformed-limit", field: "maxMatches", reason: "not-positive" },
    });
    expect(parseWorkspaceDiscoveryRequest({ include: ["*"], kinds: "symlink" })).toEqual({
      ok: false,
      error: { code: "malformed-kinds" },
    });
  });

  test("describes every discovery error code", () => {
    expect(describeWorkspaceDiscoveryError({ code: "malformed-glob", reason: "empty" })).toBe(
      "malformed-glob:empty",
    );
    expect(
      describeWorkspaceDiscoveryError({
        code: "malformed-limit",
        field: "maxDepth",
        reason: "not-positive",
      }),
    ).toBe("malformed-limit:maxDepth:not-positive");
    expect(describeWorkspaceDiscoveryError({ code: "malformed-kinds" })).toBe("malformed-kinds");
    expect(describeWorkspaceDiscoveryError({ code: "cancelled" })).toBe("cancelled");
    expect(describeWorkspaceDiscoveryError({ code: "symlink-escape" })).toBe("symlink-escape");
    expect(describeWorkspaceDiscoveryError({ code: "escaped" })).toBe("escaped");
    expect(describeWorkspaceDiscoveryError({ code: "absolute-unscoped" })).toBe(
      "absolute-unscoped",
    );
    expect(describeWorkspaceDiscoveryError({ code: "not-found" })).toBe("not-found");
    expect(describeWorkspaceDiscoveryError({ code: "not-a-directory" })).toBe("not-a-directory");
    expect(
      describeWorkspaceDiscoveryError({ code: "filesystem", reason: "permission-denied" }),
    ).toBe("filesystem:permission-denied");
    expect(
      describeWorkspaceDiscoveryError({ code: "malformed", reason: "path-illegal-character" }),
    ).toBe("malformed:path-illegal-character");
  });
});
