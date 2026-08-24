import { describe, expect, test } from "bun:test";

import { formatNativeGitLog } from "./format.ts";
import { formatNativeGitShow } from "./show.ts";

const COMPLETE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@ project",
  " export function project() {",
  "-  return 'sample';",
  "+  const complete = true;",
  "+  return complete ? 'hush' : 'sample';",
  " }",
  "",
].join("\n");

describe("native Git log format", () => {
  test("keeps every commit and full message without a result cap", () => {
    const commits = Array.from({ length: 80 }, (_, index) => {
      const hash = (index + 1).toString(16).padStart(8, "0").padEnd(40, "0");
      return [
        `commit ${hash}`,
        `Author: Agent ${index + 1} <agent${index + 1}@example.com>`,
        "Date:   Mon Aug 24 06:34:25 2026 -0700",
        "",
        `    Preserve commit ${index + 1}`,
        "",
        `    Body fact ${index + 1}`,
      ].join("\n");
    }).join("\n\n");
    const formatted = formatNativeGitLog(`${commits}\n`);

    expect(formatted).not.toBeNull();
    expect(formatted).toContain("00000001 2026-08-24 Agent 1 | Preserve commit 1");
    expect(formatted).toContain("00000050 2026-08-24 Agent 80 | Preserve commit 80");
    expect(formatted).toContain("  Body fact 80");
    expect(formatted?.split(" | Preserve commit ")).toHaveLength(81);
    expect(formatted).not.toContain("omitted");
  });

  test("retains decorations, merge parents, and every message line", () => {
    const source = [
      "commit 1111111111111111111111111111111111111111 (HEAD -> main, tag: v1)",
      "Merge: 2222222 3333333",
      "Author: Falryn <falryn@example.com>",
      "Date:   Sat Aug 23 12:00:00 2026 -0700",
      "",
      "    Preserve complete context",
      "",
      "    Keep the design note.",
      "    Closes #736",
      "",
    ].join("\n");

    expect(formatNativeGitLog(source)).toBe(
      [
        "11111111 (HEAD -> main, tag: v1) 2026-08-23 Falryn | Preserve complete context",
        "  merge 2222222 3333333",
        "",
        "  Keep the design note.",
        "  Closes #736",
        "",
      ].join("\n"),
    );
  });

  test("refuses non-native, malformed, and partial commit shapes", () => {
    expect(formatNativeGitLog("1111111 subject\n")).toBeNull();
    expect(
      formatNativeGitLog(
        [
          "commit 1111111111111111111111111111111111111111",
          "Author: Falryn <falryn@example.com>",
          "Date:   unknown",
          "",
          "    subject",
        ].join("\n"),
      ),
    ).toBeNull();
    expect(
      formatNativeGitLog(
        [
          "commit 1111111111111111111111111111111111111111",
          "Author: Falryn <falryn@example.com>",
          "Date:   Sat Aug 23 12:00:00 2026 -0700",
          "",
          "    subject",
          "unexpected tail",
        ].join("\n"),
      ),
    ).toBeNull();
  });
});

describe("native Git show format", () => {
  test("compacts commit presentation and delegates the complete patch to git.diff", () => {
    const source = [
      "commit 1111111111111111111111111111111111111111",
      "Author: Falryn <falryn@example.com>",
      "Date:   Sat Aug 23 12:00:00 2026 -0700",
      "",
      "    Preserve complete context",
      "",
      COMPLETE_DIFF,
    ].join("\n");
    const formatted = formatNativeGitShow(source, ["HEAD", "--", "src/a.ts"]);

    expect(formatted).not.toBeNull();
    expect(formatted).toContain(
      "11111111 2026-08-23 Falryn | Preserve complete context\nsrc/a.ts:",
    );
    expect(formatted).toContain("1111111..2222222 100644");
    expect(formatted).toContain("@@ -1,3 +1,4 @@ project");
    expect(formatted).toContain(" export function project() {");
    expect(formatted).toContain("-  return 'sample';");
    expect(formatted).toContain("+  return complete ? 'hush' : 'sample';");
    expect(formatted).not.toContain("--- a/src/a.ts");
    expect(formatted).not.toContain("+++ b/src/a.ts");
  });

  test("compacts a requested complete diff stat without dropping a file", () => {
    const source = [
      "commit 1111111111111111111111111111111111111111",
      "Author: Falryn <falryn@example.com>",
      "Date:   Sat Aug 23 12:00:00 2026 -0700",
      "",
      "    Preserve complete context",
      "",
      " src/a.ts   | 3 ++-",
      " src/new.ts | 2 ++",
      " 2 files changed, 4 insertions(+), 1 deletion(-)",
      "",
    ].join("\n");

    expect(formatNativeGitShow(source, ["HEAD", "--stat"])).toBe(
      [
        "11111111 2026-08-23 Falryn | Preserve complete context",
        " src/a.ts   | 3 ++-",
        " src/new.ts | 2 ++",
        " 2 files changed, 4 insertions(+), 1 deletion(-)",
      ].join("\n"),
    );
  });

  test("refuses binary, combined, and unsupported show bodies", () => {
    const header = [
      "commit 1111111111111111111111111111111111111111",
      "Author: Falryn <falryn@example.com>",
      "Date:   Sat Aug 23 12:00:00 2026 -0700",
      "",
      "    subject",
      "",
    ].join("\n");
    expect(
      formatNativeGitShow(
        `${header}diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n`,
        ["HEAD"],
      ),
    ).toBeNull();
    expect(
      formatNativeGitShow(`${header}diff --cc src/a.ts\n@@@ -1,1 -1,1 +1,1 @@@\n`, ["HEAD"]),
    ).toBeNull();
    expect(formatNativeGitShow(`${header}M\tsrc/a.ts\n`, ["HEAD", "--name-status"])).toBeNull();
  });
});
