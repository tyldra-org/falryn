/**
 * Debug Adapter Protocol supervision contracts (#96).
 *
 * Falryn owns adapter identity, the lifecycle state machine, initialize and
 * disconnect results, and Content-Length DAP framing. Process handles stay
 * behind ManagedServicePort. Launch/attach/breakpoints remain #97; scopes and
 * variables remain #98; artifact capture remains #100.
 */

import { z } from "zod";
import type { ConfigurationGeneration, ManagedServiceId, ServiceGeneration } from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const DEBUG_ADAPTER_PROTOCOL = "dap";

export const DEBUG_ADAPTER_STATES = [
  "discovered",
  "starting",
  "initializing",
  "ready",
  "degraded",
  "failed",
  "restarting",
  "disconnecting",
  "stopped",
] as const;
export type DebugAdapterState = (typeof DEBUG_ADAPTER_STATES)[number];

export const DEBUG_ADAPTER_FAILURE_REASONS = [
  "missing-executable",
  "spawn-failed",
  "incompatible-protocol",
  "initialization-failure",
  "malformed-response",
  "request-timeout",
  "crash",
  "restart-exhaustion",
  "disconnect-timeout",
  "cancelled",
  "capacity-exceeded",
  "already-running",
  "not-found",
  "stale-generation",
  "unsupported",
  "not-ready",
] as const;
export type DebugAdapterFailureReason = (typeof DEBUG_ADAPTER_FAILURE_REASONS)[number];

export const DEFAULT_DEBUG_ADAPTER_INITIALIZE_TIMEOUT_MS = 10_000;
export const DEFAULT_DEBUG_ADAPTER_DISCONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_DEBUG_ADAPTER_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_DEBUG_ADAPTER_INITIALIZE_TIMEOUT_MS = 120_000;
export const MAX_DEBUG_ADAPTER_DISCONNECT_TIMEOUT_MS = 60_000;
export const MAX_DEBUG_ADAPTER_REQUEST_TIMEOUT_MS = 300_000;
export const MAX_DEBUG_ADAPTER_RESTARTS = 8;
export const MAX_DEBUG_ADAPTER_RESTART_WINDOW_MS = 60 * 60_000;
export const MAX_DEBUG_ADAPTER_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_DEBUG_ADAPTER_HEADER_BYTES = 8 * 1024;
export const MAX_DEBUG_ADAPTER_NAME_LENGTH = 64;
export const MAX_DEBUG_ADAPTER_PATH_LENGTH = 4_096;
export const MAX_DEBUG_ADAPTER_CAPABILITY_KEYS = 256;

export type DebugAdapterKey = {
  readonly workspaceRoot: string;
  readonly adapterName: string;
  readonly configurationGeneration: ConfigurationGeneration;
};

export type DebugAdapterLimits = {
  readonly initializeTimeoutMs: number;
  readonly disconnectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxRestarts: number;
  readonly restartWindowMs: number;
  readonly maxFrameBytes: number;
};

export const DEFAULT_DEBUG_ADAPTER_LIMITS: DebugAdapterLimits = {
  initializeTimeoutMs: DEFAULT_DEBUG_ADAPTER_INITIALIZE_TIMEOUT_MS,
  disconnectTimeoutMs: DEFAULT_DEBUG_ADAPTER_DISCONNECT_TIMEOUT_MS,
  requestTimeoutMs: DEFAULT_DEBUG_ADAPTER_REQUEST_TIMEOUT_MS,
  maxRestarts: 3,
  restartWindowMs: 60_000,
  maxFrameBytes: MAX_DEBUG_ADAPTER_FRAME_BYTES,
};

const debugAdapterLimitsInputSchema = z
  .object({
    initializeTimeoutMs: z.number().int().positive().optional(),
    disconnectTimeoutMs: z.number().int().positive().optional(),
    requestTimeoutMs: z.number().int().positive().optional(),
    maxRestarts: z.number().int().nonnegative().optional(),
    restartWindowMs: z.number().int().positive().optional(),
    maxFrameBytes: z.number().int().positive().optional(),
  })
  .strict();

export type DebugAdapterLimitsInput = z.infer<typeof debugAdapterLimitsInputSchema>;

export type DebugAdapterLimitsError = {
  readonly kind: "debug-adapter";
  readonly code: "invalid-limits";
  readonly field: keyof DebugAdapterLimits;
};

