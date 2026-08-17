/**
 * Language-server lifecycle contracts (#89).
 *
 * Falryn owns server identity, the lifecycle state machine, initialize and
 * shutdown results, and JSON-RPC framing. Process handles stay behind
 * ManagedServicePort. Feature requests are #91; edits-as-patches remain #92.
 */

import { z } from "zod";
import type { ConfigurationGeneration, ManagedServiceId, ServiceGeneration } from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const LANGUAGE_SERVER_PROTOCOL = "lsp";

export const LANGUAGE_SERVER_STATES = [
  "discovered",
  "starting",
  "initializing",
  "ready",
  "degraded",
  "failed",
  "restarting",
  "shutting-down",
  "stopped",
] as const;
export type LanguageServerState = (typeof LANGUAGE_SERVER_STATES)[number];

export const LANGUAGE_SERVER_FAILURE_REASONS = [
  "missing-executable",
  "spawn-failed",
  "incompatible-protocol",
  "initialization-failure",
  "malformed-response",
  "request-timeout",
  "crash",
  "restart-exhaustion",
  "shutdown-timeout",
  "cancelled",
  "capacity-exceeded",
  "already-running",
  "not-found",
  "stale-generation",
  "unsupported",
  "not-ready",
  "document-not-open",
  "document-already-open",
  "stale-document",
] as const;
export type LanguageServerFailureReason = (typeof LANGUAGE_SERVER_FAILURE_REASONS)[number];

export const DEFAULT_LANGUAGE_SERVER_INITIALIZE_TIMEOUT_MS = 10_000;
export const DEFAULT_LANGUAGE_SERVER_SHUTDOWN_TIMEOUT_MS = 5_000;
export const DEFAULT_LANGUAGE_SERVER_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_LANGUAGE_SERVER_INITIALIZE_TIMEOUT_MS = 120_000;
export const MAX_LANGUAGE_SERVER_SHUTDOWN_TIMEOUT_MS = 60_000;
export const MAX_LANGUAGE_SERVER_REQUEST_TIMEOUT_MS = 300_000;
export const MAX_LANGUAGE_SERVER_RESTARTS = 8;
export const MAX_LANGUAGE_SERVER_RESTART_WINDOW_MS = 60 * 60_000;
export const MAX_LANGUAGE_SERVER_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_LANGUAGE_SERVER_HEADER_BYTES = 8 * 1024;
export const MAX_LANGUAGE_SERVER_SERVER_NAME_LENGTH = 64;
export const MAX_LANGUAGE_SERVER_ROOT_URI_LENGTH = 4_096;
export const MAX_LANGUAGE_SERVER_CAPABILITY_KEYS = 256;
export const LANGUAGE_SERVER_JSONRPC_VERSION = "2.0";

export type LanguageServerKey = {
  readonly workspaceRoot: string;
  readonly serverName: string;
  readonly configurationGeneration: ConfigurationGeneration;
};

export type LanguageServerLimits = {
  readonly initializeTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxRestarts: number;
  readonly restartWindowMs: number;
  readonly maxFrameBytes: number;
};

export const DEFAULT_LANGUAGE_SERVER_LIMITS: LanguageServerLimits = {
  initializeTimeoutMs: DEFAULT_LANGUAGE_SERVER_INITIALIZE_TIMEOUT_MS,
  shutdownTimeoutMs: DEFAULT_LANGUAGE_SERVER_SHUTDOWN_TIMEOUT_MS,
  requestTimeoutMs: DEFAULT_LANGUAGE_SERVER_REQUEST_TIMEOUT_MS,
  maxRestarts: 3,
  restartWindowMs: 60_000,
  maxFrameBytes: MAX_LANGUAGE_SERVER_FRAME_BYTES,
};

const languageServerLimitsInputSchema = z
  .object({
    initializeTimeoutMs: z.number().int().positive().optional(),
    shutdownTimeoutMs: z.number().int().positive().optional(),
    requestTimeoutMs: z.number().int().positive().optional(),
    maxRestarts: z.number().int().nonnegative().optional(),
    restartWindowMs: z.number().int().positive().optional(),
    maxFrameBytes: z.number().int().positive().optional(),
  })
  .strict();

export type LanguageServerLimitsInput = z.infer<typeof languageServerLimitsInputSchema>;

