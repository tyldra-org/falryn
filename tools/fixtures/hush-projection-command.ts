#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { cloudFixtureOutput } from "./hush-cloud-output.ts";
import { curlFixtureOutput, wgetFixtureOutput } from "./hush-http-output.ts";
import { infrastructureFixtureOutput } from "./hush-infra-output.ts";
import { networkFixtureOutput } from "./hush-network-output.ts";

const executable = basename(Bun.argv[1] ?? "");
const args = Bun.argv.slice(2);

if (executable === "curl" || executable === "wget") {
  const result = executable === "curl" ? curlFixtureOutput(args) : wgetFixtureOutput(args);
  if (result.download !== null)
    writeFileSync(result.download.path, "x".repeat(result.download.bytes));
  if (result.stdout.length > 0) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
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
  test: () => genericTestOutput(),
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
  jest: () => jestOutput(args),
  vitest: () => vitestOutput(args),
  playwright: () => playwrightOutput(args),
  mocha: () => mochaOutput(),
  pytest: () => pytestOutput(),
  python: () => pythonOutput(args),
  go: () => goOutput(args),
  gradle: () => gradleOutput(args),
  gradlew: () => gradleOutput(args),
  mvn: () => mavenOutput(args),
  mvnw: () => mavenOutput(args),
  sbt: () => sbtOutput(args),
  dotnet: () => dotnetOutput(args),
  swift: () => swiftOutput(args),
  xcodebuild: () => xcodeOutput(args),
  php: () => phpWrapperOutput(args),
  phpunit: () => phpunitOutput(),
  pest: () => pestOutput(),
  paratest: () => paratestOutput(),
  rake: () => minitestOutput(),
  rails: () => minitestOutput(),
  rspec: () => rspecOutput(args),
  format: () => genericFormatOutput(),
  lint: () => genericLintOutput(),
  biome: () => biomeOutput(),
  eslint: () => eslintOutput(),
  oxlint: () => oxlintOutput(),
  prettier: () => prettierOutput(),
  clippy: () => rustDiagnosticOutput(),
  mypy: () => mypyOutput(),
  ruff: () => ruffOutput(args),
  "golangci-lint": () => golangciOutput(args),
  golangci: () => golangciOutput(args),
  mix: () => mixCommandOutput(args),
  phpstan: () => phpstanOutput(args),
  ecs: () => ecsOutput(),
  pint: () => pintOutput(args),
  rubocop: () => rubocopOutput(args),
  "pre-commit": () => precommitOutput(),
  hadolint: () => hadolintOutput(),
  markdownlint: () => markdownlintOutput(),
  shellcheck: () => shellcheckOutput(),
  yamllint: () => yamllintOutput(),
  err: () => errOutput(args),
  build: () => genericBuildOutput(args),
  next: () => nextBuildOutput(),
  nx: () => nxBuildOutput(),
  turbo: () => turboBuildOutput(),
  prisma: () => prismaOutput(args),
  gcc: () => compilerBuildOutput("main.c"),
  "g++": () => compilerBuildOutput("main.cpp"),
  pio: () => platformIoBuildOutput(),
  quarto: () => quartoBuildOutput(),
  trunk: () => trunkBuildOutput(),
  podman: () => podmanOutput(args),
  skopeo: () => skopeoOutput(args),
  kubectl: () => kubernetesOutput("kubectl", args),
  oc: () => kubernetesOutput("oc", args),
  just: () => taskRunnerBuildOutput("$ build"),
  mise: () => taskRunnerBuildOutput("[build] $ build"),
  task: () => taskRunnerBuildOutput("task: [build] build"),
  make: () => taskRunnerBuildOutput("make: Entering directory '/workspace'"),
  shopify: () => shopifyOutput(args),
  ollama: () => ollamaOutput(args),
  java: () => javaOutput(args),
  tsc: () =>
    [
      "src/a.ts(10,4): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/b.ts(20,8): error TS2304: Cannot find name 'missing'.",
      "Found 2 errors in 2 files.",
    ].join("\n"),
  basedpyright: () =>
    [
      "basedpyright 1.22.0",
      "Searching for source files",
      "Found 42 source files",
      "",
      "/workspace/app/main.py",
      '  /workspace/app/main.py:10:5 - error: "foo" is not defined (reportUndefinedVariable)',
      '  /workspace/app/main.py:25:1 - error: Type "str" is not assignable to type "int" (reportAssignmentType)',
      "",
      "/workspace/app/utils.py",
      '  /workspace/app/utils.py:8:9 - warning: Variable "x" is not accessed (reportUnusedVariable)',
      "",
      "2 errors, 1 warning, 0 informations",
    ].join("\n"),
  ty: () =>
    [
      "ty 0.1.0",
      "Checking 15 files",
      "",
      "error[unresolved-reference]: Name `foo` used when not defined",
      "  --> app/main.py:10:5",
      "   |",
      "10 |     foo()",
      "   |     ^^^",
      "   |",
      "",
      "warning[unused-variable]: Variable `x` is not used",
      "  --> app/utils.py:8:9",
      "   |",
      " 8 |     x = 42",
      "   |     ^",
      "   |",
      "",
      "Found 1 error, 1 warning",
    ].join("\n"),
  cargo: () => cargoOutput(args),
  npm: () => npmOutput(args),
  pnpm: () => pnpmOutput(args),
  yarn: () => yarnOutput(args),
  bun: () => bunOutput(args),
  npx: () => npxOutput(args),
  pnpx: () => packageRunnerOutput(),
  pip: () => pipOutput(args),
  pip3: () => pipOutput(args),
  uv: () => uvOutput(args),
  poetry: () => poetryOutput(args),
  brew: () => brewOutput(args),
  composer: () => composerOutput(args),
  bundle: () => bundleOutput(args),
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
  ping: () => requiredNetworkOutput("ping", args),
  rsync: () => requiredNetworkOutput("rsync", args),
  ssh: () => requiredNetworkOutput("ssh", args),
  aws: () => requiredCloudOutput("aws", args),
  gcloud: () => requiredCloudOutput("gcloud", args),
  az: () => requiredCloudOutput("az", args),
  "ansible-playbook": () => requiredInfrastructureOutput("ansible-playbook", args),
  "fail2ban-client": () => requiredInfrastructureOutput("fail2ban-client", args),
  helm: () => requiredInfrastructureOutput("helm", args),
  iptables: () => requiredInfrastructureOutput("iptables", args),
  liquibase: () => requiredInfrastructureOutput("liquibase", args),
  pulumi: () => requiredInfrastructureOutput("pulumi", args),
  sops: () => requiredInfrastructureOutput("sops", args),
  terraform: () => requiredInfrastructureOutput("terraform", args),
  tofu: () => requiredInfrastructureOutput("tofu", args),
};

function requiredCloudOutput(executable: string, argv: readonly string[]): string {
  const output = cloudFixtureOutput(executable, argv);
  if (output === null) throw new Error(`unsupported cloud fixture executable: ${executable}`);
  return output;
}

function requiredInfrastructureOutput(executable: string, argv: readonly string[]): string {
  const output = infrastructureFixtureOutput(executable, argv);
  if (output === null)
    throw new Error(`unsupported infrastructure fixture executable: ${executable}`);
  return output;
}

function requiredNetworkOutput(executable: string, argv: readonly string[]): string {
  const output = networkFixtureOutput(executable, argv);
  if (output === null) throw new Error(`unsupported network fixture executable: ${executable}`);
  return output;
}

function genericTestOutput(): string {
  return [
    "Falryn custom runner v2",
    "running complete",
    "running budget",
    "Tests: 2 passed, 0 failed",
  ].join("\n");
}

