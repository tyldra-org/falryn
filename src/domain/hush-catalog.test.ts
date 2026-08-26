/** Exhaustive command-catalog and reducer coverage for Hush. */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { artifactId } from "./artifact.ts";
import { duration, instant } from "./clock.ts";
import { commandShape } from "./hush/command-shape.ts";
import { HUSH_COMMAND_RULES, HUSH_PROJECTION_KINDS, matchHushCommand } from "./hush/rules/index.ts";
import {
  MAX_COMMAND_OUTPUT_BYTES,
  type ProcessCaptureReport,
  type ProcessCaptureRequest,
  processCaptureId,
  reduceHush,
} from "./index.ts";

const PINNED_RTK_EXECUTABLES = [
  "ansible-playbook",
  "aws",
  "basedpyright",
  "biome",
  "brew",
  "bundle",
  "cargo",
  "cat",
  "composer",
  "curl",
  "df",
  "diff",
  "docker",
  "dotnet",
  "du",
  "ecs",
  "eslint",
  "fail2ban-client",
  "find",
  "g++",
  "gcc",
  "gcloud",
  "gh",
  "git",
  "glab",
  "go",
  "golangci",
  "golangci-lint",
  "gradle",
  "gradlew",
  "grep",
  "gt",
  "hadolint",
  "head",
  "helm",
  "iptables",
  "java",
  "jest",
  "jira",
  "jj",
  "jq",
  "just",
  "kubectl",
  "liquibase",
  "lint",
  "ls",
  "make",
  "markdownlint",
  "mise",
  "mix",
  "mvn",
  "mvnw",
  "mypy",
  "next",
  "npm",
  "npx",
  "nx",
  "oc",
  "ollama",
  "oxlint",
  "paratest",
  "pest",
  "php",
  "phpstan",
  "phpunit",
  "ping",
  "pint",
  "pio",
  "pip",
  "pip3",
  "playwright",
  "pnpm",
  "poetry",
  "pre-commit",
  "prettier",
  "prisma",
  "ps",
  "psql",
  "pulumi",
  "pytest",
  "quarto",
  "rake",
  "rails",
  "rg",
  "rspec",
  "rsync",
  "rubocop",
  "ruff",
  "sbt",
  "shellcheck",
  "shopify",
  "skopeo",
  "sops",
  "ssh",
  "stat",
  "swift",
  "systemctl",
  "tail",
  "task",
  "terraform",
  "tofu",
  "tree",
  "trunk",
  "tsc",
  "turbo",
  "ty",
  "uv",
  "vitest",
  "wc",
  "wget",
  "xcodebuild",
  "yadm",
  "yamllint",
] as const;

const EXPECTED_CATALOG_REDUCER_IDS = [
  "files.ls",
  "files.tree",
  "files.find",
  "files.read",
  "files.tail",
  "files.rg",
  "files.grep",
  "transform.sed",
  "files.diff",
  "files.count",
  "data.json",
  "transform.log",
  "transform.summary",
  "test.generic",
  "format.generic",
  "build.generic",
  "git.diff",
  "git.status",
  "git.log",
  "git.mutation",
  "forge.github",
  "forge.gitlab",
  "forge.graphite",
  "vcs.jujutsu.diff",
  "vcs.jujutsu.log",
  "forge.jira",
  "js.package",
  "js.typecheck",
  "js.lint",
  "js.format",
  "js.test",
  "js.build",
  "js.prisma",
  "bun.test",
  "bun.build",
  "bun.lint",
  "bun.typecheck",
  "bun.command",
  "rust.test",
  "rust.diagnostic",
  "rust.build",
  "python.test",
  "python.diagnostic",
  "python.package",
  "go.test",
  "go.diagnostic",
  "go.build",
  "jvm.test",
  "jvm.build",
  "dotnet.test",
  "dotnet.diagnostic",
  "dotnet.build",
  "apple.test",
  "apple.build",
  "native.build",
  "elixir.diagnostic",
  "elixir.build",
  "php.test",
  "php.diagnostic",
  "php.command",
  "ruby.test",
  "ruby.diagnostic",
  "container.table",
  "kubernetes.table",
  "container.log",
  "kubernetes.log",
  "container.build",
  "container.operation",
  "kubernetes.operation",
  "package.manager",
  "task.build",
  "precommit.diagnostic",
  "cloud.aws",
  "cloud.command",
  "data.command",
  "network.curl",
  "network.wget",
  "network.command",
  "infra.operation",
  "system.table",
  "diagnostic.command",
  "operation.command",
] as const;

