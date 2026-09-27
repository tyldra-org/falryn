import { expect, test } from "bun:test";
import { type ChildAuthority, narrowChildAuthority } from "./child-admission.ts";
import {
  checkEditScopeWrites,
  editScopeContains,
  editScopeDirectories,
  editScopesOverlap,
  editScopeWithin,
  normalizeEditScope,
  workspaceRelative,
} from "./edit-scope.ts";

const scope = (...patterns: string[]) => {
  const normalized = normalizeEditScope(patterns);
  if (!normalized.ok) throw new Error("invalid");
  return normalized.value;
};

test("normalizes prefixes and bounded globs, refusing escapes and unsupported syntax", () => {
  expect(scope("./src//a/", "src/a", "docs/*.md")).toEqual(["docs/*.md", "src/a"]);
  expect(scope(".")).toEqual([""]);
  for (const invalid of [
    ["../x"],
    ["/abs"],
    ["C:/x"],
    ["a\\b"],
    ["a/[ab]"],
    ["a/{b}"],
    ["x".repeat(1025)],
    Array.from({ length: 65 }, (_, index) => `p${index}`),
    [],
  ])
    expect(normalizeEditScope(invalid).ok).toBe(false);
});

test("containment, nesting and conservative overlap", () => {
  const a = scope("src/a");
  expect(editScopeContains(a, "src/a")).toBe(true);
  expect(editScopeContains(a, "src/a/deep/file.ts")).toBe(true);
  expect(editScopeContains(a, "src/ab")).toBe(false);
  expect(editScopeContains(scope("src/*.ts"), "src/x.ts")).toBe(true);
  expect(editScopeContains(scope("src/?.ts"), "src/xy.ts")).toBe(false);
  expect(editScopeContains(null, "anything")).toBe(true);
  expect(editScopeWithin(scope("src/a/b"), a)).toBe(true);
  expect(editScopeWithin(scope("src/*.ts"), a)).toBe(false);
  expect(editScopeWithin(scope("src/x.ts"), scope("src/*.ts"))).toBe(true);
  expect(editScopeWithin(null, a)).toBe(false);
  expect(editScopeWithin(a, null)).toBe(true);
  expect(editScopesOverlap(a, scope("src/b"))).toBe(false);
  expect(editScopesOverlap(a, scope("src"))).toBe(true);
  expect(editScopesOverlap(scope("src/*.ts"), scope("src/a.ts"))).toBe(true);
  expect(editScopesOverlap(scope("src/*.ts"), scope("src/a.md"))).toBe(false);
  expect(editScopesOverlap(scope("src/*.ts"), scope("src/?.md"))).toBe(true);
  expect(editScopesOverlap(null, a)).toBe(true);
  expect(editScopeDirectories(scope("src/a", "docs"))).toEqual(["docs", "src/a"]);
  expect(editScopeDirectories(scope("src/*.ts"))).toBeNull();
});

test("mutation targets inside, outside and across the scope boundary", () => {
  const a = scope("src/a");
  const check = (targets: { paths?: string[]; moves?: { from: string; to: string }[] }) =>
    checkEditScopeWrites({
      scope: a,
      root: "/work",
      writes: "paths",
      targets: { paths: targets.paths ?? [], moves: targets.moves ?? [] },
      confined: false,
    });
  expect(check({ paths: ["src/a/x.ts", "/work/src/a/y.ts"] })).toBeNull();
  expect(check({ paths: ["src/a/x.ts", "src/b/y.ts"] })).toBe("edit-scope-violation");
  expect(check({ paths: ["src/a/../b/x.ts"] })).toBe("edit-scope-violation");
  expect(check({ paths: ["/elsewhere/src/a/x.ts"] })).toBe("edit-scope-violation");
  expect(check({ moves: [{ from: "src/a/x.ts", to: "src/b/x.ts" }] })).toBe("edit-scope-boundary");
  expect(check({ moves: [{ from: "src/b/x.ts", to: "src/c/x.ts" }] })).toBe("edit-scope-violation");
  expect(check({ moves: [{ from: "src/a/x.ts", to: "src/a/y.ts" }] })).toBeNull();
  const kind = (writes: "none" | "unbounded" | "sandbox", confined: boolean, patterns = a) =>
    checkEditScopeWrites({ scope: patterns, root: null, writes, targets: null, confined });
  expect(kind("none", false)).toBeNull();
  expect(kind("unbounded", true)).toBe("edit-scope-unenforceable");
  expect(kind("sandbox", false)).toBe("edit-scope-unenforceable");
  expect(kind("sandbox", true)).toBeNull();
  expect(kind("sandbox", true, scope("src/*.ts"))).toBe("edit-scope-unenforceable");
  expect(
    checkEditScopeWrites({
      scope: null,
      root: null,
      writes: "unbounded",
      targets: null,
      confined: false,
    }),
  ).toBeNull();
  expect(workspaceRelative("/work", "/work")).toBe("");
  expect(workspaceRelative("../x", "/work")).toBeNull();
});

test("a nested child stays inside its parent's scope and otherwise inherits it", () => {
  const parent: ChildAuthority = {
    version: 1,
    workspaceId: "w",
    configurationGeneration: "1",
    capabilityGeneration: "1",
    providers: [],
    capabilities: [],
    effects: ["observation", "mutation"],
    editScope: ["src"],
  };
  expect(narrowChildAuthority(parent, { ...parent, editScope: ["src/a"] })?.editScope).toEqual([
    "src/a",
  ]);
  expect(narrowChildAuthority(parent, { ...parent, editScope: null })?.editScope).toEqual(["src"]);
  expect(narrowChildAuthority(parent, { ...parent, editScope: ["docs"] })).toBeNull();
  expect(
    narrowChildAuthority({ ...parent, editScope: null }, { ...parent, editScope: null })?.editScope,
  ).toBeNull();
});
