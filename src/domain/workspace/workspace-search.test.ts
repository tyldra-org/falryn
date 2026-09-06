import { describe, expect, test } from "bun:test";

import { localPath } from "./filesystem.ts";
import {
  compileSearchQuery,
  describeWorkspaceSearchError,
  findMatchColumn,
  MAX_SEARCH_QUERY_LENGTH,
  parseWorkspaceSearchRequest,
} from "./workspace-search.ts";

describe("compileSearchQuery", () => {
  test("compiles a literal without a regex", () => {
    const compiled = compileSearchQuery("token", "literal", true);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      throw new Error("expected query");
    }
    expect(compiled.value.regex).toBeNull();
    expect(compiled.value.query).toBe("token");
  });

  test("rejects malformed regex without echoing the pattern", () => {
    const compiled = compileSearchQuery("(unclosed", "regex", true);
    expect(compiled).toEqual({ ok: false, error: { code: "malformed-regex" } });
    expect(JSON.stringify(compiled)).not.toContain("(unclosed");
  });

  test("rejects a query that contains a secret without echoing it", () => {
    const compiled = compileSearchQuery("sk-live-SECRET", "literal", true);
    expect(compiled.ok).toBe(true);
    const empty = compileSearchQuery("", "literal", true);
    expect(empty).toEqual({ ok: false, error: { code: "malformed-query", reason: "empty" } });
    const tooLong = compileSearchQuery("a".repeat(MAX_SEARCH_QUERY_LENGTH + 1), "literal", true);
    expect(tooLong).toEqual({
      ok: false,
      error: { code: "malformed-query", reason: "too-long" },
    });
    expect(JSON.stringify(tooLong)).not.toContain("aaaa");
    const nul = compileSearchQuery("sk-live-SECRET\0", "literal", true);
    expect(nul).toEqual({
      ok: false,
      error: { code: "malformed-query", reason: "illegal-character" },
    });
    expect(JSON.stringify(nul)).not.toContain("sk-live-SECRET");
  });
});

describe("findMatchColumn", () => {
  test("returns a 1-based column for literal and regex hits", () => {
    const literal = compileSearchQuery("bar", "literal", true);
    const regex = compileSearchQuery("b[a]r", "regex", true);
    const insensitive = compileSearchQuery("BAR", "literal", false);
    if (!literal.ok || !regex.ok || !insensitive.ok) {
      throw new Error("expected queries");
    }
    expect(findMatchColumn("foo bar", literal.value)).toBe(5);
    expect(findMatchColumn("foo bar", regex.value)).toBe(5);
    expect(findMatchColumn("foo bar", insensitive.value)).toBe(5);
    expect(findMatchColumn("foo", literal.value)).toBeNull();
  });
});

describe("parseWorkspaceSearchRequest", () => {
  test("applies defaults for an omitted start and include glob", () => {
    const parsed = parseWorkspaceSearchRequest({ query: "token" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected search request");
    }
    expect(parsed.value.start).toBe(".");
    expect(parsed.value.include).toHaveLength(1);
    expect(parsed.value.include[0]?.pattern).toBe("*");
    expect(parsed.value.includeHidden).toBe(false);
    expect(parsed.value.includeBinary).toBe(false);
    expect(parsed.value.caseSensitive).toBe(true);
    expect(parsed.value.query.kind).toBe("literal");
    expect(parsed.value.ripgrepExecutable).toBeNull();
    expect(parsed.value.maxMatches).toBe(100);
    expect(parsed.value.context).toBe(0);
  });

  test("accepts an absolute ripgrep executable", () => {
    const parsed = parseWorkspaceSearchRequest({
      query: "token",
      ripgrepExecutable: "/usr/bin/rg",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected search request");
    }
    expect(parsed.value.ripgrepExecutable).toBe(localPath("/usr/bin/rg"));
  });

  test("rejects a relative executable and a malformed kind", () => {
    expect(parseWorkspaceSearchRequest({ query: "token", ripgrepExecutable: "rg" })).toEqual({
      ok: false,
      error: { code: "malformed-executable" },
    });
    expect(parseWorkspaceSearchRequest({ query: "token", kind: "fuzzy" })).toEqual({
      ok: false,
      error: { code: "malformed-kind" },
    });
  });

  test("rejects too many globs and malformed limits", () => {
    expect(
      parseWorkspaceSearchRequest({
        query: "token",
        include: ["a", "b", "c", "d"],
        exclude: ["e", "f", "g"],
      }),
    ).toEqual({
      ok: false,
      error: { code: "malformed-glob", reason: "too-many" },
    });
    expect(parseWorkspaceSearchRequest({ query: "token", maxMatches: 0 })).toEqual({
      ok: false,
      error: { code: "malformed-limit", field: "maxMatches", reason: "not-positive" },
    });
  });
});

describe("describeWorkspaceSearchError", () => {
  test("describes every search error code", () => {
    expect(describeWorkspaceSearchError({ code: "malformed-glob", reason: "empty" })).toBe(
      "malformed-glob:empty",
    );
    expect(
      describeWorkspaceSearchError({
        code: "malformed-limit",
        field: "maxMatches",
        reason: "not-positive",
      }),
    ).toBe("malformed-limit:maxMatches:not-positive");
    expect(describeWorkspaceSearchError({ code: "malformed-query", reason: "empty" })).toBe(
      "malformed-query:empty",
    );
    expect(describeWorkspaceSearchError({ code: "malformed-regex" })).toBe("malformed-regex");
    expect(describeWorkspaceSearchError({ code: "malformed-kind" })).toBe("malformed-kind");
    expect(describeWorkspaceSearchError({ code: "malformed-executable" })).toBe(
      "malformed-executable",
    );
    expect(describeWorkspaceSearchError({ code: "timed-out" })).toBe("timed-out");
    expect(describeWorkspaceSearchError({ code: "cancelled" })).toBe("cancelled");
    expect(describeWorkspaceSearchError({ code: "symlink-escape" })).toBe("symlink-escape");
    expect(describeWorkspaceSearchError({ code: "escaped" })).toBe("escaped");
    expect(describeWorkspaceSearchError({ code: "absolute-unscoped" })).toBe("absolute-unscoped");
    expect(describeWorkspaceSearchError({ code: "not-found" })).toBe("not-found");
    expect(describeWorkspaceSearchError({ code: "not-a-directory" })).toBe("not-a-directory");
    expect(describeWorkspaceSearchError({ code: "filesystem", reason: "permission-denied" })).toBe(
      "filesystem:permission-denied",
    );
    expect(
      describeWorkspaceSearchError({ code: "malformed", reason: "path-illegal-character" }),
    ).toBe("malformed:path-illegal-character");
  });
});
