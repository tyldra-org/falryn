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
    expect(projected.text).toBe("#736 open Do more with less context @yogesh");
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
