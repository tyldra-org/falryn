import { describe, expect, test } from "bun:test";

import {
  configurationGeneration,
  createWorkspaceSet,
  documentUriUnderRoot,
  languageServerFoldersFromWorkspaceSet,
  localPath,
  localPathToFileUri,
  rootIdForDocumentUri,
  shouldSyncLanguageServerFolders,
  workspaceRootId,
  workspaceSetFolderChange,
} from "./index.ts";

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

describe("localPathToFileUri", () => {
  test("encodes a posix absolute path", () => {
    expect(localPathToFileUri(localPath("/work/falryn"))).toBe("file:///work/falryn");
  });

  test("percent-encodes path segments that need it", () => {
    expect(localPathToFileUri(localPath("/work/my project"))).toBe("file:///work/my%20project");
  });
});

describe("languageServerFoldersFromWorkspaceSet", () => {
  test("maps each root to an LSP folder in primary-first order", () => {
    const folders = languageServerFoldersFromWorkspaceSet(twoRootSet());
    expect(folders).toEqual({
      ok: true,
      value: [
        { uri: "file:///work/falryn", name: "falryn" },
        { uri: "file:///work/docs", name: "docs" },
      ],
    });
  });
});

describe("workspaceSetFolderChange", () => {
  test("returns null when the folder list is unchanged", () => {
    const set = twoRootSet();
    expect(workspaceSetFolderChange(set, set)).toEqual({ ok: true, value: null });
  });

  test("adds and removes roots by URI", () => {
    const previous = twoRootSet();
    const next = createWorkspaceSet([
      { rootId: rootA, name: "falryn", path: localPath("/work/falryn") },
      {
        rootId: workspaceRootId.from("root-c"),
        name: "extra",
        path: localPath("/work/extra"),
      },
    ]);
    expect(next.ok).toBe(true);
    if (!next.ok) {
      return;
    }
    expect(workspaceSetFolderChange(previous, next.value)).toEqual({
      ok: true,
      value: {
        added: [{ uri: "file:///work/extra", name: "extra" }],
        removed: [{ uri: "file:///work/docs", name: "docs" }],
      },
    });
  });

  test("treats a null previous set as all additions", () => {
    expect(workspaceSetFolderChange(null, twoRootSet())).toEqual({
      ok: true,
      value: {
        added: [
          { uri: "file:///work/falryn", name: "falryn" },
          { uri: "file:///work/docs", name: "docs" },
        ],
        removed: [],
      },
    });
  });
});

describe("rootIdForDocumentUri", () => {
  test("attributes a document under the matching root", () => {
    const set = twoRootSet();
    expect(rootIdForDocumentUri("file:///work/falryn/src/a.ts", set)).toEqual({
      ok: true,
      value: rootA,
    });
    expect(rootIdForDocumentUri("file:///work/docs/README.md", set)).toEqual({
      ok: true,
      value: rootB,
    });
  });

  test("refuses documents outside every root", () => {
    expect(rootIdForDocumentUri("file:///tmp/other/a.ts", twoRootSet())).toEqual({
      ok: false,
      error: { code: "unscoped" },
    });
  });

  test("builds document URIs under a root", () => {
    const set = twoRootSet();
    const primary = set.roots[0];
    expect(primary).toBeDefined();
    if (primary === undefined) {
      return;
    }
    expect(documentUriUnderRoot(primary, "src/main.ts")).toBe("file:///work/falryn/src/main.ts");
  });
});

describe("shouldSyncLanguageServerFolders", () => {
  test("resyncs when the configuration generation changes", () => {
    const set = twoRootSet();
    expect(
      shouldSyncLanguageServerFolders(
        { set, configurationGeneration: configurationGeneration.from(1) },
        { set, configurationGeneration: configurationGeneration.from(2) },
      ),
    ).toBe(true);
  });

  test("skips when set and generation are unchanged", () => {
    const set = twoRootSet();
    const snap = { set, configurationGeneration: configurationGeneration.from(1) };
    expect(shouldSyncLanguageServerFolders(snap, snap)).toBe(false);
  });
});
