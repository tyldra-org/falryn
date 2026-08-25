#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const executable = basename(Bun.argv[1] ?? "");
const args = Bun.argv.slice(2);

if (executable === "wget") {
  runWgetFixture(args);
  process.exit(0);
}
if (executable === "sed") {
  runSedFixture(args);
  process.exit(0);
}
if (executable === "diff") {
  runDiffFixture(args);
  process.exit(1);
}

const outputs: Readonly<Record<string, () => string>> = {
  find: () => ["./src/main.ts", "./src/domain/hush.ts", "./docs/README.md"].join("\n"),
  cat: () => ["# Falryn", "", "Do more with less context.", "Keep every useful fact."].join("\n"),
  json: () => readFileSync(args[0] ?? "config.json", "utf8").trimEnd(),
  rg: () =>
    [
      "src/a.ts:10:first marker",
      "src/a.ts:20:second marker",
      "src/a.ts:30:third marker",
      "src/b.ts:7:fourth marker",
    ].join("\n"),
  git: () => gitOutput(args),
  gh: () => ghOutput(args),
  glab: () => glabOutput(args),
  gt: () => graphiteOutput(args),
  jira: () => jiraOutput(args),
  pytest: () =>
    [
      "tests/test_hush.py::test_complete PASSED",
      "tests/test_hush.py::test_budget PASSED",
      "2 passed in 0.12s",
    ].join("\n"),
  tsc: () =>
    [
      "src/a.ts(10,4): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/b.ts(20,8): error TS2304: Cannot find name 'missing'.",
      "Found 2 errors in 2 files.",
    ].join("\n"),
  cargo: () => `${"Compiling falryn v0.1.0\n".repeat(6)}Finished release target in 0.42s`,
  npm: () => npmOutput(args),
  pnpm: () => pnpmOutput(args),
  yarn: () => yarnOutput(args),
  npx: () => packageRunnerOutput(),
  pnpx: () => packageRunnerOutput(),
  docker: () => dockerOutput(args),
  wc: () => wcOutput(args),
  psql: () => psqlOutput(args),
  sqlite3: () => sqliteOutput(args),
  df: () =>
    [
      "Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on",
      "/dev/disk3s5   460Gi   147Gi   290Gi    34%    1.7M  3.0G    0%   /System/Volumes/Data",
    ].join("\n"),
  du: () => "319M\t.",
  ps: () => ["  PID  PPID STAT COMM", "49114 41183 Ss   bun"].join("\n"),
  stat: () =>
    [
      '  File: "package.json"',
      "  Size: 2527         FileType: Regular File",
      "  Mode: (0644/-rw-r--r--)         Uid: (  501/yogeshprasad)  Gid: (   20/   staff)",
      "Device: 1,15   Inode: 32125206    Links: 1",
      "Access: Mon Aug 24 01:55:42 2026",
      "Modify: Sun Aug 23 05:26:48 2026",
      "Change: Sun Aug 23 05:26:48 2026",
      " Birth: Fri Aug 21 19:55:14 2026",
    ].join("\n"),
  systemctl: () =>
    [
      "● falryn.service - Falryn agent",
      "     Loaded: loaded (/etc/systemd/system/falryn.service; enabled; preset: enabled)",
      "     Active: active (running) since Mon 2026-08-24 10:00:00 PDT; 2h 30min ago",
      "   Main PID: 736 (falryn)",
      "      Tasks: 8 (limit: 1024)",
      "     Memory: 42.0M",
      "        CPU: 1.234s",
      "     CGroup: /system.slice/falryn.service",
      "             └─736 /usr/local/bin/falryn",
    ].join("\n"),
  journalctl: () =>
    [
      "Aug 24 10:00:00 falryn-host falryn[736]: INFO session started session=demo",
      "Aug 24 10:00:01 falryn-host falryn[736]: INFO context engine ready reducers=82",
      "Aug 24 10:00:02 falryn-host falryn[736]: INFO waiting for provider",
      "Aug 24 10:00:02 falryn-host falryn[736]: INFO waiting for provider",
      "Aug 24 10:00:02 falryn-host falryn[736]: INFO waiting for provider",
      "Aug 24 10:00:03 falryn-host falryn[736]: WARN reducer fallback command=unknown",
      "Aug 24 10:00:04 falryn-host falryn[736]: ERROR capture unavailable id=cap-42",
      "Aug 24 10:00:05 falryn-host falryn[736]: INFO request complete tokens=219",
    ].join("\n"),
  curl: () =>
    JSON.stringify(
      {
        status: "ok",
        requestId: "req-736",
        result: { reducers: 81, complete: true },
      },
      null,
      2,
    ),
  ssh: () => ["connected example.test", "remote command: ok"].join("\n"),
  terraform: () =>
    [
      "Terraform will perform the following actions:",
      "  # falryn_context.primary will be updated in-place",
      '  ~ resource "falryn_context" "primary"',
      "Plan: 0 to add, 1 to change, 0 to destroy.",
    ].join("\n"),
  aws: () =>
    JSON.stringify(
      {
        Account: "123456789012",
        Arn: "arn:aws:iam::123456789012:user/falryn",
        UserId: "AIDAEXAMPLE",
      },
      null,
      2,
    ),
};

