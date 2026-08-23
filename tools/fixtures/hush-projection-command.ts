#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const executable = basename(Bun.argv[1] ?? "");
const args = Bun.argv.slice(2);

if (executable === "wget") {
  runWgetFixture(args);
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
  gh: () =>
    [
      "128\tOPEN\tContext engine groundwork\tpriority:P1",
      "736\tOPEN\tDo more with less context\tpriority:P0",
      "784\tOPEN\tComplete Hush projections\tpriority:P0",
    ].join("\n"),
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
if (executable === "curl") {
  process.stderr.write(
    "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n" +
      "                                 Dload  Upload   Total   Spent    Left  Speed\n" +
      "100   102  100   102    0     0   1020      0 --:--:-- --:--:-- --:--:--  1020\n",
  );
  process.stdout.write(`${output}\n`);
} else if (executable === "git" && gitSubcommand(args) === "push") {
  process.stderr.write(`${output}\n`);
} else {
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
    default:
      return [
        "Enumerating objects: 3, done.",
        "Writing objects: 100% (3/3), done.",
        "To github.com:yogeshprasad098/falryn.git",
        "   1111111..2222222  feature -> feature",
      ].join("\n");
  }
}

function gitSubcommand(argv: readonly string[]): string {
  return argv.find((argument) => !argument.startsWith("-")) ?? "";
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