function genericFormatOutput(): string {
  return "Formatting complete: 42 files checked, 42 unchanged.";
}

function genericBuildOutput(argv: readonly string[] = []): string {
  if (argv.includes("--fail")) return genericLintOutput();
  return [
    "Falryn build",
    "Build step 1/3: compile context engine",
    "Build step 2/3: bundle runtime",
    "Build step 3/3: write manifest",
    "Build complete: dist/falryn (1.2 MB) in 420 ms",
  ].join("\n");
}

function errOutput(argv: readonly string[]): string {
  if (argv[0] !== "build" || argv[1] !== "--fail") {
    throw new Error(`unsupported err fixture arguments: ${argv.join(" ")}`);
  }
  return [
    "src/runtime.ts:14:6: error BUILD001: Missing provider route.",
    "src/router.ts:28:3: warning BUILD002: Fallback route is not explicit.",
    "2 issues (1 error, 1 warning)",
  ].join("\n");
}

function nextBuildOutput(): string {
  return [
    "▲ Next.js 15.4.0",
    "Creating an optimized production build",
    "✓ Compiled successfully in 4.2s",
    "Collecting page data",
    "Generating static pages (2/2)",
    "Finalizing page optimization",
    "Route (app) Size First Load JS",
    "○ / 5.2kB 102kB",
    "ƒ /api/context 0B 97kB",
  ].join("\n");
}

function nxBuildOutput(): string {
  return [
    "NX Running target build for project falryn",
    "> nx run falryn:build",
    "output: dist/apps/falryn",
    "Successfully ran target build for project falryn (2.1s)",
  ].join("\n");
}

function turboBuildOutput(): string {
  return [
    "• Packages in scope: @falryn/app, @falryn/core",
    "• Running build in 2 packages",
    "• Remote caching disabled",
    "@falryn/core:build: cache miss, executing 2d736",
    "@falryn/core:build: built dist/core.js",
    "@falryn/app:build: cache miss, executing 784aa",
    "@falryn/app:build: built dist/app.js",
    "Tasks: 2 successful, 2 total",
    "Cached: 0 cached, 2 total",
    "Time: 1.2s",
  ].join("\n");
}

function prismaOutput(argv: readonly string[]): string {
  const prefix = [
    "Environment variables loaded from .env",
    "Prisma schema loaded from prisma/schema.prisma",
  ];
  if (argv[0] === "generate") {
    return [
      ...prefix,
      "✔ Generated Prisma Client (v6.14.0) to ./node_modules/@prisma/client in 123ms",
      "Start by importing your Prisma Client",
    ].join("\n");
  }
  if (argv[0] === "migrate" && argv[1] === "dev") {
    return [
      ...prefix,
      'Datasource "db": SQLite database "dev.db" at "file:./dev.db"',
      "Applying migration `20260825_add_context_receipts`",
      "The following migration(s) have been applied:",
      "migrations/",
      "  └─ 20260825_add_context_receipts/",
      "Your database is now in sync with your schema.",
    ].join("\n");
  }
  if (argv[0] === "migrate" && argv[1] === "status") {
    return [
      ...prefix,
      'Datasource "db": SQLite database "dev.db" at "file:./dev.db"',
      "12 migrations found in prisma/migrations",
      "Database schema is up to date!",
    ].join("\n");
  }
  if (argv[0] === "db" && argv[1] === "push") {
    return [
      ...prefix,
      'Datasource "db": SQLite database "dev.db" at "file:./dev.db"',
      "🚀 Your database is now in sync with your Prisma schema. Done in 84ms",
    ].join("\n");
  }
  if (argv[0] === "validate") {
    return [...prefix, "The schema at prisma/schema.prisma is valid 🚀"].join("\n");
  }
  throw new Error(`unsupported prisma fixture arguments: ${argv.join(" ")}`);
}

function genericLintOutput(): string {
  return [
    "src/runtime.ts:14:6: error lint/noUnsafe: Unsafe value reaches the provider.",
    "src/router.ts:28:3: warning lint/noFallback: Fallback route is not explicit.",
    "2 issues (1 error, 1 warning)",
  ].join("\n");
}

function biomeOutput(): string {
  return [
    "src/runtime.ts:14:6 lint/suspicious/noExplicitAny ━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "  × Unexpected any. Specify a different type.",
    "src/router.ts:28:3 lint/correctness/noUnusedVariables ━━━━━━━━━━━━━━━━━━━━━━━",
    "  × This variable is unused.",
    "Checked 42 files in 18ms. No fixes applied.",
    "Found 2 errors.",
  ].join("\n");
}

function eslintOutput(): string {
  return [
    "/workspace/src/runtime.ts",
    "  14:6  error    Unsafe any value              @typescript-eslint/no-unsafe-assignment",
    "  28:3  warning  Unexpected console statement  no-console",
    "✖ 2 problems (1 error, 1 warning)",
  ].join("\n");
}

function oxlintOutput(): string {
  return [
    "src/runtime.ts:14:6: error no-undef: `missing` is not defined",
    "src/router.ts:28:3: warning no-console: Unexpected console statement",
    "Found 1 warning and 1 error.",
  ].join("\n");
}

function prettierOutput(): string {
  return [
    "Checking formatting...",
    "[warn] src/runtime.ts",
    "[warn] src/router.ts",
    "[warn] Code style issues found in 2 files. Run Prettier with --write to fix.",
  ].join("\n");
}

function rustDiagnosticOutput(): string {
  return [
    "    Checking falryn v0.3.0 (/workspace)",
    "error[E0425]: cannot find value `missing` in this scope",
    "  --> src/lib.rs:14:6",
    "   |",
    "14 |     missing();",
    "   |     ^^^^^^^ not found in this scope",
    "warning: unused variable: `context`",
    "  --> src/router.rs:28:3",
    "   |",
    "28 |   let context = pack();",
    "   |       ^^^^^^^ help: prefix it with an underscore",
    "warning: falryn generated 1 warning",
    "error: could not compile `falryn` due to 1 previous error",
  ].join("\n");
}

function rustfmtOutput(): string {
  return [
    "Diff in /workspace/src/lib.rs:",
    "-fn project(){",
    "+fn project() {",
    "     preserve_context();",
    " }",
  ].join("\n");
}

function mypyOutput(): string {
  return [
    'src/app.py:14:6: error: Name "missing" is not defined  [name-defined]',
    "src/router.py:28:3: error: Incompatible return value type  [return-value]",
    "Found 2 errors in 2 files (checked 42 source files)",
  ].join("\n");
}

function ruffOutput(argv: readonly string[]): string {
  if (argv.some((argument) => argument.includes("output-format=json"))) {
    return JSON.stringify([
      {
        code: "F821",
        filename: "src/app.py",
        location: { row: 14, column: 6 },
        end_location: { row: 14, column: 13 },
        message: "Undefined name `missing`",
        fix: null,
        noqa_row: 14,
        url: "https://docs.astral.sh/ruff/rules/undefined-name",
      },
      {
        code: "E501",
        filename: "src/router.py",
        location: { row: 28, column: 3 },
        end_location: { row: 28, column: 92 },
        message: "Line too long (92 > 88)",
        fix: null,
        noqa_row: 28,
        url: "https://docs.astral.sh/ruff/rules/line-too-long",
      },
    ]);
  }
  if (argv[0] === "format") {
    return [
      "Would reformat: src/app.py",
      "Would reformat: src/router.py",
      "2 files would be reformatted",
    ].join("\n");
  }
  return [
    "src/app.py:14:6: F821 Undefined name `missing`",
    "src/router.py:28:3: E501 Line too long (92 > 88)",
    "Found 2 errors.",
    "[*] 0 fixable with the `--fix` option.",
  ].join("\n");
}