export type LanguageServerLimitsError = {
  readonly kind: "language-server";
  readonly code: "invalid-limits";
  readonly field: keyof LanguageServerLimits;
};

export function languageServerLimits(
  input: LanguageServerLimitsInput = {},
): Result<LanguageServerLimits, LanguageServerLimitsError> {
  const parsed = languageServerLimitsInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({ kind: "language-server", code: "invalid-limits", field: "initializeTimeoutMs" });
  }
  const value = parsed.data;
  const limits: LanguageServerLimits = {
    initializeTimeoutMs:
      value.initializeTimeoutMs ?? DEFAULT_LANGUAGE_SERVER_LIMITS.initializeTimeoutMs,
    shutdownTimeoutMs: value.shutdownTimeoutMs ?? DEFAULT_LANGUAGE_SERVER_LIMITS.shutdownTimeoutMs,
    requestTimeoutMs: value.requestTimeoutMs ?? DEFAULT_LANGUAGE_SERVER_LIMITS.requestTimeoutMs,
    maxRestarts: value.maxRestarts ?? DEFAULT_LANGUAGE_SERVER_LIMITS.maxRestarts,
    restartWindowMs: value.restartWindowMs ?? DEFAULT_LANGUAGE_SERVER_LIMITS.restartWindowMs,
    maxFrameBytes: value.maxFrameBytes ?? DEFAULT_LANGUAGE_SERVER_LIMITS.maxFrameBytes,
  };
  if (limits.initializeTimeoutMs > MAX_LANGUAGE_SERVER_INITIALIZE_TIMEOUT_MS) {
    return err({ kind: "language-server", code: "invalid-limits", field: "initializeTimeoutMs" });
  }
  if (limits.shutdownTimeoutMs > MAX_LANGUAGE_SERVER_SHUTDOWN_TIMEOUT_MS) {
    return err({ kind: "language-server", code: "invalid-limits", field: "shutdownTimeoutMs" });
  }
  if (limits.requestTimeoutMs > MAX_LANGUAGE_SERVER_REQUEST_TIMEOUT_MS) {
    return err({ kind: "language-server", code: "invalid-limits", field: "requestTimeoutMs" });
  }
  if (limits.maxRestarts > MAX_LANGUAGE_SERVER_RESTARTS) {
    return err({ kind: "language-server", code: "invalid-limits", field: "maxRestarts" });
  }
  if (limits.restartWindowMs > MAX_LANGUAGE_SERVER_RESTART_WINDOW_MS) {
    return err({ kind: "language-server", code: "invalid-limits", field: "restartWindowMs" });
  }
  if (limits.maxFrameBytes > MAX_LANGUAGE_SERVER_FRAME_BYTES) {
    return err({ kind: "language-server", code: "invalid-limits", field: "maxFrameBytes" });
  }
  return ok(limits);
}

export type LanguageServerClientInfo = {
  readonly name: string;
  readonly version: string;
};

export type LanguageServerInitializeParams = {
  readonly processId: number | null;
  readonly rootUri: string | null;
  readonly workspaceFolders: readonly { readonly uri: string; readonly name: string }[] | null;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly clientInfo: LanguageServerClientInfo;
  readonly locale?: string | undefined;
};

export type LanguageServerInitializeResult = {
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly serverInfo: LanguageServerClientInfo | null;
};

export type LanguageServerSnapshot = {
  readonly serviceId: ManagedServiceId;
  readonly key: LanguageServerKey;
  readonly generation: ServiceGeneration;
  readonly state: LanguageServerState;
  readonly pid: number | null;
  readonly restartCount: number;
  readonly capabilities: Readonly<Record<string, unknown>> | null;
  readonly serverInfo: LanguageServerClientInfo | null;
  readonly failureReason: LanguageServerFailureReason | null;
  readonly openDocuments: readonly {
    readonly uri: string;
    readonly languageId: string;
    readonly version: number;
  }[];
  readonly workspaceFolders: readonly { readonly uri: string; readonly name: string }[];
  readonly registeredCapabilities: readonly {
    readonly id: string;
    readonly method: string;
  }[];
};

