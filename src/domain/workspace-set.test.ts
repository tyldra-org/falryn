import { describe, expect, test } from "bun:test";

import { localPath } from "./filesystem.ts";
import { workspaceRootId } from "./identity.ts";
import {
  bindWorkspaceSetPath,
  createWorkspaceSet,
  describeWorkspaceSetBindError,
  describeWorkspaceSetError,
  primaryWorkspaceRoot,
} from "./workspace-set.ts";

const falryn = localPath("/work/falryn");
const docs = localPath("/work/falryn-docs");
const rootA = workspaceRootId.from("root-a");
const rootB = workspaceRootId.from("root-b");

function twoRootSet() {
  const set = createWorkspaceSet([
    { rootId: rootA, name: "falryn", path: falryn },
    { rootId: rootB, name: "falryn-docs", path: docs },
  ]);
  expect(set.ok).toBe(true);
  if (!set.ok) {
    throw new Error("expected set");
  }
  return set.value;
}

describe("createWorkspaceSet", () => {
  test("keeps order and names the first root primary", () => {
    const set = twoRootSet();
    expect(primaryWorkspaceRoot(set).rootId).toBe(rootA);
    expect(set.roots.map((root) => root.name)).toEqual(["falryn", "falryn-docs"]);
  });

  test("refuses an empty set", () => {
    expect(createWorkspaceSet([])).toEqual({ ok: false, error: { code: "empty" } });
  });

  test("refuses illegal and duplicate names", () => {
    expect(createWorkspaceSet([{ rootId: rootA, name: "with/slash", path: falryn }])).toEqual({
      ok: false,
      error: { code: "invalid-name" },
    });
    expect(
      createWorkspaceSet([
        { rootId: rootA, name: "falryn", path: falryn },
        { rootId: rootB, name: "falryn", path: docs },
      ]),
    ).toEqual({ ok: false, error: { code: "duplicate-name" } });
  });

  test("refuses duplicate ids and duplicate canonical paths", () => {
    expect(
      createWorkspaceSet([
        { rootId: rootA, name: "falryn", path: falryn },
        { rootId: rootA, name: "docs", path: docs },
      ]),
    ).toEqual({ ok: false, error: { code: "duplicate-root-id" } });
    expect(
      createWorkspaceSet([
        { rootId: rootA, name: "falryn", path: falryn },
        { rootId: rootB, name: "docs", path: falryn },
      ]),
    ).toEqual({ ok: false, error: { code: "duplicate-path" } });
  });

  test("refuses overlapping roots", () => {
    expect(
      createWorkspaceSet([
        { rootId: rootA, name: "parent", path: localPath("/work") },
        { rootId: rootB, name: "child", path: falryn },
      ]),
    ).toEqual({ ok: false, error: { code: "overlapping-roots" } });
  });

  test("refuses a relative root path without echoing it", () => {
    const secret = "sk-live-relative";
    const result = createWorkspaceSet([{ rootId: rootA, name: "falryn", path: `./${secret}` }]);
    expect(result).toEqual({
      ok: false,
      error: { code: "not-absolute", reason: "path-not-absolute" },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("bindWorkspaceSetPath", () => {
  test("binds a relative path to the primary root", () => {
    const bound = bindWorkspaceSetPath(twoRootSet(), "src/a.ts");
    expect(bound.ok).toBe(true);
    if (!bound.ok) {
      throw new Error("expected bind");
    }
    expect(bound.value.rootId).toBe(rootA);
    expect(bound.value.resolved as string).toBe("/work/falryn/src/a.ts");
    expect(bound.value.logical).toBe("src/a.ts");
  });

  test("binds a relative path only inside a supplied root id", () => {
    const bound = bindWorkspaceSetPath(twoRootSet(), "README.md", { rootId: rootB });
    expect(bound.ok).toBe(true);
    if (!bound.ok) {
      throw new Error("expected bind");
    }
    expect(bound.value.rootId).toBe(rootB);
    expect(bound.value.resolved as string).toBe("/work/falryn-docs/README.md");
  });

  test("accepts an absolute path inside exactly one root", () => {
    const bound = bindWorkspaceSetPath(twoRootSet(), "/work/falryn-docs/guides/a.md");
    expect(bound.ok).toBe(true);
    if (!bound.ok) {
      throw new Error("expected bind");
    }
    expect(bound.value.rootId).toBe(rootB);
    expect(bound.value.logical).toBe("guides/a.md");
  });

  test("refuses an absolute path outside every root", () => {
    expect(bindWorkspaceSetPath(twoRootSet(), "/etc/passwd")).toEqual({
      ok: false,
      error: { code: "absolute-unscoped" },
    });
  });

  test("reports ambiguous-root when a path sits in more than one root", () => {
    const overlapping = {
      roots: [
        { rootId: rootA, name: "parent", path: localPath("/work") },
        { rootId: rootB, name: "child", path: falryn },
      ],
    } as const;
    expect(bindWorkspaceSetPath(overlapping, "/work/falryn/src/a.ts")).toEqual({
      ok: false,
      error: { code: "ambiguous-root" },
    });
  });

  test("refuses .. escape from the chosen root", () => {
    expect(bindWorkspaceSetPath(twoRootSet(), "../secret", { rootId: rootB })).toEqual({
      ok: false,
      error: { code: "escaped" },
    });
  });

  test("refuses an unknown root id", () => {
    expect(
      bindWorkspaceSetPath(twoRootSet(), "a.ts", {
        rootId: workspaceRootId.from("missing"),
      }),
    ).toEqual({ ok: false, error: { code: "unknown-root" } });
  });

  test("never echoes rejected text", () => {
    const secret = "sk-live-0123456789";
    const result = bindWorkspaceSetPath(twoRootSet(), `src/${secret}\0/etc/passwd`);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("describes set and bind errors", () => {
    expect(describeWorkspaceSetError({ code: "overlapping-roots" })).toBe("overlapping-roots");
    expect(describeWorkspaceSetError({ code: "invalid-root-id" })).toBe("invalid-root-id");
    expect(describeWorkspaceSetBindError({ code: "escaped" })).toBe("escaped");
    expect(describeWorkspaceSetBindError({ code: "ambiguous-root" })).toBe("ambiguous-root");
  });
});
