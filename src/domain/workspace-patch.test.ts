import { describe, expect, test } from "bun:test";

import { instant } from "./clock.ts";
import { localPath } from "./filesystem.ts";
import type { GitIdentity, GitStatusEntry, GitStatusSnapshot } from "./git.ts";
import {
  applyPatchHunks,
  assessPatchGitStatus,
  computePatchPlanId,
  DEFAULT_MAX_PATCH_TARGETS,
  describeWorkspacePatchError,
  gitPathForPatchTarget,
  HARD_MAX_PATCH_HUNKS,
  hunkHeader,
  joinPatchedLines,
  linesForChangedRegion,
  NOT_ATTEMPTED_PATCH_ROLLBACK,
  parsePatchChangedRegionRead,
  parseWorkspacePatchPlan,
  summarizePatchRollback,
} from "./workspace-patch.ts";

describe("parseWorkspacePatchPlan", () => {
  test("defaults to fail-before-effect and fills limits", () => {
    const parsed = parseWorkspacePatchPlan({
      targets: [
        {
          path: "src/a.ts",
          hunks: [{ oldStart: 1, oldLines: ["one"], newLines: ["two"] }],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected plan");
    }
    expect(parsed.value.policy).toBe("fail-before-effect");
    expect(parsed.value.expectedGitHead).toBeNull();
    expect(parsed.value.limits.maxTargets).toBe(DEFAULT_MAX_PATCH_TARGETS);
    expect(parsed.value.targets[0]?.hunks).toHaveLength(1);
  });

  test("rejects overlapping hunks, empty hunks, and secrets in malformed text", () => {
    expect(
      parseWorkspacePatchPlan({
        targets: [
          {
            path: "a.ts",
            hunks: [
              { oldStart: 1, oldLines: ["a", "b"], newLines: ["x"] },
              { oldStart: 2, oldLines: ["b"], newLines: ["y"] },
            ],
          },
        ],
      }),
    ).toEqual({ ok: false, error: { code: "overlapping-hunks" } });
    expect(
      parseWorkspacePatchPlan({
        targets: [{ path: "a.ts", hunks: [{ oldStart: 1, oldLines: [], newLines: [] }] }],
      }),
    ).toEqual({ ok: false, error: { code: "malformed-hunk" } });
    const secret = parseWorkspacePatchPlan({
      targets: [
        {
          path: "a.ts",
          hunks: [{ oldStart: 1, oldLines: ["sk-live-SECRET\0"], newLines: ["x"] }],
        },
      ],
    });
    expect(secret).toEqual({ ok: false, error: { code: "malformed-text" } });
    expect(JSON.stringify(secret)).not.toContain("sk-live-SECRET");
  });

  test("rejects malformed policy, plan ids, limits, and duplicate paths", () => {
    expect(
      parseWorkspacePatchPlan({
        policy: "atomic",
        targets: [{ path: "a.ts", hunks: [{ oldStart: 1, oldLines: ["a"], newLines: ["b"] }] }],
      }),
    ).toEqual({ ok: false, error: { code: "malformed-policy" } });
    expect(
      parseWorkspacePatchPlan({
        expectedPlanId: "mutate-1",
        targets: [{ path: "a.ts", hunks: [{ oldStart: 1, oldLines: ["a"], newLines: ["b"] }] }],
      }),
    ).toEqual({ ok: false, error: { code: "malformed-plan-id" } });
    expect(
      parseWorkspacePatchPlan({
        maxHunks: HARD_MAX_PATCH_HUNKS + 1,
        targets: [{ path: "a.ts", hunks: [{ oldStart: 1, oldLines: ["a"], newLines: ["b"] }] }],
      }),
    ).toEqual({
      ok: false,
      error: { code: "malformed-limit", field: "maxHunks", reason: "above-hard-maximum" },
    });
    expect(
      parseWorkspacePatchPlan({
        targets: [
          { path: "src/a.ts", hunks: [{ oldStart: 1, oldLines: ["a"], newLines: ["b"] }] },
          { path: "src/a.ts", hunks: [{ oldStart: 1, oldLines: ["a"], newLines: ["c"] }] },
        ],
      }),
    ).toEqual({ ok: false, error: { code: "overlapping-targets", reason: "duplicate" } });
  });
});

describe("applyPatchHunks", () => {
  test("replaces, inserts, and deletes at exact lines", () => {
    const replaced = applyPatchHunks(
      ["a", "b", "c"],
      [{ index: 0, oldStart: 2, oldLines: ["b"], newLines: ["B"] }],
    );
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) {
      throw new Error("expected replace");
    }
    expect(replaced.value.lines).toEqual(["a", "B", "c"]);
    expect(replaced.value.hunks[0]?.header).toBe(hunkHeader(2, 1, 2, 1));

    const inserted = applyPatchHunks(
      ["a", "c"],
      [{ index: 0, oldStart: 2, oldLines: [], newLines: ["b"] }],
    );
    expect(inserted.ok && inserted.value.lines).toEqual(["a", "b", "c"]);

    const deleted = applyPatchHunks(
      ["a", "b", "c"],
      [{ index: 0, oldStart: 2, oldLines: ["b"], newLines: [] }],
    );
    expect(deleted.ok && deleted.value.lines).toEqual(["a", "c"]);
  });

  test("refuses a mismatched hunk without relocating it", () => {
    const result = applyPatchHunks(
      ["a", "secret", "c"],
      [{ index: 0, oldStart: 2, oldLines: ["b"], newLines: ["sk-live-NEW"] }],
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected conflict");
    }
    expect(result.error.code).toBe("conflict");
    if (result.error.code === "conflict") {
      expect(result.error.found).toEqual(["secret"]);
    }
    expect(JSON.stringify(result)).not.toContain("sk-live-NEW");
  });

  test("applies later hunks against original line numbers", () => {
    const result = applyPatchHunks(
      ["a", "b", "c", "d"],
      [
        { index: 0, oldStart: 1, oldLines: ["a"], newLines: ["A", "A2"] },
        { index: 1, oldStart: 3, oldLines: ["c"], newLines: ["C"] },
      ],
    );
    expect(result.ok && result.value.lines).toEqual(["A", "A2", "b", "C", "d"]);
  });
});

describe("patch helpers", () => {
  test("joins lines with the original newline and trailing newline", () => {
    expect(joinPatchedLines(["a", "b"], "lf", true)).toBe("a\nb\n");
    expect(joinPatchedLines(["a", "b"], "crlf", false)).toBe("a\r\nb");
  });

  test("builds a stable plan identity", () => {
    const plan = parseWorkspacePatchPlan({
      targets: [{ path: "a.ts", hunks: [{ oldStart: 1, oldLines: ["a"], newLines: ["b"] }] }],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      throw new Error("expected plan");
    }
    expect(computePatchPlanId(plan.value)).toBe(computePatchPlanId(plan.value));
    expect(computePatchPlanId(plan.value).startsWith("patch-")).toBe(true);
  });

  test("describeWorkspacePatchError covers every declared code", () => {
    expect(describeWorkspacePatchError({ code: "malformed", reason: "path-empty" })).toBe(
      "malformed:path-empty",
    );
    expect(
      describeWorkspacePatchError({
        code: "conflict",
        hunkIndex: 0,
        lineStart: 1,
        lineEnd: 2,
        foundCount: 1,
        found: ["x"],
      }),
    ).toBe("conflict:0");
    expect(describeWorkspacePatchError({ code: "overlapping-targets", reason: "duplicate" })).toBe(
      "overlapping-targets:duplicate",
    );
    expect(describeWorkspacePatchError({ code: "stale-plan" })).toBe("stale-plan");
    expect(describeWorkspacePatchError({ code: "malformed-range" })).toBe("malformed-range");
    expect(
      describeWorkspacePatchError({ code: "rollback-failed", reason: "concurrent-change" }),
    ).toBe("rollback-failed:concurrent-change");
    expect(describeWorkspacePatchError({ code: "filesystem", reason: "io-failure" })).toBe(
      "filesystem:io-failure",
    );
    expect(describeWorkspacePatchError({ code: "git-conflict" })).toBe("git-conflict");
    expect(describeWorkspacePatchError({ code: "git-head-mismatch" })).toBe("git-head-mismatch");
    expect(describeWorkspacePatchError({ code: "git-operation", operation: "merge" })).toBe(
      "git-operation:merge",
    );
    expect(describeWorkspacePatchError({ code: "git-unavailable", reason: "truncated" })).toBe(
      "git-unavailable:truncated",
    );
  });

  test("parses changed-region reads and maps half-open ranges", () => {
    expect(parsePatchChangedRegionRead({ path: "a.ts" })).toEqual({
      ok: false,
      error: { code: "malformed-range" },
    });
    const parsed = parsePatchChangedRegionRead({
      path: "src/a.ts",
      regions: [{ start: 2, end: 3 }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected regions");
    }
    expect(parsed.value.regions).toEqual([{ start: 2, end: 3 }]);
    const lines = linesForChangedRegion("one\nTWO\nthree\n", { start: 2, end: 3 });
    expect(lines).toEqual({
      ok: true,
      value: { lines: [{ number: 2, text: "TWO" }], truncated: false },
    });
    expect(linesForChangedRegion("one\n", { start: 2, end: 2 })).toEqual({
      ok: true,
      value: { lines: [], truncated: false },
    });
    expect(summarizePatchRollback(false, [], [])).toEqual(NOT_ATTEMPTED_PATCH_ROLLBACK);
    expect(summarizePatchRollback(true, [0], [])).toEqual({
      status: "complete",
      restored: [0],
      failed: [],
    });
  });
});

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function gitIdentity(operation: GitIdentity["operation"] = "clean"): GitIdentity {
  return {
    worktreeRoot: localPath("/work/project"),
    gitDir: ".git",
    commonDir: ".git",
    head: { state: "observed", value: HEAD },
    headState: "branch",
    branch: { state: "observed", value: "main" },
    upstream: { state: "unavailable", reason: "none" },
    ahead: { state: "unavailable", reason: "none" },
    behind: { state: "unavailable", reason: "none" },
    operation,
    superproject: { state: "unavailable", reason: "no-superproject" },
    sparseCheckout: { state: "observed", value: false },
    gitVersion: { state: "observed", value: "2.45.0" },
    remotes: { state: "observed", value: [] },
    observedAt: instant(0),
  };
}

function entry(path: string, kind: GitStatusEntry["kind"]): GitStatusEntry {
  return { kind, path, originalPath: null, indexStatus: ".", worktreeStatus: "M" };
}

function snapshot(
  entries: readonly GitStatusEntry[],
  operation: GitIdentity["operation"] = "clean",
): GitStatusSnapshot {
  return {
    identity: gitIdentity(operation),
    entries: { state: "observed", value: entries },
  };
}

describe("patch git observation", () => {
  test("maps a nested workspace path onto the worktree", () => {
    expect(gitPathForPatchTarget("/repo", "/repo/pkg", "src/a.ts")).toBe("pkg/src/a.ts");
    expect(gitPathForPatchTarget("/private/var/repo", "/var/repo", "a.ts")).toBe("a.ts");
  });

  test("allows a dirty target when the repository operation is clean", () => {
    const assessed = assessPatchGitStatus(
      snapshot([entry("src/a.ts", "ordinary")]),
      "/work/project",
      ["src/a.ts"],
      HEAD,
    );
    expect(assessed.ok).toBe(true);
    if (assessed.ok) {
      expect(assessed.value.dirtyTargets).toEqual(["src/a.ts"]);
    }
  });

  test("refuses a merge, an unmerged path, a HEAD mismatch, and truncated unknown paths", () => {
    const merging = assessPatchGitStatus(
      snapshot([], "merge"),
      "/work/project",
      ["src/a.ts"],
      null,
    );
    expect(merging.ok).toBe(false);
    if (!merging.ok) {
      expect(merging.error).toEqual({ code: "git-operation", operation: "merge" });
    }
    const unmerged = assessPatchGitStatus(
      snapshot([entry("src/a.ts", "unmerged")]),
      "/work/project",
      ["src/a.ts"],
      null,
    );
    expect(unmerged.ok).toBe(false);
    if (!unmerged.ok) {
      expect(unmerged.error).toEqual({ code: "git-conflict" });
    }
    const staleHead = assessPatchGitStatus(
      snapshot([]),
      "/work/project",
      ["src/a.ts"],
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(staleHead.ok).toBe(false);
    if (!staleHead.ok) {
      expect(staleHead.error).toEqual({ code: "git-head-mismatch" });
    }
    const truncated = assessPatchGitStatus(
      {
        identity: gitIdentity(),
        entries: { state: "truncated", value: [entry("other.ts", "ordinary")], omitted: 1 },
      },
      "/work/project",
      ["src/a.ts"],
      null,
    );
    expect(truncated.ok).toBe(false);
    if (!truncated.ok) {
      expect(truncated.error).toEqual({ code: "git-unavailable", reason: "truncated" });
    }
  });
});