export type LanguageServerError =
  | { readonly kind: "language-server"; readonly code: LanguageServerFailureReason }
  | LanguageServerLimitsError
  | {
      readonly kind: "language-server";
      readonly code: "invalid-request";
      readonly reason:
        | "invalid-server-name"
        | "invalid-workspace-root"
        | "invalid-executable"
        | "invalid-root-uri"
        | "invalid-capabilities"
        | "invalid-uri"
        | "invalid-language-id"
        | "invalid-version"
        | "invalid-text"
        | "text-too-large"
        | "too-many-changes"
        | "invalid-change"
        | "invalid-folder"
        | "too-many-folders"
        | "invalid-capability"
        | "invalid-position"
        | "invalid-range"
        | "invalid-diagnostic"
        | "invalid-hover"
        | "invalid-location"
        | "invalid-symbol"
        | "invalid-completion"
        | "result-too-large";
    }
  | {
      readonly kind: "language-server";
      readonly code: "transport";
      readonly reason:
        | "header-too-large"
        | "frame-too-large"
        | "malformed-header"
        | "malformed-json";
    };

export type LanguageServerStartRequest = {
  readonly serviceId: ManagedServiceId;
  readonly key: LanguageServerKey;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd?: string | undefined;
  readonly initialize: LanguageServerInitializeParams;
  readonly limits?: LanguageServerLimitsInput | undefined;
};

type LanguageServerEventBase = {
  readonly serviceId: ManagedServiceId;
  readonly generation: ServiceGeneration;
  readonly order: number;
};

export type LanguageServerEvent =
  | (LanguageServerEventBase & { readonly kind: "state"; readonly state: LanguageServerState })
  | (LanguageServerEventBase & {
      readonly kind: "initialized";
      readonly capabilities: Readonly<Record<string, unknown>>;
      readonly serverInfo: LanguageServerClientInfo | null;
    })
  | (LanguageServerEventBase & {
      readonly kind: "failed";
      readonly reason: LanguageServerFailureReason;
    })
  | (LanguageServerEventBase & {
      readonly kind: "notification";
      readonly method: string;
      readonly params: unknown;
    })
  | (LanguageServerEventBase & {
      readonly kind: "document-opened";
      readonly uri: string;
      readonly languageId: string;
      readonly version: number;
    })
  | (LanguageServerEventBase & {
      readonly kind: "document-changed";
      readonly uri: string;
      readonly version: number;
    })
  | (LanguageServerEventBase & { readonly kind: "document-saved"; readonly uri: string })
  | (LanguageServerEventBase & { readonly kind: "document-closed"; readonly uri: string })
  | (LanguageServerEventBase & {
      readonly kind: "workspace-folders-changed";
      readonly folders: readonly { readonly uri: string; readonly name: string }[];
    })
  | (LanguageServerEventBase & {
      readonly kind: "capability-registered";
      readonly id: string;
      readonly method: string;
    })
  | (LanguageServerEventBase & {
      readonly kind: "capability-unregistered";
      readonly id: string;
    })
  | (LanguageServerEventBase & {
      readonly kind: "diagnostics";
      readonly uri: string;
      readonly version: number | null;
      readonly diagnostics: readonly {
        readonly range: {
          readonly start: { readonly line: number; readonly character: number };
          readonly end: { readonly line: number; readonly character: number };
        };
        readonly message: string;
        readonly severity?: 1 | 2 | 3 | 4 | undefined;
        readonly code?: string | number | undefined;
        readonly source?: string | undefined;
        readonly tags?: readonly number[] | undefined;
      }[];
    })
  | (LanguageServerEventBase & { readonly kind: "stopped" });

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  readonly jsonrpc: typeof LANGUAGE_SERVER_JSONRPC_VERSION;
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
};

export type JsonRpcNotification = {
  readonly jsonrpc: typeof LANGUAGE_SERVER_JSONRPC_VERSION;
  readonly method: string;
  readonly params?: unknown;
};

export type JsonRpcSuccess = {
  readonly jsonrpc: typeof LANGUAGE_SERVER_JSONRPC_VERSION;
  readonly id: JsonRpcId;
  readonly result: unknown;
};

