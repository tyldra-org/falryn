import { describe, expect, test } from "bun:test";

import {
  describeWorkspaceIndexError,
  indexLifecycleQueryable,
  lifecycleQueryError,
  MAX_INDEX_QUERY_LENGTH,
  parseWorkspaceIndexQuery,
  recordMatchesQuery,
} from "./workspace-index.ts";

describe("parseWorkspaceIndexQuery", () => {
  test("applies defaults for an omitted kind and include glob", () => {
    const parsed = parseWorkspaceIndexQuery({ query: "Token" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected query");
    }
    expect(parsed.value.kind).toBe("structural");
    expect(parsed.value.include).toHaveLength(1);
    expect(parsed.value.include[0]?.pattern).toBe("*");
    expect(parsed.value.includeHidden).toBe(false);
    expect(parsed.value.caseSensitive).toBe(true);
    expect(parsed.value.maxMatches).toBe(100);
    expect(parsed.value.recordKinds).toEqual(["symbol", "heading", "chunk"]);
  });

  test("rejects a query that contains a secret without echoing it", () => {
    const empty = parseWorkspaceIndexQuery({ query: "" });
    expect(empty).toEqual({ ok: false, error: { code: "malformed-query", reason: "empty" } });
    const tooLong = parseWorkspaceIndexQuery({
      query: "a".repeat(MAX_INDEX_QUERY_LENGTH + 1),
    });
    expect(tooLong).toEqual({
      ok: false,
      error: { code: "malformed-query", reason: "too-long" },
    });
    expect(JSON.stringify(tooLong)).not.toContain("aaaa");
    const nul = parseWorkspaceIndexQuery({ query: "sk-live-SECRET\0" });
    expect(nul).toEqual({
      ok: false,
      error: { code: "malformed-query", reason: "illegal-character" },
    });
    expect(JSON.stringify(nul)).not.toContain("sk-live-SECRET");
  });

  test("rejects malformed kinds and limits", () => {
    expect(parseWorkspaceIndexQuery({ query: "token", kind: "semantic" })).toEqual({
      ok: false,
      error: { code: "malformed-kind" },
    });
    expect(parseWorkspaceIndexQuery({ query: "token", recordKinds: ["class"] })).toEqual({
      ok: false,
      error: { code: "malformed-record-kind" },
    });
    expect(parseWorkspaceIndexQuery({ query: "token", maxMatches: 0 })).toEqual({
      ok: false,
      error: { code: "malformed-limit", field: "maxMatches", reason: "not-positive" },
    });
  });
});

describe("recordMatchesQuery", () => {
  test("matches structural names and lexical text", () => {
    const structural = parseWorkspaceIndexQuery({ query: "foo", kind: "structural" });
    const lexical = parseWorkspaceIndexQuery({ query: "token", kind: "lexical" });
    const insensitive = parseWorkspaceIndexQuery({
      query: "FOO",
      kind: "structural",
      caseSensitive: false,
    });
    if (!structural.ok || !lexical.ok || !insensitive.ok) {
      throw new Error("expected queries");
    }
    const record = {
      logical: "src/a.ts",
      kind: "symbol" as const,
      name: "fooBar",
      text: "export function fooBar() { return token; }",
      startLine: 1,
      endLine: 1,
      revision: "1",
    };
    expect(recordMatchesQuery(record, structural.value)).toBe(true);
    expect(recordMatchesQuery(record, lexical.value)).toBe(true);
    expect(recordMatchesQuery(record, insensitive.value)).toBe(true);
    expect(
      recordMatchesQuery(record, {
        ...structural.value,
        recordKinds: ["heading"],
      }),
    ).toBe(false);
  });
});

describe("index lifecycle", () => {
  test("only ready-family lifecycles are queryable", () => {
    expect(indexLifecycleQueryable("ready")).toBe(true);
    expect(indexLifecycleQueryable("updating")).toBe(true);
    expect(indexLifecycleQueryable("stale")).toBe(true);
    expect(indexLifecycleQueryable("degraded")).toBe(true);
    expect(indexLifecycleQueryable("absent")).toBe(false);
    expect(indexLifecycleQueryable("building")).toBe(false);
    expect(lifecycleQueryError("absent")).toEqual({ code: "index-absent" });
    expect(lifecycleQueryError("corrupt")).toEqual({ code: "index-corrupt" });
    expect(lifecycleQueryError("building")).toEqual({
      code: "index-not-ready",
      lifecycle: "building",
    });
  });
});

describe("describeWorkspaceIndexError", () => {
  test("describes every index error code", () => {
    expect(describeWorkspaceIndexError({ code: "malformed-glob", reason: "empty" })).toBe(
      "malformed-glob:empty",
    );
    expect(
      describeWorkspaceIndexError({
        code: "malformed-limit",
        field: "maxMatches",
        reason: "not-positive",
      }),
    ).toBe("malformed-limit:maxMatches:not-positive");
    expect(describeWorkspaceIndexError({ code: "malformed-query", reason: "empty" })).toBe(
      "malformed-query:empty",
    );
    expect(describeWorkspaceIndexError({ code: "malformed-kind" })).toBe("malformed-kind");
    expect(describeWorkspaceIndexError({ code: "malformed-record-kind" })).toBe(
      "malformed-record-kind",
    );
    expect(describeWorkspaceIndexError({ code: "index-absent" })).toBe("index-absent");
    expect(describeWorkspaceIndexError({ code: "index-not-ready", lifecycle: "building" })).toBe(
      "index-not-ready:building",
    );
    expect(describeWorkspaceIndexError({ code: "index-corrupt" })).toBe("index-corrupt");
    expect(describeWorkspaceIndexError({ code: "unavailable" })).toBe("unavailable");
    expect(describeWorkspaceIndexError({ code: "cancelled" })).toBe("cancelled");
    expect(describeWorkspaceIndexError({ code: "symlink-escape" })).toBe("symlink-escape");
    expect(describeWorkspaceIndexError({ code: "escaped" })).toBe("escaped");
    expect(describeWorkspaceIndexError({ code: "absolute-unscoped" })).toBe("absolute-unscoped");
    expect(describeWorkspaceIndexError({ code: "not-found" })).toBe("not-found");
    expect(describeWorkspaceIndexError({ code: "not-a-directory" })).toBe("not-a-directory");
    expect(describeWorkspaceIndexError({ code: "filesystem", reason: "permission-denied" })).toBe(
      "filesystem:permission-denied",
    );
    expect(
      describeWorkspaceIndexError({ code: "malformed", reason: "path-illegal-character" }),
    ).toBe("malformed:path-illegal-character");
  });
});
