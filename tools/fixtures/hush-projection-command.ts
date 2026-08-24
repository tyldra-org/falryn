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
      return [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,2 @@",
        "-const mode = 'sample';",
        "+const mode = 'complete';",
        " export const marker = 736;",
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
