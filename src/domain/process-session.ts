/**
 * Contracts for interactive PTYs and long-lived managed processes.
 *
 * The domain names lifecycle, identity, limits, and stale-generation behavior.
 * Host adapters own Bun handles and platform signals; callers receive typed
 * snapshots and copied byte events instead of raw subprocess objects.
 */

import type { DurationMs } from "./clock.ts";
import type { ManagedServiceId, PtySessionId, ServiceGeneration } from "./identity.ts";
import {
  isAbsoluteCommandPath,
  MAX_COMMAND_ARGUMENTS,
  MAX_COMMAND_ENVIRONMENT_BYTES,
  MAX_COMMAND_ENVIRONMENT_ENTRIES,
} from "./process.ts";
import { err, ok, type Result } from "./result.ts";
import { MAX_TERMINAL_COLUMNS, MIN_TERMINAL_COLUMNS } from "./terminal.ts";

export const PTY_ENCODINGS = ["utf-8"] as const;
export type PtyEncoding = (typeof PTY_ENCODINGS)[number];

export const DEFAULT_PTY_COLUMNS = 80;
export const DEFAULT_PTY_ROWS = 24;
export const DEFAULT_PTY_TERMINAL_NAME = "xterm-256color";
export const MAX_PTY_TERMINAL_NAME_LENGTH = 64;
export const MAX_PTY_WRITE_BYTES = 64 * 1_024;
export const MAX_PTY_BACKLOG_BYTES = 64 * 1_024;
export const MAX_PTY_SESSIONS = 32;
export const MAX_RETAINED_PTY_SESSIONS = 128;
export const PTY_TERMINATION_TIMEOUT_MS = 2_000;

export type PtyDimensions = {
  readonly columns: number;
  readonly rows: number;
};

export type PtySessionRequest = {
  readonly executable: string;
  readonly argv: readonly string[];
  /** The complete environment supplied to the child. */
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd?: string | undefined;
  readonly dimensions: PtyDimensions;
  readonly terminalName?: string | undefined;
  readonly encoding?: PtyEncoding | undefined;
  /** Zero disables replay retention for the session. */
  readonly backlogBytes?: number | undefined;
};

export const PTY_SESSION_STATES = ["running", "exited", "uncertain"] as const;
export type PtySessionState = (typeof PTY_SESSION_STATES)[number];

export type PtyExit = {
  readonly exitCode: number | null;
  readonly signal: string | null;
};

export type PtyReplay = {
  /** Exact bytes retained after the most recent bounded window. */
  readonly bytes: Uint8Array;
  /** Bytes dropped from the front of the replay window. */
  readonly droppedBytes: number;
};

type PtyEventBase = {
  readonly sessionId: PtySessionId;
  /** In-process observation order, not a durable stream sequence. */
  readonly order: number;
};

export type PtySessionEvent =
  | (PtyEventBase & {
      readonly kind: "opened";
      readonly pid: number;
      readonly dimensions: PtyDimensions;
      readonly terminalName: string;
      readonly encoding: PtyEncoding;
    })
  | (PtyEventBase & {
      readonly kind: "data";
      readonly bytes: Uint8Array;
    })
  | (PtyEventBase & {
      readonly kind: "resized";
      readonly dimensions: PtyDimensions;
    })
  | (PtyEventBase & { readonly kind: "attached" })
  | (PtyEventBase & { readonly kind: "detached" })
  | (PtyEventBase & { readonly kind: "interrupted"; readonly signal: "SIGINT" })
  | (PtyEventBase & {
      readonly kind: "termination-requested";
      readonly signal: PtySignal;
    })
  | (PtyEventBase & { readonly kind: "eof" })
  | (PtyEventBase & { readonly kind: "exited"; readonly exit: PtyExit });

export type PtySessionSnapshot = {
  readonly sessionId: PtySessionId;
  readonly pid: number;
  readonly state: PtySessionState;
  readonly dimensions: PtyDimensions;
  readonly terminalName: string;
  readonly encoding: PtyEncoding;
  readonly replay: PtyReplay;
  readonly exit: PtyExit | null;
};

