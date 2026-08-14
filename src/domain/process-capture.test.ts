import { describe, expect, test } from "bun:test";

import { type ArtifactIngestRequest, type ArtifactStorePort, artifactId } from "./artifact.ts";
import { instant } from "./clock.ts";
import {
  contentDigest,
  createProcessCaptureCollector,
  duration,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_PROCESS_CAPTURE_INLINE_BYTES,
  type ProcessCaptureRequest,
  type ProcessCaptureValidationCode,
  processCaptureArtifactId,
  processCaptureId,
  resolveProcessCaptureLimits,
  timestampFromEpochMilliseconds,
  validateProcessCaptureRequest,
} from "./index.ts";
import { err, ok } from "./result.ts";

const BASE: ProcessCaptureRequest = {
  executable: "/bin/sh",
  argv: ["-c", "printf hello"],
  environment: { PATH: "/usr/bin:/bin" },
  timeoutMs: duration(5_000),
  maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
};

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function createMemoryArtifacts(
  fail = false,
): ArtifactStorePort & { readonly stored: Map<string, Uint8Array> } {
  const stored = new Map<string, Uint8Array>();
  return {
    stored,
    async ingest(request: ArtifactIngestRequest) {
      if (fail) {
        return err({ kind: "artifact", code: "not-found", artifactId: request.artifactId });
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of request.content) {
        chunks.push(chunk);
        total += chunk.byteLength;
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      stored.set(request.artifactId, bytes);
      return ok({
        record: {
          artifactId: request.artifactId,
          digest: contentDigest.from(`sha-256:${"a".repeat(64)}`),
          mediaType: request.mediaType,
          encoding: request.encoding,
          byteLength: bytes.byteLength,
          sensitivity: request.sensitivity,
          origin: request.origin,
          invocationId: request.invocationId,
          createdAt: timestampFromEpochMilliseconds(0),
          finalizedAt: timestampFromEpochMilliseconds(0),
          availability: "available" as const,
        },
        deduplicated: false,
        cancelledAfterCommit: false,
      });
    },
    get: () => ok(null),
    findByDigest: () => ok([]),
    listByInvocation: () => ok([]),
    readRange: async () =>
      err({ kind: "artifact", code: "not-found", artifactId: artifactId.from("missing") }),
    preview: async () =>
      err({ kind: "artifact", code: "not-found", artifactId: artifactId.from("missing") }),
    sweep: async () => ({
      examined: 0,
      deleted: 0,
      retained: [],
      failed: 0,
      completeness: "complete" as const,
      effect: "none" as const,
    }),
  };
}

describe("process capture request contracts", () => {
  test("accepts a bounded argv request and fills capture defaults", () => {
    expect(validateProcessCaptureRequest(BASE)).toBeNull();
    expect(resolveProcessCaptureLimits(BASE).maxInlineBytes).toBe(MAX_PROCESS_CAPTURE_INLINE_BYTES);
  });

  test.each([
    ["relative executable", { ...BASE, executable: "sh" }, "invalid-executable"],
    ["relative working directory", { ...BASE, cwd: "workspace" }, "invalid-working-directory"],
    [
      "negative timeout",
      { ...BASE, timeoutMs: -1 as ProcessCaptureRequest["timeoutMs"] },
      "invalid-timeout",
    ],
    ["negative inline limit", { ...BASE, maxInlineBytes: -1 }, "invalid-inline-limit"],
  ])("rejects %s without exposing request data", (_name, request, reason) => {
    expect(validateProcessCaptureRequest(request)).toBe(reason as ProcessCaptureValidationCode);
    expect(JSON.stringify(validateProcessCaptureRequest(request))).not.toContain("workspace");
  });

  test("derives a legal artifact identity from the capture id", () => {
    const parsed = processCaptureArtifactId(processCaptureId.from("cap-1"), "stderr");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toBe(artifactId.from("cap-1.stderr"));
    }
  });
});