function golangciOutput(argv: readonly string[]): string {
  if (argv.some((argument) => argument.includes("out-format=json"))) {
    return JSON.stringify({
      Issues: [
        {
          FromLinter: "govet",
          Text: "printf: fmt.Printf format %d has arg name of wrong type string",
          Pos: { Filename: "main.go", Line: 14, Column: 6 },
        },
        {
          FromLinter: "errcheck",
          Text: "Error return value of `save` is not checked",
          Pos: { Filename: "router.go", Line: 28, Column: 3 },
        },
      ],
      Report: {
        Linters: [
          { Name: "govet", Enabled: true },
          { Name: "errcheck", Enabled: true },
        ],
      },
    });
  }
  return [
    "main.go:14:6: printf: fmt.Printf format %d has arg name of wrong type string (govet)",
    "router.go:28:3: Error return value of `save` is not checked (errcheck)",
    "2 issues:",
    "* errcheck: 1",
    "* govet: 1",
  ].join("\n");
}

function mixOutput(): string {
  return [
    "** (Mix) mix format failed due to --check-formatted.",
    "The following files are not formatted:",
    "  * lib/falryn.ex",
    "  * lib/router.ex",
  ].join("\n");
}

function mixCommandOutput(argv: readonly string[]): string {
  if (argv[0] === "format") return mixOutput();
  if (argv[0] === "compile") {
    return ["Compiling 42 files (.ex)", "Generated falryn app"].join("\n");
  }
  throw new Error(`unsupported mix fixture arguments: ${argv.join(" ")}`);
}

function phpstanOutput(argv: readonly string[]): string {
  if (argv.some((argument) => argument.includes("error-format") || argument === "json")) {
    return JSON.stringify({
      totals: { errors: 0, file_errors: 2 },
      files: {
        "/workspace/src/App.php": {
          errors: 1,
          messages: [
            {
              message: "Call to an undefined method App::missing().",
              line: 14,
              ignorable: true,
              identifier: "method.notFound",
            },
          ],
        },
        "/workspace/src/Router.php": {
          errors: 1,
          messages: [
            {
              message: "Method Router::route() should return string but returns int.",
              line: 28,
              ignorable: true,
              identifier: "return.type",
            },
          ],
        },
      },
      errors: [],
    });
  }
  return [
    " ------ ---------------------------------------------------------------- ",
    "  Line   /workspace/src/App.php                                         ",
    " ------ ---------------------------------------------------------------- ",
    "  14     Call to an undefined method App::missing().                    ",
    "         🪪  method.notFound                                             ",
    " ------ ---------------------------------------------------------------- ",
    "  Line   /workspace/src/Router.php                                      ",
    " ------ ---------------------------------------------------------------- ",
    "  28     Method Router::route() should return string but returns int.   ",
    "         🪪  return.type                                                 ",
    " ------ ---------------------------------------------------------------- ",
    " [ERROR] Found 2 errors",
  ].join("\n");
}

function ecsOutput(): string {
  return [
    "2 files with errors",
    "===================",
    "1) src/App.php",
    "---------- begin diff ----------",
    "-final class App{",
    "+final class App {",
    "----------- end diff -----------",
    "2) src/Router.php",
    "---------- begin diff ----------",
    "-return$context;",
    "+return $context;",
    "----------- end diff -----------",
  ].join("\n");
}

function pintOutput(argv: readonly string[]): string {
  if (argv.some((argument) => argument.includes("format=json"))) {
    return JSON.stringify({
      files: [
        { name: "src/App.php", status: "failed", appliedFixers: ["class_attributes_separation"] },
        {
          name: "src/Router.php",
          status: "failed",
          appliedFixers: ["single_space_around_construct"],
        },
      ],
    });
  }
  return [
    "  ⨯⨯",
    "  ─────────────────────────────────────────────────────────── Laravel",
    "    FAIL  ........................................ 2 files, 2 style issues",
    "  ⨯ src/App.php                         class_attributes_separation",
    "  ⨯ src/Router.php                     single_space_around_construct",
  ].join("\n");
}

function rubocopOutput(argv: readonly string[]): string {
  if (argv.some((argument) => argument === "json" || argument.includes("format=json"))) {
    return JSON.stringify({
      metadata: { rubocop_version: "1.80.0", ruby_engine: "ruby", ruby_version: "3.4.0" },
      files: [
        {
          path: "app.rb",
          offenses: [
            {
              severity: "convention",
              message: "Layout/TrailingWhitespace: Trailing whitespace detected.",
              cop_name: "Layout/TrailingWhitespace",
              corrected: false,
              correctable: true,
              location: { start_line: 14, start_column: 6, line: 14, column: 6, length: 1 },
            },
          ],
        },
        {
          path: "router.rb",
          offenses: [
            {
              severity: "warning",
              message: "Lint/UselessAssignment: Useless assignment to variable - context.",
              cop_name: "Lint/UselessAssignment",
              corrected: false,
              correctable: true,
              location: { start_line: 28, start_column: 3, line: 28, column: 3, length: 7 },
            },
          ],
        },
      ],
      summary: { offense_count: 2, target_file_count: 2, inspected_file_count: 2 },
    });
  }
  return [
    "Inspecting 2 files",
    "CW",
    "Offenses:",
    "app.rb:14:6: C: [Correctable] Layout/TrailingWhitespace: Trailing whitespace detected.",
    "router.rb:28:3: W: [Correctable] Lint/UselessAssignment: Useless assignment to variable - context.",
    "2 files inspected, 2 offenses detected, 2 offenses autocorrectable",
  ].join("\n");
}

function precommitOutput(): string {
  return [
    "Trim trailing whitespace.................................................Failed",
    "- hook id: trailing-whitespace",
    "- exit code: 1",
    "- files were modified by this hook",
    "Check YAML...............................................................Passed",
  ].join("\n");
}

function hadolintOutput(): string {
  return [
    "Dockerfile:14 DL3008 warning: Pin versions in apt get install.",
    "Dockerfile:28 DL3015 info: Avoid additional packages by specifying --no-install-recommends.",
  ].join("\n");
}

function markdownlintOutput(): string {
  return [
    "README.md:14:6 MD013/line-length Line length [Expected: 80; Actual: 92]",
    "docs/guide.md:28 MD022/blanks-around-headings Headings should be surrounded by blank lines",
  ].join("\n");
}

function shellcheckOutput(): string {
  return [
    "In scripts/build.sh line 14:",
    "echo $artifact",
    "     ^-------^ SC2086 (info): Double quote to prevent globbing and word splitting.",
  ].join("\n");
}

function yamllintOutput(): string {
  return [
    ".github/workflows/check.yml",
    '  14:6      warning  missing document start "---"  (document-start)',
    "  28:3      error    trailing spaces  (trailing-spaces)",
  ].join("\n");
}

function jestOutput(argv: readonly string[]): string {
  if (argv.includes("--json")) {
    return JSON.stringify({
      testResults: [
        {
          name: "/workspace/src/hush.test.ts",
          assertionResults: [
            { fullName: "hush complete", status: "passed", failureMessages: [] },
            { fullName: "hush budget", status: "passed", failureMessages: [] },
          ],
        },
      ],
      numTotalTests: 2,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 0,
    });
  }
  return [
    "PASS src/hush.test.ts",
    "  ✓ hush complete",
    "  ✓ hush budget",
    "Test Suites: 1 passed, 1 total",
    "Tests: 2 passed, 2 total",
    "Snapshots: 0 total",
    "Time: 0.45 s",
    "Ran all test suites.",
  ].join("\n");
}