export const PTY_WRITE_STATUSES = ["accepted", "closed", "failed", "too-large"] as const;
export type PtyWriteStatus = (typeof PTY_WRITE_STATUSES)[number];

export type PtyWriteReport = {
  readonly status: PtyWriteStatus;
  readonly acceptedBytes: number;
};

export type PtySignal = "SIGINT" | "SIGTERM";

export type PtySignalReport = {
  readonly signal: PtySignal;
  readonly state: PtySessionState;
};

export type PtyTerminationReport =
  | {
      readonly kind: "terminated";
      readonly signal: PtySignal;
      readonly exit: PtyExit;
    }
  | {
      readonly kind: "already-exited";
      readonly exit: PtyExit;
    }
  | {
      readonly kind: "uncertain";
      readonly signal: PtySignal;
      readonly exit: PtyExit | null;
    };

export type PtyValidationCode =
  | "invalid-executable"
  | "invalid-working-directory"
  | "invalid-argument"
  | "too-many-arguments"
  | "invalid-environment"
  | "environment-too-large"
  | "invalid-columns"
  | "invalid-rows"
  | "invalid-terminal-name"
  | "invalid-backlog"
  | "unsupported-encoding";

export type PtySessionError =
  | { readonly kind: "pty"; readonly code: "invalid-request"; readonly reason: PtyValidationCode }
  | { readonly kind: "pty"; readonly code: "capacity-exceeded"; readonly maximum: number }
  | { readonly kind: "pty"; readonly code: "spawn-failed"; readonly detail: string | null }
  | { readonly kind: "pty"; readonly code: "unsupported" }
  | { readonly kind: "pty"; readonly code: "not-found" }
  | { readonly kind: "pty"; readonly code: "not-running"; readonly state: PtySessionState }
  | { readonly kind: "pty"; readonly code: "input-too-large"; readonly maxBytes: number }
  | { readonly kind: "pty"; readonly code: "write-failed"; readonly detail: string | null }
  | { readonly kind: "pty"; readonly code: "resize-failed"; readonly detail: string | null };

export type PtySessionListener = (event: PtySessionEvent) => void;

export type PtyAttachment = {
  readonly replay: PtyReplay;
  detach(): void;
};

export type PtySessionPort = {
  open: (request: PtySessionRequest) => Promise<Result<PtySessionSnapshot, PtySessionError>>;
  attach(
    sessionId: PtySessionId,
    listener: PtySessionListener,
  ): Result<PtyAttachment, PtySessionError>;
  write(sessionId: PtySessionId, bytes: Uint8Array): Result<PtyWriteReport, PtySessionError>;
  resize(
    sessionId: PtySessionId,
    dimensions: PtyDimensions,
  ): Result<PtyDimensions, PtySessionError>;
  interrupt(sessionId: PtySessionId): Result<PtySignalReport, PtySessionError>;
  terminate(
    sessionId: PtySessionId,
    signal?: PtySignal,
  ): Promise<Result<PtyTerminationReport, PtySessionError>>;
  snapshot(sessionId: PtySessionId): PtySessionSnapshot | null;
};

export type ManagedServiceReadiness =
  | { readonly kind: "immediate" }
  | {
      readonly kind: "output-marker";
      readonly marker: string;
      readonly stream: "stdout" | "stderr" | "any";
      readonly timeoutMs: DurationMs;
    };

export type ManagedServiceIdlePolicy =
  | { readonly kind: "disabled" }
  | { readonly kind: "timeout"; readonly timeoutMs: DurationMs };

export type ManagedServiceRestartPolicy = {
  readonly maxRestarts: number;
  readonly windowMs: DurationMs;
};

