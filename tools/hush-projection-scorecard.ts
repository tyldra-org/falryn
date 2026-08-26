/** Compare every non-ls/tree Hush projection with pinned RTK on controlled output. */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareHushCaptureRequest } from "../src/application/hush-capture-command.ts";
import type { HushProjectionKind } from "../src/domain/hush/catalog/index.ts";
import { classifyCommand } from "../src/domain/hush/classification.ts";
import {
  duration,
  HUSH_REDUCER_VERSION,
  instant,
  MAX_COMMAND_OUTPUT_BYTES,
  type ProcessCaptureReport,
  processCaptureId,
  reduceHush,
} from "../src/domain/index.ts";
import { HUSH_RTK_BASELINE } from "./hush-command-coverage.ts";
import { type HushLsMeasurement, measureText } from "./hush-ls-scorecard.ts";

export const HUSH_PROJECTION_CORPUS_VERSION = "hush-projections.v27";

export const HUSH_FIND_LISTING_PATHS = [
  "bounds.ts",
  "catalog/contracts.ts",
  "catalog/files.ts",
  "catalog/index.ts",
  "catalog/javascript.ts",
  "catalog/languages.ts",
  "catalog/operations.ts",
  "catalog/version-control.ts",
  "classification.ts",
  "command-shape.ts",
  "contracts.ts",
  "git-command.test.ts",
  "git-command.ts",
  "github-command.ts",
  "reducers/compound/projection.test.ts",
  "reducers/compound/projection.ts",
  "reducers/forge/github/format.test.ts",
  "reducers/forge/github/issue-list.ts",
  "reducers/forge/github/json.ts",
  "reducers/forge/github/pr-list.ts",
  "reducers/forge/github/pr-view.ts",
  "reducers/forge/github/projection.ts",
  "reducers/forge/github/run-list.ts",
  "reducers/forge/projection.test.ts",
  "reducers/forge/projection.ts",
  "reducers/git/diff.ts",
  "reducers/git/index.ts",
  "reducers/git/mutation.ts",
  "reducers/git/mutation/add.ts",
  "reducers/git/mutation/commit.ts",
  "reducers/git/mutation/pull.ts",
  "reducers/git/mutation/push.ts",
  "reducers/git/mutation/shared.ts",
  "reducers/git/paths.ts",
  "reducers/git/status.ts",
  "reducers/http/curl.ts",
  "reducers/http/progress.ts",
  "reducers/http/wget.ts",
  "reducers/index.ts",
  "reducers/json/format.test.ts",
  "reducers/json/format.ts",
  "reducers/json/projection.ts",
  "reducers/listing.ts",
  "reducers/listing/format.test.ts",
  "reducers/listing/format.ts",
  "reducers/lossless-text.ts",
  "reducers/ls/block-format.ts",
  "reducers/ls/format.test.ts",
  "reducers/ls/long-format.ts",
  "reducers/ls/projection.ts",
  "reducers/search/format.test.ts",
  "reducers/search/format.ts",
  "reducers/search/projection.ts",
  "reducers/semantic.ts",
  "reducers/structured/projection.ts",
  "reducers/table/format.ts",
  "reducers/table/projection.ts",
  "reducers/transform/projection.ts",
  "reducers/tree/format.test.ts",
  "reducers/tree/format.ts",
  "reducers/tree/parser.ts",
  "reducers/tree/policy.ts",
  "reducers/tree/projection.ts",
  "reducers/tree/render.ts",
  "shell-command.test.ts",
  "shell-command.ts",
  "text-format.ts",
] as const;

const HUSH_FIND_LISTING_MARKERS = [
  "67 files (*.ts)",
  "./ bounds classification command-shape contracts git-command git-command.test github-command shell-command shell-command.test text-format",
  "catalog/ contracts files index javascript languages operations version-control",
  "reducers/ index listing lossless-text semantic",
  " compound/ projection projection.test",
  " forge/ projection projection.test",
  "  github/ format.test issue-list json pr-list pr-view projection run-list",
  " git/ diff index mutation paths status",
  "  mutation/ add commit pull push shared",
  " http/ curl progress wget",
  " json/ format format.test projection",
  " listing/ format format.test",
  " ls/ block-format format.test long-format projection",
  " search/ format format.test projection",
  " structured/ projection",
  " table/ format projection",
  " transform/ projection",
  " tree/ format format.test parser policy projection render",
] as const;

type ProjectionCase = Readonly<{
  id: string;
  projection: HushProjectionKind;
  executable: string;
  argv: readonly string[];
  rtkArgv?: readonly string[];
  shellCommand?: string;
  baseline?: "raw" | "rewrite" | "rtk-log";
  competitiveTarget?: "tie" | "win";
  acceptedExitCodes?: readonly number[];
  requiredMarkers: readonly string[];
  forbiddenMarkers?: readonly string[];
}>;

