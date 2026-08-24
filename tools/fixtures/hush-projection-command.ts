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
  npm: () =>
    [
      "added 12 packages, and audited 13 packages in 1s",
      "2 packages are looking for funding",
      "found 0 vulnerabilities",
    ].join("\n"),
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
} else if (executable === "git" && gitSubcommand(args) === "push") {
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
      return [
        "commit 1111111111111111111111111111111111111111",
        "Author: Falryn <falryn@example.com>",
        "Date:   Sat Aug 23 12:00:00 2026 -0700",
        "",
        "    Preserve complete context",
      ].join("\n");
    case "add":
      return "";
    case "commit":
      return [
        "[feature 2222222] Preserve complete context",
        " 3 files changed, 10 insertions(+), 2 deletions(-)",
      ].join("\n");
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
    default:
      return "";
  }
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
        {
          number: 128,
          title: "Context engine groundwork",
          state: "OPEN",
          labels: [{ name: "priority:P1" }],
          updatedAt: "2026-08-23T12:00:00Z",
        },
        {
          number: 736,
          title: "Do more with less context",
          state: "OPEN",
          labels: [{ name: "priority:P0" }],
          updatedAt: "2026-08-23T12:01:00Z",
        },
        {
          number: 784,
          title: "Complete Hush projections",
          state: "OPEN",
          labels: [{ name: "priority:P0" }],
          updatedAt: "2026-08-23T12:02:00Z",
        },
      ];
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
          name: "CI",
          workflowName: "CI",
          status: "completed",
          conclusion: "success",
          createdAt: "2026-08-23T12:00:00Z",
        },
        {
          databaseId: 32602,
          name: "CodeQL",
          workflowName: "CodeQL",
          status: "completed",
          conclusion: "failure",
          createdAt: "2026-08-23T12:01:00Z",
        },
        {
          databaseId: 32603,
          name: "Platform tests",
          workflowName: "Platform tests",
          status: "in_progress",
          conclusion: "",
          createdAt: "2026-08-23T12:02:00Z",
        },
      ];
      return json
        ? JSON.stringify(runs)
        : runs
            .map(
              (run) =>
                `${run.status}\t${run.conclusion}\tHush projection validation\t${run.workflowName}\tperf/736-context-optimization\tpull_request\t${run.databaseId}\t1m\t${run.createdAt}`,
            )
            .join("\n");
    }
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