export function debugAdapterLimits(
  input: DebugAdapterLimitsInput = {},
): Result<DebugAdapterLimits, DebugAdapterLimitsError> {
  const parsed = debugAdapterLimitsInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({ kind: "debug-adapter", code: "invalid-limits", field: "initializeTimeoutMs" });
  }
  const value = parsed.data;
  const limits: DebugAdapterLimits = {
    initializeTimeoutMs:
      value.initializeTimeoutMs ?? DEFAULT_DEBUG_ADAPTER_LIMITS.initializeTimeoutMs,
    disconnectTimeoutMs:
      value.disconnectTimeoutMs ?? DEFAULT_DEBUG_ADAPTER_LIMITS.disconnectTimeoutMs,
    requestTimeoutMs: value.requestTimeoutMs ?? DEFAULT_DEBUG_ADAPTER_LIMITS.requestTimeoutMs,
    maxRestarts: value.maxRestarts ?? DEFAULT_DEBUG_ADAPTER_LIMITS.maxRestarts,
    restartWindowMs: value.restartWindowMs ?? DEFAULT_DEBUG_ADAPTER_LIMITS.restartWindowMs,
    maxFrameBytes: value.maxFrameBytes ?? DEFAULT_DEBUG_ADAPTER_LIMITS.maxFrameBytes,
  };
  if (limits.initializeTimeoutMs > MAX_DEBUG_ADAPTER_INITIALIZE_TIMEOUT_MS) {
    return err({ kind: "debug-adapter", code: "invalid-limits", field: "initializeTimeoutMs" });
  }
  if (limits.disconnectTimeoutMs > MAX_DEBUG_ADAPTER_DISCONNECT_TIMEOUT_MS) {
    return err({ kind: "debug-adapter", code: "invalid-limits", field: "disconnectTimeoutMs" });
  }
  if (limits.requestTimeoutMs > MAX_DEBUG_ADAPTER_REQUEST_TIMEOUT_MS) {
    return err({ kind: "debug-adapter", code: "invalid-limits", field: "requestTimeoutMs" });
  }
  if (limits.maxRestarts > MAX_DEBUG_ADAPTER_RESTARTS) {
    return err({ kind: "debug-adapter", code: "invalid-limits", field: "maxRestarts" });
  }
  if (limits.restartWindowMs > MAX_DEBUG_ADAPTER_RESTART_WINDOW_MS) {
    return err({ kind: "debug-adapter", code: "invalid-limits", field: "restartWindowMs" });
  }
  if (limits.maxFrameBytes > MAX_DEBUG_ADAPTER_FRAME_BYTES) {
    return err({ kind: "debug-adapter", code: "invalid-limits", field: "maxFrameBytes" });
  }
  return ok(limits);
}

export type DebugAdapterInitializeArguments = {
  readonly clientID: string;
  readonly clientName: string;
  readonly adapterID: string;
  readonly pathFormat: "path" | "uri";
  readonly linesStartAt1: boolean;
  readonly columnsStartAt1: boolean;
  readonly supportsVariableType?: boolean | undefined;
  readonly supportsVariablePaging?: boolean | undefined;
  readonly supportsRunInTerminalRequest?: boolean | undefined;
  readonly locale?: string | undefined;
};

export type DebugAdapterCapabilities = Readonly<Record<string, unknown>>;

export type DebugAdapterInitializeResult = {
  readonly capabilities: DebugAdapterCapabilities;
};

export type DebugAdapterSnapshot = {
  readonly serviceId: ManagedServiceId;
  readonly key: DebugAdapterKey;
  readonly generation: ServiceGeneration;
  readonly state: DebugAdapterState;
  readonly pid: number | null;
  readonly restartCount: number;
  readonly capabilities: DebugAdapterCapabilities | null;
  readonly failureReason: DebugAdapterFailureReason | null;
};

export type DebugAdapterError =
  | { readonly kind: "debug-adapter"; readonly code: DebugAdapterFailureReason }
  | DebugAdapterLimitsError
  | {
      readonly kind: "debug-adapter";
      readonly code: "invalid-request";
      readonly reason:
        | "invalid-adapter-name"
        | "invalid-workspace-root"
        | "invalid-executable"
        | "invalid-initialize"
        | "invalid-command"
        | "invalid-capabilities";
    }
  | {
      readonly kind: "debug-adapter";
      readonly code: "transport";
      readonly reason:
        | "header-too-large"
        | "frame-too-large"
        | "malformed-header"
        | "malformed-json";
    };

export type DebugAdapterStartRequest = {
  readonly serviceId: ManagedServiceId;
  readonly key: DebugAdapterKey;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd?: string | undefined;
  readonly initialize: DebugAdapterInitializeArguments;
  readonly limits?: DebugAdapterLimitsInput | undefined;
};

type DebugAdapterEventBase = {
  readonly serviceId: ManagedServiceId;
  readonly generation: ServiceGeneration;
  readonly order: number;
};

