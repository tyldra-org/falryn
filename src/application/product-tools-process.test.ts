/**
 * Product process tools (#712).
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  type ArtifactIngestRequest,
  type ArtifactRecord,
  type ArtifactStorePort,
  artifactId,
  CONTENT_DIGEST_ALGORITHM,
  capabilityId,
  configurationGeneration,
  contentDigest,
  createInMemoryFileSystem,
  duration,
  instant,
  invocationId,
  localPath,
  type ProcessCapturePort,
  type ProcessCaptureReport,
  type ProcessCaptureRequest,
  processCaptureId,
  timestampFromEpochMilliseconds,
} from "../domain/index.ts";
import { err, ok } from "../domain/result.ts";
import { createHostProcessCapturePort } from "../integrations/index.ts";
import { createLoomPort } from "./loom.ts";
import { MAX_PRODUCT_PROCESS_MODEL_BYTES } from "./product-process-output.ts";
import { createProductReadCoordinator, productReadInputSchema } from "./product-read.ts";
import { composeProductProcessTools } from "./product-tools-process.ts";
import type { ScratchResourcePort } from "./scratch-resources.ts";
import { createWorkspaceReader } from "./workspace-read.ts";

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

function digestOf(bytes: Uint8Array) {
  return contentDigest.from(
    `${CONTENT_DIGEST_ALGORITHM}:${createHash("sha256").update(bytes).digest("hex")}`,
  );
}

function memoryArtifacts(): ArtifactStorePort & { readonly ingests: ArtifactIngestRequest[] } {
  const records = new Map<string, ArtifactRecord>();
  const stored = new Map<string, Uint8Array>();
  const ingests: ArtifactIngestRequest[] = [];
  return {
    ingests,
    async ingest(request) {
      ingests.push(request);
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of request.content) {
        chunks.push(chunk);
        length += chunk.byteLength;
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const record: ArtifactRecord = {
        artifactId: request.artifactId,
        digest: digestOf(bytes),
        mediaType: request.mediaType,
        encoding: request.encoding,
        byteLength: bytes.byteLength,
        sensitivity: request.sensitivity,
        origin: request.origin,
        invocationId: request.invocationId,
        createdAt: timestampFromEpochMilliseconds(0),
        finalizedAt: timestampFromEpochMilliseconds(0),
        availability: "available",
      };
      records.set(request.artifactId, record);
      stored.set(request.artifactId, bytes);
      return ok({ record, deduplicated: false, cancelledAfterCommit: false });
    },
    get(id) {
      return ok(records.get(id) ?? null);
    },
    verifyIntegrity: async () => ok(true),
    findByDigest: () => ok([]),
    listByInvocation: () => ok([]),
    async readRange(id, offset, length) {
      const bytes = stored.get(id);
      if (bytes === undefined) {
        return err({ kind: "artifact", code: "not-found", artifactId: id });
      }
      const slice = bytes.subarray(offset, offset + length);
      return ok({
        artifactId: id,
        offset,
        byteLength: slice.byteLength,
        bytes: slice,
        endOfArtifact: offset + slice.byteLength >= bytes.byteLength,
      });
    },
    preview: async () =>
      err({ kind: "artifact", code: "not-found", artifactId: artifactId.from("missing") }),
    sweep: async () => ({
      examined: 0,
      deleted: 0,
      retained: [],
      failed: 0,
      completeness: "complete",
      effect: "none",
    }),
  };
}

function processTools(capture: ProcessCapturePort = capturePort()) {
  const artifacts = memoryArtifacts();
  return {
    artifacts,
    tools: composeProductProcessTools({
      generation: configurationGeneration.from(0),
      capture,
      workspaceCwd: "/work",
      artifacts,
      loom: createLoomPort({ artifacts }),
      workspaceId: "ws-1",
      sessionId: "session-1",
    }),
  };
}

describe("composeProductProcessTools", () => {
  test("defaults outputMode to hush and rejects unsupported modes", () => {
    const { tools } = processTools();
    const process = tools.registry.resolveByName("run_process");
    const shell = tools.registry.resolveByName("run_shell");
    expect(process?.manifest.inputSchema.parse({ executable: "/bin/echo" })).toMatchObject({
      outputMode: "hush",
    });
    expect(shell?.manifest.inputSchema.parse({ command: "echo ok" })).toMatchObject({
      outputMode: "hush",
    });
    expect(
      process?.manifest.inputSchema.safeParse({ executable: "/bin/echo", outputMode: "other" })
        .success,
    ).toBe(false);
    expect(
      shell?.manifest.inputSchema.safeParse({ command: "echo ok", outputMode: "other" }).success,
    ).toBe(false);
  });

  test("makes a user-level Hush off preference authoritative over model input", async () => {
    const artifacts = memoryArtifacts();
    const tools = composeProductProcessTools({
      generation: configurationGeneration.from(0),
      capture: capturePort(),
      artifacts,
      loom: createLoomPort({ artifacts }),
      workspaceId: "ws-1",
      sessionId: "session-1",
      userOutputMode: () => "raw",
    });
    const outcome = await tools.runner.execute({
      invocationId: invocationId.from("inv-user-hush-off"),
      toolCallId: "call-user-hush-off",
      toolName: "run_shell",
      capabilityId: capabilityId.from("builtin:workspace/run_shell@1"),
      version: 1,
      effect: "mutation",
      input: { command: "printf exact", outputMode: "hush" },
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({
      status: "completed",
      output: { outputMode: "raw", projection: { kind: "raw", fidelity: "exact" } },
    });
  });

  test("registers process tools and returns Hush-ready capture facts", async () => {
    const { tools } = processTools();
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
    expect(processOutcome.output).toMatchObject({
      owner: "#796",
      invocationId: "inv-proc",
      captureId: "cap-1",
      outputMode: "hush",
      origin: "process",
      projection: {
        kind: "raw",
        ordering: "per-stream",
        complete: true,
        fidelity: "exact",
      },
    });
    expect((processOutcome.output.stdout as { recovery: unknown }).recovery).toBeNull();
    expect("capture" in processOutcome.output).toBe(false);
    expect("hush" in processOutcome.output).toBe(false);

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

  test("feeds one exact scratch revision to direct process stdin", async () => {
    const requests: ProcessCaptureRequest[] = [];
    const capture: ProcessCapturePort = {
      async run(request) {
        requests.push(request);
        return ok(report(request));
      },
    };
    const scratch = {
      readBytes: async () => ok(encoder.encode("echo scratch\n")),
    } as unknown as ScratchResourcePort;
    const artifacts = memoryArtifacts();
    const tools = composeProductProcessTools({
      generation: configurationGeneration.from(0),
      capture,
      workspaceCwd: "/work",
      artifacts,
      loom: createLoomPort({ artifacts }),
      workspaceId: "ws-1",
      sessionId: "session-1",
      scratch,
    });

    const outcome = await tools.runner.execute({
      invocationId: invocationId.from("inv-scratch-stdin"),
      toolCallId: "call-scratch-stdin",
      toolName: "run_process",
      capabilityId: capabilityId.from("builtin:workspace/run_process@1"),
      version: 1,
      effect: "mutation",
      input: {
        executable: "/bin/bash",
        argv: ["-s"],
        stdinScratch: {
          handle: "scratch://session/session-1/script.sh",
          revision: 1,
        },
      },
      signal: new AbortController().signal,
    });

    expect(outcome.status).toBe("completed");
    expect(new TextDecoder().decode(requests[0]?.stdinBytes)).toBe("echo scratch\n");
    expect(JSON.stringify(outcome)).not.toContain("echo scratch");
  });

  test("retains genuine Hush reductions and never exceeds the qualified raw projection", async () => {
    const stdout = [
      "total 800",
      ...Array.from(
        { length: 100 },
        (_, index) =>
          `-rw-r--r--  1 user staff ${1_000 + index} Aug 26 10:00 file-${index}.typescript.ts`,
      ),
      "",
    ].join("\n");
    const capture: ProcessCapturePort = {
      async run(request) {
        return {
          ok: true,
          value: {
            ...report(request),
            stdout: stream("stdout", stdout),
          },
        };
      },
    };
    const { tools, artifacts } = processTools(capture);

    const outcome = await tools.runner.execute({
      invocationId: invocationId.from("inv-hush-test"),
      toolCallId: "call-hush-test",
      toolName: "run_process",
      capabilityId: capabilityId.from("builtin:workspace/run_process@1"),
      version: 1,
      effect: "mutation",
      input: { executable: "/bin/ls", argv: ["-la"] },
      signal: new AbortController().signal,
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      return;
    }
    expect(
      tools.registry.resolveByName("run_process")?.manifest.outputSchema.safeParse(outcome.output)
        .success,
    ).toBe(true);
    expect(outcome.output.projection).toMatchObject({
      kind: "hush",
      reducer: { id: "files.ls" },
      omissions: [],
    });
    expect((outcome.output.projection as { text: string }).text).toContain("files 644 (100)");
    expect(artifacts.ingests).toHaveLength(1);
    expect(artifacts.ingests[0]?.invocationId).toBe(invocationId.from("inv-hush-test"));
    expect((outcome.output.stdout as { recovery: unknown }).recovery).not.toBeNull();

    const raw = await tools.runner.execute({
      invocationId: invocationId.from("inv-raw-test"),
      toolCallId: "call-raw-test",
      toolName: "run_process",
      capabilityId: capabilityId.from("builtin:workspace/run_process@1"),
      version: 1,
      effect: "mutation",
      input: {
        executable: "/bin/ls",
        argv: ["-la"],
        outputMode: "raw",
      },
      signal: new AbortController().signal,
    });
    expect(raw.status).toBe("completed");
    if (raw.status === "completed") {
      expect(encoder.encode(JSON.stringify(outcome.output)).byteLength).toBeLessThanOrEqual(
        encoder.encode(JSON.stringify(raw.output)).byteLength,
      );
    }
  });

  test("enriches supported GitHub reads while retaining the user's command identity", async () => {
    const requests: ProcessCaptureRequest[] = [];
    const stdout = JSON.stringify({
      number: 784,
      title: "Complete Hush projections",
      state: "OPEN",
      author: { login: "yogeshprasad098" },
      body: "Preserve every useful PR fact.",
      url: "https://github.com/tyldra-org/falryn/pull/784",
      mergeable: "MERGEABLE",
      statusCheckRollup: [
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "FAILURE" },
      ],
    });
    const capture: ProcessCapturePort = {
      async run(request) {
        requests.push(request);
        return {
          ok: true,
          value: {
            ...report(request),
            stdout: stream("stdout", stdout),
          },
        };
      },
    };
    const { tools } = processTools(capture);

    const outcome = await tools.runner.execute({
      invocationId: invocationId.from("inv-gh-view"),
      toolCallId: "call-gh-view",
      toolName: "run_process",
      capabilityId: capabilityId.from("builtin:workspace/run_process@1"),
      version: 1,
      effect: "mutation",
      input: {
        executable: "/opt/homebrew/bin/gh",
        argv: ["pr", "view", "784"],
        environment: { PATH: "/opt/homebrew/bin:/usr/bin" },
      },
      signal: new AbortController().signal,
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      return;
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      argv: [
        "pr",
        "view",
        "784",
        "--json",
        "number,title,state,author,body,url,mergeable,statusCheckRollup",
      ],
    });
    const projection = outcome.output.projection as { kind: string; text?: string };
    if (projection.kind === "hush") {
      expect(projection.text).toContain("checks 1/2 ok, 1 fail");
      expect(projection.text).toContain("Preserve every useful PR fact.");
    } else {
      expect((outcome.output.stdout as { text: string }).text).toBe(stdout);
    }

    const raw = await tools.runner.execute({
      invocationId: invocationId.from("inv-gh-view-raw"),
      toolCallId: "call-gh-view-raw",
      toolName: "run_process",
      capabilityId: capabilityId.from("builtin:workspace/run_process@1"),
      version: 1,
      effect: "mutation",
      input: {
        executable: "/opt/homebrew/bin/gh",
        argv: ["pr", "view", "784"],
        outputMode: "raw",
      },
      signal: new AbortController().signal,
    });
    expect(raw.status).toBe("completed");
    expect(requests[1]?.mode).toBe("argv");
    if (requests[1]?.mode === "argv") {
      expect(requests[1].argv).toEqual(["pr", "view", "784"]);
    }
    if (raw.status === "completed") {
      expect(raw.output.projection).toEqual({
        kind: "raw",
        ordering: "per-stream",
        complete: true,
        fidelity: "exact",
      });
      expect((raw.output.stdout as { text: string }).text).toBe(stdout);
    }
  });

  test("returns small raw stdout and stderr exactly without forcing artifacts", async () => {
    const capture: ProcessCapturePort = {
      async run(request) {
        return {
          ok: true,
          value: {
            ...report(request),
            stdout: stream("stdout", "out\n"),
            stderr: stream("stderr", "err\n"),
          },
        };
      },
    };
    const { tools, artifacts } = processTools(capture);
    const outcome = await tools.runner.execute({
      invocationId: invocationId.from("inv-raw-small"),
      toolCallId: "call-raw-small",
      toolName: "run_shell",
      capabilityId: capabilityId.from("builtin:workspace/run_shell@1"),
      version: 1,
      effect: "mutation",
      input: { command: "printf out; printf err >&2", outputMode: "raw" },
      signal: new AbortController().signal,
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      return;
    }
    expect(outcome.output.projection).toEqual({
      kind: "raw",
      ordering: "per-stream",
      complete: true,
      fidelity: "exact",
    });
    expect(outcome.output.stdout).toMatchObject({ text: "out\n", completeInline: true });
    expect(outcome.output.stderr).toMatchObject({ text: "err\n", completeInline: true });
    expect(outcome.result?.artifacts).toEqual([]);
    expect(artifacts.ingests).toEqual([]);
  });

  test("bounds JSON-expanding raw text and retains exact recovery", async () => {
    const artifacts = memoryArtifacts();
    const controls = "\u0000".repeat(6_000);
    const capture: ProcessCapturePort = {
      async run(request) {
        return {
          ok: true,
          value: { ...report(request), stdout: stream("stdout", controls) },
        };
      },
    };
    const tools = composeProductProcessTools({
      generation: configurationGeneration.from(0),
      capture,
      artifacts,
      loom: createLoomPort({ artifacts }),
      workspaceId: "ws-1",
      sessionId: "session-1",
    });
    const outcome = await tools.runner.execute({
      invocationId: invocationId.from("inv-raw-controls"),
      toolCallId: "call-raw-controls",
      toolName: "run_shell",
      capabilityId: capabilityId.from("builtin:workspace/run_shell@1"),
      version: 1,
      effect: "mutation",
      input: { command: "emit-controls", outputMode: "raw" },
      signal: new AbortController().signal,
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      return;
    }
    expect(encoder.encode(JSON.stringify(outcome.output)).byteLength).toBeLessThanOrEqual(
      MAX_PRODUCT_PROCESS_MODEL_BYTES,
    );
    expect(outcome.output.projection).toMatchObject({ kind: "raw", complete: false });
    expect(outcome.output.stdout).toMatchObject({
      text: null,
      completeInline: false,
      omittedBytes: 6_000,
    });
    expect((outcome.output.stdout as { recovery: unknown }).recovery).not.toBeNull();
    expect(outcome.result?.artifacts[0]).toMatchObject({ committed: true, required: true });
  });

  test("retains oversized and binary raw output behind Loom recovery", async () => {
    const artifacts = memoryArtifacts();
    const loom = createLoomPort({ artifacts });
    const tools = composeProductProcessTools({
      generation: configurationGeneration.from(0),
      capture: createHostProcessCapturePort({ artifacts }),
      workspaceCwd: process.cwd(),
      artifacts,
      loom,
      workspaceId: "ws-1",
      sessionId: "session-1",
    });
    const execute = (id: string, command: string) =>
      tools.runner.execute({
        invocationId: invocationId.from(id),
        toolCallId: `call-${id}`,
        toolName: "run_shell",
        capabilityId: capabilityId.from("builtin:workspace/run_shell@1"),
        version: 1,
        effect: "mutation",
        input: { command, outputMode: "raw" },
        signal: new AbortController().signal,
      });

    const oversized = await execute("inv-raw-large", "printf '%07000d' 0");
    expect(oversized.status).toBe("completed");
    if (oversized.status === "completed") {
      const schema = tools.registry.resolveByName("run_shell")?.manifest.outputSchema;
      expect(schema?.safeParse(oversized.output).success).toBe(true);
      expect(oversized.output.projection).toMatchObject({
        kind: "raw",
        fidelity: "artifact-backed",
        complete: false,
      });
      expect((oversized.output.stdout as { text: string }).text.length).toBe(6 * 1_024);
      const recovery = (
        oversized.output.stdout as { recovery: Readonly<Record<string, unknown>> | null }
      ).recovery;
      expect(recovery).toMatchObject({
        lineage: {
          invocationId: "inv-raw-large",
          stream: "stdout",
          encoding: "utf-8",
          availability: "available",
        },
      });
      expect(oversized.result?.artifacts).toHaveLength(1);
      expect(oversized.result?.artifacts[0]).toMatchObject({ committed: true, required: true });
      if (recovery === null) {
        throw new Error("expected raw recovery");
      }
      const recoveryCaptureId = (recovery.lineage as { captureId?: unknown } | undefined)
        ?.captureId;
      expect(typeof recoveryCaptureId).toBe("string");
      expect(String(recoveryCaptureId)).toMatch(/^cap-/);
      const coordinator = createProductReadCoordinator({
        reader: createWorkspaceReader(
          createInMemoryFileSystem({ nodes: { "/work": { kind: "directory" } } }),
          { artifacts },
        ),
        loom,
        workspaceRoot: localPath("/work"),
        workspaceId: "ws-1",
        sessionId: "session-1",
        generation: configurationGeneration.from(0),
      });
      const recovered = await coordinator.execute(
        productReadInputSchema.parse({
          recovery,
          projection: { kind: "range", offset: 6_990, length: 10, maxBytes: 10 },
        }),
        new AbortController().signal,
      );
      expect(recovered).toMatchObject({
        ok: true,
        value: {
          content: "0000000000",
          recoveryLineage: { invocationId: "inv-raw-large", stream: "stdout" },
        },
      });
    }

    const binary = await execute("inv-raw-binary", "printf '\\377'");
    expect(binary.status).toBe("completed");
    if (binary.status === "completed") {
      expect(binary.output.stdout).toMatchObject({ encoding: "binary", text: null });
      expect((binary.output.stdout as { recovery: unknown }).recovery).not.toBeNull();
      expect(binary.result?.artifacts[0]).toMatchObject({ committed: true, required: true });
    }
  });

  test("preserves process stop semantics and reports failed exact retention as partial", async () => {
    const cancelled: ProcessCapturePort = {
      async run(request) {
        return { ok: true, value: { ...report(request), stop: { kind: "cancelled" } } };
      },
    };
    const cancelledOutcome = await processTools(cancelled).tools.runner.execute({
      invocationId: invocationId.from("inv-cancelled"),
      toolCallId: "call-cancelled",
      toolName: "run_shell",
      capabilityId: capabilityId.from("builtin:workspace/run_shell@1"),
      version: 1,
      effect: "mutation",
      input: { command: "work", outputMode: "raw" },
      signal: new AbortController().signal,
    });
    expect(cancelledOutcome.status).toBe("cancelled");

    const failedProcess: ProcessCapturePort = {
      async run(request) {
        return {
          ok: true,
          value: {
            ...report(request),
            exit: { exitCode: 7, signal: null },
            stderr: stream("stderr", "command failed\n"),
          },
        };
      },
    };
    const failedProcessOutcome = await processTools(failedProcess).tools.runner.execute({
      invocationId: invocationId.from("inv-failed-process"),
      toolCallId: "call-failed-process",
      toolName: "run_process",
      capabilityId: capabilityId.from("builtin:workspace/run_process@1"),
      version: 1,
      effect: "mutation",
      input: { executable: "/bin/false", argv: [], outputMode: "raw" },
      signal: new AbortController().signal,
    });
    expect(failedProcessOutcome.status).toBe("completed");
    if (failedProcessOutcome.status === "completed") {
      expect(failedProcessOutcome.output.process).toMatchObject({ exitCode: 7, stop: "exited" });
      expect(failedProcessOutcome.result?.containedProcessExitCode).toBe(7);
    }

    const timedOutTools = composeProductProcessTools({
      generation: configurationGeneration.from(0),
      capture: createHostProcessCapturePort(),
      workspaceCwd: process.cwd(),
    });
    const timedOut = await timedOutTools.runner.execute({
      invocationId: invocationId.from("inv-timed-out"),
      toolCallId: "call-timed-out",
      toolName: "run_shell",
      capabilityId: capabilityId.from("builtin:workspace/run_shell@1"),
      version: 1,
      effect: "mutation",
      input: { command: "sleep 1", timeoutMs: 50, outputMode: "raw" },
      signal: new AbortController().signal,
    });
    expect(timedOut.status).toBe("timed-out");

    const artifacts = memoryArtifacts();
    artifacts.ingest = async (request) =>
      err({ kind: "artifact", code: "not-found", artifactId: request.artifactId });
    const reducedOutput = [
      "total 800",
      ...Array.from(
        { length: 100 },
        (_, index) =>
          `-rw-r--r--  1 user staff ${1_000 + index} Aug 26 10:00 failure-${index}.typescript.ts`,
      ),
      "",
    ].join("\n");
    const reducedCapture: ProcessCapturePort = {
      async run(request) {
        return {
          ok: true,
          value: {
            ...report(request),
            stdout: stream("stdout", reducedOutput),
          },
        };
      },
    };
    const tools = composeProductProcessTools({
      generation: configurationGeneration.from(0),
      capture: reducedCapture,
      artifacts,
      loom: createLoomPort({ artifacts }),
      workspaceId: "ws-1",
      sessionId: "session-1",
    });
    const partial = await tools.runner.execute({
      invocationId: invocationId.from("inv-artifact-failed"),
      toolCallId: "call-artifact-failed",
      toolName: "run_process",
      capabilityId: capabilityId.from("builtin:workspace/run_process@1"),
      version: 1,
      effect: "mutation",
      input: { executable: "/bin/ls", argv: ["-la"] },
      signal: new AbortController().signal,
    });
    expect(partial.status).toBe("partial");
    if (partial.status === "partial") {
      expect(partial.result?.artifacts[0]).toMatchObject({ committed: false, required: true });
      expect((partial.output.stdout as { recovery: unknown }).recovery).toBeNull();
    }
  });
});