export const HUSH_PROJECTION_CASES = [
  {
    id: "listing-find",
    projection: "listing",
    executable: "find",
    argv: ["corpus/src/domain/hush", "-type", "f"],
    rtkArgv: ["find", "corpus/src/domain/hush", "-type", "f"],
    requiredMarkers: HUSH_FIND_LISTING_MARKERS,
    forbiddenMarkers: ["+17 more", "omitted", "…"],
  },
  {
    id: "read-cat",
    projection: "read",
    executable: "cat",
    argv: ["fixture.txt"],
    rtkArgv: ["read", "fixture.txt"],
    requiredMarkers: ["# Falryn", "Do more with less context.", "Keep every useful fact."],
  },
  {
    id: "json-structure",
    projection: "json",
    executable: "json",
    argv: ["config.json"],
    rtkArgv: ["json", "--keys-only", "config.json"],
    requiredMarkers: ["serviceName", "enabled", "targets", "arch", "os", "metadata", "ports"],
    forbiddenMarkers: [
      "falryn-private-value",
      "darwin-private",
      "arm64-private",
      "owner-private",
      "3000",
    ],
  },
  {
    id: "data-psql-table",
    projection: "structured",
    executable: "psql",
    argv: ["-c", "select id, task, status, token_savings from work_items order by id"],
    rtkArgv: ["psql", "-c", "select id, task, status, token_savings from work_items order by id"],
    requiredMarkers: [
      "id\ttask\tstatus\ttoken_savings",
      "1\tOptimize nested JSON\tdone\t32",
      "2\tPreserve database rows\tactive\t0",
      "3\tVerify model context\tpending\t18",
    ],
    forbiddenMarkers: ["----+", "(3 rows)", "omitted", "…"],
  },
  {
    id: "data-psql-expanded",
    projection: "structured",
    executable: "psql",
    argv: ["-x", "-c", "select id, task, status from work_items order by id"],
    rtkArgv: ["psql", "-x", "-c", "select id, task, status from work_items order by id"],
    requiredMarkers: [
      "record\tid\ttask\tstatus",
      "1\t101\tInvestigate latency\tactive",
      "2\t102\tVerify recovery\tdone",
    ],
    forbiddenMarkers: ["-[ RECORD", "(2 rows)", "omitted", "…"],
  },
  {
    id: "data-sqlite-column",
    projection: "structured",
    executable: "sqlite3",
    argv: ["-header", "-column", ":memory:", "select id, task, status from work_items"],
    rtkArgv: [
      "sqlite3",
      "-header",
      "-column",
      ":memory:",
      "select id, task, status from work_items",
    ],
    requiredMarkers: ["id\ttask\tstatus", "1\tOptimize JSON\tdone", "2\tPreserve rows\tactive"],
    forbiddenMarkers: ["-------------", "omitted", "…"],
  },
  {
    id: "data-sqlite-box",
    projection: "structured",
    executable: "sqlite3",
    argv: ["-header", "-box", ":memory:", "select id, task, status from work_items"],
    rtkArgv: ["sqlite3", "-header", "-box", ":memory:", "select id, task, status from work_items"],
    requiredMarkers: ["id\ttask\tstatus", "1\tOptimize JSON\tdone", "2\tPreserve rows\tactive"],
    forbiddenMarkers: ["┌", "│", "└", "omitted", "…"],
  },
  {
    id: "data-sqlite-line",
    projection: "structured",
    executable: "sqlite3",
    argv: ["-line", ":memory:", "select id, task, status from work_items"],
    rtkArgv: ["sqlite3", "-line", ":memory:", "select id, task, status from work_items"],
    requiredMarkers: [
      "record\tid\ttask\tstatus",
      "1\t1\tOptimize JSON\tdone",
      "2\t2\tPreserve rows\tactive",
    ],
    forbiddenMarkers: [" = ", "omitted", "…"],
  },
  {
    id: "system-df",
    projection: "table",
    executable: "df",
    argv: ["-h", "."],
    rtkArgv: ["df", "-h", "."],
    requiredMarkers: [
      "filesystem\tsize\tused\tavail\tcapacity\tiused\tifree\tiused%\tmounted",
      "/dev/disk3s5\t460Gi\t147Gi\t290Gi\t34%\t1.7M\t3.0G\t0%\t/System/Volumes/Data",
    ],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "system-du",
    projection: "table",
    executable: "du",
    argv: ["-sh", "."],
    rtkArgv: ["du", "-sh", "."],
    requiredMarkers: ["319M\t."],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "system-ps",
    projection: "table",
    executable: "ps",
    argv: ["-p", "49114", "-o", "pid,ppid,state,comm"],
    rtkArgv: ["ps", "-p", "49114", "-o", "pid,ppid,state,comm"],
    requiredMarkers: ["PID\tPPID\tSTAT\tCOMM", "49114\t41183\tSs\tbun"],
    forbiddenMarkers: ["PPID STAT", "omitted", "…"],
  },
  {
    id: "system-stat",
    projection: "table",
    executable: "stat",
    argv: ["-x", "package.json"],
    rtkArgv: ["stat", "-x", "package.json"],
    requiredMarkers: [
      '"package.json" 2527B Regular File',
      "dev=1,15 inode=32125206 links=1",
      "birth=Fri Aug 21 19:55:14",
    ],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "system-systemctl",
    projection: "table",
    executable: "systemctl",
    argv: ["status", "falryn"],
    rtkArgv: ["systemctl", "status", "falryn"],
    requiredMarkers: [
      "● falryn.service - Falryn agent",
      "Active: active (running)",
      "Main PID: 736 (falryn)",
      "└─736 /usr/local/bin/falryn",
    ],
    forbiddenMarkers: ["     Loaded", "omitted", "…"],
  },
  {
    id: "search-rg",
    projection: "search",
    executable: "rg",
    argv: ["marker", "."],
    rtkArgv: ["rg", "marker", "."],
    requiredMarkers: ["first marker", "second marker", "third marker", "fourth marker"],
  },
  {
    id: "transform-sed",
    projection: "transform",
    executable: "sed",
    argv: ["-n", "1,3p", "fixture.txt"],
    baseline: "raw",
    requiredMarkers: ["# Falryn", "Do more with less context."],
  },
  {
    id: "compound-rg-sed-pipe",
    projection: "compound",
    executable: "bash",
    argv: [],
    shellCommand: "rg marker . | sed -n '1,3p'",
    baseline: "rewrite",
    requiredMarkers: ["first marker", "second marker", "third marker"],
    forbiddenMarkers: ["fourth marker", "omitted", "…"],
  },
  {
    id: "compound-pipe-rg",
    projection: "compound",
    executable: "bash",
    argv: [],
    shellCommand: "cat fixture.txt | rg marker",
    baseline: "rewrite",
    requiredMarkers: ["first marker", "second marker", "third marker", "fourth marker"],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "compound-rg-and-sed",
    projection: "compound",
    executable: "bash",
    argv: [],
    shellCommand: "rg marker . && sed -n '1,3p' fixture.txt",
    baseline: "rewrite",
    requiredMarkers: [
      "first marker",
      "second marker",
      "third marker",
      "fourth marker",
      "# Falryn",
      "Do more with less context.",
    ],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "git-status",
    projection: "git-status",
    executable: "git",
    argv: ["status", "--short", "--branch"],
    rtkArgv: ["git", "status", "--short", "--branch"],
    requiredMarkers: [
      "main",
      "src/domain/hush.ts",
      "reducers/semantic.ts",
      "hush-projection-scorecard.ts",
    ],
  },
  {
    id: "git-diff",
    projection: "git-diff",
    executable: "git",
    argv: ["diff"],
    rtkArgv: ["git", "diff"],
    requiredMarkers: [
      "src/a.ts:",
      "1111111..2222222 100644",
      "@@ -1,4 +1,5 @@ export function configure()",
      " export function configure()",
      "mode = 'sample'",
      "mode = 'complete'",
      "marker = 736",
      "const exact = true",
      "return mode",
      "src/new.ts:",
      "new 100644",
      "0000000..3333333",
      "export const complete = true",
      "reducer = 'git.diff'",
    ],
    forbiddenMarkers: ["--- a/", "+++ b/", "omitted", "…"],
  },
  {
    id: "git-diff-stat",
    projection: "git-diff",
    executable: "git",
    argv: ["diff", "--stat"],
    rtkArgv: ["git", "diff", "--stat"],
    requiredMarkers: [
      "src/a.ts   | 3 ++-",
      "src/new.ts | 2 ++",
      "2 files changed, 4 insertions(+), 1 deletion(-)",
    ],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "git-diff-name-status",
    projection: "git-diff",
    executable: "git",
    argv: ["diff", "--name-status"],
    rtkArgv: ["git", "diff", "--name-status"],
    requiredMarkers: ["M\tsrc/a.ts", "A\tsrc/new.ts"],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "git-diff-large-complete",
    projection: "git-diff",
    executable: "git",
    argv: ["diff", "--", "src/large.ts"],
    rtkArgv: ["git", "diff", "--no-compact", "--", "src/large.ts"],
    requiredMarkers: [
      "src/large.ts:",
      "@@ -1,82 +1,82 @@ complete section",
      " context-before",
      "-before-1",
      "-before-80",
      "+after-1",
      "+after-80",
      " context-after",
    ],
    forbiddenMarkers: ["more changes truncated", "lines truncated", "omitted", "…"],
  },
  {
    id: "external-diff",
    projection: "git-diff",
    executable: "diff",
    argv: ["-u", "diff-before.ts", "diff-after.ts"],
    rtkArgv: ["diff", "diff-before.ts", "diff-after.ts"],
    acceptedExitCodes: [1],
    requiredMarkers: [
      "diff-before.ts -> diff-after.ts",
      "@@ -1,5 +1,6 @@",
      'const mode = "sample"',
      'const mode = "complete"',
      "const exact = true",
      'return exact ? mode : "sample"',
    ],
    forbiddenMarkers: ["2026-08-23", "unchanged", "omitted", "…"],
  },
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
  {
    id: "git-add",
    projection: "git-mutation",
    executable: "git",
    argv: ["add", "."],
    rtkArgv: ["git", "add", "."],
    requiredMarkers: ["ok"],
    forbiddenMarkers: ["file changed", "insertion", "deletion"],
  },
  {
    id: "git-branch",
    projection: "git-mutation",
    executable: "git",
    argv: ["branch"],
    rtkArgv: ["git", "branch"],
    requiredMarkers: ["feature/736", "* main"],
    forbiddenMarkers: ["remotes/origin", "omitted", "…"],
  },
  {
    id: "git-checkout",
    projection: "git-mutation",
    executable: "git",
    argv: ["checkout", "feature/736"],
    rtkArgv: ["git", "checkout", "feature/736"],
    requiredMarkers: ["ok feature/736"],
    forbiddenMarkers: ["Switched to branch", "omitted", "…"],
  },
  {
    id: "git-commit",
    projection: "git-mutation",
    executable: "git",
    argv: ["commit", "-m", "Preserve complete context"],
    rtkArgv: ["git", "commit", "-m", "Preserve complete context"],
    requiredMarkers: ["ok", "2222222"],
    forbiddenMarkers: ["file changed", "insertion", "deletion"],
  },
  {
    id: "git-fetch",
    projection: "git-mutation",
    executable: "git",
    argv: ["fetch"],
    rtkArgv: ["git", "fetch"],
    requiredMarkers: ["fetched 1 ref"],
    forbiddenMarkers: ["From github.com", "origin/main", "omitted", "…"],
  },
  {
    id: "git-push",
    projection: "git-mutation",
    executable: "git",
    argv: ["push"],
    rtkArgv: ["git", "push"],
    requiredMarkers: ["github.com:yogeshprasad098/falryn.git", "feature", "1111111", "2222222"],
    forbiddenMarkers: ["Enumerating objects", "Writing objects"],
  },
  {
    id: "git-pull",
    projection: "git-mutation",
    executable: "git",
    argv: ["pull", "--ff-only"],
    rtkArgv: ["git", "pull", "--ff-only"],
    requiredMarkers: ["ok", "3 files", "+10", "-2"],
    forbiddenMarkers: ["Fast-forward", "src/a.ts", "src/b.ts", "src/c.ts"],
  },
  {
    id: "git-stash",
    projection: "git-mutation",
    executable: "git",
    argv: ["stash", "push", "-m", "Preserve complete context"],
    rtkArgv: ["git", "stash", "push", "-m", "Preserve complete context"],
    requiredMarkers: ["stashed"],
    forbiddenMarkers: ["Saved working directory", "omitted", "…"],
  },
  {
    id: "git-worktree",
    projection: "git-mutation",
    executable: "git",
    argv: ["worktree", "list"],
    rtkArgv: ["git", "worktree", "list"],
    requiredMarkers: [". 1111111 [main]", "2222222 [review/736]"],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "gh-pr-list",
    projection: "forge",
    executable: "gh",
    argv: ["pr", "list"],
    rtkArgv: ["gh", "pr", "list"],
    requiredMarkers: [
      "128 Context engine groundwork",
      "736 Do more with less context",
      "784 Complete Hush projections",
    ],
    forbiddenMarkers: ['"number"', "Pull Requests"],
  },
  {
    id: "gh-pr-view",
    projection: "forge",
    executable: "gh",
    argv: ["pr", "view", "784"],
    rtkArgv: ["gh", "pr", "view", "784"],
    requiredMarkers: [
      "#784",
      "Complete Hush projections",
      "@yogeshprasad098",
      "mergeable",
      "checks 2/3 ok, 1 fail",
      "https://github.com/tyldra-org/falryn/pull/784",
      "Preserve every useful PR fact.",
      "No list truncation",
    ],
    forbiddenMarkers: ['"statusCheckRollup"', "???"],
  },
  {
    id: "gh-issue-list",
    projection: "forge",
    executable: "gh",
    argv: ["issue", "list", "--limit", "20"],
    rtkArgv: ["gh", "issue", "list", "--limit", "20"],
    requiredMarkers: [
      "809 Implement live browser supervision, screencast, and human takeover",
      "800 Qualify optional native acceleration kernels behind TypeScript contracts",
      "790 Implement registry-driven slash completion and command aliases",
    ],
    forbiddenMarkers: ['"labels"', "Issues\n"],
  },
  {
    id: "gh-run-list",
    projection: "forge",
    executable: "gh",
    argv: ["run", "list", "--limit", "10"],
    rtkArgv: ["gh", "run", "list", "--limit", "10"],
    requiredMarkers: [
      "Issue governance:",
      "skip 32601 32602 32603 32604 32605",
      "cancel 32606 32607",
      "ok 32608",
      "fail 32609",
      "run 32610",
    ],
    forbiddenMarkers: ['"databaseId"', "Workflow Runs"],
  },
  {
    id: "gh-repo-view",
    projection: "forge",
    executable: "gh",
    argv: ["repo", "view"],
    rtkArgv: ["gh", "repo", "view"],
    requiredMarkers: [
      "tyldra-org/falryn public",
      "A local terminal coding agent",
      "2 stars 1 forks",
      "https://github.com/tyldra-org/falryn",
    ],
    forbiddenMarkers: ['"nameWithOwner"', "# Falryn", "[public]"],
  },
  {
    id: "gh-api",
    projection: "forge",
    executable: "gh",
    argv: ["api", "repos/tyldra-org/falryn"],
    rtkArgv: ["gh", "api", "repos/tyldra-org/falryn"],
    requiredMarkers: ['"name":"falryn"', '"private":false', '"default_branch":"main"'],
  },
  {
    id: "gh-release-list",
    projection: "forge",
    executable: "gh",
    argv: ["release", "list"],
    rtkArgv: ["gh", "release", "list"],
    requiredMarkers: [
      "latest v0.2.0 Falryn 0.2.0 2026-08-24",
      "pre v0.3.0-beta Falryn 0.3 beta 2026-08-23",
    ],
    forbiddenMarkers: ['"tagName"', "Latest\t", "Pre-release\t"],
  },
  {
    id: "glab-mr-list",
    projection: "forge",
    executable: "glab",
    argv: ["mr", "list"],
    rtkArgv: ["glab", "mr", "list"],
    competitiveTarget: "win",
    requiredMarkers: [
      "-> main:",
      "!128 feat/context-engine: Context engine groundwork",
      "perf/736-context-optimization:",
      "!736 Do more with less context",
      "!784 Complete Hush projections",
    ],
    forbiddenMarkers: ['"source_branch"', "Showing 3", "omitted", "…"],
  },
  {
    id: "glab-issue-list",
    projection: "forge",
    executable: "glab",
    argv: ["issue", "list"],
    rtkArgv: ["glab", "issue", "list"],
    competitiveTarget: "win",
    requiredMarkers: [
      "#809 Implement live browser supervision and human takeover",
      "#800 Qualify optional native acceleration kernels",
      "#790 Implement registry-driven slash completion",
    ],
    forbiddenMarkers: ['"labels"', "Showing 3", "omitted", "…"],
  },
  {
    id: "glab-ci-status",
    projection: "forge",
    executable: "glab",
    argv: ["ci", "status"],
    rtkArgv: ["glab", "ci", "status"],
    competitiveTarget: "win",
    requiredMarkers: [
      "#901 fail perf/736-context-optimization@abcdef01",
      "https://gitlab.example/tyldra/falryn/-/pipelines/901",
      "ok #1001 typecheck [verify]",
      "fail #1002 tests [verify] script_failure",
      "fail #1003 codeql [security] allowed script_failure",
    ],
    forbiddenMarkers: ['"allow_failure"', "Pipeline state:", "omitted", "…"],
  },
  {
    id: "glab-pipeline-list",
    projection: "forge",
    executable: "glab",
    argv: ["pipeline", "list"],
    rtkArgv: ["glab", "pipeline", "list"],
    baseline: "raw",
    competitiveTarget: "win",
    requiredMarkers: [
      "#901 fail perf/736-context-optimization@abcdef01 push verify",
      "#900 ok main@12345678 merge_request_event verify",
    ],
    forbiddenMarkers: ['"web_url"', "Showing 2", "omitted", "…"],
  },
  {
    id: "glab-api",
    projection: "forge",
    executable: "glab",
    argv: ["api", "projects/736"],
    rtkArgv: ["glab", "api", "projects/736"],
    competitiveTarget: "tie",
    requiredMarkers: ['"id":736', '"path_with_namespace":"tyldra/falryn"', '"visibility":"public"'],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "glab-release-list",
    projection: "forge",
    executable: "glab",
    argv: ["release", "list"],
    rtkArgv: ["glab", "release", "list"],
    competitiveTarget: "win",
    requiredMarkers: [
      "release v0.2.0 Falryn 0.2.0 2026-08-24",
      "upcoming v0.3.0-beta Falryn 0.3 beta 2026-09-01",
    ],
    forbiddenMarkers: ['"tag_name"', "Showing 2", "omitted", "…"],
  },
  {
    id: "gt-log",
    projection: "forge",
    executable: "gt",
    argv: ["log"],
    rtkArgv: ["gt", "log"],
    competitiveTarget: "win",
    requiredMarkers: [
      "* feature/top 95338df Preserve complete context | 8 seconds ago",
      "feature/base 95610c6 Build Hush forge reducers | 2 minutes ago",
      "main | 5 weeks ago",
    ],
    forbiddenMarkers: ["│", "omitted", "…"],
  },
  {
    id: "gt-submit",
    projection: "forge",
    executable: "gt",
    argv: ["submit"],
    rtkArgv: ["gt", "submit"],
    competitiveTarget: "win",
    requiredMarkers: [
      "created feature/base https://app.graphite.dev/github/pr/example/repo/101",
      "updated feature/top https://app.graphite.dev/github/pr/example/repo/102",
    ],
    forbiddenMarkers: ["Validating", "Preparing", "Pushing to remote", "omitted", "…"],
  },
  {
    id: "gt-sync",
    projection: "forge",
    executable: "gt",
    argv: ["sync"],
    rtkArgv: ["gt", "sync"],
    baseline: "raw",
    competitiveTarget: "win",
    requiredMarkers: [
      "sync main up to date",
      "deleted feature/merged (#98 merged)",
      "restacked feature/base -> main",
      "restacked feature/top -> feature/base",
    ],
    forbiddenMarkers: ["Fetching latest", "Cleaning up", "Restacking branches", "omitted", "…"],
  },
  {
    id: "gt-restack",
    projection: "forge",
    executable: "gt",
    argv: ["restack"],
    rtkArgv: ["gt", "restack"],
    baseline: "raw",
    competitiveTarget: "win",
    requiredMarkers: ["restacked feature/base -> main", "restacked feature/top -> feature/base"],
    forbiddenMarkers: ["Restacking branches", "omitted", "…"],
  },
  {
    id: "gt-create",
    projection: "forge",
    executable: "gt",
    argv: ["create"],
    rtkArgv: ["gt", "create"],
    baseline: "raw",
    competitiveTarget: "win",
    requiredMarkers: [
      "created feature/demo -> main",
      "abc1234 Preserve complete context",
      "2 files +6 -1",
    ],
    forbiddenMarkers: ["insertions", "deletions", "omitted", "…"],
  },
  {
    id: "gt-branch",
    projection: "forge",
    executable: "gt",
    argv: ["branch"],
    rtkArgv: ["gt", "branch"],
    competitiveTarget: "win",
    requiredMarkers: ["* feature/top", "feature/base", "main"],
    forbiddenMarkers: ["◉", "◯", "omitted", "…"],
  },
  {
    id: "jira-issue-list",
    projection: "forge",
    executable: "jira",
    argv: ["issue", "list"],
    rtkArgv: ["jira", "issue", "list"],
    competitiveTarget: "win",
    requiredMarkers: [
      "TYPE\tKEY\tSUMMARY\tSTATUS\tASSIGNEE\tREPORTER\tPRIORITY\tRESOLUTION\tCREATED\tUPDATED\tLABELS",
      "Task\tFAL-736\tOptimize context engines\tIn Progress\tYogesh Prasad\tYogesh Prasad\tHigh\t\t2026-08-23 10:15:00\t2026-08-25 09:40:00\tcontext,performance",
      "Bug\tFAL-788\tWire live index candidates\tTo Do\tYogesh Prasad\tYogesh Prasad\tHighest\t\t2026-08-24 08:30:00\t2026-08-25 08:55:00\tindex,context",
      "Story\tFAL-806\tExpose bounded capability bridge\tDone\tYogesh Prasad\tYogesh Prasad\tNormal\tFixed\t2026-08-24 14:20:00\t2026-08-25 07:15:00\tmcp,capability",
    ],
    forbiddenMarkers: ["...", "[full output:", "omitted", "…"],
  },
  {
    id: "jira-issue-view",
    projection: "forge",
    executable: "jira",
    argv: ["issue", "view", "FAL-736"],
    rtkArgv: ["jira", "issue", "view", "FAL-736"],
    competitiveTarget: "win",
    requiredMarkers: [
      "Task\tIn Progress\tSun, 23 Aug 26\tYogesh Prasad\tFAL-736\t3 comments\t2 linked",
      "# Optimize context engines",
      "Tue, 25 Aug 26\tYogesh Prasad\tHigh\tContext Platform\tcontext, performance",
      "Description:",
      "Make Hush, Loom, Brief, indexing, and context packing preserve every useful fact while reducing total turn cost.",
      "2 Subtasks:",
      "FAL-788 Wire live index candidates • Highest • To Do",
      "FAL-806 Expose bounded capability bridge • Normal • Done",
      "https://jira.example.test/browse/FAL-736",
    ],
    forbiddenMarkers: ["------------------------", "View this issue on Jira:", "omitted", "…"],
  },
  {
    id: "test-generic",
    projection: "test",
    executable: "test",
    argv: ["custom-runner"],
    baseline: "raw",
    competitiveTarget: "win",
    requiredMarkers: [
      "Falryn custom runner v2",
      "running complete",
      "running budget",
      "2 passed, 0 failed",
    ],
    forbiddenMarkers: ["Tests:", "omitted", "…"],
  },
  {
    id: "test-jest",
    projection: "test",
    executable: "jest",
    argv: [],
    rtkArgv: ["jest"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "0.45s"],
    forbiddenMarkers: ["PASS src", "Test Suites:", "Snapshots:", "omitted", "…"],
  },
  {
    id: "test-vitest",
    projection: "test",
    executable: "vitest",
    argv: ["run"],
    rtkArgv: ["vitest"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed"],
    forbiddenMarkers: ["RUN", "Test Files", "Duration", "omitted", "…"],
  },
  {
    id: "test-playwright",
    projection: "test",
    executable: "playwright",
    argv: ["test"],
    rtkArgv: ["playwright", "test"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "1.00s"],
    forbiddenMarkers: ["Running 2 tests", "hush complete", "hush budget", "omitted", "…"],
  },
  {
    id: "test-mocha",
    projection: "test",
    executable: "mocha",
    argv: [],
    baseline: "raw",
    competitiveTarget: "win",
    requiredMarkers: ["hush", "2 passed", "12ms"],
    forbiddenMarkers: ["✓ complete", "✓ budget", "omitted", "…"],
  },
  {
    id: "test-bun",
    projection: "test",
    executable: "bun",
    argv: ["test"],
    baseline: "raw",
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "12.00ms"],
    forbiddenMarkers: ["bun test v", "expect() calls", "omitted", "…"],
  },
  {
    id: "test-pytest",
    projection: "test",
    executable: "pytest",
    argv: [],
    rtkArgv: ["pytest"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "0.12s"],
    forbiddenMarkers: ["test_complete PASSED", "test_budget PASSED", "omitted", "…"],
  },
  {
    id: "test-python-pytest",
    projection: "test",
    executable: "python",
    argv: ["-m", "pytest"],
    rtkArgv: ["pytest"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "0.12s"],
    forbiddenMarkers: ["test_complete PASSED", "test_budget PASSED", "omitted", "…"],
  },
  {
    id: "test-uv-pytest",
    projection: "test",
    executable: "uv",
    argv: ["run", "pytest"],
    rtkArgv: ["pytest"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "0.12s"],
    forbiddenMarkers: ["test_complete PASSED", "test_budget PASSED", "omitted", "…"],
  },
  {
    id: "test-cargo",
    projection: "test",
    executable: "cargo",
    argv: ["test"],
    rtkArgv: ["cargo", "test"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "0.01s"],
    forbiddenMarkers: [
      "Compiling",
      "Running unittests",
      "test complete",
      "test budget",
      "omitted",
      "…",
    ],
  },
  {
    id: "test-cargo-nextest",
    projection: "test",
    executable: "cargo",
    argv: ["nextest", "run"],
    baseline: "raw",
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "0.12s"],
    forbiddenMarkers: ["Starting", "PASS complete", "PASS budget", "omitted", "…"],
  },
  {
    id: "test-go",
    projection: "test",
    executable: "go",
    argv: ["test", "./..."],
    rtkArgv: ["go", "test", "./..."],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "1 package", "0.02s"],
    forbiddenMarkers: ["=== RUN", "--- PASS", "omitted", "…"],
  },
  {
    id: "test-gradle",
    projection: "test",
    executable: "gradle",
    argv: ["test"],
    rtkArgv: ["gradlew", "test"],
    competitiveTarget: "win",
    requiredMarkers: ["ok 1s"],
    forbiddenMarkers: ["Gradle Daemon", "> Task", "actionable tasks", "omitted", "…"],
  },
  {
    id: "test-gradlew",
    projection: "test",
    executable: "gradlew",
    argv: ["test"],
    rtkArgv: ["gradlew", "test"],
    competitiveTarget: "win",
    requiredMarkers: ["ok 1s"],
    forbiddenMarkers: ["Gradle Daemon", "> Task", "actionable tasks", "omitted", "…"],
  },
  {
    id: "test-maven",
    projection: "test",
    executable: "mvn",
    argv: ["test"],
    rtkArgv: ["mvn", "test"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "dev.falryn.HushTest", "BUILD SUCCESS", "1.20s"],
    forbiddenMarkers: ["Scanning for projects", "-----------------------", "omitted", "…"],
  },
  {
    id: "test-maven-integration",
    projection: "test",
    executable: "mvn",
    argv: ["integration-test"],
    rtkArgv: ["mvn", "integration-test"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "dev.falryn.HushTest", "BUILD SUCCESS", "1.20s"],
    forbiddenMarkers: ["Scanning for projects", "-----------------------", "omitted", "…"],
  },
  {
    id: "test-sbt",
    projection: "test",
    executable: "sbt",
    argv: ["test"],
    rtkArgv: ["sbt", "test"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "1s"],
    forbiddenMarkers: ["welcome to sbt", "loading project", "Total number", "omitted", "…"],
  },
  {
    id: "test-dotnet",
    projection: "test",
    executable: "dotnet",
    argv: ["test"],
    baseline: "raw",
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "12ms"],
    forbiddenMarkers: ["Determining projects", "Test run for", "omitted", "…"],
  },
  {
    id: "test-swift",
    projection: "test",
    executable: "swift",
    argv: ["test"],
    rtkArgv: ["swift", "test"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "0.010s"],
    forbiddenMarkers: ["Building for debugging", "Test Suite", "Test Case", "omitted", "…"],
  },
  {
    id: "test-xcodebuild",
    projection: "test",
    executable: "xcodebuild",
    argv: ["test"],
    rtkArgv: ["xcodebuild", "test"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "0.010s"],
    forbiddenMarkers: ["Building for debugging", "Test Suite", "Test Case", "omitted", "…"],
  },
  {
    id: "test-phpunit",
    projection: "test",
    executable: "phpunit",
    argv: [],
    rtkArgv: ["phpunit"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "4 assertions"],
    forbiddenMarkers: ["PHPUnit 12", "Runtime:", "Time:", "omitted", "…"],
  },
  {
    id: "test-pest",
    projection: "test",
    executable: "pest",
    argv: [],
    rtkArgv: ["pest"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "4 assertions", "0.12s"],
    forbiddenMarkers: ["Pest 5", "omitted", "…"],
  },
  {
    id: "test-paratest",
    projection: "test",
    executable: "paratest",
    argv: [],
    rtkArgv: ["paratest"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "4 assertions"],
    forbiddenMarkers: ["ParaTest v", "Random Seed", "omitted", "…"],
  },
  {
    id: "test-php-vendor",
    projection: "test",
    executable: "php",
    argv: ["vendor/bin/phpunit"],
    rtkArgv: ["phpunit"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "4 assertions"],
    forbiddenMarkers: ["PHPUnit 12", "Runtime:", "Time:", "omitted", "…"],
  },
  {
    id: "test-rake",
    projection: "test",
    executable: "rake",
    argv: ["test"],
    rtkArgv: ["rake", "test"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "0.012s"],
    forbiddenMarkers: ["Run options", "# Running", "assertions", "omitted", "…"],
  },
  {
    id: "test-rails",
    projection: "test",
    executable: "rails",
    argv: ["test"],
    rtkArgv: ["rake", "test"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "0.012s"],
    forbiddenMarkers: ["Run options", "# Running", "assertions", "omitted", "…"],
  },
  {
    id: "test-rspec",
    projection: "test",
    executable: "rspec",
    argv: [],
    rtkArgv: ["rspec"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "0.012s"],
    forbiddenMarkers: ["examples", "omitted", "…"],
  },
  {
    id: "test-bundle-rspec",
    projection: "test",
    executable: "bundle",
    argv: ["exec", "rspec"],
    rtkArgv: ["rspec"],
    competitiveTarget: "win",
    requiredMarkers: ["2 passed", "0.012s"],
    forbiddenMarkers: ["examples", "omitted", "…"],
  },
  {
    id: "diagnostic-tsc",
    projection: "diagnostic",
    executable: "tsc",
    argv: ["--noEmit"],
    rtkArgv: ["tsc", "--noEmit"],
    competitiveTarget: "win",
    acceptedExitCodes: [2],
    requiredMarkers: [
      "2 errors in 2 files",
      "src/a.ts:10:4 error[TS2322]: Type 'string' is not assignable to type 'number'.",
      "src/b.ts:20:8 error[TS2304]: Cannot find name 'missing'.",
    ],
    forbiddenMarkers: ["Found", "omitted", "…"],
  },
  {
    id: "diagnostic-basedpyright",
    projection: "diagnostic",
    executable: "basedpyright",
    argv: [],
    rtkArgv: ["basedpyright"],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "2 errors, 1 warning, 0 informations",
      '/workspace/app/main.py:10:5 error[reportUndefinedVariable]: "foo" is not defined',
      '/workspace/app/main.py:25:1 error[reportAssignmentType]: Type "str" is not assignable to type "int"',
      '/workspace/app/utils.py:8:9 warning[reportUnusedVariable]: Variable "x" is not accessed',
    ],
    forbiddenMarkers: ["Searching for source files", "Found 42 source files", "omitted", "…"],
  },
  {
    id: "diagnostic-ty",
    projection: "diagnostic",
    executable: "ty",
    argv: ["check"],
    rtkArgv: ["ty", "check"],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "1 error, 1 warning",
      "app/main.py:10:5 error[unresolved-reference]: Name `foo` used when not defined",
      "10 |     foo()",
      "|     ^^^",
      "app/utils.py:8:9 warning[unused-variable]: Variable `x` is not used",
      "8 |     x = 42",
      "|     ^",
    ],
    forbiddenMarkers: ["Checking 15 files", "Found", "omitted", "…"],
  },
  {
    id: "diagnostic-bun-typecheck",
    projection: "diagnostic",
    executable: "bun",
    argv: ["run", "typecheck"],
    baseline: "raw",
    competitiveTarget: "win",
    acceptedExitCodes: [2],
    requiredMarkers: [
      "2 errors in 2 files",
      "src/runtime.ts:14:6 error[TS2345]: Argument of type 'string' is not assignable to parameter of type 'number'.",
      "src/router.ts:28:3 error[TS2339]: Property 'route' does not exist on type 'Context'.",
    ],
    forbiddenMarkers: ["$ tsc --noEmit", "Found", "omitted", "…"],
  },
  {
    id: "diagnostic-format-generic",
    projection: "diagnostic",
    executable: "format",
    argv: [],
    baseline: "raw",
    competitiveTarget: "win",
    requiredMarkers: ["ok 42 files unchanged"],
    forbiddenMarkers: ["Formatting complete", "omitted", "…"],
  },
  {
    id: "diagnostic-lint-generic",
    projection: "diagnostic",
    executable: "lint",
    argv: ["src"],
    baseline: "raw",
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "1 error, 1 warning",
      "src/runtime.ts:14:6 error[lint/noUnsafe]: Unsafe value reaches the provider.",
      "src/router.ts:28:3 warning[lint/noFallback]: Fallback route is not explicit.",
    ],
    forbiddenMarkers: ["2 issues (", "omitted", "…"],
  },
  {
    id: "diagnostic-biome",
    projection: "diagnostic",
    executable: "biome",
    argv: ["check", "."],
    rtkArgv: ["biome", "check", "."],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "2 errors in 2 files",
      "src/runtime.ts:14:6 error[lint/suspicious/noExplicitAny]: Unexpected any. Specify a different type.",
      "src/router.ts:28:3 error[lint/correctness/noUnusedVariables]: This variable is unused.",
    ],
    forbiddenMarkers: ["Checked 42", "Found 2", "━", "omitted", "…"],
  },
  {
    id: "diagnostic-eslint",
    projection: "diagnostic",
    executable: "eslint",
    argv: ["src"],
    rtkArgv: ["eslint", "src"],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "E[@typescript-eslint/no-unsafe-assignment] /workspace/src/runtime.ts:14:6 Unsafe any value",
      "W[no-console] /workspace/src/runtime.ts:28:3 Unexpected console statement",
    ],
    forbiddenMarkers: ["✖", "problems", "omitted", "…"],
  },
  {
    id: "diagnostic-oxlint",
    projection: "diagnostic",
    executable: "oxlint",
    argv: ["src"],
    rtkArgv: ["oxlint", "src"],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "E[no-undef] src/runtime.ts:14:6 `missing` is not defined",
      "W[no-console] src/router.ts:28:3 Unexpected console statement",
    ],
    forbiddenMarkers: ["Found", "omitted", "…"],
  },
  {
    id: "diagnostic-prettier",
    projection: "diagnostic",
    executable: "prettier",
    argv: ["--check", "."],
    rtkArgv: ["prettier", "--check", "."],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: ["fmt 2", "src/runtime.ts", "src/router.ts"],
    forbiddenMarkers: ["Checking formatting", "[warn]", "omitted", "…"],
  },
  {
    id: "diagnostic-bun-check",
    projection: "diagnostic",
    executable: "bun",
    argv: ["run", "check"],
    baseline: "raw",
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "2 errors in 2 files",
      "src/runtime.ts:14:6 error[lint/suspicious/noExplicitAny]",
      "src/router.ts:28:3 error[lint/correctness/noUnusedVariables]",
    ],
    forbiddenMarkers: ["$ biome", "Checked 42", "Found 2", "━", "omitted", "…"],
  },
  {
    id: "diagnostic-bun-lint",
    projection: "diagnostic",
    executable: "bun",
    argv: ["run", "lint"],
    baseline: "raw",
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "2 errors in 2 files",
      "src/runtime.ts:14:6 error[lint/suspicious/noExplicitAny]",
      "src/router.ts:28:3 error[lint/correctness/noUnusedVariables]",
    ],
    forbiddenMarkers: ["$ biome", "Checked 42", "Found 2", "━", "omitted", "…"],
  },
  {
    id: "diagnostic-cargo-clippy",
    projection: "diagnostic",
    executable: "cargo",
    argv: ["clippy"],
    rtkArgv: ["cargo", "clippy"],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "E[E0425] src/lib.rs:14:6 cannot find value `missing` in this scope",
      "W src/router.rs:28:3 unused variable: `context`",
    ],
    forbiddenMarkers: [
      "Checking falryn",
      "could not compile",
      "generated 1 warning",
      "omitted",
      "…",
    ],
  },
  {
    id: "diagnostic-cargo-check",
    projection: "diagnostic",
    executable: "cargo",
    argv: ["check"],
    rtkArgv: ["cargo", "check"],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: ["E[E0425] src/lib.rs:14:6", "W src/router.rs:28:3"],
    forbiddenMarkers: [
      "Checking falryn",
      "could not compile",
      "generated 1 warning",
      "omitted",
      "…",
    ],
  },
  {
    id: "diagnostic-cargo-fmt",
    projection: "diagnostic",
    executable: "cargo",
    argv: ["fmt", "--", "--check"],
    rtkArgv: ["cargo", "fmt", "--", "--check"],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: ["/workspace/src/lib.rs:", "-fn project(){", "+fn project() {"],
    forbiddenMarkers: ["Diff in", "omitted", "…"],
  },
  {
    id: "diagnostic-clippy",
    projection: "diagnostic",
    executable: "clippy",
    argv: [],
    baseline: "raw",
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: ["E[E0425] src/lib.rs:14:6", "W src/router.rs:28:3"],
    forbiddenMarkers: [
      "Checking falryn",
      "could not compile",
      "generated 1 warning",
      "omitted",
      "…",
    ],
  },
  {
    id: "diagnostic-mypy",
    projection: "diagnostic",
    executable: "mypy",
    argv: ["src"],
    rtkArgv: ["mypy", "src"],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "2 errors checked 42 files",
      'src/app.py:14:6 error[name-defined]: Name "missing" is not defined',
      "src/router.py:28:3 error[return-value]: Incompatible return value type",
    ],
    forbiddenMarkers: ["Found 2", "source files", "omitted", "…"],
  },
  {
    id: "diagnostic-python-mypy",
    projection: "diagnostic",
    executable: "python",
    argv: ["-m", "mypy", "src"],
    rtkArgv: ["mypy", "src"],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "2 errors checked 42 files",
      "src/app.py:14:6 error[name-defined]",
      "src/router.py:28:3 error[return-value]",
    ],
    forbiddenMarkers: ["Found 2", "source files", "omitted", "…"],
  },
  {
    id: "diagnostic-ruff-check",
    projection: "diagnostic",
    executable: "ruff",
    argv: ["check", "."],
    rtkArgv: ["ruff", "check", "."],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "2 errors 0 fixable",
      "src/app.py:14:6 error[F821]: Undefined name `missing`",
      "src/router.py:28:3 error[E501]: Line too long (92 > 88)",
    ],
    forbiddenMarkers: ["Found 2", "--fix", "omitted", "…"],
  },
  {
    id: "diagnostic-ruff-format",
    projection: "diagnostic",
    executable: "ruff",
    argv: ["format", "--check", "."],
    rtkArgv: ["ruff", "format", "--check", "."],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: ["2 files need formatting", "src/app.py", "src/router.py"],
    forbiddenMarkers: ["Would reformat", "would be reformatted", "omitted", "…"],
  },
  {
    id: "diagnostic-go-vet",
    projection: "diagnostic",
    executable: "go",
    argv: ["vet", "./..."],
    rtkArgv: ["go", "vet", "./..."],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "E ./main.go:14:6 fmt.Printf format %d has arg name of wrong type string",
      "E ./router.go:28:3 result of save call not used",
    ],
    forbiddenMarkers: ["# example/falryn", "omitted", "…"],
  },
  {
    id: "diagnostic-golangci-lint",
    projection: "diagnostic",
    executable: "golangci-lint",
    argv: ["run"],
    rtkArgv: ["golangci-lint", "run"],
    competitiveTarget: "win",
    acceptedExitCodes: [0, 1],
    requiredMarkers: ["E[govet] main.go:14:6", "E[errcheck] router.go:28:3"],
    forbiddenMarkers: ["* errcheck", "* govet", "omitted", "…"],
  },
  {
    id: "diagnostic-golangci",
    projection: "diagnostic",
    executable: "golangci",
    argv: ["run"],
    rtkArgv: ["golangci", "run"],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: ["E[govet] main.go:14:6", "E[errcheck] router.go:28:3"],
    forbiddenMarkers: ["* errcheck", "* govet", "omitted", "…"],
  },
  {
    id: "diagnostic-dotnet-format",
    projection: "diagnostic",
    executable: "dotnet",
    argv: ["format"],
    baseline: "raw",
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "1 error, 1 warning 42ms",
      "/workspace/App.cs:14:6 warning[IDE0055]: Fix formatting",
      "/workspace/Router.cs:28:3 error[CS0103]: The name 'missing' does not exist in the current context",
    ],
    forbiddenMarkers: ["Format complete", "omitted", "…"],
  },
  {
    id: "diagnostic-mix-format",
    projection: "diagnostic",
    executable: "mix",
    argv: ["format", "--check-formatted"],
    rtkArgv: ["mix", "format", "--check-formatted"],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: ["2 files need formatting", "lib/falryn.ex", "lib/router.ex"],
    forbiddenMarkers: ["Mix", "The following", "*", "omitted", "…"],
  },
  {
    id: "diagnostic-phpstan",
    projection: "diagnostic",
    executable: "phpstan",
    argv: ["analyse", "src"],
    rtkArgv: ["phpstan", "analyse", "src"],
    competitiveTarget: "win",
    acceptedExitCodes: [0, 1],
    requiredMarkers: [
      "E[method.notFound] /workspace/src/App.php:14 Call to an undefined method App::missing().",
      "E[return.type] /workspace/src/Router.php:28 Method Router::route() should return string but returns int.",
    ],
    forbiddenMarkers: ["Line", "🪪", "------", "[ERROR] Found", "omitted", "…"],
  },
  {
    id: "diagnostic-ecs",
    projection: "diagnostic",
    executable: "ecs",
    argv: ["check", "src"],
    baseline: "raw",
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "2 files need formatting",
      "src/App.php",
      "src/Router.php",
      "-return$context;",
      "+return $context;",
    ],
    forbiddenMarkers: ["begin diff", "end diff", "====", "omitted", "…"],
  },
  {
    id: "diagnostic-pint",
    projection: "diagnostic",
    executable: "pint",
    argv: ["--test"],
    rtkArgv: ["pint", "--test"],
    competitiveTarget: "win",
    acceptedExitCodes: [0, 1],
    requiredMarkers: [
      "src/App.php [class_attributes_separation]",
      "src/Router.php [single_space_around_construct]",
    ],
    forbiddenMarkers: ["Laravel", "FAIL", "⨯", "omitted", "…"],
  },
  {
    id: "diagnostic-rubocop",
    projection: "diagnostic",
    executable: "rubocop",
    argv: [],
    rtkArgv: ["rubocop"],
    competitiveTarget: "win",
    acceptedExitCodes: [0, 1],
    requiredMarkers: [
      "2 warnings 2 files, 2 correctable",
      "app.rb:14:6 warning[Layout/TrailingWhitespace]: Trailing whitespace detected.",
      "router.rb:28:3 warning[Lint/UselessAssignment]: Useless assignment to variable - context.",
    ],
    forbiddenMarkers: ["Inspecting", "Offenses", "autocorrectable", "omitted", "…"],
  },
  {
    id: "diagnostic-bundle-rubocop",
    projection: "diagnostic",
    executable: "bundle",
    argv: ["exec", "rubocop"],
    rtkArgv: ["rubocop"],
    competitiveTarget: "win",
    acceptedExitCodes: [0, 1],
    requiredMarkers: [
      "2 warnings 2 files, 2 correctable",
      "app.rb:14:6 warning[Layout/TrailingWhitespace]",
      "router.rb:28:3 warning[Lint/UselessAssignment]",
    ],
    forbiddenMarkers: ["Inspecting", "Offenses", "autocorrectable", "omitted", "…"],
  },
  {
    id: "diagnostic-precommit",
    projection: "diagnostic",
    executable: "pre-commit",
    argv: ["run", "--all-files"],
    rtkArgv: ["pre-commit", "run", "--all-files"],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "1 failed, 1 passed",
      "failed Trim trailing whitespace [trailing-whitespace] exit 1: files modified by this hook",
      "passed Check YAML",
    ],
    forbiddenMarkers: ["hook id:", "exit code:", "...", "omitted", "…"],
  },
  {
    id: "diagnostic-hadolint",
    projection: "diagnostic",
    executable: "hadolint",
    argv: ["Dockerfile"],
    rtkArgv: ["hadolint", "Dockerfile"],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "W[DL3008] Dockerfile:14 Pin versions in apt get install.",
      "I[DL3015] Dockerfile:28 Avoid additional packages by specifying --no-install-recommends.",
    ],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "diagnostic-markdownlint",
    projection: "diagnostic",
    executable: "markdownlint",
    argv: ["."],
    rtkArgv: ["markdownlint", "."],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "E[MD013] README.md:14:6 Line length [Expected: 80; Actual: 92]",
      "E[MD022] docs/guide.md:28 Headings should be surrounded by blank lines",
    ],
    forbiddenMarkers: ["/line-length", "/blanks-around-headings", "omitted", "…"],
  },
  {
    id: "diagnostic-shellcheck",
    projection: "diagnostic",
    executable: "shellcheck",
    argv: ["scripts/build.sh"],
    rtkArgv: ["shellcheck", "scripts/build.sh"],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      "I[SC2086] scripts/build.sh:14 Double quote to prevent globbing and word splitting.",
      "echo $artifact",
    ],
    forbiddenMarkers: ["In scripts", "For more information", "omitted", "…"],
  },
  {
    id: "diagnostic-yamllint",
    projection: "diagnostic",
    executable: "yamllint",
    argv: ["."],
    rtkArgv: ["yamllint", "."],
    competitiveTarget: "win",
    acceptedExitCodes: [1],
    requiredMarkers: [
      'W[document-start] .github/workflows/check.yml:14:6 missing document start "---"',
      "E[trailing-spaces] .github/workflows/check.yml:28:3 trailing spaces",
    ],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "build-cargo",
    projection: "build",
    executable: "cargo",
    argv: ["build", "--release"],
    rtkArgv: ["cargo", "build", "--release"],
    requiredMarkers: ["Finished release target", "0.42s"],
  },
  {
    id: "package-npm-install",
    projection: "package",
    executable: "npm",
    argv: ["install"],
    rtkArgv: ["npm", "install"],
    competitiveTarget: "win",
    requiredMarkers: ["packages +12; audited 13; 1s", "funding 2: npm fund", "vulnerabilities 0"],
    forbiddenMarkers: ["looking for funding", "omitted", "…"],
  },
  {
    id: "package-npm-list",
    projection: "package",
    executable: "npm",
    argv: ["list"],
    rtkArgv: ["npm", "list"],
    competitiveTarget: "win",
    requiredMarkers: [
      "falryn@0.3.0 /workspace",
      "- @falryn/context@0.3.0",
      "- zod@4.0.0",
      "- typescript@5.9.2",
    ],
    forbiddenMarkers: ["├", "└", "omitted", "…"],
  },
  {
    id: "package-npm-outdated",
    projection: "package",
    executable: "npm",
    argv: ["outdated"],
    rtkArgv: ["npm", "outdated"],
    competitiveTarget: "win",
    requiredMarkers: [
      "current>wanted>latest",
      "@falryn/context 0.2.0>0.2.5>0.3.0",
      "zod 3.24.0>3.25.0>4.0.0",
    ],
    forbiddenMarkers: ["node_modules", "omitted", "…"],
  },
  {
    id: "package-npm-run",
    projection: "package",
    executable: "npm",
    argv: ["run", "verify"],
    rtkArgv: ["npm", "run", "verify"],
    competitiveTarget: "win",
    requiredMarkers: [
      "node tools/verify-packages.mjs",
      "checking package graph",
      "verified 12 packages",
    ],
    forbiddenMarkers: ["> falryn@", "omitted", "…"],
  },
  {
    id: "package-pnpm-install",
    projection: "package",
    executable: "pnpm",
    argv: ["install"],
    rtkArgv: ["pnpm", "install"],
    competitiveTarget: "win",
    requiredMarkers: [
      "+3 packages",
      "prod @falryn/context 0.3.0, zod 4.0.0",
      "dev typescript 5.9.2",
    ],
    forbiddenMarkers: ["Progress:", "+++", "omitted", "…"],
  },
  {
    id: "package-pnpm-list",
    projection: "package",
    executable: "pnpm",
    argv: ["list"],
    rtkArgv: ["pnpm", "list"],
    competitiveTarget: "win",
    requiredMarkers: [
      "falryn@0.3.0 /workspace",
      "prod: @falryn/context@0.3.0, zod@4.0.0",
      "dev: typescript@5.9.2",
    ],
    forbiddenMarkers: ["Legend:", "omitted", "…"],
  },
  {
    id: "package-pnpm-outdated",
    projection: "package",
    executable: "pnpm",
    argv: ["outdated"],
    rtkArgv: ["pnpm", "outdated"],
    competitiveTarget: "win",
    requiredMarkers: [
      "current>wanted>latest",
      "@falryn/context 0.2.0>0.2.5>0.3.0",
      "zod 3.24.0>3.25.0>4.0.0",
    ],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "package-pnpm-run",
    projection: "package",
    executable: "pnpm",
    argv: ["run", "verify"],
    rtkArgv: ["pnpm", "run", "verify"],
    competitiveTarget: "win",
    requiredMarkers: [
      "node tools/verify-packages.mjs",
      "checking package graph",
      "verified 12 packages",
    ],
    forbiddenMarkers: ["> falryn@", "omitted", "…"],
  },
  {
    id: "package-yarn-install",
    projection: "package",
    executable: "yarn",
    argv: ["install"],
    rtkArgv: ["yarn", "install"],
    competitiveTarget: "win",
    requiredMarkers: [
      "lockfile saved",
      "dependencies +2",
      "direct:",
      "all:",
      "@falryn/context@0.3.0",
      "typescript@5.9.2",
    ],
    forbiddenMarkers: ["[1/4]", "yarn install", "omitted", "…"],
  },
  {
    id: "package-yarn-list",
    projection: "package",
    executable: "yarn",
    argv: ["list"],
    rtkArgv: ["yarn", "list"],
    competitiveTarget: "win",
    requiredMarkers: ["- @falryn/context@0.3.0", "- zod@4.0.0", "- typescript@5.9.2"],
    forbiddenMarkers: ["yarn list", "├", "└", "omitted", "…"],
  },
  {
    id: "package-yarn-outdated",
    projection: "package",
    executable: "yarn",
    argv: ["outdated"],
    rtkArgv: ["yarn", "outdated"],
    competitiveTarget: "win",
    requiredMarkers: [
      "current>wanted>latest",
      "@falryn/context 0.2.0>0.2.5>0.3.0",
      "zod 3.24.0>3.25.0>4.0.0",
    ],
    forbiddenMarkers: ["https://", "omitted", "…"],
  },
  {
    id: "package-yarn-run",
    projection: "package",
    executable: "yarn",
    argv: ["run", "verify"],
    rtkArgv: ["yarn", "run", "verify"],
    competitiveTarget: "win",
    requiredMarkers: [
      "node tools/verify-packages.mjs",
      "checking package graph",
      "verified 12 packages",
    ],
    forbiddenMarkers: ["yarn run", "Done in", "omitted", "…"],
  },
  {
    id: "package-bun-install",
    projection: "package",
    executable: "bun",
    argv: ["install"],
    rtkArgv: ["bun", "install"],
    competitiveTarget: "win",
    requiredMarkers: [
      "bun install v1.4.0 (0aa2b1cd)",
      "resolved/downloaded/extracted 12",
      "lockfile saved",
      "+ @falryn/context@0.3.0",
      "+ zod@4.0.0",
      "+ typescript@5.9.2",
      "installed 12 packages [118.00ms]",
    ],
    forbiddenMarkers: ["Resolving dependencies", "omitted", "…"],
  },
  {
    id: "package-bun-add",
    projection: "package",
    executable: "bun",
    argv: ["add", "@falryn/context", "zod"],
    rtkArgv: ["bun", "add", "@falryn/context", "zod"],
    competitiveTarget: "win",
    requiredMarkers: [
      "bun add v1.4.0 (0aa2b1cd)",
      "resolved/downloaded/extracted 12",
      "lockfile saved",
      "+ @falryn/context@0.3.0",
      "+ zod@4.0.0",
      "+ typescript@5.9.2",
      "installed 12 packages [118.00ms]",
    ],
    forbiddenMarkers: ["Resolving dependencies", "omitted", "…"],
  },
  {
    id: "package-bun-outdated",
    projection: "package",
    executable: "bun",
    argv: ["outdated"],
    rtkArgv: ["bun", "outdated"],
    competitiveTarget: "win",
    requiredMarkers: [
      "current>wanted>latest",
      "@falryn/context 0.2.0>0.2.5>0.3.0",
      "zod 3.24.0>3.25.0>4.0.0",
    ],
    forbiddenMarkers: ["node_modules", "omitted", "…"],
  },
  {
    id: "package-bun-run",
    projection: "package",
    executable: "bun",
    argv: ["run", "custom"],
    rtkArgv: ["bun", "run", "custom"],
    competitiveTarget: "win",
    requiredMarkers: [
      "bun run tools/verify-packages.mjs",
      "checking package graph ×3",
      "verified 12 packages",
    ],
    forbiddenMarkers: ["$ bun run", "omitted", "…"],
  },
  {
    id: "package-bun-audit",
    projection: "package",
    executable: "bun",
    argv: ["audit"],
    rtkArgv: ["bun", "audit"],
    competitiveTarget: "tie",
    requiredMarkers: ["No vulnerabilities found"],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "package-bun-pm-list",
    projection: "package",
    executable: "bun",
    argv: ["pm", "ls"],
    rtkArgv: ["bun", "pm", "ls"],
    competitiveTarget: "tie",
    requiredMarkers: [
      "/workspace node_modules (3)",
      "├── @falryn/context@0.3.0",
      "├── zod@4.0.0",
      "└── typescript@5.9.2",
    ],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "package-npx",
    projection: "package",
    executable: "npx",
    argv: ["package-audit"],
    rtkArgv: ["npx", "package-audit"],
    competitiveTarget: "win",
    requiredMarkers: ["checking package graph ×3", "verified 12 packages"],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "package-pnpx",
    projection: "package",
    executable: "pnpx",
    argv: ["package-audit"],
    rtkArgv: ["pnpx", "package-audit"],
    competitiveTarget: "win",
    requiredMarkers: ["checking package graph ×3", "verified 12 packages"],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "package-pip-install",
    projection: "package",
    executable: "pip",
    argv: ["install", "requests"],
    rtkArgv: ["pip", "install", "requests"],
    competitiveTarget: "win",
    requiredMarkers: ["installed requests-2.32.3"],
    forbiddenMarkers: ["Collecting", "Using cached", "omitted", "…"],
  },
  {
    id: "package-pip-list",
    projection: "package",
    executable: "pip",
    argv: ["list"],
    rtkArgv: ["pip", "list"],
    competitiveTarget: "win",
    requiredMarkers: ["packages 3", "certifi@2026.8.1", "requests@2.32.3", "urllib3@2.2.2"],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "package-pip3-outdated",
    projection: "package",
    executable: "pip3",
    argv: ["list", "--outdated"],
    rtkArgv: ["pip", "outdated"],
    competitiveTarget: "win",
    requiredMarkers: ["current>latest wheel", "requests 2.31.0>2.32.3", "urllib3 2.1.0>2.2.2"],
    forbiddenMarkers: ["hint", "omitted", "…"],
  },
  {
    id: "package-uv-sync",
    projection: "package",
    executable: "uv",
    argv: ["sync"],
    rtkArgv: ["uv", "sync"],
    competitiveTarget: "win",
    requiredMarkers: ["+2", "+ certifi@2026.8.1", "+ requests@2.32.3"],
    forbiddenMarkers: ["Downloading", "Using cached", "Prepared", "omitted", "…"],
  },
  {
    id: "package-poetry-install",
    projection: "package",
    executable: "poetry",
    argv: ["install"],
    rtkArgv: ["poetry", "install"],
    competitiveTarget: "win",
    requiredMarkers: ["current"],
    forbiddenMarkers: ["Installing dependencies", "omitted", "…"],
  },
  {
    id: "package-brew-install",
    projection: "package",
    executable: "brew",
    argv: ["install", "jq"],
    rtkArgv: ["brew", "install", "jq"],
    competitiveTarget: "win",
    requiredMarkers: ["installed jq@1.8.1; 20 files, 1.4MB"],
    forbiddenMarkers: ["Fetching", "Downloading", "Pouring", "omitted", "…"],
  },
  {
    id: "package-composer-install",
    projection: "package",
    executable: "composer",
    argv: ["install"],
    rtkArgv: ["composer", "install"],
    competitiveTarget: "win",
    requiredMarkers: ["current"],
    forbiddenMarkers: ["Loading composer", "omitted", "…"],
  },
  {
    id: "package-bundle-install",
    projection: "package",
    executable: "bundle",
    argv: ["install"],
    rtkArgv: ["bundle", "install"],
    competitiveTarget: "win",
    requiredMarkers: ["complete 85/200"],
    forbiddenMarkers: ["Using ", "omitted", "…"],
  },
  {
    id: "table-docker",
    projection: "table",
    executable: "docker",
    argv: ["ps"],
    rtkArgv: ["docker", "ps"],
    requiredMarkers: ["abc123", "falryn-dev", "def456", "falryn-db"],
  },
  {
    id: "count-wc-single",
    projection: "count",
    executable: "wc",
    argv: ["-l", "-w", "-c", "src/domain/hush/reducers/log/format.ts"],
    rtkArgv: ["wc", "-l", "-w", "-c", "src/domain/hush/reducers/log/format.ts"],
    requiredMarkers: ["127", "384", "3268"],
    forbiddenMarkers: ["src/domain", "omitted", "…"],
  },
  {
    id: "count-wc-multi",
    projection: "count",
    executable: "wc",
    argv: ["src/domain/hush/reducers/log/format.ts", "src/domain/hush/reducers/log/projection.ts"],
    rtkArgv: [
      "wc",
      "src/domain/hush/reducers/log/format.ts",
      "src/domain/hush/reducers/log/projection.ts",
    ],
    requiredMarkers: [
      "127L 384W 3268B format.ts",
      "32L 131W 1251B projection.ts",
      "Σ 159L 515W 4519B",
    ],
    forbiddenMarkers: ["src/domain", "omitted", "…"],
  },
  {
    id: "log-docker",
    projection: "log",
    executable: "docker",
    argv: ["logs", "falryn-dev"],
    rtkArgv: ["docker", "logs", "falryn-dev"],
    requiredMarkers: ["service started", "req-736", "req-784"],
  },
  {
    id: "log-journalctl",
    projection: "log",
    executable: "journalctl",
    argv: ["-u", "falryn", "-n", "20"],
    baseline: "rtk-log",
    requiredMarkers: [
      "Aug 24 10:00 falryn-host falryn[736]",
      "00 [I] session started session=demo",
      "01 [I] context engine ready reducers=82",
      "02 [I] waiting for provider ×3",
      "03 [W] reducer fallback command=unknown",
      "04 [E] capture unavailable id=cap-42",
      "05 [I] request complete tokens=219",
    ],
    forbiddenMarkers: ["Log Summary", "omitted", "…"],
  },
  {
    id: "curl-json",
    projection: "curl",
    executable: "curl",
    argv: ["https://example.test/status"],
    rtkArgv: ["curl", "https://example.test/status"],
    requiredMarkers: ["req-736", "reducers", "81", "complete", "true"],
    forbiddenMarkers: ["% Total", "Dload", "1020"],
  },
  {
    id: "wget-download",
    projection: "wget",
    executable: "wget",
    argv: ["https://example.test/releases/falryn.tar.gz"],
    rtkArgv: ["wget", "https://example.test/releases/falryn.tar.gz"],
    requiredMarkers: ["200", "example.test/releases/falryn.tar.gz", "falryn.tar.gz", "1.5KB"],
    forbiddenMarkers: ["Resolving", "Connecting", "100%", "saved ["],
  },
  {
    id: "network-ssh",
    projection: "network",
    executable: "ssh",
    argv: ["example.test", "echo", "connected"],
    rtkArgv: ["ssh", "example.test", "echo", "connected"],
    requiredMarkers: ["connected", "example.test", "remote command: ok"],
  },
  {
    id: "operation-terraform",
    projection: "operation",
    executable: "terraform",
    argv: ["plan"],
    rtkArgv: ["terraform", "plan"],
    requiredMarkers: ["falryn_context.primary", "0 to add", "1 to change", "0 to destroy"],
  },
  {
    id: "structured-aws",
    projection: "structured",
    executable: "aws",
    argv: ["sts", "get-caller-identity"],
    rtkArgv: ["aws", "sts", "get-caller-identity"],
    requiredMarkers: ["123456789012", "user=falryn", "AIDAEXAMPLE"],
  },
] as const satisfies readonly ProjectionCase[];