function vitestOutput(argv: readonly string[]): string {
  if (argv.some((argument) => argument === "--reporter=json" || argument === "--reporter")) {
    return JSON.stringify({
      testResults: [
        {
          name: "/workspace/src/hush.test.ts",
          assertionResults: [
            { fullName: "hush complete", status: "passed", failureMessages: [] },
            { fullName: "hush budget", status: "passed", failureMessages: [] },
          ],
        },
      ],
      numTotalTests: 2,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 0,
    });
  }
  return [
    " RUN  v4.0.0 /workspace",
    " ✓ src/hush.test.ts (2 tests)",
    " Test Files  1 passed (1)",
    " Tests  2 passed (2)",
    " Duration  0.50s",
  ].join("\n");
}

function playwrightOutput(argv: readonly string[]): string {
  if (argv.some((argument) => argument === "--reporter=json")) {
    return JSON.stringify({
      stats: { expected: 2, unexpected: 0, skipped: 0, duration: 1_000 },
      suites: [
        {
          title: "hush.spec.ts",
          file: "tests/hush.spec.ts",
          specs: [
            { title: "complete", ok: true, tests: [] },
            { title: "budget", ok: true, tests: [] },
          ],
        },
      ],
    });
  }
  return [
    "Running 2 tests using 1 worker",
    "  ✓ hush complete",
    "  ✓ hush budget",
    "  2 passed (1.00s)",
  ].join("\n");
}

function mochaOutput(): string {
  return ["  hush", "    ✓ complete", "    ✓ budget", "", "  2 passing (12ms)"].join("\n");
}

function pytestOutput(): string {
  return [
    "tests/test_hush.py::test_complete PASSED",
    "tests/test_hush.py::test_budget PASSED",
    "2 passed in 0.12s",
  ].join("\n");
}

function pythonOutput(argv: readonly string[]): string {
  if (argv[0] === "-m" && argv[1] === "pytest") return pytestOutput();
  if (argv[0] === "-m" && argv[1] === "mypy") return mypyOutput();
  throw new Error(`unsupported python fixture arguments: ${argv.join(" ")}`);
}

function cargoOutput(argv: readonly string[]): string {
  if (argv[0] === "test") {
    return [
      "   Compiling falryn v0.1.0 (/workspace)",
      "    Finished `test` profile target(s) in 0.42s",
      "     Running unittests src/lib.rs",
      "running 2 tests",
      "test complete ... ok",
      "test budget ... ok",
      "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s",
    ].join("\n");
  }
  if (argv[0] === "nextest") {
    return [
      "Starting 2 tests across 1 binary",
      "        PASS complete",
      "        PASS budget",
      "Summary [0.12s] 2 tests run: 2 passed, 0 skipped",
    ].join("\n");
  }
  if (argv[0] === "clippy" || argv[0] === "check") return rustDiagnosticOutput();
  if (argv[0] === "fmt") return rustfmtOutput();
  if (argv[0] === "install") {
    return [
      "    Updating crates.io index",
      "  Installing hush-cli v0.3.0",
      " Downloaded terminal_size v0.4.0",
      "   Compiling terminal_size v0.4.0",
      "   Compiling hush-cli v0.3.0",
      "    Finished `release` profile [optimized] target(s) in 4.2s",
      "  Installing /workspace/.cargo/bin/hush",
      "   Installed package `hush-cli v0.3.0` (executable `hush`)",
    ].join("\n");
  }
  return [
    "   Compiling serde v1.0.219",
    "   Compiling falryn v0.3.0 (/workspace)",
    "    Finished `release` profile target(s) in 0.42s",
  ].join("\n");
}