export type DebugAdapterEvent =
  | (DebugAdapterEventBase & { readonly kind: "state"; readonly state: DebugAdapterState })
  | (DebugAdapterEventBase & {
      readonly kind: "initialized";
      readonly capabilities: DebugAdapterCapabilities;
    })
  | (DebugAdapterEventBase & {
      readonly kind: "failed";
      readonly reason: DebugAdapterFailureReason;
    })
  | (DebugAdapterEventBase & {
      readonly kind: "dap-event";
      readonly event: string;
      readonly body: unknown;
    })
  | (DebugAdapterEventBase & { readonly kind: "stopped" });

export type DapRequest = {
  readonly seq: number;
  readonly type: "request";
  readonly command: string;
  readonly arguments?: unknown;
};

export type DapResponse = {
  readonly seq: number;
  readonly type: "response";
  readonly request_seq: number;
  readonly success: boolean;
  readonly command: string;
  readonly message?: string | undefined;
  readonly body?: unknown;
};

export type DapEventMessage = {
  readonly seq: number;
  readonly type: "event";
  readonly event: string;
  readonly body?: unknown;
};

export type DapMessage = DapRequest | DapResponse | DapEventMessage;

const encoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeDapFrame(message: DapMessage): Uint8Array {
  const body = encoder.encode(JSON.stringify(message));
  const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
  const frame = new Uint8Array(header.byteLength + body.byteLength);
  frame.set(header, 0);
  frame.set(body, header.byteLength);
  return frame;
}

export type DapFrameDecodeError = Extract<DebugAdapterError, { readonly code: "transport" }>;

export type DapFrameDecoder = {
  push(bytes: Uint8Array): Result<readonly DapMessage[], DapFrameDecodeError>;
  reset(): void;
};

function indexOfHeaderEnd(bytes: Uint8Array): number {
  for (let index = 0; index + 3 < bytes.byteLength; index += 1) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return index;
    }
  }
  return -1;
}

function parseContentLength(headerText: string): number | null {
  const match = /^Content-Length:\s*(\d+)\s*$/im.exec(headerText);
  if (match === null) {
    return null;
  }
  const length = Number(match[1]);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDapMessage(value: unknown): DapMessage | null {
  if (!isRecord(value) || typeof value.seq !== "number" || !Number.isSafeInteger(value.seq)) {
    return null;
  }
  if (value.type === "request") {
    if (typeof value.command !== "string" || value.command.length === 0) {
      return null;
    }
    return {
      seq: value.seq,
      type: "request",
      command: value.command,
      ...(value.arguments === undefined ? {} : { arguments: value.arguments }),
    };
  }
  if (value.type === "response") {
    if (
      typeof value.request_seq !== "number" ||
      !Number.isSafeInteger(value.request_seq) ||
      typeof value.success !== "boolean" ||
      typeof value.command !== "string"
    ) {
      return null;
    }
    return {
      seq: value.seq,
      type: "response",
      request_seq: value.request_seq,
      success: value.success,
      command: value.command,
      ...(typeof value.message === "string" ? { message: value.message } : {}),
      ...(value.body === undefined ? {} : { body: value.body }),
    };
  }
  if (value.type === "event") {
    if (typeof value.event !== "string" || value.event.length === 0) {
      return null;
    }
    return {
      seq: value.seq,
      type: "event",
      event: value.event,
      ...(value.body === undefined ? {} : { body: value.body }),
    };
  }
  return null;
}

export function createDapFrameDecoder(
  maxFrameBytes: number = MAX_DEBUG_ADAPTER_FRAME_BYTES,
): DapFrameDecoder {
  let buffer = new Uint8Array(0);
  return {
    reset() {
      buffer = new Uint8Array(0);
    },
    push(bytes) {
      if (bytes.byteLength === 0) {
        return ok([]);
      }
      const next = new Uint8Array(buffer.byteLength + bytes.byteLength);
      next.set(buffer, 0);
      next.set(bytes, buffer.byteLength);
      buffer = next;
      const messages: DapMessage[] = [];
      while (true) {
        const headerEnd = indexOfHeaderEnd(buffer);
        if (headerEnd === -1) {
          if (buffer.byteLength > MAX_DEBUG_ADAPTER_HEADER_BYTES) {
            buffer = new Uint8Array(0);
            return err({
              kind: "debug-adapter",
              code: "transport",
              reason: "header-too-large",
            });
          }
          return ok(messages);
        }
        if (headerEnd > MAX_DEBUG_ADAPTER_HEADER_BYTES) {
          buffer = new Uint8Array(0);
          return err({
            kind: "debug-adapter",
            code: "transport",
            reason: "header-too-large",
          });
        }
        const headerText = textDecoder.decode(buffer.subarray(0, headerEnd));
        const contentLength = parseContentLength(headerText);
        if (contentLength === null) {
          buffer = new Uint8Array(0);
          return err({
            kind: "debug-adapter",
            code: "transport",
            reason: "malformed-header",
          });
        }
        if (contentLength > maxFrameBytes) {
          buffer = new Uint8Array(0);
          return err({
            kind: "debug-adapter",
            code: "transport",
            reason: "frame-too-large",
          });
        }
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + contentLength;
        if (buffer.byteLength < bodyEnd) {
          return ok(messages);
        }
        const bodyText = textDecoder.decode(buffer.subarray(bodyStart, bodyEnd));
        buffer = buffer.subarray(bodyEnd);
        let parsed: unknown;
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          return err({
            kind: "debug-adapter",
            code: "transport",
            reason: "malformed-json",
          });
        }
        const message = parseDapMessage(parsed);
        if (message === null) {
          return err({
            kind: "debug-adapter",
            code: "transport",
            reason: "malformed-json",
          });
        }
        messages.push(message);
      }
    },
  };
}

