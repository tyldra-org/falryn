import { describe, expect, test } from "bun:test";

import { compactTreeOutput } from "./format.ts";
import { shouldPruneDefaultTreeNoise } from "./policy.ts";

describe("semantic tree format", () => {
  test("preserves every visible entry instead of sampling the first 32 lines", () => {
    const entries = Array.from({ length: 48 }, (_, index) => `|-- file-${index}.ts`);
    const source = ["workspace", ...entries, "", "0 directories, 48 files", ""].join("\n");

    const projected = compactTreeOutput(source, { pruneNoise: false });

    expect(projected.split("\n").filter(Boolean)).toHaveLength(49);
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
      [
        "workspace",
        "`-- [drwxr-xr-x]  ./workspace/src/",
        "    `-- [rw-r--r--]  ./workspace/src/main.ts",
        "",
      ].join("\n"),
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
});
