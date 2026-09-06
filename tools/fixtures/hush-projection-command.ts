#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { cloudFixtureOutput } from "./hush-cloud-output.ts";
import { curlFixtureOutput, wgetFixtureOutput } from "./hush-http-output.ts";
import { infrastructureFixtureOutput } from "./hush-infra-output.ts";
import { networkFixtureOutput } from "./hush-network-output.ts";
import {
  compilerBuildOutput,
  errOutput,
  genericBuildOutput,
  javaOutput,
  mixCommandOutput,
  nextBuildOutput,
  nxBuildOutput,
  ollamaOutput,
  platformIoBuildOutput,
  prismaOutput,
  quartoBuildOutput,
  shopifyOutput,
  taskRunnerBuildOutput,
  trunkBuildOutput,
  turboBuildOutput,
} from "./hush-projection-command/build.ts";
import { dockerOutput, podmanOutput, skopeoOutput } from "./hush-projection-command/containers.ts";
import {
  biomeOutput,
  diagnosticFailure,
  ecsOutput,
  eslintOutput,
  genericFormatOutput,
  genericLintOutput,
  golangciOutput,
  hadolintOutput,
  markdownlintOutput,
  mypyOutput,
  oxlintOutput,
  phpstanOutput,
  pintOutput,
  precommitOutput,
  prettierOutput,
  rubocopOutput,
  ruffOutput,
  rustDiagnosticOutput,
  shellcheckOutput,
  yamllintOutput,
} from "./hush-projection-command/diagnostics.ts";
import {
  psqlOutput,
  runDiffFixture,
  runSedFixture,
  sqliteOutput,
  wcOutput,
} from "./hush-projection-command/files.ts";
import {
  ghOutput,
  glabOutput,
  graphiteOutput,
  jiraOutput,
} from "./hush-projection-command/forge.ts";
import { gitOutput, gitSubcommand } from "./hush-projection-command/git.ts";
import { kubernetesOutput } from "./hush-projection-command/kubernetes.ts";
import {
  brewOutput,
  bundleOutput,
  bunOutput,
  composerOutput,
  npmOutput,
  npxOutput,
  packageRunnerOutput,
  pipOutput,
  pnpmOutput,
  poetryOutput,
  uvOutput,
  yarnOutput,
} from "./hush-projection-command/package.ts";
import {
  cargoOutput,
  dotnetOutput,
  genericTestOutput,
  goOutput,
  gradleOutput,
  jestOutput,
  mavenOutput,
  minitestOutput,
  mochaOutput,
  paratestOutput,
  pestOutput,
  phpunitOutput,
  phpWrapperOutput,
  playwrightOutput,
  pytestOutput,
  pythonOutput,
  rspecOutput,
  sbtOutput,
  swiftOutput,
  vitestOutput,
  xcodeOutput,
} from "./hush-projection-command/test.ts";

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

const output = outputs[executable]?.();
if (output === undefined) {
  process.stderr.write(`unsupported projection fixture executable: ${executable}\n`);
  process.exit(2);
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
