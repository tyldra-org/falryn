/**
 * Product process tools (#712).
 */

import { describe, expect, test } from "bun:test";

import {
  capabilityId,
  configurationGeneration,
  duration,
  instant,
  invocationId,
  type ProcessCapturePort,
  type ProcessCaptureReport,
  type ProcessCaptureRequest,
  processCaptureId,
} from "../domain/index.ts";
import { composeProductProcessTools } from "./product-tools-process.ts";

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

function report(request: ProcessCaptureRequest): ProcessCaptureReport {
  const text =
    request.mode === "bash"
      ? `bash:${request.command}\n`
      : `argv:${request.executable} ${(request.argv ?? []).join(" ")}\n`;
  return {
    captureId: processCaptureId.from("cap-1"),
    pid: 42,
    startedAt: instant(1),
    endedAt: instant(2),
    durationMs: duration(1),
    stop: { kind: "exited" },
    killStage: "none",
    exit: { exitCode: 0, signal: null },
    stdout: stream("stdout", text),
    stderr: stream("stderr", ""),
    events: [],
  };
}

function capturePort(): ProcessCapturePort {
  return {
    async run(request) {
      return { ok: true, value: report(request) };
    },
  };
}

describe("composeProductProcessTools", () => {
  test("registers process tools and returns Hush-ready capture facts", async () => {
    const tools = composeProductProcessTools({
      generation: configurationGeneration.from(0),
      capture: capturePort(),
      workspaceCwd: "/work",
    });
    expect(tools.owner).toBe("#712");
    expect(tools.toolNames).toEqual(
      expect.arrayContaining(["run_process", "run_shell", "open_pty"]),
    );
    expect(tools.catalog.resolve("run_process")?.id).toBe(
      capabilityId.from("builtin:workspace/run_process@1"),
    );

    const processOutcome = await tools.runner.execute({
      invocationId: invocationId.from("inv-proc"),
      toolCallId: "call-proc",
      toolName: "run_process",
      capabilityId: capabilityId.from("builtin:workspace/run_process@1"),
      version: 1,
      effect: "mutation",
      input: {
        executable: "/bin/echo",
        argv: ["hi"],
        environment: { PATH: "/usr/bin" },
      },
      signal: new AbortController().signal,
    });
    expect(processOutcome.status).toBe("completed");
    if (processOutcome.status !== "completed") {
      return;
    }
    expect(processOutcome.output.origin).toBe("process");
    expect(typeof processOutcome.output.projection).toBe("string");
    expect(processOutcome.output.capture).toBeDefined();

    const shellOutcome = await tools.runner.execute({
      invocationId: invocationId.from("inv-shell"),
      toolCallId: "call-shell",
      toolName: "run_shell",
      capabilityId: capabilityId.from("builtin:workspace/run_shell@1"),
      version: 1,
      effect: "mutation",
      input: {
        command: "echo hi",
        environment: { PATH: "/usr/bin" },
      },
      signal: new AbortController().signal,
    });
    expect(shellOutcome.status).toBe("completed");
    if (shellOutcome.status !== "completed") {
      return;
    }
    expect(shellOutcome.output.origin).toBe("shell");

    const pty = await tools.runner.execute({
      invocationId: invocationId.from("inv-pty"),
      toolCallId: "call-pty",
      toolName: "open_pty",
      capabilityId: capabilityId.from("builtin:workspace/open_pty@1"),
      version: 1,
      effect: "mutation",
      input: {},
      signal: new AbortController().signal,
    });
    expect(pty.status).toBe("unavailable");
  });
});
