import type { ProjectionCase } from "../../hush-projection-case.ts";

export const GIT_LOG_CASES: readonly ProjectionCase[] = [
  {
    id: "git-log",
    projection: "git-log",
    executable: "git",
    argv: ["log", "-3"],
    rtkArgv: ["git", "log", "-3"],
    requiredMarkers: [
      "11111111 2026-08-23 Falryn | Preserve complete context",
      "Keep every requested commit.",
      "22222222 2026-08-24 Context Agent | Keep every message fact",
      "33333333 2026-08-24 Review Agent | Keep the final commit",
    ],
    forbiddenMarkers: ["Author:", "Date:", "commit 1111111", "omitted", "…"],
  },
  {
    id: "git-show",
    projection: "git-log",
    executable: "git",
    argv: ["show", "HEAD", "--", "src/a.ts", "src/new.ts"],
    rtkArgv: ["git", "show", "HEAD", "--", "src/a.ts", "src/new.ts"],
    requiredMarkers: [
      "11111111 2026-08-23 Falryn | Preserve complete context",
      "Keep every requested commit.",
      "src/a.ts:",
      "1111111..2222222 100644",
      "@@ -1,4 +1,5 @@ export function configure()",
      " export function configure()",
      "mode = 'sample'",
      "mode = 'complete'",
      "const marker = 736",
      "const exact = true",
      "return mode",
      "src/new.ts:",
      "new 100644",
      "0000000..3333333",
      "export const complete = true",
      "export const reducer = 'git.show'",
    ],
    forbiddenMarkers: ["Author:", "Date:", "--- a/", "+++ b/", "omitted", "…"],
  },
];
