import { describe, expect, test } from "bun:test";

import { createInMemoryFileSystem, localPath } from "../domain/index.ts";
import { createWorkspacePathBinder } from "./workspace-path.ts";

const root = localPath("/work/project");

describe("createWorkspacePathBinder", () => {
  test("keeps a lexical bind when the path does not exist yet", async () => {
    const binder = createWorkspacePathBinder(createInMemoryFileSystem());
    const bound = await binder.bind(root, "src/new.ts");
    expect(bound.ok).toBe(true);
    if (!bound.ok) {
      throw new Error("expected bind");
    }
    expect(bound.value.logical).toBe("src/new.ts");
  });

  test("refuses a symlink whose real path leaves the root", async () => {
    const fs = createInMemoryFileSystem({
      nodes: {
        "/work/project": { kind: "directory" },
        "/work/project/out": { kind: "symlink", target: "/etc/passwd" },
        "/etc/passwd": { kind: "file", text: "x" },
      },
    });
    const binder = createWorkspacePathBinder(fs);
    const bound = await binder.bind(root, "out");
    expect(bound).toEqual({ ok: false, error: { code: "symlink-escape" } });
  });

  test("does not invoke a runner or read file bytes", async () => {
    const fs = createInMemoryFileSystem({
      nodes: {
        "/work/project": { kind: "directory" },
        "/work/project/secret.txt": { kind: "file", text: "sk-live-ABCDEF" },
      },
    });
    const binder = createWorkspacePathBinder(fs);
    const bound = await binder.bind(root, "secret.txt");
    expect(bound.ok).toBe(true);
    if (!bound.ok) {
      throw new Error("expected bind");
    }
    expect(JSON.stringify(bound.value)).not.toContain("sk-live-ABCDEF");
  });
});
