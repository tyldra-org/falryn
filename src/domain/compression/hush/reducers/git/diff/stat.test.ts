import { describe, expect, test } from "bun:test";

import { formatGitDiffStat } from "./stat.ts";

describe("Git diff stat format", () => {
  test("removes only the redundant terminal newline from complete stat output", () => {
    const source = [
      " src/a.ts   | 3 ++-",
      " src/new.ts | 2 ++",
      " 2 files changed, 4 insertions(+), 1 deletion(-)",
      "",
    ].join("\n");
    expect(formatGitDiffStat(source)).toBe(
      [
        " src/a.ts   | 3 ++-",
        " src/new.ts | 2 ++",
        " 2 files changed, 4 insertions(+), 1 deletion(-)",
      ].join("\n"),
    );
    expect(formatGitDiffStat("3 files changed, 10 insertions(+), 2 deletions(-)\n")).toBe(
      "3 files changed, 10 insertions(+), 2 deletions(-)",
    );
  });

  test("refuses non-stat and unterminated output", () => {
    expect(formatGitDiffStat("M\tsrc/a.ts\n")).toBeNull();
    expect(formatGitDiffStat("1 file changed, 1 insertion(+)")).toBeNull();
  });
});
