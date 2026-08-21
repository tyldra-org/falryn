/**
 * Product Hush harness projection (#718).
 */

import { describe, expect, test } from "bun:test";

import { duration, instant, type ProcessCaptureReport, processCaptureId } from "../domain/index.ts";
import { createHushIntegrator } from "./hush.ts";
import { PRODUCT_HUSH_PROJECTION_OWNER, projectHushForHarness } from "./product-hush-projection.ts";

const encoder = new TextEncoder();

function stream(name: "stdout" | "stderr", text: string) {
  const bytes = encoder.encode(text);
  return {
    stream: name,
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

describe("projectHushForHarness", () => {
  test("always attaches expansion and recovery handles", () => {
    const capture: ProcessCaptureReport = {
      captureId: processCaptureId.from("cap-hush"),
      pid: 1,
      startedAt: instant(1),
      endedAt: instant(2),
      durationMs: duration(1),
      stop: { kind: "exited" },
      killStage: "none",
      exit: { exitCode: 0, signal: null },
      stdout: stream("stdout", "hello\n"),
      stderr: stream("stderr", ""),
      events: [],
    };
    const reduced = createHushIntegrator().reduce({
      origin: "shell",
      command: {
        mode: "bash",
        executable: "/bin/bash",
        command: "echo hello",
        environment: {},
        timeoutMs: duration(1_000),
        maxOutputBytes: 1_024,
      },
      capture,
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      return;
    }
    const harness = projectHushForHarness(reduced.value);
    expect(harness.owner).toBe(PRODUCT_HUSH_PROJECTION_OWNER);
    expect(harness.recovery.captureId).toBe("cap-hush");
    expect(harness.expansion.claimsExactSource === true || harness.reduced).toBe(true);
    expect(typeof harness.text).toBe("string");
  });
});