export function parseDebugAdapterInitializeResult(
  value: unknown,
): Result<DebugAdapterInitializeResult, DebugAdapterError> {
  if (!isRecord(value)) {
    return err({ kind: "debug-adapter", code: "malformed-response" });
  }
  // DAP initialize body *is* the capabilities object.
  const keys = Object.keys(value);
  if (keys.length > MAX_DEBUG_ADAPTER_CAPABILITY_KEYS) {
    return err({ kind: "debug-adapter", code: "invalid-request", reason: "invalid-capabilities" });
  }
  return ok({ capabilities: value });
}

function isAbsoluteExecutable(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export function validateDebugAdapterStartRequest(
  request: DebugAdapterStartRequest,
): DebugAdapterError | null {
  if (
    typeof request.key.adapterName !== "string" ||
    request.key.adapterName.length === 0 ||
    request.key.adapterName.length > MAX_DEBUG_ADAPTER_NAME_LENGTH
  ) {
    return { kind: "debug-adapter", code: "invalid-request", reason: "invalid-adapter-name" };
  }
  if (
    typeof request.key.workspaceRoot !== "string" ||
    request.key.workspaceRoot.length === 0 ||
    request.key.workspaceRoot.length > MAX_DEBUG_ADAPTER_PATH_LENGTH
  ) {
    return { kind: "debug-adapter", code: "invalid-request", reason: "invalid-workspace-root" };
  }
  if (
    typeof request.executable !== "string" ||
    request.executable.length === 0 ||
    !isAbsoluteExecutable(request.executable)
  ) {
    return { kind: "debug-adapter", code: "invalid-request", reason: "invalid-executable" };
  }
  const init = request.initialize;
  if (
    typeof init.clientID !== "string" ||
    init.clientID.length === 0 ||
    typeof init.clientName !== "string" ||
    init.clientName.length === 0 ||
    typeof init.adapterID !== "string" ||
    init.adapterID.length === 0 ||
    (init.pathFormat !== "path" && init.pathFormat !== "uri") ||
    typeof init.linesStartAt1 !== "boolean" ||
    typeof init.columnsStartAt1 !== "boolean"
  ) {
    return { kind: "debug-adapter", code: "invalid-request", reason: "invalid-initialize" };
  }
  return null;
}

export function describeDebugAdapterFailure(reason: DebugAdapterFailureReason): string {
  switch (reason) {
    case "missing-executable":
      return "debug adapter executable is missing or not absolute";
    case "spawn-failed":
      return "debug adapter process failed to start";
    case "incompatible-protocol":
      return "debug adapter protocol is incompatible";
    case "initialization-failure":
      return "debug adapter initialize failed";
    case "malformed-response":
      return "debug adapter returned a malformed response";
    case "request-timeout":
      return "debug adapter request timed out";
    case "crash":
      return "debug adapter process crashed";
    case "restart-exhaustion":
      return "debug adapter restart budget exhausted";
    case "disconnect-timeout":
      return "debug adapter disconnect timed out";
    case "cancelled":
      return "debug adapter operation cancelled";
    case "capacity-exceeded":
      return "debug adapter capacity exceeded";
    case "already-running":
      return "debug adapter is already running";
    case "not-found":
      return "debug adapter session not found";
    case "stale-generation":
      return "debug adapter generation is stale";
    case "unsupported":
      return "debug adapter command is unsupported";
    case "not-ready":
      return "debug adapter is not ready";
    default:
      return assertNever(reason, "unhandled debug adapter failure");
  }
}