function goOutput(argv: readonly string[]): string {
  if (argv[0] === "vet") {
    return [
      "# example/falryn",
      "./main.go:14:6: fmt.Printf format %d has arg name of wrong type string",
      "./router.go:28:3: result of save call not used",
    ].join("\n");
  }
  if (argv.includes("-json")) {
    return [
      { Action: "run", Package: "example/falryn", Test: "TestComplete" },
      { Action: "pass", Package: "example/falryn", Test: "TestComplete", Elapsed: 0.01 },
      { Action: "run", Package: "example/falryn", Test: "TestBudget" },
      { Action: "pass", Package: "example/falryn", Test: "TestBudget", Elapsed: 0.01 },
      { Action: "pass", Package: "example/falryn", Elapsed: 0.02 },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
  }
  if (argv[0] === "build") return "";
  return [
    "=== RUN   TestComplete",
    "--- PASS: TestComplete (0.01s)",
    "=== RUN   TestBudget",
    "--- PASS: TestBudget (0.01s)",
    "PASS",
    "ok\texample/falryn\t0.02s",
  ].join("\n");
}

function gradleOutput(argv: readonly string[]): string {
  if (argv.some((argument) => /test/i.test(argument))) {
    return [
      "Starting a Gradle Daemon (subsequent builds will be faster)",
      "> Task :compileJava UP-TO-DATE",
      "> Task :processResources NO-SOURCE",
      "> Task :test",
      "BUILD SUCCESSFUL in 1s",
      "4 actionable tasks: 4 executed",
    ].join("\n");
  }
  return [
    "> Task :compileJava",
    "> Task :processResources",
    "> Task :classes",
    "> Task :jar",
    "BUILD SUCCESSFUL in 2s",
    "4 actionable tasks: 4 executed",
  ].join("\n");
}

function mavenOutput(argv: readonly string[]): string {
  if (argv.some((argument) => /test/i.test(argument))) {
    return [
      "[INFO] Scanning for projects...",
      "[INFO] -----------------------< dev.falryn:core >-----------------------",
      "[INFO] Running dev.falryn.HushTest",
      "[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.12 s - in dev.falryn.HushTest",
      "[INFO] BUILD SUCCESS",
      "[INFO] Total time:  1.20 s",
    ].join("\n");
  }
  return [
    "[INFO] Scanning for projects...",
    "[INFO] Building falryn-core 0.3.0",
    "[INFO] Packaging: jar",
    "[INFO] --- maven-compiler-plugin:3.13.0:compile ---",
    "[INFO] BUILD SUCCESS",
    "[INFO] Total time:  1.42 s",
    "[INFO] Finished at: 2026-08-25T12:00:00-07:00",
  ].join("\n");
}

function sbtOutput(argv: readonly string[]): string {
  if (argv.some((argument) => /test/i.test(argument))) {
    return [
      "[info] welcome to sbt 1.10.0",
      "[info] loading project definition",
      "[info] Total number of tests run: 2",
      "[info] Tests: succeeded 2, failed 0, canceled 0, ignored 0, pending 0",
      "[success] Total time: 1 s",
    ].join("\n");
  }
  return [
    "[info] welcome to sbt 1.10.0",
    "[info] compiling 42 Scala sources to /workspace/target/classes",
    "[success] Total time: 2 s, completed Aug 25, 2026",
  ].join("\n");
}

function dotnetOutput(argv: readonly string[]): string {
  if (argv[0] === "format") {
    return [
      "/workspace/App.cs(14,6): warning IDE0055: Fix formatting",
      "/workspace/Router.cs(28,3): error CS0103: The name 'missing' does not exist in the current context",
      "Format complete in 42 ms.",
    ].join("\n");
  }
  if (argv[0] === "build") {
    return [
      "  Determining projects to restore...",
      "  All projects are up-to-date for restore.",
      "  Falryn -> /workspace/bin/Release/net10.0/Falryn.dll",
      "Build succeeded.",
      "    0 Warning(s)",
      "    0 Error(s)",
      "Time Elapsed 00:00:01.42",
    ].join("\n");
  }
  if (argv[0] === "restore") {
    return [
      "  Determining projects to restore...",
      "  Restored /workspace/Falryn.csproj (in 142 ms).",
      "  Restored /workspace/Falryn.Tests.csproj (in 184 ms).",
    ].join("\n");
  }
  return [
    "Determining projects to restore...",
    "All projects are up-to-date for restore.",
    "Test run for Falryn.Tests.dll (.NETCoreApp,Version=v10.0)",
    "Passed! - Failed: 0, Passed: 2, Skipped: 0, Total: 2, Duration: 12 ms - Falryn.Tests.dll",
  ].join("\n");
}

function appleTestOutput(): string {
  return [
    "Building for debugging...",
    "Build complete! (0.42s)",
    "Test Suite 'All tests' started at 2026-08-25",
    "Test Case 'HushTests.complete' passed (0.005 seconds)",
    "Test Case 'HushTests.budget' passed (0.005 seconds)",
    "Test Suite 'All tests' passed at 2026-08-25",
    "\t Executed 2 tests, with 0 failures (0 unexpected) in 0.010 (0.012) seconds",
    "** TEST SUCCEEDED **",
  ].join("\n");
}

function swiftOutput(argv: readonly string[]): string {
  if (argv.includes("test")) return appleTestOutput();
  return [
    "Building for production...",
    "[1/4] Write sources",
    "[2/4] Compiling Falryn main.swift",
    "[3/4] Linking falryn",
    "[4/4] Write Objects.LinkFileList",
    "Build complete! (0.42s)",
  ].join("\n");
}

function xcodeOutput(argv: readonly string[]): string {
  if (argv.includes("test")) return appleTestOutput();
  return [
    "Command line invocation:",
    "    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild build",
    "Build settings from command line:",
    "    CONFIGURATION = Release",
    "=== BUILD TARGET Falryn OF PROJECT Falryn ===",
    "CompileSwift normal arm64 /workspace/Sources/Falryn.swift",
    "Ld /workspace/build/Release/Falryn normal arm64",
    "** BUILD SUCCEEDED **",
  ].join("\n");
}

function phpWrapperOutput(argv: readonly string[]): string {
  if (argv[0] === "-l") {
    return `No syntax errors detected in ${argv[1] ?? "app.php"}`;
  }
  if (argv[0] === "artisan") {
    return ["INFO", "Configuration cached successfully."].join("\n");
  }
  const tool = basename(argv[0] ?? "");
  if (tool === "phpunit") return phpunitOutput();
  if (tool === "pest") return pestOutput();
  if (tool === "paratest") return paratestOutput();
  if (tool === "phpstan") return phpstanOutput(argv.slice(1));
  if (tool === "ecs") return ecsOutput();
  if (tool === "pint") return pintOutput(argv.slice(1));
  return "Falryn PHP application result: context ready";
}

function phpunitOutput(): string {
  return [
    "PHPUnit 12.2.0 by Sebastian Bergmann and contributors.",
    "Runtime: PHP 8.4.0",
    ".. 2 / 2 (100%)",
    "Time: 00:00:00.120, Memory: 8.00 MB",
    "OK (2 tests, 4 assertions)",
  ].join("\n");
}

function pestOutput(): string {
  return ["Pest 5.0.0", "..", "Tests: 2 passed (4 assertions)", "Duration: 0.12s"].join("\n");
}

function paratestOutput(): string {
  return [
    "ParaTest v7.3.0 upon PHPUnit 12.2.0",
    "Random Seed: 736",
    ".. 2 / 2 (100%)",
    "OK (2 tests, 4 assertions)",
  ].join("\n");
}

function minitestOutput(): string {
  return [
    "Run options: --seed 736",
    "# Running:",
    "..",
    "Finished in 0.012s, 166 runs/s",
    "2 runs, 4 assertions, 0 failures, 0 errors, 0 skips",
  ].join("\n");
}

function rspecOutput(argv: readonly string[]): string {
  if (argv.includes("json")) {
    return JSON.stringify({
      examples: [
        {
          full_description: "hush complete",
          status: "passed",
          file_path: "spec/hush_spec.rb",
          line_number: 4,
        },
        {
          full_description: "hush budget",
          status: "passed",
          file_path: "spec/hush_spec.rb",
          line_number: 8,
        },
      ],
      summary: {
        duration: 0.012,
        example_count: 2,
        failure_count: 0,
        pending_count: 0,
        errors_outside_of_examples_count: 0,
      },
    });
  }
  return ["..", "Finished in 0.012 seconds", "2 examples, 0 failures"].join("\n");
}

function npxOutput(argv: readonly string[]): string {
  const tool = argv.find((argument) => ["jest", "vitest", "playwright"].includes(argument));
  if (tool === "jest") return jestOutput(argv);
  if (tool === "vitest") return vitestOutput(argv);
  if (tool === "playwright") return playwrightOutput(argv);
  return packageRunnerOutput();
}

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

function bunOutput(argv: readonly string[]): string {
  const action = argv[0] ?? "";
  if (action === "test") {
    return [
      "bun test v1.4.0",
      "✓ complete",
      "✓ budget",
      "",
      "2 pass",
      "0 fail",
      "4 expect() calls",
      "Ran 2 tests across 1 file. [12.00ms]",
    ].join("\n");
  }
  if (action === "install" || action === "add") {
    return [
      `bun ${action} v1.4.0 (0aa2b1cd)`,
      "Resolving dependencies",
      "Resolved, downloaded and extracted [12]",
      "Saved lockfile",
      "",
      "+ @falryn/context@0.3.0",
      "+ zod@4.0.0",
      "+ typescript@5.9.2",
      "",
      "12 packages installed [118.00ms]",
    ].join("\n");
  }
  if (action === "run") {
    if (argv[1] === "build") {
      return [
        "$ bun build src/index.ts --outdir dist",
        "Bundled 42 modules in 48ms",
        "  dist/falryn.js 1.2MB (entry point)",
      ].join("\n");
    }
    if (argv[1] === "typecheck") {
      return [
        "src/runtime.ts(14,6): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
        "src/router.ts(28,3): error TS2339: Property 'route' does not exist on type 'Context'.",
        "Found 2 errors in 2 files.",
      ].join("\n");
    }
    if (argv[1] === "check" || argv[1] === "lint") {
      return `$ biome check .\n${biomeOutput()}`;
    }
    return [
      "$ bun run tools/verify-packages.mjs",
      "checking package graph",
      "checking package graph",
      "checking package graph",
      "verified 12 packages",
    ].join("\n");
  }
  if (action === "outdated") {
    return [
      "Package          Current  Wanted  Latest  Location                       Depended by",
      "@falryn/context  0.2.0    0.2.5   0.3.0   node_modules/@falryn/context  falryn",
      "zod              3.24.0   3.25.0  4.0.0   node_modules/zod              falryn",
    ].join("\n");
  }
  if (action === "audit") {
    return "No vulnerabilities found";
  }
  if (action === "pm" && argv[1] === "ls") {
    return [
      "/workspace node_modules (3)",
      "├── @falryn/context@0.3.0",
      "├── zod@4.0.0",
      "└── typescript@5.9.2",
    ].join("\n");
  }
  throw new Error(`unsupported bun fixture arguments: ${argv.join(" ")}`);
}

function pipOutput(argv: readonly string[]): string {
  const outdated = argv.includes("outdated") || argv.includes("--outdated");
  const json = argv.some((argument) => argument === "--format=json" || argument === "--json");
  if (json) {
    return JSON.stringify(
      outdated
        ? [
            { name: "requests", version: "2.31.0", latest_version: "2.32.3" },
            { name: "urllib3", version: "2.1.0", latest_version: "2.2.2" },
          ]
        : [
            { name: "certifi", version: "2026.8.1" },
            { name: "requests", version: "2.32.3" },
            { name: "urllib3", version: "2.2.2" },
          ],
    );
  }
  if (outdated) {
    return [
      "Package   Version  Latest  Type",
      "--------- -------- ------- -----",
      "requests  2.31.0   2.32.3  wheel",
      "urllib3   2.1.0    2.2.2   wheel",
    ].join("\n");
  }
  if (argv[0] === "list") {
    return [
      "Package   Version",
      "--------- --------",
      "certifi   2026.8.1",
      "requests  2.32.3",
      "urllib3   2.2.2",
    ].join("\n");
  }
  if (argv[0] === "install") {
    return [
      "Collecting requests",
      "Using cached requests-2.32.3-py3-none-any.whl",
      "Installing collected packages: requests",
      "Successfully installed requests-2.32.3",
    ].join("\n");
  }
  throw new Error(`unsupported pip fixture arguments: ${argv.join(" ")}`);
}

function uvOutput(argv: readonly string[]): string {
  if (argv[0] === "run" && argv[1] === "pytest") {
    return pytestOutput();
  }
  if (argv[0] !== "sync") {
    throw new Error(`unsupported uv fixture arguments: ${argv.join(" ")}`);
  }
  return [
    "  Downloading requests-2.32.3-py3-none-any.whl (64.9 kB)",
    "  Using cached certifi-2026.8.1-py3-none-any.whl (161 kB)",
    "Prepared 2 packages in 15ms",
    "Installed 2 packages in 23ms",
    " + certifi==2026.8.1",
    " + requests==2.32.3",
  ].join("\n");
}

function poetryOutput(argv: readonly string[]): string {
  if (argv[0] !== "install") {
    throw new Error(`unsupported poetry fixture arguments: ${argv.join(" ")}`);
  }
  return [
    "Installing dependencies from lock file",
    "",
    "No dependencies to install or update",
  ].join("\n");
}

function brewOutput(argv: readonly string[]): string {
  if (argv[0] !== "install") {
    throw new Error(`unsupported brew fixture arguments: ${argv.join(" ")}`);
  }
  return [
    "==> Fetching downloads for: jq",
    "==> Downloading https://ghcr.io/v2/homebrew/core/jq/manifests/1.8.1",
    "######################################################################## 100.0%",
    "==> Pouring jq--1.8.1.arm64_sequoia.bottle.tar.gz",
    "==> Summary",
    "🍺  /opt/homebrew/Cellar/jq/1.8.1: 20 files, 1.4MB",
  ].join("\n");
}

function composerOutput(argv: readonly string[]): string {
  if (argv[0] !== "install") {
    throw new Error(`unsupported composer fixture arguments: ${argv.join(" ")}`);
  }
  return [
    "Loading composer repositories with package information",
    "Updating dependencies",
    "Lock file operations: 0 installs, 0 updates, 0 removals",
    "Nothing to install, update or remove",
    "Generating autoload files",
  ].join("\n");
}

function bundleOutput(argv: readonly string[]): string {
  if (argv[0] === "exec" && argv[1] === "rspec") {
    return rspecOutput(argv.slice(2));
  }
  if (argv[0] === "exec" && argv[1] === "rubocop") {
    return rubocopOutput(argv.slice(2));
  }
  if (argv[0] !== "install") {
    throw new Error(`unsupported bundle fixture arguments: ${argv.join(" ")}`);
  }
  return [
    "Using bundler 2.5.6",
    "Using rake 13.1.0",
    "Using ast 2.4.2",
    "Using minitest 5.22.2",
    "Bundle complete! 85 Gemfile dependencies, 200 gems now installed.",
    "Use `bundle info [gemname]` to see where a bundled gem is installed.",
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
if (executable === "bun" && args[0] === "run" && args[1] === "typecheck") {
  process.stderr.write("$ tsc --noEmit\n");
  process.stdout.write(`${output}\n`);
  process.exit(2);
} else if (executable === "git" && ["checkout", "fetch", "push"].includes(gitSubcommand(args))) {
  process.stderr.write(`${output}\n`);
} else if (output.length > 0) {
  process.stdout.write(`${output}\n`);
}

if (executable === "tsc") {
  process.exit(2);
}
if (executable === "basedpyright" || executable === "ty") {
  process.exit(1);
}
if (diagnosticFailure(executable, args)) {
  process.exit(1);
}

function diagnosticFailure(command: string, argv: readonly string[]): boolean {
  if (
    [
      "lint",
      "biome",
      "eslint",
      "oxlint",
      "prettier",
      "clippy",
      "mypy",
      "ruff",
      "golangci-lint",
      "golangci",
      "phpstan",
      "ecs",
      "pint",
      "rubocop",
      "pre-commit",
      "hadolint",
      "markdownlint",
      "shellcheck",
      "yamllint",
    ].includes(command)
  ) {
    return true;
  }
  if (command === "cargo") return ["clippy", "check", "fmt"].includes(argv[0] ?? "");
  if (command === "python") return argv[0] === "-m" && argv[1] === "mypy";
  if (command === "go") return argv[0] === "vet";
  if (command === "mix") return argv[0] === "format";
  if (command === "dotnet") return argv[0] === "format";
  if (command === "bun") return argv[0] === "run" && ["check", "lint"].includes(argv[1] ?? "");
  if (command === "bundle") return argv[0] === "exec" && argv[1] === "rubocop";
  if (command === "php") {
    return ["phpstan", "ecs", "pint"].includes(basename(argv[0] ?? ""));
  }
  if (command === "build") return argv.includes("--fail");
  if (command === "err") return argv.includes("--fail");
  return false;
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

function compilerBuildOutput(source: string): string {
  return `${source}:14:6: warning: unused variable 'context' [-Wunused-variable]`;
}

function platformIoBuildOutput(): string {
  return [
    "Processing native (platform: native; board: native)",
    "----------------------------------------------------------------",
    "Verbose mode can be enabled via `-v, --verbose` option",
    "RAM:   [==        ]  18.4% (used 6024 bytes from 32768 bytes)",
    "Flash: [====      ]  42.1% (used 44160 bytes from 104857 bytes)",
    "Building .pio/build/native/program",
    "========================= [SUCCESS] Took 1.23 seconds =========================",
  ].join("\n");
}

function quartoBuildOutput(): string {
  return [
    "Rendering docs/index.qmd",
    "pandoc index.md --to html --output _site/index.html",
    "Output created: _site/index.html",
  ].join("\n");
}

function trunkBuildOutput(): string {
  return [
    "2026-08-25T12:00:00Z INFO starting build",
    "2026-08-25T12:00:00Z INFO spawning asset pipelines",
    "2026-08-25T12:00:01Z INFO Finished `release` target(s) in 0.42s",
    "2026-08-25T12:00:01Z INFO success: Build completed to dist/index.html",
  ].join("\n");
}

function taskRunnerBuildOutput(prefix: string): string {
  return [
    prefix,
    "Falryn build",
    "Build step 1/3: compile context engine",
    "Build step 2/3: bundle runtime",
    "Build step 3/3: write manifest",
    "Build complete: dist/falryn (1.2 MB) in 420 ms",
  ].join("\n");
}

function shopifyOutput(argv: readonly string[]): string {
  const action = argv[0] === "theme" ? (argv[1] ?? "push") : (argv[0] ?? "push");
  return [
    "⠋ Uploading theme files",
    `Theme falryn-${action} ${action === "pull" ? "pulled from" : "pushed to"} falryn-store.myshopify.com (42 files)`,
    "Preview URL: https://falryn-store.myshopify.com?preview_theme_id=736",
  ].join("\n");
}

function ollamaOutput(argv: readonly string[]): string {
  return argv[0] === "run"
    ? "Falryn model response: every required build fact is preserved."
    : "ollama operation complete";
}

function javaOutput(argv: readonly string[]): string {
  return argv[0] === "-jar"
    ? "Falryn Java application: context engine ready"
    : "Falryn Java operation complete";
}

function buildkitOutput(compose: boolean): string {
  return [
    '#0 building with "desktop-linux" instance using docker driver',
    "#1 [internal] load build definition from Dockerfile",
    "#1 DONE 0.0s",
    "#2 [internal] load metadata for docker.io/library/bun:1.4",
    "#2 DONE 0.2s",
    "#3 [1/2] COPY . /app",
    "#3 DONE 0.1s",
    "#4 [2/2] RUN bun run build",
    "#4 DONE 0.3s",
    "#5 exporting to image",
    "#5 writing image sha256:736abc784def",
    "#5 naming to docker.io/library/falryn:latest",
    "#5 DONE 0.1s",
    ...(compose ? [" falryn Built"] : []),
  ].join("\n");
}

function podmanOutput(argv: readonly string[]): string {
  const compose = argv[0] === "compose";
  const action = compose ? argv[1] : argv[0];
  if (action === "build") {
    return [
      "STEP 1/3: FROM docker.io/library/bun:1.4",
      "STEP 2/3: COPY . /app",
      "STEP 3/3: RUN bun run build",
      "COMMIT falryn:latest",
      "--> 736abc784def",
      "Successfully tagged localhost/falryn:latest",
      "736abc784def",
      ...(compose ? ["falryn Built"] : []),
    ].join("\n");
  }
  if (action === "ps") return containerPsOutput(compose, hasFormatOption(argv));
  if (action === "images") return containerImagesOutput(hasFormatOption(argv));
  if (action === "inspect") return containerInspectOutput("podman");
  if (action === "logs") return containerLogsOutput(compose);
  if (action === "run") return "736abc784def736abc784def736abc784def736abc784def736abc784def736a";
  if (action === "exec") return "Falryn exec result: provider route ready\nexit=0";
  if (action === "pull") return copyProgressOutput(true);
  if (action === "stop") return "falryn-dev";
  throw new Error(`unsupported podman fixture arguments: ${argv.join(" ")}`);
}

function dockerOutput(argv: readonly string[]): string {
  if (argv[0] === "build" || (argv[0] === "compose" && argv[1] === "build")) {
    return buildkitOutput(argv[0] === "compose");
  }
  const compose = argv[0] === "compose";
  const action = compose ? argv[1] : argv[0];
  if (action === "ps") return containerPsOutput(compose, hasFormatOption(argv));
  if (action === "images") return containerImagesOutput(hasFormatOption(argv));
  if (action === "inspect") return containerInspectOutput("docker");
  if (action === "logs") return containerLogsOutput(compose);
  if (action === "run") return "736abc784def736abc784def736abc784def736abc784def736abc784def736a";
  if (action === "exec") return "Falryn exec result: provider route ready\nexit=0";
  if (action === "pull") return dockerPullOutput();
  if (action === "stop") return "falryn-dev";
  throw new Error(`unsupported docker fixture arguments: ${argv.join(" ")}`);
}

function containerPsOutput(compose: boolean, formatted: boolean): string {
  if (formatted) {
    return compose
      ? [
          "falryn-api\tfalryn\tfalryn:dev\trunning\t0.0.0.0:3000->3000/tcp",
          "falryn-db\tdb\tpostgres:17\trunning\t5432/tcp",
        ].join("\n")
      : [
          "abc123\tfalryn-dev\tUp 2 minutes\tfalryn:dev\t0.0.0.0:3000->3000/tcp",
          "def456\tfalryn-db\tUp 2 minutes\tpostgres:17\t5432/tcp",
        ].join("\n");
  }
  if (compose) {
    return [
      "NAME          SERVICE   IMAGE          STATUS          PORTS",
      "falryn-api    falryn    falryn:dev     Up 2 minutes    0.0.0.0:3000->3000/tcp",
      "falryn-db     db        postgres:17    Up 2 minutes    5432/tcp",
    ].join("\n");
  }
  return [
    "CONTAINER ID   IMAGE          COMMAND          STATUS          PORTS                         NAMES",
    'abc123         falryn:dev     "bun run dev"    Up 2 minutes    0.0.0.0:3000->3000/tcp    falryn-dev',
    'def456         postgres:17    "postgres"       Up 2 minutes    5432/tcp                      falryn-db',
  ].join("\n");
}

function containerImagesOutput(formatted: boolean): string {
  if (formatted) {
    return [
      "falryn\tlatest\timg736\t2 hours ago\t1.2GB",
      "postgres\t17\timg784\t3 days ago\t438MB",
    ].join("\n");
  }
  return [
    "REPOSITORY   TAG      IMAGE ID   CREATED       SIZE",
    "falryn       latest   img736     2 hours ago   1.2GB",
    "postgres     17       img784     3 days ago    438MB",
  ].join("\n");
}

function hasFormatOption(argv: readonly string[]): boolean {
  return argv.some((token) => token === "--format" || token.startsWith("--format="));
}

function containerInspectOutput(executable: "docker" | "podman"): string {
  return JSON.stringify(
    [
      {
        Id: "sha256:736abc784def",
        Name: "/falryn-dev",
        Driver: executable === "podman" ? "overlay" : "overlay2",
        State: { Status: "running", Running: true, ExitCode: 0, Pid: 736 },
        Config: { Image: "falryn:dev", Env: ["NODE_ENV=development"] },
        NetworkSettings: {
          IPAddress: "172.18.0.2",
          Ports: { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "3000" }] },
        },
      },
    ],
    null,
    2,
  );
}

function containerLogsOutput(compose: boolean): string {
  const lines = [
    "2026-08-25T12:00:00.001Z service started",
    "2026-08-25T12:00:01.125Z request=req-736 status=ok",
    "2026-08-25T12:00:02.250Z request=req-784 status=ok",
  ];
  return compose
    ? lines.map((line, index) => `${index === 2 ? "db" : "api"}     | ${line}`).join("\n")
    : lines.join("\n");
}

function dockerPullOutput(): string {
  return [
    "1.4: Pulling from library/bun",
    "a736: Pulling fs layer",
    "b784: Download complete",
    "a736: Pull complete",
    "Digest: sha256:736abc784def",
    "Status: Downloaded newer image for bun:1.4",
    "docker.io/library/bun:1.4",
  ].join("\n");
}

function copyProgressOutput(includeIdentity: boolean): string {
  return [
    "Getting image source signatures",
    "Copying blob sha256:111aaa",
    "Copying blob sha256:222bbb",
    "Copying config sha256:333ccc",
    "Writing manifest to image destination",
    "Storing signatures",
    ...(includeIdentity ? ["sha256:736abc784def"] : []),
  ].join("\n");
}

function skopeoOutput(argv: readonly string[]): string {
  if (argv[0] === "inspect") {
    return JSON.stringify(
      {
        Name: "docker.io/library/bun",
        Digest: "sha256:736abc784def",
        RepoTags: ["1.4", "latest"],
        Created: "2026-08-25T12:00:00Z",
        Architecture: "arm64",
        Os: "linux",
        Layers: ["sha256:111aaa", "sha256:222bbb"],
      },
      null,
      2,
    );
  }
  if (argv[0] === "copy") return copyProgressOutput(false);
  if (argv[0] === "delete") return "Deleted docker://registry.example/falryn:old";
  throw new Error(`unsupported skopeo fixture arguments: ${argv.join(" ")}`);
}

function kubernetesOutput(executable: "kubectl" | "oc", argv: readonly string[]): string {
  const verbIndex = kubernetesVerbIndex(argv);
  const verb = argv[verbIndex];
  const argument = argv[verbIndex + 1];
  if (verb === "get" || verb === "pods" || verb === "services") {
    const resource = verb === "get" ? argument : verb;
    if (resource === "pods" || resource === "pod" || resource === "po") {
      if (kubernetesRequestedOutput(argv) === "json") return kubernetesPodsJson();
      return kubernetesPodsOutput(argv.includes("wide") || argv.includes("-o=wide"));
    }
    if (resource === "services" || resource === "service" || resource === "svc") {
      if (kubernetesRequestedOutput(argv) === "json") return kubernetesServicesJson();
      return kubernetesServicesOutput();
    }
  }
  if (verb === "status" && executable === "oc") return openShiftStatusOutput();
  if (verb === "logs") {
    if (argv.includes("plain")) return "ready\nready\nrequest=req-736 status=ok";
    return kubernetesLogsOutput(argv.includes("--prefix"));
  }
  if (verb === "describe") return kubernetesDescribeOutput();
  if (verb === "apply") {
    return [
      "deployment.apps/falryn configured",
      "service/falryn configured",
      "configmap/falryn created",
    ].join("\n");
  }
  if (verb === "create") return "namespace/falryn created";
  if (verb === "delete") return 'pod "falryn-old" deleted';
  if (verb === "rollout") return 'deployment "falryn" successfully rolled out';
  if (verb === "scale") return "deployment.apps/falryn scaled";
  if (verb === "auth") return "yes";
  if (verb === "adm" && argument === "top") return openShiftTopOutput();
  if (verb === "adm") return 'clusterrole.rbac.authorization.k8s.io/admin added: "falryn"';
  throw new Error(`unsupported ${executable} fixture arguments: ${argv.join(" ")}`);
}

function kubernetesRequestedOutput(argv: readonly string[]): string | null {
  const index = argv.findIndex((token) => token === "-o" || token === "--output");
  if (index >= 0) return argv[index + 1] ?? "";
  const inline = argv.find((token) => token.startsWith("-o=") || token.startsWith("--output="));
  return inline?.slice(inline.indexOf("=") + 1) ?? null;
}

function kubernetesVerbIndex(argv: readonly string[]): number {
  const optionsWithValue = new Set(["--context", "--kubeconfig", "--namespace", "-n"]);
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (!token.startsWith("-")) return index;
    index += optionsWithValue.has(token) && !token.includes("=") ? 2 : 1;
  }
  return index;
}

function kubernetesPodsOutput(wide: boolean): string {
  if (wide) {
    return [
      "NAME             READY   STATUS    RESTARTS       AGE   IP           NODE       NOMINATED NODE   READINESS GATES",
      "falryn-api       1/1     Running   0              2m    10.42.0.8    worker-1   <none>           <none>",
      "falryn-worker    1/1     Running   1 (30s ago)    5m    10.42.0.11   worker-2   <none>           <none>",
    ].join("\n");
  }
  return [
    "NAME             READY   STATUS    RESTARTS       AGE",
    "falryn-api       1/1     Running   0              2m",
    "falryn-worker    1/1     Running   1 (30s ago)    5m",
  ].join("\n");
}

function kubernetesPodsJson(): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        metadata: {
          name: "falryn-api",
          namespace: "falryn",
          creationTimestamp: "2026-08-25T11:58:00Z",
        },
        spec: { nodeName: "worker-1" },
        status: {
          phase: "Running",
          podIP: "10.42.0.8",
          containerStatuses: [{ ready: true, restartCount: 0 }],
        },
      },
      {
        metadata: {
          name: "falryn-worker",
          namespace: "falryn",
          creationTimestamp: "2026-08-25T11:55:00Z",
        },
        spec: { nodeName: "worker-2" },
        status: {
          phase: "Running",
          podIP: "10.42.0.11",
          containerStatuses: [{ ready: true, restartCount: 1 }],
        },
      },
    ],
  });
}

