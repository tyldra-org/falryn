import { describe, expect, test } from "bun:test";

import { compactTreeOutput, treeEntryFacts } from "./format.ts";
import { shouldPruneDefaultTreeNoise } from "./policy.ts";

describe("semantic tree format", () => {
  test("preserves every visible entry instead of sampling the first 32 lines", () => {
    const entries = Array.from({ length: 48 }, (_, index) => `|-- file-${index}.ts`);
    const source = ["workspace", ...entries, "", "0 directories, 48 files", ""].join("\n");

    const projected = compactTreeOutput(source, { pruneNoise: false });

    expect(projected.split("\n").filter(Boolean)).toHaveLength(50);
    expect(projected).toStartWith("workspace/\n./:\n");
    for (let index = 0; index < 48; index += 1) {
      expect(projected).toContain(`file-${index}.ts`);
    }
    expect(projected).not.toContain("directories");
  });

  test("removes a default noise subtree without dropping its following sibling", () => {
    const source = [
      "workspace",
      "|-- node_modules",
      "|   |-- package-a",
      "|   `-- package-b",
      "|-- src",
      "|   `-- main.ts",
      "`-- package.json",
      "",
      "3 directories, 4 files",
      "",
    ].join("\n");

    expect(compactTreeOutput(source, { pruneNoise: true })).toBe(
      ["workspace", "|-- src", "|   `-- main.ts", "`-- package.json", ""].join("\n"),
    );
  });

  test("recognizes full paths, metadata, ASCII branches, and egg-info noise", () => {
    const source = [
      "workspace",
      "|-- [drwxr-xr-x]  ./workspace/cache.egg-info/",
      "|   `-- [rw-r--r--]  ./workspace/cache.egg-info/PKG-INFO",
      "`-- [drwxr-xr-x]  ./workspace/src/",
      "    `-- [rw-r--r--]  ./workspace/src/main.ts",
      "",
    ].join("\n");

    expect(compactTreeOutput(source, { pruneNoise: true })).toBe(
      ["workspace/", "./:", "  [drwxr-xr-x] src/", "src/:", "  [rw-r--r--] main.ts", ""].join("\n"),
    );
  });

  test("keeps unrecognized lines and internal spacing intact", () => {
    const source = "workspace\ncustom renderer line\n\nnext section\n";
    expect(compactTreeOutput(source, { pruneNoise: true })).toBe(source);
  });

  test("respects show-all and caller-owned ignore options", () => {
    expect(shouldPruneDefaultTreeNoise(["tree"])).toBe(true);
    expect(shouldPruneDefaultTreeNoise(["tree", "-L", "3"])).toBe(true);
    expect(shouldPruneDefaultTreeNoise(["tree", "-a"])).toBe(false);
    expect(shouldPruneDefaultTreeNoise(["tree", "--all"])).toBe(false);
    expect(shouldPruneDefaultTreeNoise(["tree", "-I", "vendor"])).toBe(false);
    expect(shouldPruneDefaultTreeNoise(["tree", "--ignore=vendor"])).toBe(false);
  });

  test("normalizes an empty tree like the baseline filter", () => {
    expect(compactTreeOutput("", { pruneNoise: true })).toBe("\n");
  });

  test("preserves the same model-facing facts in native and Hush formats", () => {
    const native = [
      "workspace",
      "|-- [drwxr-xr-x]  src",
      "|   `-- [-rw-r--r--]  main.ts",
      "`-- current -> src",
      "",
    ].join("\n");
    const hush = compactTreeOutput(native, { pruneNoise: false });

    expect(hush).toBe(
      [
        "workspace/",
        "./:",
        "  [drwxr-xr-x] src/",
        "  current -> src",
        "src/:",
        "  [-rw-r--r--] main.ts",
        "",
      ].join("\n"),
    );
    expect(treeEntryFacts(hush)).toEqual(treeEntryFacts(native));
  });

  test("marks depth-limited entries as directories for tree -d", () => {
    const source = ["workspace", "`-- leaf", ""].join("\n");
    expect(treeEntryFacts(source, { directoriesOnly: true })).toEqual([
      '[".","directory",[],null,"workspace"]',
      '["leaf","directory",[],"",null,0]',
    ]);
  });

  test("keeps tree -F classification markers", () => {
    const files = Array.from(
      { length: 20 },
      (_, index) => `|   ${index === 19 ? "`--" : "|--"} run-${index}*`,
    );
    const source = ["workspace", "|-- app/", ...files, "`-- current@ -> app", ""].join("\n");
    const projected = compactTreeOutput(source, { pruneNoise: false });

    expect(projected).toContain("  app/");
    expect(projected).toContain("  run-0*");
    expect(projected).toContain("  current@ -> app");
    expect(treeEntryFacts(projected)).toEqual(treeEntryFacts(source));
  });

  test("keeps the native shape when a semantic form would cost more context", () => {
    const source = ["workspace", "`-- README.md", ""].join("\n");
    expect(compactTreeOutput(source, { pruneNoise: false })).toBe(source);
  });

  test("keeps the requested root path while compacting tree -f output", () => {
    const files = Array.from({ length: 20 }, (_, index) => `|-- /tmp/workspace/file-${index}.ts`);
    const source = ["/tmp/workspace", ...files, ""].join("\n");
    const projected = compactTreeOutput(source, { pruneNoise: false });

    expect(projected).toStartWith("/tmp/workspace/\n./:\n");
    expect(treeEntryFacts(projected)).toEqual(treeEntryFacts(source));
  });
});