describe("ordered capture and spillover", () => {
  test("records merged order across stdout and stderr", async () => {
    const collector = createProcessCaptureCollector({
      captureId: processCaptureId.from("cap-1"),
      limits: resolveProcessCaptureLimits(BASE),
      artifacts: null,
    });
    await collector.start(9, instant(1_000));
    expect(await collector.append("stdout", encode("out-"))).toBe("continue");
    expect(await collector.append("stderr", encode("err-"))).toBe("continue");
    expect(await collector.append("stdout", encode("done"))).toBe("continue");
    const report = await collector.finish({ exitCode: 0, signal: null }, instant(1_040), {
      kind: "exited",
    });

    expect(report.killStage).toBe("none");
    expect(report.durationMs).toBe(duration(40));
    expect(report.stdout.inlineText).toBe("out-done");
    expect(report.stderr.inlineText).toBe("err-");
    expect(
      report.events
        .filter((event) => event.kind === "chunk")
        .map((event) => [event.order, event.stream, new TextDecoder().decode(event.bytes)]),
    ).toEqual([
      [2, "stdout", "out-"],
      [3, "stderr", "err-"],
      [4, "stdout", "done"],
    ]);
  });

  test("stops without an artifact store once the inline preview is exceeded", async () => {
    const collector = createProcessCaptureCollector({
      captureId: processCaptureId.from("cap-2"),
      limits: resolveProcessCaptureLimits({ ...BASE, maxInlineBytes: 4 }),
      artifacts: null,
    });
    await collector.start(1, instant(0));
    expect(await collector.append("stdout", encode("hello"))).toBe("inline");
    const report = await collector.finish({ exitCode: null, signal: "SIGTERM" }, instant(10), {
      kind: "capture-exceeded",
      reason: "inline",
    });
    expect(report.stdout.truncated).toBe(true);
    expect(report.stdout.artifact).toBeNull();
    expect(new TextDecoder().decode(report.stdout.inlineBytes)).toBe("hell");
  });

  test("spills exact overflow to an artifact and keeps the inline prefix", async () => {
    const artifacts = createMemoryArtifacts();
    const collector = createProcessCaptureCollector({
      captureId: processCaptureId.from("cap-3"),
      limits: resolveProcessCaptureLimits({
        ...BASE,
        maxInlineBytes: 4,
        maxCaptureBytes: 64,
      }),
      artifacts,
    });
    await collector.start(1, instant(0));
    expect(await collector.append("stdout", encode("hello-world"))).toBe("continue");
    const report = await collector.finish({ exitCode: 0, signal: null }, instant(5), {
      kind: "exited",
    });

    expect(report.stop).toEqual({ kind: "exited" });
    expect(report.stdout.inlineText).toBe("hell");
    expect(report.stdout.truncated).toBe(true);
    expect(report.stdout.artifact).toEqual({
      artifactId: artifactId.from("cap-3.stdout"),
      committed: true,
      truncated: false,
      byteLength: 11,
    });
    expect(new TextDecoder().decode(artifacts.stored.get("cap-3.stdout"))).toBe("hello-world");
  });

  test("spills invalid UTF-8 as a binary artifact", async () => {
    const artifacts = createMemoryArtifacts();
    const collector = createProcessCaptureCollector({
      captureId: processCaptureId.from("cap-4"),
      limits: resolveProcessCaptureLimits(BASE),
      artifacts,
    });
    await collector.start(1, instant(0));
    expect(await collector.append("stderr", new Uint8Array([0xff, 0xfe, 0xfd]))).toBe("continue");
    const report = await collector.finish({ exitCode: 0, signal: null }, instant(5), {
      kind: "exited",
    });

    expect(report.stderr.encoding).toBe("binary");
    expect(report.stderr.inlineText).toBeNull();
    expect(report.stderr.artifact?.committed).toBe(true);
    expect(artifacts.stored.get("cap-4.stderr")).toEqual(new Uint8Array([0xff, 0xfe, 0xfd]));
  });

  test("reports uncertainty when artifact ingest fails after a spill", async () => {
    const collector = createProcessCaptureCollector({
      captureId: processCaptureId.from("cap-5"),
      limits: resolveProcessCaptureLimits({ ...BASE, maxInlineBytes: 2 }),
      artifacts: createMemoryArtifacts(true),
    });
    await collector.start(1, instant(0));
    expect(await collector.append("stdout", encode("abcd"))).toBe("continue");
    const report = await collector.finish({ exitCode: 0, signal: null }, instant(5), {
      kind: "exited",
    });
    expect(report.stop).toEqual({ kind: "uncertain", reason: "artifact-ingest-failed" });
    expect(report.stdout.artifact?.committed).toBe(false);
  });
});