function kubernetesServicesOutput(): string {
  return [
    "NAME         TYPE        CLUSTER-IP    EXTERNAL-IP   PORT(S)    AGE",
    "falryn       ClusterIP   10.96.0.42    <none>        3000/TCP   2m",
    "falryn-db    ClusterIP   10.96.0.84    <none>        5432/TCP   5m",
  ].join("\n");
}

function kubernetesServicesJson(): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        metadata: {
          name: "falryn",
          namespace: "falryn",
          creationTimestamp: "2026-08-25T11:58:00Z",
        },
        spec: {
          type: "ClusterIP",
          clusterIP: "10.96.0.42",
          ports: [{ port: 3000, protocol: "TCP" }],
        },
      },
      {
        metadata: {
          name: "falryn-db",
          namespace: "falryn",
          creationTimestamp: "2026-08-25T11:55:00Z",
        },
        spec: {
          type: "ClusterIP",
          clusterIP: "10.96.0.84",
          ports: [{ port: 5432, protocol: "TCP" }],
        },
      },
    ],
  });
}

function openShiftStatusOutput(): string {
  return [
    "In project falryn on server https://api.example:6443",
    "",
    "svc/falryn - 10.96.0.42:3000",
    "  deployment/falryn deploys image falryn:dev",
    "    deployment #2 running for 2 minutes - 1 pod",
    "",
    "View details with 'oc describe <resource>/<name>' or list everything with 'oc get all -o yaml'.",
  ].join("\n");
}