export type ManagedServiceRequest = {
  readonly serviceId: ManagedServiceId;
  /** Stable protocol identity, such as `lsp` or `mcp`. */
  readonly protocol: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd?: string | undefined;
  readonly readiness: ManagedServiceReadiness;
  readonly idle: ManagedServiceIdlePolicy;
  readonly restart: ManagedServiceRestartPolicy;
  readonly shutdownTimeoutMs: DurationMs;
  /** Bounds the per-generation replay available to a late protocol attachment. */
  readonly replayBytes?: number | undefined;
};

export const MANAGED_SERVICE_STATES = [
  "starting",
  "ready",
  "stopping",
  "stopped",
  "failed",
] as const;
export type ManagedServiceState = (typeof MANAGED_SERVICE_STATES)[number];

export const MAX_MANAGED_SERVICE_PROTOCOL_LENGTH = 64;
export const MAX_MANAGED_SERVICE_MARKER_BYTES = 4 * 1_024;
export const MAX_MANAGED_SERVICE_READINESS_BYTES = 64 * 1_024;
export const MAX_MANAGED_SERVICE_REPLAY_BYTES = 64 * 1_024;
export const MAX_MANAGED_SERVICE_WRITE_BYTES = 64 * 1_024;
export const MAX_MANAGED_SERVICE_RESTARTS = 8;
export const MAX_MANAGED_SERVICE_RESTART_WINDOW_MS = 60 * 60_000;
export const MAX_MANAGED_SERVICE_IDLE_MS = 24 * 60 * 60_000;
export const MAX_MANAGED_SERVICE_SHUTDOWN_TIMEOUT_MS = 60_000;
export const MAX_MANAGED_SERVICES = 16;
export const MAX_RETAINED_MANAGED_SERVICES = 64;

export type ManagedServiceExit = {
  readonly exitCode: number | null;
  readonly signal: string | null;
};

export type ManagedServiceSnapshot = {
  readonly serviceId: ManagedServiceId;
  readonly protocol: string;
  readonly generation: ServiceGeneration;
  readonly pid: number | null;
  readonly state: ManagedServiceState;
  readonly restartCount: number;
  readonly lastExit: ManagedServiceExit | null;
};

export type ManagedServiceReplay = {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly droppedStdoutBytes: number;
  readonly droppedStderrBytes: number;
};

type ManagedServiceEventBase = {
  readonly serviceId: ManagedServiceId;
  readonly generation: ServiceGeneration;
  readonly order: number;
};

export type ManagedServiceEvent =
  | (ManagedServiceEventBase & { readonly kind: "started"; readonly pid: number })
  | (ManagedServiceEventBase & {
      readonly kind: "output";
      readonly stream: "stdout" | "stderr";
      readonly bytes: Uint8Array;
    })
  | (ManagedServiceEventBase & { readonly kind: "ready" })
  | (ManagedServiceEventBase & {
      readonly kind: "crashed";
      readonly exit: ManagedServiceExit;
      readonly restartScheduled: boolean;
    })
  | (ManagedServiceEventBase & {
      readonly kind: "restarted";
      readonly previousGeneration: ServiceGeneration;
      readonly pid: number;
    })
  | (ManagedServiceEventBase & {
      readonly kind: "stopping";
      readonly reason: "requested" | "idle" | "shutdown";
    })
  | (ManagedServiceEventBase & {
      readonly kind: "stopped";
      readonly reason: "requested" | "idle" | "shutdown";
      readonly exit: ManagedServiceExit | null;
    })
  | (ManagedServiceEventBase & {
      readonly kind: "failed";
      readonly reason:
        | "spawn-failed"
        | "readiness-timeout"
        | "readiness-output-exceeded"
        | "no-restart-policy"
        | "restart-budget-exhausted"
        | "shutdown-timeout";
    });

export type ManagedServiceValidationCode =
  | "invalid-service-id"
  | "invalid-protocol"
  | "invalid-executable"
  | "invalid-working-directory"
  | "invalid-argument"
  | "too-many-arguments"
  | "invalid-environment"
  | "environment-too-large"
  | "invalid-marker"
  | "invalid-readiness-timeout"
  | "invalid-idle-timeout"
  | "invalid-restart-budget"
  | "invalid-restart-window"
  | "invalid-shutdown-timeout"
  | "invalid-replay";