describe("Hush command rules", () => {
  test("keeps one ordered rule and reducer for every supported command family", () => {
    const ruleIds = HUSH_COMMAND_RULES.map((entry) => entry.reducerId);
    const executables = new Set(HUSH_COMMAND_RULES.flatMap((entry) => [...entry.executables]));
    const examples = HUSH_COMMAND_RULES.flatMap((entry) => [...entry.examples]);

    expect(ruleIds).toEqual([...EXPECTED_CATALOG_REDUCER_IDS]);
    expect(new Set(ruleIds).size).toBe(82);
    expect(executables.size).toBe(131);
    expect(examples.length).toBe(267);
    expect(HUSH_PROJECTION_KINDS.length).toBe(25);
    expect(HUSH_COMMAND_RULES.every((rule) => typeof rule.reduce === "function")).toBe(true);
    expect(existsSync(`${import.meta.dir}/hush/catalog/index.ts`)).toBe(false);
    expect(existsSync(`${import.meta.dir}/hush/reducers/commands/index.ts`)).toBe(false);
  });

  test("covers every pinned RTK executable with an explicit policy", () => {
    const catalogExecutables = new Set(
      HUSH_COMMAND_RULES.flatMap((entry) => [...entry.executables]),
    );
    const missing = PINNED_RTK_EXECUTABLES.filter(
      (executable) => !catalogExecutables.has(executable),
    );
    expect(missing).toEqual([]);
  });

  test("routes every catalog example to its owning non-generic reducer", () => {
    for (const entry of HUSH_COMMAND_RULES) {
      expect(entry.examples.length).toBeGreaterThan(0);
      for (const example of entry.examples) {
        const shape = commandShape(bash(example));
        expect(shape.compound, example).toBe(false);
        const policy = matchHushCommand(shape.tokens);
        expect(policy?.reducerId, example).toBe(entry.reducerId);
        expect(policy?.reducerId, example).not.toBe("generic");
      }
    }
  });

  test("normalizes wrappers and isolates compound shell output", () => {
    expect(policyFor("FOO=1 sudo git -C workspace log -10")?.reducerId).toBe("git.log");
    expect(policyFor("sudo env FOO=1 git status")?.reducerId).toBe("git.status");
    expect(policyFor("npm exec tsc -- --noEmit")?.reducerId).toBe("js.typecheck");
    expect(policyFor("python -m pytest")?.reducerId).toBe("python.test");
    expect(policyFor("uv run pytest")?.reducerId).toBe("python.test");
    expect(policyFor("php vendor/bin/phpunit")?.reducerId).toBe("php.test");
    expect(policyFor("vendor/bin/pest")?.reducerId).toBe("php.test");
    expect(policyFor("bundle exec rspec")?.reducerId).toBe("ruby.test");
    expect(policyFor("python -m mypy src")?.reducerId).toBe("python.diagnostic");
    expect(policyFor("bundle exec rubocop")?.reducerId).toBe("ruby.diagnostic");
    expect(policyFor("php vendor/bin/phpstan analyse src")?.reducerId).toBe("php.diagnostic");
    expect(policyFor("bun run check")?.reducerId).toBe("bun.lint");
    expect(policyFor("rails server")).toBeNull();
    expect(commandShape(bash("git status && cargo test"))).toMatchObject({
      compound: true,
      operators: ["and"],
      commands: [
        ["git", "status"],
        ["cargo", "test"],
      ],
    });
  });

  test("does not claim unwired RTK helper commands as Hush support", () => {
    expect(policyFor("smart src/main.ts")).toBeNull();
    expect(policyFor("deps .")).toBeNull();
    expect(policyFor("env -f AWS")).toBeNull();
    expect(policyFor("log app.log")).toBeNull();
    expect(policyFor("summary make")).toBeNull();
    expect(policyFor("proxy make")).toBeNull();
  });

  test("routes only the requested data helpers through dedicated projections", () => {
    expect(policyFor("json config.json")).toMatchObject({
      reducerId: "data.json",
      projection: "json",
    });
    expect(policyFor("curl https://example.com")).toMatchObject({
      reducerId: "network.curl",
      projection: "curl",
    });
    expect(policyFor("wget https://example.com/file")).toMatchObject({
      reducerId: "network.wget",
      projection: "wget",
    });
  });

  test("routes sed through a dedicated lossless transform projection", () => {
    expect(policyFor("ripgrep marker src")).toMatchObject({
      reducerId: "files.rg",
      projection: "search",
    });
    expect(policyFor("sed -n '1,40p' src/main.ts")).toMatchObject({
      reducerId: "transform.sed",
      projection: "transform",
    });
  });

  test("routes compound shell commands through an explicit Hush policy", () => {
    const reduced = reduceHush({
      command: bash("git status && cargo test"),
      capture: longReport(),
    });

    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      return;
    }
    expect(reduced.value.reducerId).toBe("shell.compound");
    expect(reduced.value.strategy).toBe("passthrough");
    expect(reduced.value.fallbackReason).toBeNull();
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.truncated).toBe(false);
  });

  test("runs every catalog policy as a non-generic recoverable projection", () => {
    const capture = longReport();
    for (const entry of HUSH_COMMAND_RULES) {
      const example = entry.examples[0];
      if (example === undefined) {
        throw new Error(`missing example for ${entry.reducerId}`);
      }
      const reduced = reduceHush({ command: bash(example), capture });
      expect(reduced.ok, example).toBe(true);
      if (!reduced.ok) {
        continue;
      }
      expect(reduced.value.reducerId, example).toBe(entry.reducerId);
      expect(["specialized", "passthrough"], example).toContain(reduced.value.strategy);
      expect(reduced.value.fallbackReason, example).toBeNull();
      expect(
        reduced.value.omissions.some((omission) => omission.kind === "capped-bytes"),
        example,
      ).toBe(false);
      expect(reduced.value.truncated, example).toBe(false);
      expect(reduced.value.expansion.stdoutArtifact, example).toBe(
        artifactId.from("catalog.stdout"),
      );
    }
  });
});

