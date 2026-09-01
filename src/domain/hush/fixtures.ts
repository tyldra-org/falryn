/** Shared process-command and capture fixtures for Hush behavior tests. */

import { artifactId } from "../artifact.ts";
import { duration, instant } from "../clock.ts";
import {
  MAX_COMMAND_OUTPUT_BYTES,
  type ProcessCaptureReport,
  type ProcessCaptureRequest,
  processCaptureId,
} from "../index.ts";

export const encoder = new TextEncoder();

export function argv(executable: string, args: readonly string[] = []): ProcessCaptureRequest {
  return {
    executable,
    argv: args,
    environment: { SECRET: "do-not-copy" },
    cwd: "/workspace",
    timeoutMs: duration(5_000),
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
  };
}

export function bash(command: string): ProcessCaptureRequest {
  return {
    mode: "bash",
    executable: "/bin/bash",
    command,
    environment: { SECRET: "do-not-copy" },
    timeoutMs: duration(5_000),
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
  };
}

export function report(
  stdout: string,
  overrides: {
    readonly stderr?: string;
    readonly encoding?: "utf-8" | "binary";
    readonly truncated?: boolean;
    readonly artifact?: boolean;
    readonly exitCode?: number | null;
    readonly stop?: ProcessCaptureReport["stop"];
    readonly durationMs?: number;
  } = {},
): ProcessCaptureReport {
  const stdoutBytes = encoder.encode(stdout);
  const stderrText = overrides.stderr ?? "";
  const stderrBytes = encoder.encode(stderrText);
  return {
    captureId: processCaptureId.from("cap-1"),
    pid: 42,
    startedAt: instant(1_000),
    endedAt: instant(1_000 + (overrides.durationMs ?? 12)),
    durationMs: duration(overrides.durationMs ?? 12),
    stop: overrides.stop ?? { kind: "exited" },
    killStage: "none",
    exit: { exitCode: overrides.exitCode === undefined ? 0 : overrides.exitCode, signal: null },
    stdout: {
      stream: "stdout",
      byteCount: stdoutBytes.byteLength,
      inlineBytes: stdoutBytes,
      inlineText: overrides.encoding === "binary" ? null : stdout,
      encoding: overrides.encoding ?? "utf-8",
      truncated: overrides.truncated ?? false,
      omittedBytes: 0,
      maxLineExceeded: false,
      artifact: overrides.artifact
        ? {
            artifactId: artifactId.from("cap-1.stdout"),
            committed: true,
            truncated: false,
            byteLength: stdoutBytes.byteLength,
          }
        : null,
    },
    stderr: {
      stream: "stderr",
      byteCount: stderrBytes.byteLength,
      inlineBytes: stderrBytes,
      inlineText: stderrText,
      encoding: "utf-8",
      truncated: false,
      omittedBytes: 0,
      maxLineExceeded: false,
      artifact: null,
    },
    events: [],
  };
}
