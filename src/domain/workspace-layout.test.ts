import { describe, expect, test } from "bun:test";

import { localPath } from "./filesystem.ts";
import { workspaceRootId } from "./identity.ts";
import {
  describeWorkspaceLayoutDocumentError,
  layoutNameFromFileName,
  MAX_WORKSPACE_LAYOUT_CATALOG,
  parseWorkspaceLayoutDocument,
  queryWorkspaceLayoutCatalog,
  serializeWorkspaceLayout,
  WORKSPACE_LAYOUT_VERSION,
  workspaceLayoutFromSet,
  workspaceLayoutName,
  workspaceSetFromLayout,
} from "./workspace-layout.ts";
import { createWorkspaceSet } from "./workspace-set.ts";

const rootA = workspaceRootId.from("root-a");
const rootB = workspaceRootId.from("root-b");

function sampleSet() {
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

describe("workspaceLayoutName", () => {
  test("accepts profile-shaped names and refuses separators", () => {
    expect(workspaceLayoutName.parse("falryn-app").ok).toBe(true);
    expect(workspaceLayoutName.parse("with/slash").ok).toBe(false);
    expect(workspaceLayoutName.parse("")).toEqual({
      ok: false,
      error: {
        kind: "identity",
        code: "identifier-empty",
        identity: "workspaceLayoutName",
      },
    });
  });
});

describe("workspace layout documents", () => {
  test("round-trips a set through serialize and parse", () => {
    const name = workspaceLayoutName.from("falryn-app");
    const layout = workspaceLayoutFromSet(name, sampleSet());
    expect(layout.ok).toBe(true);
    if (!layout.ok) {
      throw new Error("expected layout");
    }
    const text = serializeWorkspaceLayout(layout.value);
    expect(text).toContain(WORKSPACE_LAYOUT_VERSION);
    const parsed = parseWorkspaceLayoutDocument(JSON.parse(text), name);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected parse");
    }
    const set = workspaceSetFromLayout(parsed.value);
    expect(set.ok).toBe(true);
    if (!set.ok) {
      throw new Error("expected set");
    }
    expect(set.value.roots.map((root) => root.name)).toEqual(["falryn", "docs"]);
  });

  test("refuses a filename and document name mismatch", () => {
    const layout = workspaceLayoutFromSet(workspaceLayoutName.from("saved"), sampleSet());
    expect(layout.ok).toBe(true);
    if (!layout.ok) {
      throw new Error("expected layout");
    }
    expect(
      parseWorkspaceLayoutDocument(
        JSON.parse(serializeWorkspaceLayout(layout.value)),
        workspaceLayoutName.from("other"),
      ),
    ).toEqual({ ok: false, error: { code: "name-mismatch" } });
  });

  test("derives layout names from file names", () => {
    expect(layoutNameFromFileName("falryn-app.jsonc")).toBe(workspaceLayoutName.from("falryn-app"));
    expect(layoutNameFromFileName("bad/name.jsonc")).toBeNull();
    expect(layoutNameFromFileName("readme.md")).toBeNull();
  });

  test("bounds a catalog and names the expansion route", () => {
    const entries = Array.from({ length: 5 }, (_, index) => ({
      name: workspaceLayoutName.from(`layout-${index}`),
      rootCount: 1,
    }));
    const catalog = queryWorkspaceLayoutCatalog(entries, 2);
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) {
      throw new Error("expected catalog");
    }
    expect(catalog.value.layouts).toHaveLength(2);
    expect(catalog.value.omitted).toBe(3);
    expect(catalog.value.expansion).toBe(`workspace list --limit ${MAX_WORKSPACE_LAYOUT_CATALOG}`);
  });

  test("describes document errors", () => {
    expect(describeWorkspaceLayoutDocumentError({ code: "name-mismatch" })).toBe("name-mismatch");
    expect(describeWorkspaceLayoutDocumentError({ code: "malformed", field: "roots" })).toBe(
      "malformed:roots",
    );
  });
});