function kubernetesLogsOutput(prefixed: boolean): string {
  const lines = [
    "2026-08-25T12:00:00.001Z service started",
    "2026-08-25T12:00:01.125Z request=req-736 status=ok",
    "2026-08-25T12:00:02.250Z request=req-784 status=ok",
  ];
  return prefixed
    ? lines
        .map(
          (line, index) =>
            `[pod/${index === 2 ? "falryn-worker" : "falryn-api"}/container/falryn] ${line}`,
        )
        .join("\n")
    : lines.join("\n");
}

function kubernetesDescribeOutput(): string {
  return [
    "Name:             falryn-api",
    "Namespace:        falryn",
    "Priority:         0",
    "Service Account:  falryn",
    "Node:             worker-1/10.0.0.11",
    "Start Time:       Tue, 25 Aug 2026 11:58:00 -0700",
    "Labels:           app=falryn",
    "                  component=api",
    "Annotations:      checksum/config=736abc",
    "Status:           Running",
    "IP:               10.42.0.8",
    "Containers:",
    "  falryn:",
    "    Container ID:  containerd://sha256:736abc784def",
    "    Image:         falryn:dev",
    "    State:         Running",
    "      Started:     Tue, 25 Aug 2026 11:58:01 -0700",
    "    Ready:         True",
    "    Restart Count: 0",
    "Conditions:",
    "  Type              Status",
    "  PodReadyToStartContainers   True",
    "  Initialized       True",
    "  Ready             True",
    "Events:",
    "  Type    Reason     Age   From               Message",
    "  Normal  Scheduled  2m    default-scheduler  Successfully assigned falryn/falryn-api to worker-1",
  ].join("\n");
}

function openShiftTopOutput(): string {
  return [
    "NAME             CPU(cores)   MEMORY(bytes)",
    "falryn-api       25m          96Mi",
    "falryn-worker    12m          64Mi",
  ].join("\n");
}
