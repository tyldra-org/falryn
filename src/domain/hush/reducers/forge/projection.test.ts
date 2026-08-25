import { describe, expect, test } from "bun:test";

import { duration, instant } from "../../../clock.ts";
import { processCaptureId } from "../../../identity.ts";
import type { ProcessCaptureReport } from "../../../process-capture.ts";
import { forgeProjection } from "./projection.ts";

describe("Hush forge projection", () => {
  test("projects a complete successful supported GitHub read", () => {
    const output = JSON.stringify([
      {
        number: 736,
        title: "Do more with less context",
        state: "OPEN",
        author: { login: "yogesh" },
      },
    ]);
    const projected = forgeProjection(report(output), 64 * 1_024, [], ["gh", "pr", "list"]);
    expect(projected.text).toBe("736 Do more with less context");
    expect(projected.omissions).toEqual([]);
  });

  test("preserves explicit output formats exactly", () => {
    const output = '[{"number":736,"title":"Do more with less context"}]\n';
    const projected = forgeProjection(
      report(output),
      64 * 1_024,
      [],
      ["gh", "issue", "list", "--json", "number,title"],
    );
    expect(projected.text).toBe(output);
    expect(projected.omissions).toEqual([]);
  });

  test("preserves failures and stderr instead of formatting partial facts", () => {
    const stdout = "partial response\n";
    const stderr = "HTTP 401: Bad credentials\n";
    const projected = forgeProjection(
      report(stdout, stderr, 1),
      64 * 1_024,
      [],
      ["gh", "pr", "view", "784"],
    );
    expect(projected.text).toBe(`${stdout}\nstderr:\n${stderr}`);
    expect(projected.omissions).toEqual([]);
  });

  test("preserves caller-filtered output exactly", () => {
    const output = "736\tOPEN\tDo more with less context\t\t2026-08-23T12:00:00Z\n";
    const projected = forgeProjection(report(output), 64 * 1_024, ["736"], ["gh", "issue", "list"]);
    expect(projected.text).toBe(output);
    expect(projected.omissions).toEqual([]);
  });

  test("keeps arbitrary API responses exact", () => {
    const output = '{"name":"falryn","private":false}\n';
    const projected = forgeProjection(
      report(output),
      64 * 1_024,
      [],
      ["gh", "api", "repos/tyldra-org/falryn"],
    );
    expect(projected.text).toBe(output);
    expect(projected.omissions).toEqual([]);
  });

  test("projects complete GitLab list facts without an item cap", () => {
    const output = JSON.stringify([
      {
        iid: 736,
        title: "Do more with less context",
        state: "opened",
        source_branch: "perf/736-context-optimization",
        target_branch: "main",
        author: { username: "yogesh" },
        web_url: "https://gitlab.example/tyldra/falryn/-/merge_requests/736",
      },
    ]);
    const projected = forgeProjection(report(output), 64 * 1_024, [], ["glab", "mr", "list"]);
    expect(projected.text).toBe(
      "!736 perf/736-context-optimization: Do more with less context -> main",
    );
    expect(projected.omissions).toEqual([]);
  });

  test("keeps GitLab API and live CI output exact", () => {
    const api = '{"id":736,"private":true}\n';
    expect(forgeProjection(report(api), 64 * 1_024, [], ["glab", "api", "projects/736"]).text).toBe(
      api,
    );
    const live = "(running) • test [verify]\n";
    expect(
      forgeProjection(report(live), 64 * 1_024, [], ["glab", "ci", "status", "--live"]).text,
    ).toBe(live);
  });

  test("projects complete Graphite log and submit facts", () => {
    const log = [
      "◉ feature/top (current)",
      "│ 8 seconds ago",
      "│",
      "│ 95338df - Preserve complete context",
      "◯ main",
      "│ 5 weeks ago",
    ].join("\n");
    expect(forgeProjection(report(log), 64 * 1_024, [], ["gt", "log"]).text).toBe(
      "* feature/top 95338df Preserve complete context | 8 seconds ago\n  main | 5 weeks ago",
    );

    const submit = [
      "🥞 Validating that this Graphite stack is ready to submit...",
      "📝 Preparing to submit PRs for the following branches...",
      "▸ feature/base (Create)",
      "▸ feature/top (Update)",
      "📨 Pushing to remote and creating/updating PRs...",
      "feature/base: https://app.graphite.dev/github/pr/example/repo/101 (created)",
      "feature/top: https://app.graphite.dev/github/pr/example/repo/102 (updated)",
    ].join("\n");
    expect(forgeProjection(report(submit), 64 * 1_024, [], ["gt", "submit"]).text).toBe(
      "created feature/base https://app.graphite.dev/github/pr/example/repo/101\nupdated feature/top https://app.graphite.dev/github/pr/example/repo/102",
    );
    expect(forgeProjection(report("", submit), 64 * 1_024, [], ["gt", "submit"]).text).toBe(
      "created feature/base https://app.graphite.dev/github/pr/example/repo/101\nupdated feature/top https://app.graphite.dev/github/pr/example/repo/102",
    );
  });

  test("preserves unknown Graphite output and failures exactly", () => {
    const prompt = "? Title > Preserve complete context\n";
    expect(forgeProjection(report(prompt), 64 * 1_024, [], ["gt", "submit"]).text).toBe(prompt);
    const conflict = "CONFLICT: feature/top must be restacked manually\n";
    expect(
      forgeProjection(report(conflict, "restack failed\n", 1), 64 * 1_024, [], ["gt", "restack"])
        .text,
    ).toBe(`${conflict}\nstderr:\nrestack failed\n`);
  });
});

function report(stdout: string, stderr = "", exitCode = 0): ProcessCaptureReport {
  return {
    captureId: processCaptureId.from("forge-test"),
    pid: 42,
    startedAt: instant(1),
    endedAt: instant(2),
    durationMs: duration(1),
    stop: { kind: "exited" },
    killStage: "none",
    exit: { exitCode, signal: null },
    stdout: stream("stdout", stdout),
    stderr: stream("stderr", stderr),
    events: [],
  };
}

function stream(stream: "stdout" | "stderr", text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    stream,
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