export type ManagedServiceError =
  | {
      readonly kind: "managed-service";
      readonly code: "invalid-request";
      readonly reason: ManagedServiceValidationCode;
    }
  | {
      readonly kind: "managed-service";
      readonly code: "capacity-exceeded";
      readonly maximum: number;
    }
  | { readonly kind: "managed-service"; readonly code: "already-running" }
  | {
      readonly kind: "managed-service";
      readonly code: "spawn-failed";
      readonly detail: string | null;
    }
  | { readonly kind: "managed-service"; readonly code: "readiness-timeout" }
  | { readonly kind: "managed-service"; readonly code: "readiness-output-exceeded" }
  | { readonly kind: "managed-service"; readonly code: "no-restart-policy" }
  | { readonly kind: "managed-service"; readonly code: "restart-budget-exhausted" }
  | { readonly kind: "managed-service"; readonly code: "not-found" }
  | { readonly kind: "managed-service"; readonly code: "stale-generation" }
  | {
      readonly kind: "managed-service";
      readonly code: "not-ready";
      readonly state: ManagedServiceState;
    }
  | {
      readonly kind: "managed-service";
      readonly code: "input-too-large";
      readonly maxBytes: number;
    }
  | {
      readonly kind: "managed-service";
      readonly code: "write-failed";
      readonly detail: string | null;
    }
  | { readonly kind: "managed-service"; readonly code: "shutdown-timeout" };

export type ManagedServiceListener = (event: ManagedServiceEvent) => void;

export type ManagedServiceAttachment = {
  readonly replay: ManagedServiceReplay;
  detach(): void;
};

export type ManagedServiceWriteReport = {
  readonly acceptedBytes: number;
};

export type ManagedServiceStopReport = {
  readonly kind: "stopped" | "already-stopped" | "uncertain";
  readonly reason: "requested" | "idle" | "shutdown";
  readonly exit: ManagedServiceExit | null;
};

export type ManagedServicePort = {
  start(
    request: ManagedServiceRequest,
  ): Promise<Result<ManagedServiceSnapshot, ManagedServiceError>>;
  attach(
    serviceId: ManagedServiceId,
    listener: ManagedServiceListener,
  ): Result<ManagedServiceAttachment, ManagedServiceError>;
  send(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    bytes: Uint8Array,
  ): Promise<Result<ManagedServiceWriteReport, ManagedServiceError>>;
  stop(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    reason?: "requested" | "shutdown",
  ): Promise<Result<ManagedServiceStopReport, ManagedServiceError>>;
  snapshot(serviceId: ManagedServiceId): ManagedServiceSnapshot | null;
};

export function validatePtySessionRequest(request: PtySessionRequest): PtyValidationCode | null {
  if (!isAbsoluteCommandPath(request.executable)) {
    return "invalid-executable";
  }
  if (request.cwd !== undefined && !isAbsoluteCommandPath(request.cwd)) {
    return "invalid-working-directory";
  }
  if (request.argv.length > MAX_COMMAND_ARGUMENTS) {
    return "too-many-arguments";
  }
  if (request.argv.some((argument) => argument.includes("\0"))) {
    return "invalid-argument";
  }
  const environmentError = validateEnvironment(request.environment);
  if (environmentError !== null) {
    return environmentError;
  }
  if (!validDimension(request.dimensions.columns)) {
    return "invalid-columns";
  }
  if (!validDimension(request.dimensions.rows)) {
    return "invalid-rows";
  }
  if (
    request.terminalName !== undefined &&
    (request.terminalName.length === 0 ||
      request.terminalName.length > MAX_PTY_TERMINAL_NAME_LENGTH ||
      !printable(request.terminalName))
  ) {
    return "invalid-terminal-name";
  }
  if (request.encoding !== undefined && request.encoding !== "utf-8") {
    return "unsupported-encoding";
  }
  if (
    request.backlogBytes !== undefined &&
    (!Number.isSafeInteger(request.backlogBytes) ||
      request.backlogBytes < 0 ||
      request.backlogBytes > MAX_PTY_BACKLOG_BYTES)
  ) {
    return "invalid-backlog";
  }
  return null;
}

