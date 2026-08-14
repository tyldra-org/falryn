/**
 * Host process-output capture, against real processes.
 */

import { describe, expect, test } from "bun:test";

import {
  type ArtifactIngestRequest,
  type ArtifactStorePort,
  artifactId,
} from "../domain/artifact.ts";
import {
  contentDigest,
  duration,
  MAX_COMMAND_OUTPUT_BYTES,
  type ProcessCaptureRequest,
  timestampFromEpochMilliseconds,
} from "../domain/index.ts";
import { err, ok } from "../domain/result.ts";
import { createHostProcessCapturePort } from "./host-process-capture.ts";

const POSIX = process.platform !== "win32";
const platformTest = POSIX ? test : test.skip;
const ENVIRONMENT = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
const decoder = new TextDecoder();

function request(
  script: string,
  overrides: {
    readonly executable?: string;
    readonly timeoutMs?: ProcessCaptureRequest["timeoutMs"];
    readonly maxInlineBytes?: number;
    readonly maxCaptureBytes?: number;
  } = {},
): ProcessCaptureRequest {
  return {
    executable: overrides.executable ?? "/bin/sh",
    argv: ["-c", script],
    environment: ENVIRONMENT,
    timeoutMs: overrides.timeoutMs ?? duration(5_000),
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    ...(overrides.maxInlineBytes === undefined ? {} : { maxInlineBytes: overrides.maxInlineBytes }),
    ...(overrides.maxCaptureBytes === undefined
      ? {}
      : { maxCaptureBytes: overrides.maxCaptureBytes }),
  };
}

function createMemoryArtifacts(): ArtifactStorePort & { readonly stored: Map<string, Uint8Array> } {
  const stored = new Map<string, Uint8Array>();
  return {
    stored,
    async ingest(ingestRequest: ArtifactIngestRequest) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of ingestRequest.content) {
        chunks.push(chunk);
        total += chunk.byteLength;
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      stored.set(ingestRequest.artifactId, bytes);
      return ok({
        record: {
          artifactId: ingestRequest.artifactId,
          digest: contentDigest.from(`sha-256:${"a".repeat(64)}`),
          mediaType: ingestRequest.mediaType,
          encoding: ingestRequest.encoding,
          byteLength: bytes.byteLength,
          sensitivity: ingestRequest.sensitivity,
          origin: ingestRequest.origin,
          invocationId: ingestRequest.invocationId,
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

describe("host process capture", () => {
  platformTest("captures ordered stdout and stderr with the exit code", async () => {
    const port = createHostProcessCapturePort();
    const captured = await port.run(request("printf 'out\\n'; printf 'err\\n' >&2; exit 7"));
    expect(captured.ok).toBe(true);
    if (!captured.ok) {
      throw new Error("expected a capture report");
    }
    expect(captured.value.stop).toEqual({ kind: "exited" });
    expect(captured.value.exit.exitCode).toBe(7);
    expect(captured.value.stdout.inlineText).toBe("out\n");
    expect(captured.value.stderr.inlineText).toBe("err\n");
    const chunks = captured.value.events.filter((event) => event.kind === "chunk");
    expect(chunks.map((event) => event.stream).sort()).toEqual(["stderr", "stdout"]);
    const orders = chunks.map((event) => event.order);
    expect(orders).toEqual([...orders].sort((left, right) => left - right));
  });

  platformTest("spills overflow to an artifact instead of dropping it", async () => {
    const artifacts = createMemoryArtifacts();
    const port = createHostProcessCapturePort({ artifacts });
    const captured = await port.run(
      request("printf 'abcdefghij'", { maxInlineBytes: 4, maxCaptureBytes: 64 }),
    );
    expect(captured.ok).toBe(true);
    if (!captured.ok) {
      throw new Error("expected a capture report");
    }
    expect(captured.value.stdout.inlineText).toBe("abcd");
    expect(captured.value.stdout.artifact?.committed).toBe(true);
    expect(decoder.decode(artifacts.stored.get("cap-1.stdout"))).toBe("abcdefghij");
  });

  platformTest("times out a child that does not exit", async () => {
    const port = createHostProcessCapturePort();
    const captured = await port.run(request("sleep 5", { timeoutMs: duration(200) }));
    expect(captured.ok).toBe(true);
    if (!captured.ok) {
      throw new Error("expected a capture report");
    }
    expect(captured.value.stop.kind).toBe("timed-out");
  });

  platformTest("rejects a relative executable without spawning", async () => {
    const port = createHostProcessCapturePort();
    const captured = await port.run(request("true", { executable: "sh" }));
    expect(captured).toEqual({
      ok: false,
      error: { kind: "process-capture", code: "invalid-request", reason: "invalid-executable" },
    });
  });
});