function npmOutput(argv: readonly string[]): string {
  const action = argv[0] ?? "";
  if (["install", "i", "ci"].includes(action)) {
    return [
      "added 12 packages, and audited 13 packages in 1s",
      "",
      "2 packages are looking for funding",
      "  run `npm fund` for details",
      "",
      "found 0 vulnerabilities",
    ].join("\n");
  }
  if (action === "list" || action === "ls") {
    return [
      "falryn@0.3.0 /workspace",
      "├── @falryn/context@0.3.0",
      "├── zod@4.0.0",
      "└── typescript@5.9.2",
    ].join("\n");
  }
  if (action === "outdated") {
    return [
      "Package          Current  Wanted  Latest  Location                       Depended by",
      "@falryn/context  0.2.0    0.2.5   0.3.0   node_modules/@falryn/context  falryn",
      "zod              3.24.0   3.25.0  4.0.0   node_modules/zod              falryn",
    ].join("\n");
  }
  if (action === "run" || action === "run-script") {
    return [
      "> falryn@0.3.0 verify",
      "> node tools/verify-packages.mjs",
      "",
      "checking package graph",
      "verified 12 packages",
    ].join("\n");
  }
  throw new Error(`unsupported npm fixture arguments: ${argv.join(" ")}`);
}

function pnpmOutput(argv: readonly string[]): string {
  const action = argv.find((argument) => ["install", "list", "outdated", "run"].includes(argument));
  if (action === "install") {
    return [
      "Progress: resolved 12, reused 10, downloaded 2, added 3",
      "Packages: +3",
      "+++",
      "Progress: resolved 12, reused 10, downloaded 2, added 3, done",
      "",
      "dependencies:",
      "+ @falryn/context 0.3.0",
      "+ zod 4.0.0",
      "",
      "devDependencies:",
      "+ typescript 5.9.2",
      "",
      "Done in 1.2s using pnpm v11.0.0",
    ].join("\n");
  }
  if (action === "list") {
    if (argv.includes("--json") || argv.some((argument) => argument.startsWith("--json="))) {
      return JSON.stringify([
        {
          name: "falryn",
          version: "0.3.0",
          dependencies: {
            "@falryn/context": { version: "0.3.0" },
            zod: { version: "4.0.0" },
          },
          devDependencies: { typescript: { version: "5.9.2" } },
        },
      ]);
    }
    return [
      "Legend: production dependency, optional only, dev only",
      "",
      "falryn@0.3.0 /workspace",
      "",
      "dependencies:",
      "@falryn/context 0.3.0",
      "zod 4.0.0",
      "",
      "devDependencies:",
      "typescript 5.9.2",
    ].join("\n");
  }
  if (action === "outdated") {
    if (argv.includes("json")) {
      return JSON.stringify({
        "@falryn/context": {
          current: "0.2.0",
          wanted: "0.2.5",
          latest: "0.3.0",
          dependencyType: "dependencies",
        },
        zod: {
          current: "3.24.0",
          wanted: "3.25.0",
          latest: "4.0.0",
          dependencyType: "dependencies",
        },
      });
    }
    return [
      "Package          Current  Wanted  Latest  Package Type",
      "@falryn/context  0.2.0    0.2.5   0.3.0   dependencies",
      "zod              3.24.0   3.25.0  4.0.0   dependencies",
    ].join("\n");
  }
  if (action === "run") {
    return [
      "> falryn@0.3.0 verify /workspace",
      "> node tools/verify-packages.mjs",
      "",
      "checking package graph",
      "verified 12 packages",
    ].join("\n");
  }
  throw new Error(`unsupported pnpm fixture arguments: ${argv.join(" ")}`);
}

function yarnOutput(argv: readonly string[]): string {
  const action = argv[0] ?? "";
  if (action === "install") {
    return [
      "yarn install v1.22.22",
      "[1/4] Resolving packages...",
      "[2/4] Fetching packages...",
      "[3/4] Linking dependencies...",
      "[4/4] Building fresh packages...",
      "success Saved lockfile.",
      "success Saved 2 new dependencies.",
      "info Direct dependencies",
      "└─ @falryn/context@0.3.0",
      "info All dependencies",
      "├─ @falryn/context@0.3.0",
      "└─ typescript@5.9.2",
      "Done in 2.14s.",
    ].join("\n");
  }
  if (action === "list") {
    return [
      "yarn list v1.22.22",
      "├─ @falryn/context@0.3.0",
      "├─ zod@4.0.0",
      "└─ typescript@5.9.2",
      "Done in 0.21s.",
    ].join("\n");
  }
  if (action === "outdated") {
    return [
      "Package          Current  Wanted  Latest  Package Type  URL",
      "@falryn/context  0.2.0    0.2.5   0.3.0   dependencies  https://example.test/context",
      "zod              3.24.0   3.25.0  4.0.0   dependencies  https://example.test/zod",
    ].join("\n");
  }
  if (action === "run") {
    return [
      "yarn run v1.22.22",
      "$ node tools/verify-packages.mjs",
      "checking package graph",
      "verified 12 packages",
      "Done in 0.18s.",
    ].join("\n");
  }
  throw new Error(`unsupported yarn fixture arguments: ${argv.join(" ")}`);
}

