import { describe, expect, test } from "bun:test";

import { compactInodeBlockLs } from "./block-format.ts";
import { compactLongLs } from "./long-format.ts";

describe("semantic ls formats", () => {
  test("groups repeated long metadata while preserving every entry", () => {
    const source = [
      "total 24",
      "drwxr-xr-x@  6 user  staff    192 Aug 23 04:09 .",
      "drwx------@  4 user  staff    128 Aug 23 04:09 ..",
      "drwxr-xr-x@ 27 user  staff    864 Aug 23 04:09 src",
      "-rw-r--r--@  1 user  staff   2380 Aug 23 04:09 package.json",
      "-rwxr-xr-x   1 user  staff      1 Aug 23 04:09 verify",
      "lrwxr-xr-x   1 user  staff      3 Aug 23 04:09 current -> src",
      "",
    ].join("\n");

    expect(compactLongLs(source)).toBe(
      [
        "dirs 755 (1):",
        "src/",
        "files 644 (1):",
        "package.json 2.3K",
        "files 755 (1):",
        "verify 1B",
        "links 755 (1):",
        "current -> src 3B",
      ].join("\n"),
    );
  });

  test("keeps multi-path section context", () => {
    const source = [
      "app:",
      "total 8",
      "-rw-r--r-- 1 user staff 10 Aug 23 04:09 README.md",
      "",
      "src:",
      "total 0",
      "drwxr-xr-x 2 user staff 64 Aug 23 04:09 domain",
      "",
    ].join("\n");

    expect(compactLongLs(source)).toBe(
      ["app:", "files 644 (1):", "README.md 10B", "src:", "dirs 755 (1):", "domain/"].join("\n"),
    );
  });

  test("represents an empty long listing without navigation noise", () => {
    const source = [
      "total 0",
      "drwxr-xr-x 2 user staff 64 Aug 23 04:09 .",
      "drwxr-xr-x 4 user staff 128 Aug 23 04:09 ..",
      "",
    ].join("\n");

    expect(compactLongLs(source)).toBe("(empty)");
  });

  test("groups block counts without retaining inode noise", () => {
    const source = [
      "total 32",
      "33079495 8 README.md",
      "33079460 8 file with spaces.txt",
      "33079468 16 bundle.bin",
      "",
    ].join("\n");

    expect(compactInodeBlockLs(source)).toBe(
      [
        "blocks total=32",
        "8 blocks (2):",
        "README.md",
        "file with spaces.txt",
        "16 blocks (1):",
        "bundle.bin",
      ].join("\n"),
    );
  });

  test("declines unknown shapes instead of guessing", () => {
    expect(compactLongLs("not a portable long row\n")).toBeNull();
    expect(compactInodeBlockLs("123 file.txt\n")).toBeNull();
  });
});
