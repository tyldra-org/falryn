/**
 * Ordered process-output capture, limits, and artifact spillover.
 *
 * CommandRunnerPort remains the credential-safe one-shot runner: it returns
 * stdout and discards stderr. This port is the observation path Hush and later
 * process tools consume. It records both streams in merged observation order,
 * keeps a bounded inline preview, and spills exact overflow or invalid UTF-8
 * through ArtifactStorePort. It does not reduce output, register a product
 * tool, or own process-tree cleanup.
 */

import { type ArtifactId, type ArtifactStorePort, artifactId } from "./artifact.ts";
import type { DurationMs, Instant } from "./clock.ts";
import { elapsedBetween } from "./clock.ts";
import type { ProcessCaptureId } from "./identity.ts";
import {
  type CommandRequest,
  isAbsoluteCommandPath,
  MAX_COMMAND_ARGUMENTS,
  MAX_COMMAND_ENVIRONMENT_BYTES,
  MAX_COMMAND_ENVIRONMENT_ENTRIES,
  MAX_COMMAND_SCRIPT_BYTES,
} from "./process.ts";
import { assertNever, err, type Result } from "./result.ts";

export type { ProcessCaptureId } from "./identity.ts";

/** Longest inline preview retained per stream. */
export const MAX_PROCESS_CAPTURE_INLINE_BYTES = 64 * 1_024;
export const DEFAULT_PROCESS_CAPTURE_INLINE_BYTES = MAX_PROCESS_CAPTURE_INLINE_BYTES;

/** Longest exact capture retained per stream, including spilled bytes. */
export const MAX_PROCESS_CAPTURE_BYTES = 8 * 1_024 * 1_024;
export const DEFAULT_PROCESS_CAPTURE_BYTES = 1 * 1_024 * 1_024;

/** Longest line observed before the stream is treated as overflowing. */
export const MAX_PROCESS_CAPTURE_LINE_BYTES = 64 * 1_024;
export const DEFAULT_PROCESS_CAPTURE_LINE_BYTES = 16 * 1_024;

/** Longest single queued chunk a listener may be asked to accept. */
export const MAX_PROCESS_CAPTURE_QUEUE_BYTES = 256 * 1_024;
export const DEFAULT_PROCESS_CAPTURE_QUEUE_BYTES = 64 * 1_024;

/** Longest artifact one spilled stream may commit. */
export const MAX_PROCESS_CAPTURE_ARTIFACT_BYTES = 8 * 1_024 * 1_024;
export const DEFAULT_PROCESS_CAPTURE_ARTIFACT_BYTES = 1 * 1_024 * 1_024;

export const PROCESS_STREAM_NAMES = ["stdout", "stderr"] as const;
export type ProcessStreamName = (typeof PROCESS_STREAM_NAMES)[number];

export const PROCESS_CAPTURE_ENCODINGS = ["utf-8", "binary"] as const;
export type ProcessCaptureEncoding = (typeof PROCESS_CAPTURE_ENCODINGS)[number];

export type ProcessCaptureLimits = {
  readonly maxInlineBytes: number;
  readonly maxCaptureBytes: number;
  readonly maxLineBytes: number;
  readonly maxQueueBytes: number;
  readonly maxArtifactBytes: number;
};

export type ProcessCaptureRequest = CommandRequest & {
  readonly maxInlineBytes?: number | undefined;
  readonly maxCaptureBytes?: number | undefined;
  readonly maxLineBytes?: number | undefined;
  readonly maxQueueBytes?: number | undefined;
  readonly maxArtifactBytes?: number | undefined;
};

export type ProcessCaptureExit = {
  readonly exitCode: number | null;
  readonly signal: string | null;
};

export type ProcessCaptureStop =
  | { readonly kind: "exited" }
  | { readonly kind: "timed-out"; readonly timeoutMs: DurationMs }
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "capture-exceeded";
      readonly reason: "total" | "artifact" | "queue" | "line" | "inline" | "encoding";
    }
  | { readonly kind: "uncertain"; readonly reason: "artifact-ingest-failed" | "unconfirmed-exit" };

