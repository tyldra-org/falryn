import { describe, expect, test } from "bun:test";

import { formatGitUnifiedDiff } from "./format.ts";

const COMPLETE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@ export function configure() {",
  " export function configure() {",
  "-  const mode = 'sample';",
  "+  const mode = 'complete';",
  "   const marker = 736;",
  "+  const exact = true;",
  "   return mode;",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+export const complete = true;",
  "+export const reducer = 'git.diff';",
  "",
].join("\n");

describe("Git unified diff format", () => {
  test("removes only validated duplicate path headers", () => {
    expect(formatGitUnifiedDiff(COMPLETE_DIFF)).toBe(
      [
        "src/a.ts:",
        "index 1111111..2222222 100644",
        "@@ -1,4 +1,5 @@ export function configure() {",
        " export function configure() {",
        "-  const mode = 'sample';",
        "+  const mode = 'complete';",
        "   const marker = 736;",
        "+  const exact = true;",
        "   return mode;",
        "",
        "src/new.ts:",
        "new file mode 100644",
        "index 0000000..3333333",
        "@@ -0,0 +1,2 @@",
        "+export const complete = true;",
        "+export const reducer = 'git.diff';",
        "",
      ].join("\n"),
    );
  });

  test("keeps rename and mode-only metadata without inventing a hunk", () => {
    expect(
      formatGitUnifiedDiff(
        [
          "diff --git a/src/old.ts b/src/new.ts",
          "similarity index 100%",
          "rename from src/old.ts",
          "rename to src/new.ts",
          "diff --git a/script.sh b/script.sh",
          "old mode 100644",
          "new mode 100755",
        ].join("\n"),
      ),
    ).toBe(
      [
        "src/old.ts → src/new.ts:",
        "similarity index 100%",
        "rename from src/old.ts",
        "rename to src/new.ts",
        "",
        "script.sh:",
        "old mode 100644",
        "new mode 100755",
      ].join("\n"),
    );
  });

  test("retains every context and changed line without an item-count cap", () => {
    const removed = Array.from({ length: 80 }, (_, index) => `-before-${index + 1}`);
    const added = Array.from({ length: 80 }, (_, index) => `+after-${index + 1}`);
    const source = [
      "diff --git a/large.txt b/large.txt",
      "index 1111111..2222222 100644",
      "--- a/large.txt",
      "+++ b/large.txt",
      "@@ -1,82 +1,82 @@ section",
      " context-before",
      ...removed,
      ...added,
      " context-after",
    ].join("\n");
    const formatted = formatGitUnifiedDiff(source);

    expect(formatted).not.toBeNull();
    expect(formatted).toContain(" context-before");
    expect(formatted).toContain("-before-80");
    expect(formatted).toContain("+after-80");
    expect(formatted).toContain(" context-after");
    expect(formatted?.split("\n")).toHaveLength(165);
  });

  test("refuses malformed, mismatched, binary, combined, and quoted shapes", () => {
    expect(formatGitUnifiedDiff(COMPLETE_DIFF.replace("@@ -1,4 +1,5", "@@ -1,5 +1,5"))).toBeNull();
    expect(
      formatGitUnifiedDiff(COMPLETE_DIFF.replace("--- a/src/a.ts", "--- a/src/b.ts")),
    ).toBeNull();
    expect(
      formatGitUnifiedDiff(
        [
          "diff --git a/image.png b/image.png",
          "index 1111111..2222222 100644",
          "Binary files a/image.png and b/image.png differ",
        ].join("\n"),
      ),
    ).toBeNull();
    expect(
      formatGitUnifiedDiff(
        [
          "diff --git a/file.ts b/file.ts",
          "index 1111111..2222222 100644",
          "--- a/file.ts",
          "+++ b/file.ts",
          "@@@ -1,1 -1,1 +1,1 @@@",
          "++new",
        ].join("\n"),
      ),
    ).toBeNull();
    expect(formatGitUnifiedDiff('diff --git "a/file name.ts" "b/file name.ts"')).toBeNull();
  });
});
