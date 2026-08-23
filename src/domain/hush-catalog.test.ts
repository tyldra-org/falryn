/** Exhaustive command-catalog and reducer coverage for Hush. */

import { describe, expect, test } from "bun:test";

import { artifactId } from "./artifact.ts";
import { duration, instant } from "./clock.ts";
import { HUSH_COMMAND_CATALOG, matchHushCommand } from "./hush/catalog/index.ts";
import { commandShape } from "./hush/command-shape.ts";
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

describe("Hush RTK command catalog", () => {
  test("covers every pinned RTK executable with an explicit policy", () => {
    const catalogExecutables = new Set(
      HUSH_COMMAND_CATALOG.flatMap((entry) => [...entry.executables]),
    );
    const missing = PINNED_RTK_EXECUTABLES.filter(
      (executable) => !catalogExecutables.has(executable),
    );
    expect(missing).toEqual([]);
  });

  test("routes every catalog example to its owning non-generic reducer", () => {
    for (const entry of HUSH_COMMAND_CATALOG) {
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
    expect(policyFor("bundle exec rspec")?.reducerId).toBe("ruby.test");
    expect(commandShape(bash("git status && cargo test")).compound).toBe(true);
  });

  test("does not claim unwired RTK helper commands as Hush support", () => {
    expect(policyFor("smart src/main.ts")).toBeNull();
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
    expect(reduced.value.strategy).toBe("specialized");
    expect(reduced.value.fallbackReason).toBeNull();
    expect(reduced.value.omissions.length).toBeGreaterThan(0);
  });

  test("runs every catalog policy as a specialized recoverable reducer", () => {
    const capture = longReport();
    for (const entry of HUSH_COMMAND_CATALOG) {
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
      expect(reduced.value.strategy, example).toBe("specialized");
      expect(reduced.value.fallbackReason, example).toBeNull();
      expect(reduced.value.omissions.length, example).toBeGreaterThan(0);
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