function policyFor(command: string): ReturnType<typeof matchHushCommand> {
  return matchHushCommand(commandShape(bash(command)).tokens);
}

function bash(command: string): ProcessCaptureRequest {
  return {
    mode: "bash",
    executable: "/bin/bash",
    command,
    environment: {},
    cwd: "/workspace",
    timeoutMs: duration(5_000),
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
  };
}

function longReport(): ProcessCaptureReport {
  const stdout = Array.from({ length: 180 }, (_, index) => {
    if (index % 29 === 0) {
      return `src/file-${index}.ts:${index + 1}:2 error: representative failure ${index}`;
    }
    if (index % 17 === 0) {
      return `warning: representative warning ${index}`;
    }
    return `worker-${index % 9} output row ${index} with repeated progress context`;
  }).join("\n");
  const stderr = "summary: 170 passed, 10 failed\nerror: representative stderr failure";
  const stdoutBytes = new TextEncoder().encode(stdout);
  const stderrBytes = new TextEncoder().encode(stderr);
  return {
    captureId: processCaptureId.from("catalog"),
    pid: 42,
    startedAt: instant(1_000),
    endedAt: instant(1_100),
    durationMs: duration(100),
    stop: { kind: "exited" },
    killStage: "none",
    exit: { exitCode: 1, signal: null },
    stdout: {
      stream: "stdout",
      byteCount: stdoutBytes.byteLength,
      inlineBytes: stdoutBytes,
      inlineText: stdout,
      encoding: "utf-8",
      truncated: false,
      omittedBytes: 0,
      maxLineExceeded: false,
      artifact: {
        artifactId: artifactId.from("catalog.stdout"),
        committed: true,
        truncated: false,
        byteLength: stdoutBytes.byteLength,
      },
    },
    stderr: {
      stream: "stderr",
      byteCount: stderrBytes.byteLength,
      inlineBytes: stderrBytes,
      inlineText: stderr,
      encoding: "utf-8",
      truncated: false,
      omittedBytes: 0,
      maxLineExceeded: false,
      artifact: null,
    },
    events: [],
  };
}