export type JsonRpcFailure = {
  readonly jsonrpc: typeof LANGUAGE_SERVER_JSONRPC_VERSION;
  readonly id: JsonRpcId | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeJsonRpcFrame(message: JsonRpcMessage): Uint8Array {
  const body = encoder.encode(`${JSON.stringify(message)}\r\n`);
  const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
  const frame = new Uint8Array(header.byteLength + body.byteLength);
  frame.set(header, 0);
  frame.set(body, header.byteLength);
  return frame;
}

export type JsonRpcFrameDecodeError = Extract<LanguageServerError, { readonly code: "transport" }>;

export type JsonRpcFrameDecoder = {
  push(bytes: Uint8Array): Result<readonly JsonRpcMessage[], JsonRpcFrameDecodeError>;
  reset(): void;
};

export function createJsonRpcFrameDecoder(
  maxFrameBytes = MAX_LANGUAGE_SERVER_FRAME_BYTES,
): JsonRpcFrameDecoder {
  let buffer = new Uint8Array(0);

  return {
    push(bytes) {
      if (bytes.byteLength === 0) {
        return ok([]);
      }
      const next = new Uint8Array(buffer.byteLength + bytes.byteLength);
      next.set(buffer, 0);
      next.set(bytes, buffer.byteLength);
      buffer = next;

      const messages: JsonRpcMessage[] = [];
      while (true) {
        const headerEnd = indexOfHeaderEnd(buffer);
        if (headerEnd === -1) {
          if (buffer.byteLength > MAX_LANGUAGE_SERVER_HEADER_BYTES) {
            buffer = new Uint8Array(0);
            return err({
              kind: "language-server",
              code: "transport",
              reason: "header-too-large",
            });
          }
          return ok(messages);
        }

        const headerText = decoder.decode(buffer.subarray(0, headerEnd));
        const contentLength = parseContentLength(headerText);
        if (contentLength === null) {
          buffer = new Uint8Array(0);
          return err({
            kind: "language-server",
            code: "transport",
            reason: "malformed-header",
          });
        }
        if (contentLength > maxFrameBytes) {
          buffer = new Uint8Array(0);
          return err({
            kind: "language-server",
            code: "transport",
            reason: "frame-too-large",
          });
        }

        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + contentLength;
        if (buffer.byteLength < bodyEnd) {
          return ok(messages);
        }

        const bodyText = decoder.decode(buffer.subarray(bodyStart, bodyEnd));
        buffer = buffer.subarray(bodyEnd);
        let parsed: unknown;
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          return err({
            kind: "language-server",
            code: "transport",
            reason: "malformed-json",
          });
        }
        const message = parseJsonRpcMessage(parsed);
        if (message === null) {
          return err({
            kind: "language-server",
            code: "transport",
            reason: "malformed-json",
          });
        }
        messages.push(message);
      }
    },

    reset() {
      buffer = new Uint8Array(0);
    },
  };
}

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
  const lines = headerText.split(/\r\n/);
  for (const line of lines) {
    const match = /^Content-Length:\s*(\d+)\s*$/i.exec(line);
    if (match !== null) {
      const length = Number(match[1]);
      return Number.isSafeInteger(length) && length >= 0 ? length : null;
    }
  }
  return null;
}

function parseJsonRpcMessage(value: unknown): JsonRpcMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== LANGUAGE_SERVER_JSONRPC_VERSION) {
    return null;
  }
  if (typeof record.method === "string") {
    if ("id" in record) {
      if (!isJsonRpcId(record.id)) {
        return null;
      }
      return {
        jsonrpc: LANGUAGE_SERVER_JSONRPC_VERSION,
        id: record.id,
        method: record.method,
        ...(record.params === undefined ? {} : { params: record.params }),
      };
    }
    return {
      jsonrpc: LANGUAGE_SERVER_JSONRPC_VERSION,
      method: record.method,
      ...(record.params === undefined ? {} : { params: record.params }),
    };
  }
  if ("result" in record) {
    if (!isJsonRpcId(record.id)) {
      return null;
    }
    return {
      jsonrpc: LANGUAGE_SERVER_JSONRPC_VERSION,
      id: record.id,
      result: record.result,
    };
  }
  if ("error" in record) {
    const failure = record.error;
    if (typeof failure !== "object" || failure === null || Array.isArray(failure)) {
      return null;
    }
    const errorRecord = failure as Record<string, unknown>;
    if (typeof errorRecord.code !== "number" || typeof errorRecord.message !== "string") {
      return null;
    }
    if (record.id !== null && !isJsonRpcId(record.id)) {
      return null;
    }
    return {
      jsonrpc: LANGUAGE_SERVER_JSONRPC_VERSION,
      id: (record.id as JsonRpcId | null) ?? null,
      error: {
        code: errorRecord.code,
        message: errorRecord.message,
        ...(errorRecord.data === undefined ? {} : { data: errorRecord.data }),
      },
    };
  }
  return null;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

