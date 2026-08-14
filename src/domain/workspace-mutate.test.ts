import { describe, expect, test } from "bun:test";

import { localPath } from "./filesystem.ts";
import {
  computeMutationPlanId,
  DEFAULT_MAX_MUTATION_ENTRIES,
  describeWorkspaceMutationError,
  destinationInsideSource,
  HARD_MAX_MUTATION_DEPTH,
  parseWorkspaceMutation,
} from "./workspace-mutate.ts";

describe("parseWorkspaceMutation", () => {
  test("defaults overwrite to error and fills listing limits", () => {
    const parsed = parseWorkspaceMutation({
      kind: "move",
      source: "src/a.ts",
      destination: "src/b.ts",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected mutation");
    }
    expect(parsed.value.overwrite).toBe("error");
    expect(parsed.value.recursive).toBe(false);
    expect(parsed.value.limits.maxEntries).toBe(DEFAULT_MAX_MUTATION_ENTRIES);
  });

  test("treats an omitted trash destination as unsupported", () => {
    expect(parseWorkspaceMutation({ kind: "trash", source: "src/a.ts" })).toEqual({
      ok: false,
      error: { code: "unsupported-trash" },
    });
  });

  test("refuses a destination on remove and a missing one on move", () => {
    expect(
      parseWorkspaceMutation({ kind: "remove", source: "src/a.ts", destination: "x" }),
    ).toEqual({ ok: false, error: { code: "malformed-destination" } });
    expect(parseWorkspaceMutation({ kind: "move", source: "src/a.ts" })).toEqual({
      ok: false,
      error: { code: "malformed-destination" },
    });
  });

  test("rejects malformed kinds, overwrites, plan ids, and limits without echoing secrets", () => {
    expect(parseWorkspaceMutation({ kind: "patch", source: "a.ts" })).toEqual({
      ok: false,
      error: { code: "malformed-kind" },
    });
    expect(
      parseWorkspaceMutation({
        kind: "copy",
        source: "a.ts",
        destination: "b.ts",
        overwrite: "atomic",
      }),
    ).toEqual({ ok: false, error: { code: "malformed-overwrite" } });
    expect(
      parseWorkspaceMutation({
        kind: "copy",
        source: "a.ts",
        destination: "b.ts",
        expectedPlanId: "plan-1",
      }),
    ).toEqual({ ok: false, error: { code: "malformed-plan-id" } });
    expect(
      parseWorkspaceMutation({
        kind: "copy",
        source: "a.ts",
        destination: "b.ts",
        maxDepth: HARD_MAX_MUTATION_DEPTH + 1,
      }),
    ).toEqual({
      ok: false,
      error: { code: "malformed-limit", field: "maxDepth", reason: "above-hard-maximum" },
    });
    const secret = parseWorkspaceMutation({
      kind: "copy",
      source: "a.ts",
      destination: "sk-live-SECRET\0",
    });
    expect(secret).toEqual({ ok: false, error: { code: "malformed-destination" } });
    expect(JSON.stringify(secret)).not.toContain("sk-live-SECRET");
  });
});

describe("mutation helpers", () => {
  test("builds a stable plan identity from the canonical fields", () => {
    expect(
      computeMutationPlanId("move", "src/a.ts", "src/b.ts", "error", false, ["src/a.ts"]),
    ).toBe(computeMutationPlanId("move", "src/a.ts", "src/b.ts", "error", false, ["src/a.ts"]));
    expect(
      computeMutationPlanId("move", "src/a.ts", "src/b.ts", "error", false, ["src/a.ts"]),
    ).not.toBe(computeMutationPlanId("copy", "src/a.ts", "src/b.ts", "error", false, ["src/a.ts"]));
  });

  test("detects a destination nested inside the source", () => {
    expect(
      destinationInsideSource(
        localPath("/work/project/src"),
        localPath("/work/project/src/nested"),
      ),
    ).toBe(true);
    expect(
      destinationInsideSource(localPath("/work/project/src"), localPath("/work/project/src")),
    ).toBe(false);
    expect(
      destinationInsideSource(localPath("/work/project/src"), localPath("/work/project/lib")),
    ).toBe(false);
  });

  test("describeWorkspaceMutationError covers every declared code", () => {
    expect(describeWorkspaceMutationError({ code: "malformed", reason: "path-empty" })).toBe(
      "malformed:path-empty",
    );
    expect(describeWorkspaceMutationError({ code: "escaped" })).toBe("escaped");
    expect(describeWorkspaceMutationError({ code: "absolute-unscoped" })).toBe("absolute-unscoped");
    expect(describeWorkspaceMutationError({ code: "symlink-escape" })).toBe("symlink-escape");
    expect(describeWorkspaceMutationError({ code: "not-found" })).toBe("not-found");
    expect(describeWorkspaceMutationError({ code: "not-a-directory" })).toBe("not-a-directory");
    expect(describeWorkspaceMutationError({ code: "cancelled" })).toBe("cancelled");
    expect(describeWorkspaceMutationError({ code: "already-exists" })).toBe("already-exists");
    expect(describeWorkspaceMutationError({ code: "not-a-file" })).toBe("not-a-file");
    expect(describeWorkspaceMutationError({ code: "not-empty" })).toBe("not-empty");
    expect(describeWorkspaceMutationError({ code: "into-self" })).toBe("into-self");
    expect(describeWorkspaceMutationError({ code: "too-broad", truncation: "entry-limit" })).toBe(
      "too-broad:entry-limit",
    );
    expect(describeWorkspaceMutationError({ code: "unsupported-trash" })).toBe("unsupported-trash");
    expect(describeWorkspaceMutationError({ code: "stale-plan" })).toBe("stale-plan");
    expect(describeWorkspaceMutationError({ code: "malformed-plan" })).toBe("malformed-plan");
    expect(describeWorkspaceMutationError({ code: "malformed-kind" })).toBe("malformed-kind");
    expect(describeWorkspaceMutationError({ code: "malformed-overwrite" })).toBe(
      "malformed-overwrite",
    );
    expect(describeWorkspaceMutationError({ code: "malformed-destination" })).toBe(
      "malformed-destination",
    );
    expect(describeWorkspaceMutationError({ code: "malformed-plan-id" })).toBe("malformed-plan-id");
    expect(
      describeWorkspaceMutationError({
        code: "malformed-limit",
        field: "maxEntries",
        reason: "not-positive",
      }),
    ).toBe("malformed-limit:maxEntries:not-positive");
    expect(describeWorkspaceMutationError({ code: "plan-refused" })).toBe("plan-refused");
    expect(describeWorkspaceMutationError({ code: "filesystem", reason: "io-failure" })).toBe(
      "filesystem:io-failure",
    );
  });
});