export type ProcessCaptureArtifactRef = {
  readonly artifactId: ArtifactId;
  readonly committed: boolean;
  readonly truncated: boolean;
  readonly byteLength: number;
};

export type ProcessStreamCapture = {
  readonly stream: ProcessStreamName;
  readonly byteCount: number;
  readonly inlineBytes: Uint8Array;
  readonly inlineText: string | null;
  readonly encoding: ProcessCaptureEncoding;
  readonly truncated: boolean;
  readonly omittedBytes: number;
  readonly maxLineExceeded: boolean;
  readonly artifact: ProcessCaptureArtifactRef | null;
};

type CaptureEventBase = {
  readonly captureId: ProcessCaptureId;
  /** Merged observation order across both streams. */
  readonly order: number;
};

export type ProcessCaptureEvent =
  | (CaptureEventBase & {
      readonly kind: "started";
      readonly pid: number;
      readonly startedAt: Instant;
    })
  | (CaptureEventBase & {
      readonly kind: "chunk";
      readonly stream: ProcessStreamName;
      readonly streamOrder: number;
      readonly bytes: Uint8Array;
    })
  | (CaptureEventBase & {
      readonly kind: "truncated";
      readonly stream: ProcessStreamName;
      readonly reason: "inline" | "total" | "line" | "queue" | "artifact";
      readonly omittedBytes: number;
    })
  | (CaptureEventBase & {
      readonly kind: "spilled";
      readonly stream: ProcessStreamName;
      readonly artifactId: ArtifactId;
      readonly committed: boolean;
      readonly byteLength: number;
    })
  | (CaptureEventBase & {
      readonly kind: "exited";
      readonly exit: ProcessCaptureExit;
      readonly stop: ProcessCaptureStop;
    });

export type ProcessCaptureReport = {
  readonly captureId: ProcessCaptureId;
  readonly pid: number | null;
  readonly startedAt: Instant;
  readonly endedAt: Instant;
  readonly durationMs: DurationMs;
  readonly stop: ProcessCaptureStop;
  readonly exit: ProcessCaptureExit;
  readonly stdout: ProcessStreamCapture;
  readonly stderr: ProcessStreamCapture;
  readonly events: readonly ProcessCaptureEvent[];
};

export type ProcessCaptureValidationCode =
  | "invalid-executable"
  | "invalid-working-directory"
  | "invalid-argument"
  | "too-many-arguments"
  | "invalid-command"
  | "command-too-large"
  | "invalid-environment"
  | "environment-too-large"
  | "invalid-timeout"
  | "invalid-output-limit"
  | "invalid-inline-limit"
  | "invalid-capture-limit"
  | "invalid-line-limit"
  | "invalid-queue-limit"
  | "invalid-artifact-limit";

export type ProcessCaptureError =
  | {
      readonly kind: "process-capture";
      readonly code: "invalid-request";
      readonly reason: ProcessCaptureValidationCode;
    }
  | {
      readonly kind: "process-capture";
      readonly code: "spawn-failed";
      readonly detail: string | null;
    }
  | { readonly kind: "process-capture"; readonly code: "invalid-capture-id" };

export type ProcessCaptureListener = (event: ProcessCaptureEvent) => void | Promise<void>;

export type ProcessCapturePort = {
  run(
    request: ProcessCaptureRequest,
    listener?: ProcessCaptureListener,
  ): Promise<Result<ProcessCaptureReport, ProcessCaptureError>>;
};

export type CapturePressure =
  | "continue"
  | "total"
  | "artifact"
  | "queue"
  | "line"
  | "inline"
  | "encoding";

