import { describe, expect, test } from "bun:test";

import {
  createInMemoryFileSystem,
  createWorkspaceSet,
  localPath,
  workspaceRootId,
} from "../../domain/index.ts";
import { known, unavailable } from "../view-model.ts";
import { createWorkspaceController } from "./controller.ts";
import { formatWorkspaceHeaderText, projectWorkspaceHeader, workspaceRootFacts } from "./format.ts";

const rootA = workspaceRootId.from("root-a");
const rootB = workspaceRootId.from("root-b");

function twoRootSet() {
  const set = createWorkspaceSet([
    { rootId: rootA, name: "falryn", path: localPath("/work/falryn") },
    { rootId: rootB, name: "docs", path: localPath("/work/docs") },
  ]);
  expect(set.ok).toBe(true);
  if (!set.ok) {
    throw new Error("expected set");
  }
  return set.value;
}

describe("formatWorkspaceHeaderText", () => {
  test("names a one-root set without a count", () => {
    expect(
      formatWorkspaceHeaderText({
        roots: [{ rootId: "root-a", name: "falryn", path: "/work/falryn" }],
      }),
    ).toBe("falryn");
  });

  test("appends the extra-root count", () => {
    expect(
      formatWorkspaceHeaderText({
        roots: [
          { rootId: "root-a", name: "falryn", path: "/work/falryn" },
          { rootId: "root-b", name: "docs", path: "/work/docs" },
          { rootId: "root-c", name: "extra", path: "/work/extra" },
        ],
      }),
    ).toBe("falryn +2");
  });

  test("returns null for an empty set", () => {
    expect(formatWorkspaceHeaderText({ roots: [] })).toBeNull();
  });
});

describe("projectWorkspaceHeader", () => {
  test("replaces the workspace field from the set", () => {
    const header = {
      workspace: known("/old"),
      branch: unavailable("no Git yet"),
      session: unavailable("no session yet"),
      model: unavailable("no provider yet"),
    };
    expect(
      projectWorkspaceHeader(header, {
        roots: [
          { rootId: "root-a", name: "falryn", path: "/work/falryn" },
          { rootId: "root-b", name: "docs", path: "/work/docs" },
        ],
      }).workspace,
    ).toEqual(known("falryn +1"));
  });
});

describe("workspaceRootFacts", () => {
  test("marks the primary root", () => {
    const facts = workspaceRootFacts({
      roots: [
        { rootId: "root-a", name: "falryn", path: "/work/falryn" },
        { rootId: "root-b", name: "docs", path: "/work/docs" },
      ],
    });
    expect(facts[0]?.label).toBe("falryn (primary)");
    expect(facts[1]?.label).toBe("docs");
  });
});

describe("createWorkspaceController", () => {
  test("adds, saves, lists, loads, and refuses removing the primary", async () => {
    const fs = createInMemoryFileSystem({
      nodes: {
        "/work/falryn": { kind: "directory" },
        "/work/docs": { kind: "directory" },
        "/home/user/.falryn": { kind: "directory" },
      },
    });
    const controller = createWorkspaceController({
      fileSystem: fs,
      configurationRoot: localPath("/home/user/.falryn"),
      currentDirectory: localPath("/work/falryn"),
      initial: twoRootSet(),
    });

    expect(controller.initial.roots).toHaveLength(2);

    const removed = controller.removeRoot(controller.initial, "root-a");
    expect(removed.ok).toBe(false);
    if (!removed.ok) {
      expect(removed.error.code).toBe("primary-required");
    }

    const withoutDocs = controller.removeRoot(controller.initial, "root-b");
    expect(withoutDocs.ok).toBe(true);
    if (!withoutDocs.ok) {
      throw new Error("expected remove");
    }
    expect(withoutDocs.value.roots).toHaveLength(1);

    const saved = await controller.save(controller.initial, "falryn-app");
    expect(saved.ok).toBe(true);

    const listed = await controller.listLayouts();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.map((entry) => entry.name)).toContain("falryn-app");
    }

    const loaded = await controller.load("falryn-app");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.roots.map((root) => root.name).sort()).toEqual(["docs", "falryn"]);
    }
  });

  test("selects the configuration home lazily for layout reads and writes", async () => {
    const current = localPath("/home/user/.falryn");
    const legacy = localPath("/home/user/Library/Application Support/Falryn/config");
    const fs = createInMemoryFileSystem({
      nodes: {
        "/work/falryn": { kind: "directory" },
        "/work/docs": { kind: "directory" },
        "/home": { kind: "directory" },
        "/home/user": { kind: "directory" },
        "/home/user/.falryn": { kind: "directory" },
        "/home/user/Library": { kind: "directory" },
        "/home/user/Library/Application Support": { kind: "directory" },
        "/home/user/Library/Application Support/Falryn": { kind: "directory" },
        [legacy]: { kind: "directory" },
      },
    });
    const intents: Array<"read" | "write"> = [];
    const controller = createWorkspaceController({
      fileSystem: fs,
      configurationRoot: current,
      configurationRootFor: async (intent) => {
        intents.push(intent);
        return intent === "read" ? legacy : current;
      },
      currentDirectory: localPath("/work/falryn"),
      initial: twoRootSet(),
    });

    expect((await controller.listLayouts()).ok).toBe(true);
    expect((await controller.save(controller.initial, "falryn-app")).ok).toBe(true);
    expect(intents).toEqual(["read", "write"]);
  });
});