type CommandRun = Readonly<{ stdout: string; stderr: string; exitCode: number }>;

export type HushProjectionScore = Readonly<{
  id: string;
  projection: HushProjectionKind;
  gate: "rtk" | "raw" | "rewrite" | "rtk-log";
  raw: HushLsMeasurement;
  rtk: HushLsMeasurement;
  hush: HushLsMeasurement;
  competitiveTarget: "tie" | "win";
  competitiveResult: "loss" | "tie" | "win";
  meetsCompetitiveTarget: boolean;
  withinRtkBudget: boolean;
  retainsRequiredContext: boolean;
  excludesKnownNoise: boolean;
  noArbitraryCap: boolean;
  recognized: boolean;
  result: "PASS" | "FAIL";
}>;

export type HushProjectionScorecard = Readonly<{
  corpusVersion: typeof HUSH_PROJECTION_CORPUS_VERSION;
  hushVersion: typeof HUSH_REDUCER_VERSION;
  rtkVersion: string;
  rtkCommit: typeof HUSH_RTK_BASELINE.commit;
  scores: readonly HushProjectionScore[];
  passes: boolean;
}>;

async function createScorecard(): Promise<HushProjectionScorecard> {
  const rtk = Bun.which("rtk");
  if (rtk === null) {
    throw new Error("hush projection scorecard requires a local rtk binary");
  }
  const root = await mkdtemp(join(tmpdir(), "falryn-hush-projections-"));
  try {
    const fixtureBin = await createFixtureCommands(root);
    await createListingCorpus(root);
    await writeFile(
      join(root, "fixture.txt"),
      "# Falryn\n\nDo more with less context.\nKeep every useful fact.\n",
    );
    await writeFile(
      join(root, "config.json"),
      `${JSON.stringify(
        {
          serviceName: "falryn-private-value",
          enabled: true,
          targets: [
            { os: "darwin-private", arch: "arm64-private" },
            { os: "linux-private", arch: "x64-private" },
          ],
          metadata: { owner: "owner-private", nested: { marker: "deep-private" } },
          ports: [3000, 3001, 3002],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(root, "diff-before.ts"),
      [
        "export function project() {",
        '  const mode = "sample";',
        "  const marker = 736;",
        "  return mode;",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "diff-after.ts"),
      [
        "export function project() {",
        '  const mode = "complete";',
        "  const marker = 736;",
        "  const exact = true;",
        '  return exact ? mode : "sample";',
        "}",
        "",
      ].join("\n"),
    );
    const versionRun = runCommand([rtk, "--version"], root, fixtureBin);
    if (versionRun.exitCode !== 0) {
      throw new Error(`rtk --version failed: ${versionRun.stderr.trim()}`);
    }

    const scores: HushProjectionScore[] = [];
    const cases: readonly ProjectionCase[] = HUSH_PROJECTION_CASES;
    for (const [index, fixture] of cases.entries()) {
      const executable = projectionExecutable(fixture, fixtureBin);
      const command =
        fixture.shellCommand === undefined
          ? ({
              executable,
              argv: fixture.argv,
              environment: {},
              cwd: root,
              timeoutMs: duration(10_000),
              maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
            } as const)
          : ({
              mode: "bash",
              executable,
              command: fixture.shellCommand,
              environment: {},
              cwd: root,
              timeoutMs: duration(10_000),
              maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
            } as const);
      const prepared = prepareHushCaptureRequest(command);
      const raw =
        prepared.mode === "bash"
          ? runCommand([prepared.executable, "-c", prepared.command], root, fixtureBin)
          : runCommand([prepared.executable, ...prepared.argv], root, fixtureBin);
      const baseline = runBaseline(fixture, raw, rtk, executable, root, fixtureBin);
      const acceptedExitCodes = fixture.acceptedExitCodes ?? [0];
      if (
        !acceptedExitCodes.includes(raw.exitCode) ||
        !acceptedExitCodes.includes(baseline.exitCode)
      ) {
        throw new Error(
          `${fixture.id} failed: raw=${raw.exitCode} rtk=${baseline.exitCode}\n${raw.stderr}${baseline.stderr}`,
        );
      }
      const reduced = reduceHush({
        command,
        capture: capture(`hush-projection-${index}`, raw),
      });
      if (!reduced.ok) {
        throw new Error(`${fixture.id} Hush reduction failed: ${reduced.error.reason}`);
      }
      const rawMeasurement = measureText(combinedOutput(raw));
      const rtkMeasurement = measureText(combinedOutput(baseline));
      const hushMeasurement = measureText(reduced.value.reducedText);
      const withinRtkBudget =
        hushMeasurement.bytes <= rtkMeasurement.bytes &&
        hushMeasurement.estimatedTokens <= rtkMeasurement.estimatedTokens;
      const competitiveTarget = fixture.competitiveTarget ?? "tie";
      const competitiveResult = !withinRtkBudget
        ? "loss"
        : hushMeasurement.bytes < rtkMeasurement.bytes &&
            hushMeasurement.estimatedTokens < rtkMeasurement.estimatedTokens
          ? "win"
          : "tie";
      const meetsCompetitiveTarget =
        competitiveTarget === "win" ? competitiveResult === "win" : competitiveResult !== "loss";
      const retainsRequiredContext = fixture.requiredMarkers.every((marker) =>
        reduced.value.reducedText.includes(marker),
      );
      const excludesKnownNoise = (fixture.forbiddenMarkers ?? []).every(
        (marker) => !reduced.value.reducedText.includes(marker),
      );
      const noArbitraryCap =
        !reduced.value.truncated &&
        !reduced.value.omissions.some((omission) => omission.kind === "capped-bytes");
      const recognized =
        classifyCommand(command, capture(`classify-${index}`, raw)).projection ===
        fixture.projection;
      const passes =
        meetsCompetitiveTarget &&
        retainsRequiredContext &&
        excludesKnownNoise &&
        noArbitraryCap &&
        recognized;
      scores.push({
        id: fixture.id,
        projection: fixture.projection,
        gate: fixture.baseline ?? "rtk",
        raw: rawMeasurement,
        rtk: rtkMeasurement,
        hush: hushMeasurement,
        competitiveTarget,
        competitiveResult,
        meetsCompetitiveTarget,
        withinRtkBudget,
        retainsRequiredContext,
        excludesKnownNoise,
        noArbitraryCap,
        recognized,
        result: passes ? "PASS" : "FAIL",
      });
    }
    return {
      corpusVersion: HUSH_PROJECTION_CORPUS_VERSION,
      hushVersion: HUSH_REDUCER_VERSION,
      rtkVersion: versionRun.stdout.trim(),
      rtkCommit: HUSH_RTK_BASELINE.commit,
      scores,
      passes: scores.every((score) => score.result === "PASS"),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createListingCorpus(root: string): Promise<void> {
  await Promise.all(
    HUSH_FIND_LISTING_PATHS.map(async (path) => {
      const target = join(root, "corpus", "src", "domain", "hush", path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "export {};\n");
    }),
  );
}

export function formatHushProjectionScorecard(scorecard: HushProjectionScorecard): string {
  const headings = [
    "case",
    "gate",
    "goal",
    "raw",
    "ceiling",
    "hush",
    "delta",
    "race",
    "context",
    "result",
  ];
  const rows = scorecard.scores.map((score) => [
    score.id,
    score.gate,
    score.competitiveTarget,
    formatMeasurement(score.raw),
    formatMeasurement(score.rtk),
    formatMeasurement(score.hush),
    `${score.rtk.estimatedTokens - score.hush.estimatedTokens}t`,
    score.competitiveResult,
    score.retainsRequiredContext && score.excludesKnownNoise && score.noArbitraryCap
      ? "all"
      : "loss",
    score.result,
  ]);
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const formatRow = (row: readonly string[]): string =>
    row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("  ");
  return [
    `Hush projection scorecard ${scorecard.corpusVersion}`,
    `Hush ${scorecard.hushVersion} vs ${scorecard.rtkVersion} (${scorecard.rtkCommit})`,
    formatRow(headings),
    formatRow(widths.map((width) => "-".repeat(width))),
    ...rows.map(formatRow),
    `scorecard: ${scorecard.passes ? "PASS" : "FAIL"}`,
  ].join("\n");
}

async function createFixtureCommands(root: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const source = join(import.meta.dir, "fixtures", "hush-projection-command.ts");
  const fixtureSource = (await readFile(source, "utf8")).replace(
    /^#![^\n]+/u,
    `#!${process.execPath}`,
  );
  await Promise.all(
    [...new Set(HUSH_PROJECTION_CASES.map((fixture) => fixture.executable))]
      .filter((executable) => executable !== "bash")
      .map(async (executable) => {
        const target = join(bin, executable);
        await writeFile(target, fixtureSource);
        await chmod(target, 0o755);
      }),
  );
  return bin;
}

function projectionExecutable(fixture: ProjectionCase, fixtureBin: string): string {
  if (fixture.shellCommand !== undefined) {
    const bash = Bun.which("bash");
    if (bash === null) {
      throw new Error(`${fixture.id} requires bash`);
    }
    return bash;
  }
  return fixture.executable === "find"
    ? (Bun.which("find") ?? join(fixtureBin, fixture.executable))
    : join(fixtureBin, fixture.executable);
}

function runBaseline(
  fixture: ProjectionCase,
  raw: CommandRun,
  rtk: string,
  executable: string,
  cwd: string,
  fixtureBin: string,
): CommandRun {
  if (fixture.baseline === "raw") {
    return raw;
  }
  if (fixture.baseline === "rewrite") {
    const source = fixture.shellCommand;
    if (source === undefined) {
      throw new Error(`${fixture.id} rewrite baseline requires a shell command`);
    }
    const rewritten = runCommand([rtk, "rewrite", source], cwd, fixtureBin);
    if (rewritten.exitCode === 1) {
      return runCommand([executable, "-c", source], cwd, fixtureBin);
    }
    if (![0, 3].includes(rewritten.exitCode) || rewritten.stdout.trim().length === 0) {
      throw new Error(
        `${fixture.id} RTK rewrite failed: exit=${rewritten.exitCode} stdout=${JSON.stringify(rewritten.stdout)} stderr=${JSON.stringify(rewritten.stderr)}`,
      );
    }
    return runCommand([executable, "-c", rewritten.stdout.trim()], cwd, fixtureBin);
  }
  if (fixture.baseline === "rtk-log") {
    return runCommand([rtk, "log"], cwd, fixtureBin, raw.stdout);
  }
  if (fixture.rtkArgv === undefined) {
    throw new Error(`${fixture.id} requires RTK argv`);
  }
  return runCommand([rtk, ...fixture.rtkArgv], cwd, fixtureBin);
}

function runCommand(
  command: readonly string[],
  cwd: string,
  fixtureBin: string,
  stdin?: string,
): CommandRun {
  const result = Bun.spawnSync([...command], {
    cwd,
    env: {
      COLUMNS: "120",
      LC_ALL: "C",
      NO_COLOR: "1",
      PATH: `${fixtureBin}:${process.env.PATH ?? ""}`,
      FALRYN_HUSH_FIXTURE_CWD: cwd,
      ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
    },
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    exitCode: result.exitCode,
  };
}

function capture(id: string, run: CommandRun): ProcessCaptureReport {
  return {
    captureId: processCaptureId.from(id),
    pid: 1,
    startedAt: instant(1),
    endedAt: instant(2),
    durationMs: duration(1),
    stop: { kind: "exited" },
    killStage: "none",
    exit: { exitCode: run.exitCode, signal: null },
    stdout: stream("stdout", run.stdout),
    stderr: stream("stderr", run.stderr),
    events: [],
  };
}

function stream(name: "stdout" | "stderr", text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    stream: name,
    byteCount: bytes.byteLength,
    inlineBytes: bytes,
    inlineText: text,
    encoding: "utf-8" as const,
    truncated: false,
    omittedBytes: 0,
    maxLineExceeded: false,
    artifact: null,
  };
}

function formatMeasurement(measurement: HushLsMeasurement): string {
  return `${measurement.bytes}B/${measurement.estimatedTokens}t`;
}

function combinedOutput(run: CommandRun): string {
  const parts: string[] = [];
  if (run.stdout.length > 0) {
    parts.push(run.stdout);
  }
  if (run.stderr.length > 0) {
    parts.push(`stderr:\n${run.stderr}`);
  }
  return parts.join("\n");
}

if (import.meta.main) {
  const scorecard = await createScorecard();
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify(scorecard, null, 2)
      : formatHushProjectionScorecard(scorecard),
  );
  if (!scorecard.passes) {
    process.exitCode = 1;
  }
}