export type ProcessCaptureCollector = {
  start(pid: number, startedAt: Instant): Promise<void>;
  append(stream: ProcessStreamName, bytes: Uint8Array): Promise<CapturePressure>;
  finish(
    exit: ProcessCaptureExit,
    endedAt: Instant,
    stop: ProcessCaptureStop,
  ): Promise<ProcessCaptureReport>;
};

export function invalidProcessCaptureRequest(
  reason: ProcessCaptureValidationCode,
): Result<never, ProcessCaptureError> {
  return err({ kind: "process-capture", code: "invalid-request", reason });
}

export function resolveProcessCaptureLimits(request: ProcessCaptureRequest): ProcessCaptureLimits {
  return {
    maxInlineBytes: clampLimit(
      request.maxInlineBytes,
      DEFAULT_PROCESS_CAPTURE_INLINE_BYTES,
      MAX_PROCESS_CAPTURE_INLINE_BYTES,
    ),
    maxCaptureBytes: clampLimit(
      request.maxCaptureBytes,
      DEFAULT_PROCESS_CAPTURE_BYTES,
      MAX_PROCESS_CAPTURE_BYTES,
    ),
    maxLineBytes: clampLimit(
      request.maxLineBytes,
      DEFAULT_PROCESS_CAPTURE_LINE_BYTES,
      MAX_PROCESS_CAPTURE_LINE_BYTES,
    ),
    maxQueueBytes: clampLimit(
      request.maxQueueBytes,
      DEFAULT_PROCESS_CAPTURE_QUEUE_BYTES,
      MAX_PROCESS_CAPTURE_QUEUE_BYTES,
    ),
    maxArtifactBytes: clampLimit(
      request.maxArtifactBytes,
      DEFAULT_PROCESS_CAPTURE_ARTIFACT_BYTES,
      MAX_PROCESS_CAPTURE_ARTIFACT_BYTES,
    ),
  };
}

export function validateProcessCaptureRequest(
  request: ProcessCaptureRequest,
): ProcessCaptureValidationCode | null {
  if (!isAbsoluteCommandPath(request.executable)) {
    return "invalid-executable";
  }
  if (request.cwd !== undefined && !isAbsoluteCommandPath(request.cwd)) {
    return "invalid-working-directory";
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0) {
    return "invalid-timeout";
  }
  if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 0) {
    return "invalid-output-limit";
  }
  const environmentError = validateEnvironment(request.environment);
  if (environmentError !== null) {
    return environmentError;
  }
  if (request.mode === "bash") {
    if (request.command.includes("\0")) {
      return "invalid-command";
    }
    if (new TextEncoder().encode(request.command).byteLength > MAX_COMMAND_SCRIPT_BYTES) {
      return "command-too-large";
    }
  } else {
    if (request.argv.length > MAX_COMMAND_ARGUMENTS) {
      return "too-many-arguments";
    }
    if (request.argv.some((argument) => argument.includes("\0"))) {
      return "invalid-argument";
    }
  }
  const limitError = validateOptionalLimit(request.maxInlineBytes, "invalid-inline-limit");
  if (limitError !== null) {
    return limitError;
  }
  const captureError = validateOptionalLimit(request.maxCaptureBytes, "invalid-capture-limit");
  if (captureError !== null) {
    return captureError;
  }
  const lineError = validateOptionalLimit(request.maxLineBytes, "invalid-line-limit");
  if (lineError !== null) {
    return lineError;
  }
  const queueError = validateOptionalLimit(request.maxQueueBytes, "invalid-queue-limit");
  if (queueError !== null) {
    return queueError;
  }
  return validateOptionalLimit(request.maxArtifactBytes, "invalid-artifact-limit");
}

export function processCaptureArtifactId(
  captureId: ProcessCaptureId,
  stream: ProcessStreamName,
): Result<ArtifactId, ProcessCaptureError> {
  const parsed = artifactId.parse(`${captureId}.${stream}`);
  return parsed.ok ? parsed : err({ kind: "process-capture", code: "invalid-capture-id" });
}

