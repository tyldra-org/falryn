import { describe, expect, test } from "bun:test";

import { localPath } from "./filesystem.ts";
import { bindWorkspacePath, describeWorkspacePathBindError } from "./workspace-path.ts";

const root = localPath("/work/project");

describe("bindWorkspacePath", () => {
  test("binds a relative path inside the root", () => {
    const bound = bindWorkspacePath(root, "src/./a.ts");
    expect(bound.ok).toBe(true);
    if (!bound.ok) {
      throw new Error("expected bind");
    }
    expect(bound.value.resolved as string).toBe("/work/project/src/a.ts");
    expect(bound.value.logical).toBe("src/a.ts");
    expect(bound.value.requested).toBe("src/./a.ts");
  });

  test("allows .. that stays inside the root", () => {
    const bound = bindWorkspacePath(root, "src/../lib/b.ts");
    expect(bound.ok).toBe(true);
    if (!bound.ok) {
      throw new Error("expected bind");
    }
    expect(bound.value.resolved as string).toBe("/work/project/lib/b.ts");
    expect(bound.value.logical).toBe("lib/b.ts");
  });

  test("refuses .. that leaves the root", () => {
    expect(bindWorkspacePath(root, "../secret")).toEqual({
      ok: false,
      error: { code: "escaped" },
    });
  });

  test("refuses a prefix that is not a child segment", () => {
    expect(bindWorkspacePath(localPath("/data/falryn"), "/data/falryn-old/x")).toEqual({
      ok: false,
      error: { code: "absolute-unscoped" },
    });
  });

  test("accepts an absolute path only when it stays in the root", () => {
    const inside = bindWorkspacePath(root, "/work/project/src/a.ts");
    expect(inside.ok).toBe(true);
    if (!inside.ok) {
      throw new Error("expected bind");
    }
    expect(inside.value.logical).toBe("src/a.ts");
    expect(bindWorkspacePath(root, "/etc/passwd")).toEqual({
      ok: false,
      error: { code: "absolute-unscoped" },
    });
  });

  test("binds . to the root itself", () => {
    const bound = bindWorkspacePath(root, ".");
    expect(bound.ok).toBe(true);
    if (!bound.ok) {
      throw new Error("expected bind");
    }
    expect(bound.value.resolved as string).toBe(root as string);
    expect(bound.value.logical).toBe("");
  });

  test("refuses NUL without echoing it", () => {
    const secret = "sk-live-0123456789";
    const result = bindWorkspacePath(root, `src/${secret}\0/etc/passwd`);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("describes every bind error code", () => {
    expect(describeWorkspacePathBindError({ code: "escaped" })).toBe("escaped");
    expect(describeWorkspacePathBindError({ code: "absolute-unscoped" })).toBe("absolute-unscoped");
    expect(
      describeWorkspacePathBindError({ code: "malformed", reason: "path-illegal-character" }),
    ).toBe("malformed:path-illegal-character");
  });
});