export function parseLanguageServerInitializeResult(
  value: unknown,
): Result<LanguageServerInitializeResult, LanguageServerError> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err({ kind: "language-server", code: "malformed-response" });
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.capabilities !== "object" ||
    record.capabilities === null ||
    Array.isArray(record.capabilities)
  ) {
    return err({ kind: "language-server", code: "malformed-response" });
  }
  const capabilities = record.capabilities as Record<string, unknown>;
  if (Object.keys(capabilities).length > MAX_LANGUAGE_SERVER_CAPABILITY_KEYS) {
    return err({
      kind: "language-server",
      code: "invalid-request",
      reason: "invalid-capabilities",
    });
  }
  let serverInfo: LanguageServerClientInfo | null = null;
  if (record.serverInfo !== undefined) {
    if (
      typeof record.serverInfo !== "object" ||
      record.serverInfo === null ||
      Array.isArray(record.serverInfo)
    ) {
      return err({ kind: "language-server", code: "malformed-response" });
    }
    const info = record.serverInfo as Record<string, unknown>;
    if (typeof info.name !== "string" || typeof info.version !== "string") {
      return err({ kind: "language-server", code: "malformed-response" });
    }
    serverInfo = { name: info.name, version: info.version };
  }
  return ok({ capabilities, serverInfo });
}

export function validateLanguageServerStartRequest(
  request: LanguageServerStartRequest,
): LanguageServerError | null {
  if (
    request.key.serverName.length === 0 ||
    request.key.serverName.length > MAX_LANGUAGE_SERVER_SERVER_NAME_LENGTH ||
    request.key.serverName.includes("\0")
  ) {
    return {
      kind: "language-server",
      code: "invalid-request",
      reason: "invalid-server-name",
    };
  }
  if (request.key.workspaceRoot.length === 0 || request.key.workspaceRoot.includes("\0")) {
    return {
      kind: "language-server",
      code: "invalid-request",
      reason: "invalid-workspace-root",
    };
  }
  if (request.executable.length === 0 || !request.executable.startsWith("/")) {
    return {
      kind: "language-server",
      code: "invalid-request",
      reason: "invalid-executable",
    };
  }
  if (
    request.initialize.rootUri !== null &&
    (request.initialize.rootUri.length === 0 ||
      request.initialize.rootUri.length > MAX_LANGUAGE_SERVER_ROOT_URI_LENGTH)
  ) {
    return {
      kind: "language-server",
      code: "invalid-request",
      reason: "invalid-root-uri",
    };
  }
  if (Object.keys(request.initialize.capabilities).length > MAX_LANGUAGE_SERVER_CAPABILITY_KEYS) {
    return {
      kind: "language-server",
      code: "invalid-request",
      reason: "invalid-capabilities",
    };
  }
  return null;
}

export function isLanguageServerState(value: string): value is LanguageServerState {
  return (LANGUAGE_SERVER_STATES as readonly string[]).includes(value);
}

export function describeLanguageServerFailure(reason: LanguageServerFailureReason): string {
  switch (reason) {
    case "missing-executable":
      return "language server executable was not found";
    case "spawn-failed":
      return "language server process failed to start";
    case "incompatible-protocol":
      return "language server rejected the JSON-RPC protocol version";
    case "initialization-failure":
      return "language server initialize request failed";
    case "malformed-response":
      return "language server returned a malformed response";
    case "request-timeout":
      return "language server request timed out";
    case "crash":
      return "language server process exited unexpectedly";
    case "restart-exhaustion":
      return "language server restart budget was exhausted";
    case "shutdown-timeout":
      return "language server shutdown timed out";
    case "cancelled":
      return "language server operation was cancelled";
    case "capacity-exceeded":
      return "language server capacity was exceeded";
    case "already-running":
      return "language server is already running";
    case "not-found":
      return "language server was not found";
    case "stale-generation":
      return "language server generation is stale";
    case "unsupported":
      return "language server capability is unsupported";
    case "not-ready":
      return "language server is not ready for document synchronization";
    case "document-not-open":
      return "language server document is not open";
    case "document-already-open":
      return "language server document is already open";
    case "stale-document":
      return "language server document version is stale";
    default:
      return assertNever(reason, "unhandled language-server failure");
  }
}