type ProcessCaptureEventDetail = {
  [Kind in ProcessCaptureEvent["kind"]]: Omit<
    Extract<ProcessCaptureEvent, { readonly kind: Kind }>,
    "captureId" | "order"
  >;
}[ProcessCaptureEvent["kind"]];

export function createProcessCaptureCollector(options: {
  readonly captureId: ProcessCaptureId;
  readonly limits: ProcessCaptureLimits;
  readonly artifacts: ArtifactStorePort | null;
  readonly listener?: ProcessCaptureListener | undefined;
}): ProcessCaptureCollector {
  const streams: Record<ProcessStreamName, StreamBuffer> = {
    stdout: newStreamBuffer(),
    stderr: newStreamBuffer(),
  };
  const events: ProcessCaptureEvent[] = [];
  let order = 0;
  let pid: number | null = null;
  let startedAt: Instant | null = null;
  const announcedTruncation: Record<ProcessStreamName, Set<string>> = {
    stdout: new Set(),
    stderr: new Set(),
  };

  const emit = async (detail: ProcessCaptureEventDetail): Promise<void> => {
    order += 1;
    const event = { captureId: options.captureId, order, ...detail } as ProcessCaptureEvent;
    events.push(event);
    if (options.listener === undefined) {
      return;
    }
    try {
      await options.listener(event);
    } catch {
      // A capture observer cannot break process supervision.
    }
  };

  const noteTruncation = async (
    stream: ProcessStreamName,
    reason: "inline" | "total" | "line" | "queue" | "artifact",
    omittedBytes: number,
  ): Promise<void> => {
    if (announcedTruncation[stream].has(reason)) {
      return;
    }
    announcedTruncation[stream].add(reason);
    await emit({ kind: "truncated", stream, reason, omittedBytes });
  };

  return {
    async start(nextPid: number, nextStartedAt: Instant): Promise<void> {
      pid = nextPid;
      startedAt = nextStartedAt;
      await emit({ kind: "started", pid: nextPid, startedAt: nextStartedAt });
    },

    async append(stream: ProcessStreamName, bytes: Uint8Array): Promise<CapturePressure> {
      if (bytes.byteLength === 0) {
        return "continue";
      }
      const copy = copyBytes(bytes);
      const buffer = streams[stream];
      buffer.streamOrder += 1;
      await emit({
        kind: "chunk",
        stream,
        streamOrder: buffer.streamOrder,
        bytes: copyBytes(copy),
      });

      if (!buffer.invalidUtf8) {
        try {
          buffer.decoder.decode(copy, { stream: true });
        } catch {
          buffer.invalidUtf8 = true;
          if (options.artifacts === null) {
            return "encoding";
          }
        }
      }

      if (copy.byteLength > options.limits.maxQueueBytes) {
        buffer.truncated = true;
        await noteTruncation(stream, "queue", 0);
        if (options.artifacts === null) {
          return "queue";
        }
      }

      for (const byte of copy) {
        if (byte === 0x0a) {
          buffer.lineBytes = 0;
        } else {
          buffer.lineBytes += 1;
          if (buffer.lineBytes > options.limits.maxLineBytes) {
            buffer.maxLineExceeded = true;
            buffer.truncated = true;
          }
        }
      }
      if (buffer.maxLineExceeded) {
        await noteTruncation(stream, "line", 0);
        if (options.artifacts === null) {
          buffer.omittedBytes += copy.byteLength;
          return "line";
        }
      }

      const remaining = options.limits.maxCaptureBytes - buffer.byteCount;
      if (remaining <= 0) {
        buffer.truncated = true;
        buffer.omittedBytes += copy.byteLength;
        await noteTruncation(stream, "total", buffer.omittedBytes);
        return "total";
      }

      const accepted = copy.byteLength <= remaining ? copy : copy.subarray(0, remaining);
      const omitted = copy.byteLength - accepted.byteLength;
      buffer.chunks.push(copyBytes(accepted));
      buffer.byteCount += accepted.byteLength;
      if (omitted > 0) {
        buffer.truncated = true;
        buffer.omittedBytes += omitted;
        await noteTruncation(stream, "total", buffer.omittedBytes);
      }

      if (buffer.byteCount > options.limits.maxInlineBytes) {
        buffer.truncated = true;
        await noteTruncation(stream, "inline", buffer.byteCount - options.limits.maxInlineBytes);
        if (options.artifacts === null) {
          return "inline";
        }
      }

      if (buffer.byteCount > options.limits.maxArtifactBytes) {
        const overflow = buffer.byteCount - options.limits.maxArtifactBytes;
        trimBufferTo(buffer, options.limits.maxArtifactBytes);
        buffer.truncated = true;
        buffer.omittedBytes += overflow + omitted;
        await noteTruncation(stream, "artifact", buffer.omittedBytes);
        return "artifact";
      }

      if (omitted > 0) {
        return "total";
      }
      if (buffer.truncated && options.artifacts === null) {
        return buffer.maxLineExceeded ? "line" : "inline";
      }
      return "continue";
    },

    async finish(
      exit: ProcessCaptureExit,
      endedAt: Instant,
      stop: ProcessCaptureStop,
    ): Promise<ProcessCaptureReport> {
      const origin = startedAt ?? endedAt;
      let nextStop = stop;
      const stdout = await finalizeStream(
        options.captureId,
        "stdout",
        streams.stdout,
        options.limits,
        options.artifacts,
        emit,
      );
      const stderr = await finalizeStream(
        options.captureId,
        "stderr",
        streams.stderr,
        options.limits,
        options.artifacts,
        emit,
      );
      if (spillFailed(stdout) || spillFailed(stderr)) {
        nextStop = { kind: "uncertain", reason: "artifact-ingest-failed" };
      }
      await emit({ kind: "exited", exit, stop: nextStop });
      return {
        captureId: options.captureId,
        pid,
        startedAt: origin,
        endedAt,
        durationMs: elapsedBetween(origin, endedAt),
        stop: nextStop,
        exit,
        stdout,
        stderr,
        events,
      };
    },
  };
}