function packageRunnerOutput(): string {
  return [
    "checking package graph",
    "checking package graph",
    "checking package graph",
    "verified 12 packages",
  ].join("\n");
}

const output = outputs[executable]?.();
if (output === undefined) {
  process.stderr.write(`unsupported projection fixture executable: ${executable}\n`);
  process.exit(2);
}

function wcOutput(argv: readonly string[]): string {
  const signature = argv.join("\0");
  if (signature === ["-l", "-w", "-c", "src/domain/hush/reducers/log/format.ts"].join("\0")) {
    return "     127     384    3268 src/domain/hush/reducers/log/format.ts";
  }
  if (
    signature ===
    ["src/domain/hush/reducers/log/format.ts", "src/domain/hush/reducers/log/projection.ts"].join(
      "\0",
    )
  ) {
    return [
      "     127     384    3268 src/domain/hush/reducers/log/format.ts",
      "      32     131    1251 src/domain/hush/reducers/log/projection.ts",
      "     159     515    4519 total",
    ].join("\n");
  }
  throw new Error(`unsupported wc fixture arguments: ${argv.join(" ")}`);
}

function psqlOutput(argv: readonly string[]): string {
  if (argv.includes("-x") || argv.includes("--expanded")) {
    return [
      "-[ RECORD 1 ]----------------",
      "id     | 101",
      "task   | Investigate latency",
      "status | active",
      "-[ RECORD 2 ]----------------",
      "id     | 102",
      "task   | Verify recovery",
      "status | done",
      "(2 rows)",
    ].join("\n");
  }
  return [
    " id | task                   | status  | token_savings",
    "----+------------------------+---------+--------------",
    "  1 | Optimize nested JSON   | done    |            32",
    "  2 | Preserve database rows | active  |             0",
    "  3 | Verify model context   | pending |            18",
    "(3 rows)",
  ].join("\n");
}

function sqliteOutput(argv: readonly string[]): string {
  if (argv.includes("-line")) {
    return [
      "    id = 1",
      "  task = Optimize JSON",
      "status = done",
      "",
      "    id = 2",
      "  task = Preserve rows",
      "status = active",
    ].join("\n");
  }
  if (argv.includes("-box")) {
    return [
      "┌────┬───────────────┬────────┐",
      "│ id │     task      │ status │",
      "├────┼───────────────┼────────┤",
      "│ 1  │ Optimize JSON │ done   │",
      "│ 2  │ Preserve rows │ active │",
      "└────┴───────────────┴────────┘",
    ].join("\n");
  }
  return [
    "id  task           status",
    "--  -------------  ------",
    "1   Optimize JSON  done  ",
    "2   Preserve rows  active",
  ].join("\n");
}

function runSedFixture(argv: readonly string[]): void {
  const printOnly = argv.includes("-n");
  const operands = argv.filter((argument) => argument !== "-n");
  const program = operands[0];
  const path = operands[1];
  if (program === undefined) {
    process.stderr.write("sed: missing command\n");
    process.exit(2);
  }
  const source = path === undefined ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  if (!printOnly) {
    process.stdout.write(source);
    return;
  }
  const range = /^(\d+)(?:,(\d+))?p$/u.exec(program);
  if (range === null) {
    process.stderr.write(`sed: unsupported fixture command: ${program}\n`);
    process.exit(2);
  }
  const start = Number.parseInt(range[1] ?? "1", 10);
  const end = Number.parseInt(range[2] ?? range[1] ?? "1", 10);
  const lines = source.split("\n");
  if (source.endsWith("\n")) {
    lines.pop();
  }
  const selected = lines.slice(Math.max(0, start - 1), end).join("\n");
  if (selected.length > 0) {
    process.stdout.write(`${selected}\n`);
  }
}

function runDiffFixture(argv: readonly string[]): void {
  if (argv.join("\0") !== ["-u", "diff-before.ts", "diff-after.ts"].join("\0")) {
    process.stderr.write(`diff: unsupported fixture arguments: ${argv.join(" ")}\n`);
    process.exit(2);
  }
  process.stdout.write(
    [
      "--- diff-before.ts\t2026-08-23 06:16:58",
      "+++ diff-after.ts\t2026-08-23 06:16:58",
      "@@ -1,5 +1,6 @@",
      " export function project() {",
      '-  const mode = "sample";',
      '+  const mode = "complete";',
      "   const marker = 736;",
      "+  const exact = true;",
      "-  return mode;",
      '+  return exact ? mode : "sample";',
      " }",
      "",
    ].join("\n"),
  );
}
if (executable === "curl") {
  process.stderr.write(
    "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n" +
      "                                 Dload  Upload   Total   Spent    Left  Speed\n" +
      "100   102  100   102    0     0   1020      0 --:--:-- --:--:-- --:--:--  1020\n",
  );
  process.stdout.write(`${output}\n`);
} else if (executable === "git" && ["checkout", "fetch", "push"].includes(gitSubcommand(args))) {
  process.stderr.write(`${output}\n`);
} else if (output.length > 0) {
  process.stdout.write(`${output}\n`);
}

