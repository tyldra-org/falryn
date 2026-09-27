/**
 * Child edit scopes (#1122). A write-capable child may mutate only workspace paths
 * inside its admitted scope: workspace-relative prefixes whose segments may use
 * `*` and `?` within one segment. An absent scope is the full inherited scope,
 * which overlaps every other writer. Overlap is decided conservatively: when two
 * patterns might intersect, they overlap.
 */
import { z } from "zod";
import { err, ok, type Result } from "../foundation/result.ts";

export const EDIT_SCOPE_LIMITS = Object.freeze({ patterns: 64, bytes: 1024 });
/** Model-supplied patterns; normalized before admission and never stored raw. */
export const editScopeInputSchema = z
  .array(z.string().min(1).max(EDIT_SCOPE_LIMITS.bytes))
  .min(1)
  .max(EDIT_SCOPE_LIMITS.patterns);
/** Normalized, sorted and unique; `""` names the whole root; null is unscoped. */
export const editScopeSchema = z
  .array(z.string().max(EDIT_SCOPE_LIMITS.bytes))
  .max(EDIT_SCOPE_LIMITS.patterns)
  .nullable();
export type EditScope = readonly string[] | null;

export type EditScopeRefusal =
  | "edit-scope-violation"
  | "edit-scope-boundary"
  | "edit-scope-unenforceable";

/** How a capability can write workspace files, declared by its owner. */
export type WorkspaceWriteClass = "none" | "paths" | "sandbox" | "unbounded";
export type WorkspaceWriteTargets = {
  readonly paths: readonly string[];
  readonly moves: readonly { readonly from: string; readonly to: string }[];
};

const GLOB = /[*?]/u;
const segments = (pattern: string) => (pattern === "" ? [] : pattern.split("/"));

function segmentMatches(glob: string, text: string): boolean {
  const source = glob
    .split("")
    .map((char) =>
      char === "*" ? "[^/]*" : char === "?" ? "[^/]" : char.replace(/[.+^$()|{}[\]\\]/gu, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`, "u").test(text);
}

/** Two segments may name the same entry; two globs are assumed to. */
function segmentsMayMeet(left: string, right: string): boolean {
  const leftGlob = GLOB.test(left);
  const rightGlob = GLOB.test(right);
  if (leftGlob && rightGlob) return true;
  if (leftGlob) return segmentMatches(left, right);
  if (rightGlob) return segmentMatches(right, left);
  return left === right;
}

/** Collapse separators and `.`; reject `..`, absolute and control forms. */
export function normalizeEditScope(
  raw: readonly string[],
): Result<readonly string[], "edit-scope-invalid"> {
  if (raw.length === 0 || raw.length > EDIT_SCOPE_LIMITS.patterns) return err("edit-scope-invalid");
  const normalized = new Set<string>();
  for (const value of raw) {
    if (
      Buffer.byteLength(value) > EDIT_SCOPE_LIMITS.bytes ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: scope patterns reject control characters.
      /[\u0000-\u001f\\]/u.test(value) ||
      value.startsWith("/") ||
      /^[a-zA-Z]:/u.test(value)
    )
      return err("edit-scope-invalid");
    const parts: string[] = [];
    for (const part of value.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === ".." || /[[\]{}!]/u.test(part)) return err("edit-scope-invalid");
      parts.push(part);
    }
    normalized.add(parts.join("/"));
  }
  return ok([...normalized].sort());
}

/**
 * A tool's target as a root-relative path, or null when it names no path under
 * the root. Relative targets are workspace-relative, as the file tools bind them.
 */
export function workspaceRelative(target: string, root: string | null): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: target paths reject control characters.
  if (target.length === 0 || /[\u0000-\u001f]/u.test(target)) return null;
  let path = target.replaceAll("\\", "/");
  if (path.startsWith("/") || /^[a-zA-Z]:\//u.test(path)) {
    const base = root?.replaceAll("\\", "/").replace(/\/+$/u, "");
    if (!base) return null;
    if (path !== base && !path.startsWith(`${base}/`)) return null;
    path = path.slice(base.length);
  }
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/** Whether a root-relative path lies inside the scope (a pattern is a prefix of it). */
export function editScopeContains(scope: EditScope, path: string): boolean {
  if (scope === null) return true;
  const target = segments(path);
  return scope.some((pattern) => {
    const prefix = segments(pattern);
    return (
      prefix.length <= target.length &&
      prefix.every((part, index) => {
        const actual = target[index] ?? "";
        return GLOB.test(part) ? segmentMatches(part, actual) : part === actual;
      })
    );
  });
}

/** Every child pattern is provably inside some parent pattern. */
export function editScopeWithin(child: EditScope, parent: EditScope): boolean {
  if (parent === null) return true;
  if (child === null) return false;
  return child.every((pattern) => {
    const inner = segments(pattern);
    return parent.some((candidate) => {
      const outer = segments(candidate);
      return (
        outer.length <= inner.length &&
        outer.every((part, index) => {
          const actual = inner[index] ?? "";
          if (!GLOB.test(part)) return part === actual;
          return actual === part || (!GLOB.test(actual) && segmentMatches(part, actual));
        })
      );
    });
  });
}

/** Two scopes overlap unless no pattern pair can name the same path. */
export function editScopesOverlap(left: EditScope, right: EditScope): boolean {
  if (left === null || right === null) return true;
  return left.some((a) =>
    right.some((b) => {
      const first = segments(a);
      const second = segments(b);
      const shared = Math.min(first.length, second.length);
      for (let index = 0; index < shared; index++)
        if (!segmentsMayMeet(first[index] ?? "", second[index] ?? "")) return false;
      return true;
    }),
  );
}

/** Directory prefixes a sandbox can use as write roots; null when any pattern is a glob. */
export function editScopeDirectories(scope: EditScope): readonly string[] | null {
  if (scope === null || scope.some((pattern) => GLOB.test(pattern))) return null;
  return scope;
}

/**
 * The refusal for one mutation, or null when the scope permits it. Command writes
 * are enforceable only when the sandbox confines them to directory scopes.
 */
export function checkEditScopeWrites(input: {
  readonly scope: EditScope;
  readonly root: string | null;
  readonly writes: WorkspaceWriteClass;
  readonly targets: WorkspaceWriteTargets | null;
  readonly confined: boolean;
}): EditScopeRefusal | null {
  const { scope } = input;
  if (scope === null || input.writes === "none") return null;
  if (input.writes === "unbounded") return "edit-scope-unenforceable";
  if (input.writes === "sandbox")
    return input.confined && editScopeDirectories(scope) !== null
      ? null
      : "edit-scope-unenforceable";
  if (input.targets === null) return "edit-scope-unenforceable";
  const inside = (target: string) => {
    const path = workspaceRelative(target, input.root);
    return path !== null && editScopeContains(scope, path);
  };
  let refusal: EditScopeRefusal | null = null;
  for (const move of input.targets.moves) {
    const from = inside(move.from);
    const to = inside(move.to);
    if (from !== to) return "edit-scope-boundary";
    if (!from) refusal = "edit-scope-violation";
  }
  if (input.targets.paths.some((path) => !inside(path))) return "edit-scope-violation";
  return refusal;
}