type StreamBuffer = {
  chunks: Uint8Array[];
  byteCount: number;
  omittedBytes: number;
  truncated: boolean;
  maxLineExceeded: boolean;
  invalidUtf8: boolean;
  decoder: TextDecoder;
  lineBytes: number;
  streamOrder: number;
};

function newStreamBuffer(): StreamBuffer {
  return {
    chunks: [],
    byteCount: 0,
    omittedBytes: 0,
    truncated: false,
    maxLineExceeded: false,
    invalidUtf8: false,
    decoder: new TextDecoder("utf-8", { fatal: true }),
    lineBytes: 0,
    streamOrder: 0,
  };
}

function trimBufferTo(buffer: StreamBuffer, maximumBytes: number): void {
  if (buffer.byteCount <= maximumBytes) {
    return;
  }
  const joined = joinChunks(buffer.chunks, maximumBytes);
  buffer.chunks = [joined];
  buffer.byteCount = joined.byteLength;
}

function spillFailed(capture: ProcessStreamCapture): boolean {
  return capture.artifact !== null && !capture.artifact.committed;
}

async function finalizeStream(
  captureId: ProcessCaptureId,
  stream: ProcessStreamName,
  buffer: StreamBuffer,
  limits: ProcessCaptureLimits,
  artifacts: ArtifactStorePort | null,
  emit: (detail: ProcessCaptureEventDetail) => Promise<void>,
): Promise<ProcessStreamCapture> {
  const retained = joinChunks(buffer.chunks, buffer.byteCount);
  const inlineBytes = retained.subarray(0, Math.min(retained.byteLength, limits.maxInlineBytes));
  if (!buffer.invalidUtf8) {
    try {
      buffer.decoder.decode();
    } catch {
      buffer.invalidUtf8 = true;
    }
  }
  const decoded = buffer.invalidUtf8 ? null : decodeUtf8(retained);
  const encoding: ProcessCaptureEncoding = decoded === null ? "binary" : "utf-8";
  const needsArtifact =
    buffer.truncated || encoding === "binary" || retained.byteLength > limits.maxInlineBytes;
  let artifact: ProcessCaptureArtifactRef | null = null;
  if (needsArtifact && artifacts !== null) {
    const identity = processCaptureArtifactId(captureId, stream);
    if (!identity.ok) {
      artifact = {
        artifactId: artifactId.from("capture.invalid"),
        committed: false,
        truncated: true,
        byteLength: retained.byteLength,
      };
    } else {
      const ingested = await artifacts.ingest({
        artifactId: identity.value,
        mediaType: encoding === "utf-8" ? "text/plain" : "application/octet-stream",
        encoding: "identity",
        sensitivity: "user-content",
        origin: "capture",
        invocationId: null,
        declaredByteLength: retained.byteLength,
        content: chunksOf(retained),
      });
      artifact = {
        artifactId: identity.value,
        committed: ingested.ok,
        truncated: buffer.omittedBytes > 0,
        byteLength: retained.byteLength,
      };
      await emit({
        kind: "spilled",
        stream,
        artifactId: identity.value,
        committed: ingested.ok,
        byteLength: retained.byteLength,
      });
    }
  }
  return {
    stream,
    byteCount: buffer.byteCount,
    inlineBytes: copyBytes(inlineBytes),
    inlineText: encoding === "utf-8" ? decodeUtf8(inlineBytes) : null,
    encoding,
    truncated: buffer.truncated || encoding === "binary",
    omittedBytes: buffer.omittedBytes,
    maxLineExceeded: buffer.maxLineExceeded,
    artifact,
  };
}

function chunksOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array, void, undefined> {
      if (bytes.byteLength > 0) {
        yield copyBytes(bytes);
      }
    },
  };
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function joinChunks(chunks: readonly Uint8Array[], byteCount: number): Uint8Array {
  const joined = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= byteCount) {
      break;
    }
    const take = Math.min(chunk.byteLength, byteCount - offset);
    joined.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return joined;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function clampLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.min(value, maximum);
}

function validateOptionalLimit(
  value: number | undefined,
  code:
    | "invalid-inline-limit"
    | "invalid-capture-limit"
    | "invalid-line-limit"
    | "invalid-queue-limit"
    | "invalid-artifact-limit",
): ProcessCaptureValidationCode | null {
  if (value === undefined) {
    return null;
  }
  return Number.isSafeInteger(value) && value >= 0 ? null : code;
}

function validateEnvironment(
  environment: Readonly<Record<string, string>>,
): "invalid-environment" | "environment-too-large" | null {
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    return "invalid-environment";
  }
  const entries = Object.entries(environment);
  if (entries.length > MAX_COMMAND_ENVIRONMENT_ENTRIES) {
    return "environment-too-large";
  }
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const [name, value] of entries) {
    if (name.includes("\0") || typeof value !== "string" || value.includes("\0")) {
      return "invalid-environment";
    }
    bytes += encoder.encode(`${name}=${value}`).byteLength;
    if (bytes > MAX_COMMAND_ENVIRONMENT_BYTES) {
      return "environment-too-large";
    }
  }
  return null;
}

export function describeProcessCaptureStop(stop: ProcessCaptureStop): string {
  switch (stop.kind) {
    case "exited":
      return "exited";
    case "timed-out":
      return "timed-out";
    case "cancelled":
      return "cancelled";
    case "capture-exceeded":
      return `capture-exceeded:${stop.reason}`;
    case "uncertain":
      return `uncertain:${stop.reason}`;
    default:
      return assertNever(stop, "unhandled process capture stop");
  }
}