function runWgetFixture(argv: readonly string[]): void {
  const url = argv.find((argument) => /^https?:\/\//u.test(argument));
  if (url === undefined) {
    process.stderr.write("wget: missing URL\n");
    process.exit(2);
  }
  const destination = wgetDestination(argv, url);
  if (destination !== "-") {
    writeFileSync(destination, "x".repeat(1_536));
  }
  process.stderr.write(
    [
      `--2026-08-23 12:00:00--  ${url}`,
      "Resolving example.test... 192.0.2.80",
      "Connecting to example.test|192.0.2.80|:443... connected.",
      "HTTP request sent, awaiting response... 200 OK",
      "Length: 1536 (1.5K) [application/gzip]",
      `Saving to: '${destination}'`,
      "",
      "     0K .                                                     100% 1.50M=0.001s",
      "",
      `2026-08-23 12:00:00 (1.50 MB/s) - '${destination}' saved [1536/1536]`,
      "",
    ].join("\n"),
  );
}

function wgetDestination(argv: readonly string[], url: string): string {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if ((argument === "-O" || argument === "--output-document") && argv[index + 1] !== undefined) {
      return argv[index + 1] ?? "index.html";
    }
    const inline = argument.match(/^(?:-O|--output-document=)(.+)$/u)?.[1];
    if (inline !== undefined) {
      return inline;
    }
  }
  const path = url.split(/[?#]/u, 1)[0] ?? url;
  return path.split("/").at(-1) || "index.html";
}

function gitOutput(argv: readonly string[]): string {
  const subcommand = gitSubcommand(argv);
  switch (subcommand) {
    case "status":
      return [
        "## main...origin/main [ahead 1]",
        " M src/domain/hush.ts",
        " M src/domain/hush/reducers/semantic.ts",
        "?? tools/hush-projection-scorecard.ts",
      ].join("\n");
    case "diff":
      if (argv.includes("--cached") && argv.includes("--shortstat")) {
        return "3 files changed, 10 insertions(+), 2 deletions(-)";
      }
      if (argv.includes("--stat")) {
        return [
          " src/a.ts   | 3 ++-",
          " src/new.ts | 2 ++",
          " 2 files changed, 4 insertions(+), 1 deletion(-)",
        ].join("\n");
      }
      if (argv.includes("--name-status")) {
        return ["M\tsrc/a.ts", "A\tsrc/new.ts"].join("\n");
      }
      if (argv.includes("src/large.ts")) {
        return largeGitDiffOutput();
      }
      return [
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
      ].join("\n");
    case "log":
      return argv.some((argument) => argument.startsWith("--pretty=format:%h "))
        ? rtkGitLogOutput()
        : nativeGitLogOutput();
    case "show":
      if (argv.includes("--no-patch")) {
        return "1111111 Preserve complete context (1 day ago) <Falryn>";
      }
      if (argv.includes("--stat") && argv.includes("--pretty=format:")) {
        return gitDiffStatOutput();
      }
      if (argv.includes("--pretty=format:")) {
        return completeGitDiffOutput();
      }
      return `${nativeGitLogOutput().split("\n\ncommit ", 1)[0] ?? ""}\n\n${completeGitDiffOutput()}`;
    case "add":
      return "";
    case "branch":
      return argv.includes("-a") || argv.includes("--all")
        ? ["  feature/736", "* main", "  remotes/origin/main", "  remotes/origin/release/v1"].join(
            "\n",
          )
        : ["  feature/736", "* main"].join("\n");
    case "checkout":
      return "Switched to branch 'feature/736'";
    case "commit":
      return [
        "[feature 2222222] Preserve complete context",
        " 3 files changed, 10 insertions(+), 2 deletions(-)",
      ].join("\n");
    case "fetch":
      return ["From github.com:tyldra-org/falryn", "   1111111..2222222  main -> origin/main"].join(
        "\n",
      );
    case "push":
      return [
        "Enumerating objects: 3, done.",
        "Writing objects: 100% (3/3), done.",
        "To github.com:yogeshprasad098/falryn.git",
        "   1111111..2222222  feature -> feature",
      ].join("\n");
    case "pull":
      return [
        "Updating 1111111..2222222",
        "Fast-forward",
        " src/a.ts | 8 +++++---",
        " src/b.ts | 2 ++",
        " src/c.ts | 2 --",
        " 3 files changed, 10 insertions(+), 2 deletions(-)",
      ].join("\n");
    case "stash":
      return argv.includes("list")
        ? [
            "stash@{0}: On main: Preserve complete context",
            "stash@{1}: WIP on feature/736: Keep every useful fact",
          ].join("\n")
        : "Saved working directory and index state On main: Preserve complete context";
    case "worktree":
      return [
        `${process.env.FALRYN_HUSH_FIXTURE_CWD ?? process.cwd()} 1111111 [main]`,
        `${process.env.FALRYN_HUSH_FIXTURE_CWD ?? process.cwd()}-review 2222222 [review/736]`,
      ].join("\n");
    default:
      return "";
  }
}

function nativeGitLogOutput(): string {
  return [
    "commit 1111111111111111111111111111111111111111",
    "Author: Falryn <falryn@example.com>",
    "Date:   Sat Aug 23 12:00:00 2026 -0700",
    "",
    "    Preserve complete context",
    "",
    "    Keep every requested commit.",
    "",
    "commit 2222222222222222222222222222222222222222",
    "Author: Context Agent <context@example.com>",
    "Date:   Mon Aug 24 06:34:25 2026 -0700",
    "",
    "    Keep every message fact",
    "",
    "commit 3333333333333333333333333333333333333333",
    "Author: Review Agent <review@example.com>",
    "Date:   Mon Aug 24 07:00:00 2026 -0700",
    "",
    "    Keep the final commit",
  ].join("\n");
}

function rtkGitLogOutput(): string {
  return [
    "1111111 Preserve complete context (1 day ago) <Falryn>",
    "Keep every requested commit.",
    "---END---",
    "2222222 Keep every message fact (2 hours ago) <Context Agent>",
    "---END---",
    "3333333 Keep the final commit (1 hour ago) <Review Agent>",
    "---END---",
  ].join("\n");
}

function completeGitDiffOutput(): string {
  return [
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
    "+export const reducer = 'git.show';",
  ].join("\n");
}

function gitDiffStatOutput(): string {
  return [
    " src/a.ts   | 3 ++-",
    " src/new.ts | 2 ++",
    " 2 files changed, 4 insertions(+), 1 deletion(-)",
  ].join("\n");
}

function gitSubcommand(argv: readonly string[]): string {
  return argv.find((argument) => !argument.startsWith("-")) ?? "";
}

function largeGitDiffOutput(): string {
  const removed = Array.from({ length: 80 }, (_, index) => `-before-${index + 1}`);
  const added = Array.from({ length: 80 }, (_, index) => `+after-${index + 1}`);
  return [
    "diff --git a/src/large.ts b/src/large.ts",
    "index 1111111..2222222 100644",
    "--- a/src/large.ts",
    "+++ b/src/large.ts",
    "@@ -1,82 +1,82 @@ complete section",
    " context-before",
    ...removed,
    ...added,
    " context-after",
  ].join("\n");
}

function ghOutput(argv: readonly string[]): string {
  const command = `${argv[0] ?? ""} ${argv[1] ?? ""}`;
  const json = argv.includes("--json");
  switch (command) {
    case "pr list": {
      const prs = [
        {
          number: 128,
          title: "Context engine groundwork",
          state: "OPEN",
          author: { login: "falryn-dev" },
          headRefName: "feat/context-engine",
          updatedAt: "2026-08-23T12:00:00Z",
        },
        {
          number: 736,
          title: "Do more with less context",
          state: "OPEN",
          author: { login: "yogeshprasad098" },
          headRefName: "perf/736-context-optimization",
          updatedAt: "2026-08-23T12:01:00Z",
        },
        {
          number: 784,
          title: "Complete Hush projections",
          state: "OPEN",
          author: { login: "yogeshprasad098" },
          headRefName: "perf/736-context-optimization",
          updatedAt: "2026-08-23T12:02:00Z",
        },
      ];
      return json
        ? JSON.stringify(prs)
        : prs
            .map(
              (pr) => `${pr.number}\t${pr.title}\t${pr.headRefName}\t${pr.state}\t${pr.updatedAt}`,
            )
            .join("\n");
    }
    case "pr view": {
      const pr = {
        number: 784,
        title: "Complete Hush projections",
        state: "OPEN",
        author: { login: "yogeshprasad098" },
        body: "## Outcome\n\nPreserve every useful PR fact.\n\n- No list truncation\n- Hush-native output",
        url: "https://github.com/tyldra-org/falryn/pull/784",
        mergeable: "MERGEABLE",
        reviews: [{ state: "APPROVED" }],
        statusCheckRollup: [
          { name: "TypeScript", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "Tests", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "CodeQL", status: "COMPLETED", conclusion: "FAILURE" },
        ],
        labels: [{ name: "area: context" }],
        assignees: [{ login: "yogeshprasad098" }],
        headRefName: "perf/736-context-optimization",
        baseRefName: "main",
        additions: 120,
        deletions: 24,
      };
      return json
        ? JSON.stringify(pr)
        : [
            `title:\t${pr.title}`,
            `state:\t${pr.state}`,
            "author:\tyogeshprasad098 (Yogesh Prasad)",
            "labels:\tarea: context",
            "assignees:\tyogeshprasad098",
            `number:\t${pr.number}`,
            `url:\t${pr.url}`,
            `additions:\t${pr.additions}`,
            `deletions:\t${pr.deletions}`,
            "--",
            pr.body,
          ].join("\n");
    }
    case "issue list": {
      const issues = [
        [809, "Implement live browser supervision, screencast, and human takeover"],
        [808, "Implement browser diagnostics, testing, accessibility, and performance tools"],
        [807, "Qualify local and remote browser adapters, installation, and readiness"],
        [806, "Expose Falryn capabilities to external agent hosts through a bounded MCP bridge"],
        [805, "Harden registered LSP and DAP tools with strict contracts and live edit feedback"],
        [804, "Qualify optional semantic retrieval beyond lexical, precise, and graph baselines"],
        [803, "Persist code relationships and build token-budgeted repository maps"],
        [802, "Wire precise LSP intelligence and structural search into product retrieval"],
        [801, "Make workspace index root-qualified, incremental, and FTS5-queryable"],
        [800, "Qualify optional native acceleration kernels behind TypeScript contracts"],
        [
          798,
          "Wire provider connections and authorized authentication through product entrypoints",
        ],
        [797, "Implement durable goals and bounded iterative loop control"],
        [796, "Expose per-command raw-output mode for process tools"],
        [795, "Add safe worktree create and remove actions to the Git dashboard"],
        [794, "Complete durable session naming and pinning in OpenTUI"],
        [793, "Implement bounded transcript and conversation search"],
        [792, "Expose manual history compact, checkpoint restore, and durable undo controls"],
        [791, "Make semantic session history artifact-complete and forensically recoverable"],
        [790, "Implement registry-driven slash completion and command aliases"],
        [789, "Implement Ask, Plan, Debug, and Agent execution profiles"],
      ].map(([number, title], index) => ({
        number,
        title,
        state: "OPEN",
        labels: [{ name: index % 2 === 0 ? "priority:P0" : "priority:P1" }],
        updatedAt: `2026-08-23T12:${String(index).padStart(2, "0")}:00Z`,
      }));
      return json
        ? JSON.stringify(issues)
        : issues
            .map(
              (issue) =>
                `${issue.number}\t${issue.state}\t${issue.title}\t${issue.labels
                  .map((label) => label.name)
                  .join(", ")}\t${issue.updatedAt}`,
            )
            .join("\n");
    }
    case "run list": {
      const runs = [
        {
          databaseId: 32601,
          status: "completed",
          conclusion: "skipped",
        },
        { databaseId: 32602, status: "completed", conclusion: "skipped" },
        { databaseId: 32603, status: "completed", conclusion: "skipped" },
        { databaseId: 32604, status: "completed", conclusion: "skipped" },
        { databaseId: 32605, status: "completed", conclusion: "skipped" },
        { databaseId: 32606, status: "completed", conclusion: "cancelled" },
        { databaseId: 32607, status: "completed", conclusion: "cancelled" },
        { databaseId: 32608, status: "completed", conclusion: "success" },
        { databaseId: 32609, status: "completed", conclusion: "failure" },
        { databaseId: 32610, status: "in_progress", conclusion: "" },
      ].map((run, index) => ({
        ...run,
        name: "Issue governance",
        workflowName: "Issue governance",
        createdAt: `2026-08-23T12:${String(index).padStart(2, "0")}:00Z`,
      }));
      return json
        ? JSON.stringify(runs)
        : runs
            .map(
              (run) =>
                `${run.status}\t${run.conclusion}\tHush projection validation\t${run.workflowName}\tperf/736-context-optimization\tpull_request\t${run.databaseId}\t1m\t${run.createdAt}`,
            )
            .join("\n");
    }
    case "repo view": {
      const repository = {
        name: "falryn",
        nameWithOwner: "tyldra-org/falryn",
        owner: { login: "tyldra-org" },
        visibility: "PUBLIC",
        isPrivate: false,
        isArchived: false,
        description: "A local terminal coding agent built with Bun, TypeScript, and OpenTUI.",
        stargazerCount: 2,
        forkCount: 1,
        url: "https://github.com/tyldra-org/falryn",
      };
      return json
        ? JSON.stringify(repository)
        : [
            "name:\ttyldra-org/falryn",
            "description:\tA local terminal coding agent built with Bun, TypeScript, and OpenTUI.",
            "--",
            "# Falryn",
            "A local terminal coding agent for deliberate, inspectable work.",
          ].join("\n");
    }
    case "api repos/tyldra-org/falryn":
      return JSON.stringify({ name: "falryn", private: false, default_branch: "main" });
    case "release list": {
      const releases = [
        {
          tagName: "v0.2.0",
          name: "Falryn 0.2.0",
          isLatest: true,
          isDraft: false,
          isPrerelease: false,
          publishedAt: "2026-08-24T12:00:00Z",
          createdAt: "2026-08-24T11:00:00Z",
        },
        {
          tagName: "v0.3.0-beta",
          name: "Falryn 0.3 beta",
          isLatest: false,
          isDraft: false,
          isPrerelease: true,
          publishedAt: "2026-08-23T12:00:00Z",
          createdAt: "2026-08-23T11:00:00Z",
        },
      ];
      return json
        ? JSON.stringify(releases)
        : [
            "Falryn 0.2.0\tLatest\tv0.2.0\t2026-08-24T12:00:00Z",
            "Falryn 0.3 beta\tPre-release\tv0.3.0-beta\t2026-08-23T12:00:00Z",
          ].join("\n");
    }
    default:
      return "";
  }
}

function glabOutput(argv: readonly string[]): string {
  const command = `${argv[0] ?? ""} ${argv[1] ?? ""}`;
  const json = outputValue(argv) === "json";
  switch (command) {
    case "mr list": {
      const mergeRequests = [
        {
          iid: 128,
          title: "Context engine groundwork",
          state: "opened",
          source_branch: "feat/context-engine",
          target_branch: "main",
          author: { username: "falryn-dev" },
          web_url: "https://gitlab.example/tyldra/falryn/-/merge_requests/128",
        },
        {
          iid: 736,
          title: "Do more with less context",
          state: "opened",
          source_branch: "perf/736-context-optimization",
          target_branch: "main",
          author: { username: "yogeshprasad098" },
          web_url: "https://gitlab.example/tyldra/falryn/-/merge_requests/736",
        },
        {
          iid: 784,
          title: "Complete Hush projections",
          state: "opened",
          source_branch: "perf/736-context-optimization",
          target_branch: "main",
          author: { username: "yogeshprasad098" },
          web_url: "https://gitlab.example/tyldra/falryn/-/merge_requests/784",
        },
      ];
      return json
        ? JSON.stringify(mergeRequests)
        : [
            "Showing 3 open merge requests on tyldra/falryn. (Page 1)",
            ...mergeRequests.map(
              (mr) =>
                `!${mr.iid} ${mr.title} (${mr.source_branch} -> ${mr.target_branch}) @${mr.author.username}`,
            ),
          ].join("\n");
    }
    case "issue list": {
      const issues = [
        {
          iid: 809,
          title: "Implement live browser supervision and human takeover",
          state: "opened",
          author: { username: "yogeshprasad098" },
          labels: ["priority:P0", "area: browser"],
          web_url: "https://gitlab.example/tyldra/falryn/-/issues/809",
        },
        {
          iid: 800,
          title: "Qualify optional native acceleration kernels",
          state: "opened",
          author: { username: "yogeshprasad098" },
          labels: ["priority:P1", "area: performance"],
          web_url: "https://gitlab.example/tyldra/falryn/-/issues/800",
        },
        {
          iid: 790,
          title: "Implement registry-driven slash completion",
          state: "opened",
          author: { username: "yogeshprasad098" },
          labels: ["priority:P1", "area: tui"],
          web_url: "https://gitlab.example/tyldra/falryn/-/issues/790",
        },
      ];
      return json
        ? JSON.stringify(issues)
        : [
            "Showing 3 open issues on tyldra/falryn. (Page 1)",
            ...issues.map(
              (issue) =>
                `#${issue.iid} ${issue.title} [${issue.labels.join(", ")}] @${issue.author.username}`,
            ),
          ].join("\n");
    }
    case "ci status": {
      const status = {
        pipeline: {
          id: 901,
          status: "failed",
          ref: "perf/736-context-optimization",
          sha: "abcdef0123456789abcdef0123456789abcdef01",
          web_url: "https://gitlab.example/tyldra/falryn/-/pipelines/901",
        },
        jobs: [
          {
            id: 1_001,
            name: "typecheck",
            stage: "verify",
            status: "success",
            allow_failure: false,
            failure_reason: "",
          },
          {
            id: 1_002,
            name: "tests",
            stage: "verify",
            status: "failed",
            allow_failure: false,
            failure_reason: "script_failure",
          },
          {
            id: 1_003,
            name: "codeql",
            stage: "security",
            status: "failed",
            allow_failure: true,
            failure_reason: "script_failure",
          },
        ],
      };
      return json
        ? JSON.stringify(status)
        : [
            "(success) • 32s  verify    typecheck",
            "(failed) • 1m12s verify    tests",
            "(failed) • 52s  security  codeql",
            "https://gitlab.example/tyldra/falryn/-/pipelines/901",
            "SHA: abcdef0123456789abcdef0123456789abcdef01",
            "Pipeline state: failed",
          ].join("\n");
    }
    case "pipeline list": {
      const pipelines = [
        {
          id: 901,
          status: "failed",
          ref: "perf/736-context-optimization",
          sha: "abcdef0123456789abcdef0123456789abcdef01",
          source: "push",
          name: "verify",
          web_url: "https://gitlab.example/tyldra/falryn/-/pipelines/901",
        },
        {
          id: 900,
          status: "success",
          ref: "main",
          sha: "1234567890abcdef1234567890abcdef12345678",
          source: "merge_request_event",
          name: "verify",
          web_url: "https://gitlab.example/tyldra/falryn/-/pipelines/900",
        },
      ];
      return json
        ? JSON.stringify(pipelines)
        : [
            "Showing 2 pipelines on tyldra/falryn. (Page 1)",
            "(failed) • #901 perf/736-context-optimization abcdef01 push",
            "(success) • #900 main 12345678 merge_request_event",
          ].join("\n");
    }
    case "api projects/736":
      return JSON.stringify({
        id: 736,
        path_with_namespace: "tyldra/falryn",
        visibility: "public",
      });
    case "release list": {
      const releases = [
        {
          tag_name: "v0.2.0",
          name: "Falryn 0.2.0",
          upcoming_release: false,
          released_at: "2026-08-24T12:00:00Z",
          created_at: "2026-08-24T11:00:00Z",
          _links: { self: "https://gitlab.example/tyldra/falryn/-/releases/v0.2.0" },
        },
        {
          tag_name: "v0.3.0-beta",
          name: "Falryn 0.3 beta",
          upcoming_release: true,
          released_at: "2026-09-01T12:00:00Z",
          created_at: "2026-08-24T12:00:00Z",
          _links: { self: "https://gitlab.example/tyldra/falryn/-/releases/v0.3.0-beta" },
        },
      ];
      return json
        ? JSON.stringify(releases)
        : [
            "Showing 2 releases on tyldra/falryn.",
            "v0.2.0 Falryn 0.2.0 released 2026-08-24",
            "v0.3.0-beta Falryn 0.3 beta upcoming 2026-09-01",
          ].join("\n");
    }
    default:
      return "";
  }
}

function outputValue(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if ((argument === "--output" || argument === "-F" || argument === "-O") && argv[index + 1]) {
      return argv[index + 1] ?? null;
    }
    const inline = /^(?:--output|-F|-O)=(.+)$/u.exec(argument)?.[1];
    if (inline !== undefined) {
      return inline;
    }
  }
  return null;
}

function graphiteOutput(argv: readonly string[]): string {
  switch (argv[0]) {
    case "log":
      return [
        "◉ feature/top (current)",
        "│ 8 seconds ago",
        "│",
        "│ 95338df - Preserve complete context",
        "│",
        "◯ feature/base",
        "│ 2 minutes ago",
        "│",
        "│ 95610c6 - Build Hush forge reducers",
        "│",
        "◯ main",
        "│ 5 weeks ago",
      ].join("\n");
    case "submit":
      return [
        "🥞 Validating that this Graphite stack is ready to submit...",
        "📝 Preparing to submit PRs for the following branches...",
        "▸ feature/base (Create)",
        "▸ feature/top (Update)",
        "📨 Pushing to remote and creating/updating PRs...",
        "feature/base: https://app.graphite.dev/github/pr/example/repo/101 (created)",
        "feature/top: https://app.graphite.dev/github/pr/example/repo/102 (updated)",
      ].join("\n");
    case "sync":
      return [
        "🌲 Fetching latest changes from remote...",
        "main is up to date.",
        "🧹 Cleaning up merged branches...",
        "Deleted feature/merged (PR #98 was merged).",
        "🔄 Restacking branches...",
        "Restacked feature/base on main.",
        "Restacked feature/top on feature/base.",
      ].join("\n");
    case "restack":
      return [
        "🔄 Restacking branches...",
        "Restacked feature/base on main.",
        "Restacked feature/top on feature/base.",
      ].join("\n");
    case "create":
      return [
        "Created branch feature/demo on main.",
        "[feature/demo abc1234] Preserve complete context",
        " 2 files changed, 6 insertions(+), 1 deletion(-)",
      ].join("\n");
    case "branch":
      return ["◉ feature/top (current)", "◯ feature/base", "◯ main"].join("\n");
    default:
      return "";
  }
}

function jiraOutput(argv: readonly string[]): string {
  const command = `${argv[0] ?? ""} ${argv[1] ?? ""}`;
  switch (command) {
    case "issue list":
      return [
        "TYPE   KEY      SUMMARY                              STATUS       ASSIGNEE       REPORTER       PRIORITY  RESOLUTION  CREATED              UPDATED              LABELS",
        "Task   FAL-736  Optimize context engines             In Progress  Yogesh Prasad  Yogesh Prasad  High                  2026-08-23 10:15:00  2026-08-25 09:40:00  context,performance",
        "Bug    FAL-788  Wire live index candidates           To Do        Yogesh Prasad  Yogesh Prasad  Highest               2026-08-24 08:30:00  2026-08-25 08:55:00  index,context",
        "Story  FAL-806  Expose bounded capability bridge     Done         Yogesh Prasad  Yogesh Prasad  Normal    Fixed       2026-08-24 14:20:00  2026-08-25 07:15:00  mcp,capability",
      ].join("\n");
    case "issue view":
      return [
        "Task  In Progress  Sun, 23 Aug 26  Yogesh Prasad  FAL-736  3 comments  2 linked",
        "# Optimize context engines",
        "Tue, 25 Aug 26  Yogesh Prasad  High  Context Platform  context, performance",
        "",
        "------------------------ Description ------------------------",
        "",
        "Make Hush, Loom, Brief, indexing, and context packing preserve every useful fact while reducing total turn cost.",
        "",
        "------------------------ 2 Subtasks ------------------------",
        "",
        "FAL-788 Wire live index candidates • Highest • To Do",
        "FAL-806 Expose bounded capability bridge • Normal • Done",
        "",
        "View this issue on Jira: https://jira.example.test/browse/FAL-736",
      ].join("\n");
    default:
      return "";
  }
}

function dockerOutput(argv: readonly string[]): string {
  if (argv[0] === "logs") {
    return [
      "2026-08-23T12:00:00Z service started",
      "2026-08-23T12:00:01Z request=req-736 status=ok",
      "2026-08-23T12:00:02Z request=req-784 status=ok",
    ].join("\n");
  }
  if (argv.includes("--format")) {
    return [
      "abc123\tfalryn-dev\tUp 2 minutes\tfalryn:dev\t",
      "def456\tfalryn-db\tUp 2 minutes\tpostgres:17\t",
    ].join("\n");
  }
  return [
    "CONTAINER ID   IMAGE          STATUS          NAMES",
    "abc123         falryn:dev     Up 2 minutes    falryn-dev",
    "def456         postgres:17    Up 2 minutes    falryn-db",
  ].join("\n");
}