export function validateManagedServiceRequest(
  request: ManagedServiceRequest,
): ManagedServiceValidationCode | null {
  if (!identifierText(request.serviceId)) {
    return "invalid-service-id";
  }
  if (
    request.protocol.length === 0 ||
    request.protocol.length > MAX_MANAGED_SERVICE_PROTOCOL_LENGTH ||
    !printable(request.protocol)
  ) {
    return "invalid-protocol";
  }
  if (!isAbsoluteCommandPath(request.executable)) {
    return "invalid-executable";
  }
  if (request.cwd !== undefined && !isAbsoluteCommandPath(request.cwd)) {
    return "invalid-working-directory";
  }
  if (request.argv.length > MAX_COMMAND_ARGUMENTS) {
    return "too-many-arguments";
  }
  if (request.argv.some((argument) => argument.includes("\0"))) {
    return "invalid-argument";
  }
  const environmentError = validateEnvironment(request.environment);
  if (environmentError !== null) {
    return environmentError;
  }
  if (request.readiness.kind === "output-marker") {
    if (
      request.readiness.marker.length === 0 ||
      new TextEncoder().encode(request.readiness.marker).byteLength >
        MAX_MANAGED_SERVICE_MARKER_BYTES ||
      request.readiness.marker.includes("\0")
    ) {
      return "invalid-marker";
    }
    if (!validDuration(request.readiness.timeoutMs, MAX_MANAGED_SERVICE_SHUTDOWN_TIMEOUT_MS)) {
      return "invalid-readiness-timeout";
    }
  }
  if (
    request.idle.kind === "timeout" &&
    !validDuration(request.idle.timeoutMs, MAX_MANAGED_SERVICE_IDLE_MS)
  ) {
    return "invalid-idle-timeout";
  }
  if (
    !Number.isSafeInteger(request.restart.maxRestarts) ||
    request.restart.maxRestarts < 0 ||
    request.restart.maxRestarts > MAX_MANAGED_SERVICE_RESTARTS
  ) {
    return "invalid-restart-budget";
  }
  if (!validDuration(request.restart.windowMs, MAX_MANAGED_SERVICE_RESTART_WINDOW_MS)) {
    return "invalid-restart-window";
  }
  if (!validDuration(request.shutdownTimeoutMs, MAX_MANAGED_SERVICE_SHUTDOWN_TIMEOUT_MS)) {
    return "invalid-shutdown-timeout";
  }
  if (
    request.replayBytes !== undefined &&
    (!Number.isSafeInteger(request.replayBytes) ||
      request.replayBytes < 0 ||
      request.replayBytes > MAX_MANAGED_SERVICE_REPLAY_BYTES)
  ) {
    return "invalid-replay";
  }
  return null;
}

function validDimension(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value >= MIN_TERMINAL_COLUMNS && value <= MAX_TERMINAL_COLUMNS
  );
}

function validDuration(value: DurationMs, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function printable(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value);
}

function identifierText(value: string): boolean {
  return value.length > 0 && value.length <= 128 && printable(value);
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

export function invalidPtyRequest(reason: PtyValidationCode): Result<never, PtySessionError> {
  return err({ kind: "pty", code: "invalid-request", reason });
}

export function invalidManagedServiceRequest(
  reason: ManagedServiceValidationCode,
): Result<never, ManagedServiceError> {
  return err({ kind: "managed-service", code: "invalid-request", reason });
}

export function ptyDimensions(
  columns: number,
  rows: number,
): Result<PtyDimensions, PtySessionError> {
  if (!validDimension(columns)) {
    return invalidPtyRequest("invalid-columns");
  }
  if (!validDimension(rows)) {
    return invalidPtyRequest("invalid-rows");
  }
  return ok({ columns, rows });
}
