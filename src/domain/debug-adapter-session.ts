/**
 * Debug-adapter session lifecycles (#97).
 *
 * Launch/attach ownership, versioned breakpoints, threads, and stack frames
 * bound to a stopped generation. Scopes/variables remain #98; artifact capture
 * remains #100.
 */

import { err, ok, type Result } from "./result.ts";

export const DEBUG_SESSION_MODES = ["none", "launch", "attach"] as const;
export type DebugSessionMode = (typeof DEBUG_SESSION_MODES)[number];

export const DEBUG_TARGET_STATES = ["idle", "running", "stopped", "exited"] as const;
export type DebugTargetState = (typeof DEBUG_TARGET_STATES)[number];

export const MAX_DEBUG_BREAKPOINTS_PER_SOURCE = 256;
export const MAX_DEBUG_BREAKPOINT_SOURCES = 512;
export const MAX_DEBUG_THREADS = 1_024;
export const MAX_DEBUG_STACK_FRAMES = 512;
export const MAX_DEBUG_SOURCE_PATH_LENGTH = 4_096;
export const MAX_DEBUG_THREAD_NAME_LENGTH = 256;
export const MAX_DEBUG_FRAME_NAME_LENGTH = 512;

export type DebugSessionError =
  | { readonly kind: "debug-adapter"; readonly code: "malformed-response" }
  | { readonly kind: "debug-adapter"; readonly code: "capacity-exceeded" }
  | {
      readonly kind: "debug-adapter";
      readonly code: "invalid-request";
      readonly reason:
        | "invalid-source"
        | "invalid-breakpoint"
        | "too-many-breakpoints"
        | "invalid-configuration"
        | "invalid-thread"
        | "invalid-frame"
        | "invalid-stack";
    };

export type DebugSourceBreakpoint = {
  readonly line: number;
  readonly column?: number | undefined;
  readonly condition?: string | undefined;
  readonly hitCondition?: string | undefined;
  readonly logMessage?: string | undefined;
};

export type DebugBreakpoint = {
  readonly id: number | null;
  readonly verified: boolean;
  readonly line: number;
  readonly column: number | null;
  readonly message: string | null;
};

export type DebugSetBreakpointsRequest = {
  readonly sourcePath: string;
  readonly breakpoints: readonly DebugSourceBreakpoint[];
  readonly sourceModified?: boolean | undefined;
};

export type DebugSetBreakpointsResult = {
  readonly sourcePath: string;
  readonly breakpoints: readonly DebugBreakpoint[];
  readonly revision: number;
};

export type DebugLaunchRequest = {
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly noDebug?: boolean | undefined;
};

export type DebugAttachRequest = {
  readonly configuration: Readonly<Record<string, unknown>>;
};

export type DebugThread = {
  readonly id: number;
  readonly name: string;
};

export type DebugStackFrame = {
  readonly id: number;
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly sourcePath: string | null;
};

export type DebugStoppedInfo = {
  readonly generation: number;
  readonly threadId: number | null;
  readonly reason: string;
  readonly allThreadsStopped: boolean;
};

export type DebugSessionSnapshot = {
  readonly mode: DebugSessionMode;
  readonly targetState: DebugTargetState;
  readonly configurationDone: boolean;
  readonly stopped: DebugStoppedInfo | null;
  readonly breakpointRevisions: Readonly<Record<string, number>>;
  readonly threads: readonly DebugThread[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(
  reason:
    | "invalid-source"
    | "invalid-breakpoint"
    | "too-many-breakpoints"
    | "invalid-configuration"
    | "invalid-thread"
    | "invalid-frame"
    | "invalid-stack",
): DebugSessionError {
  return { kind: "debug-adapter", code: "invalid-request", reason };
}

export function validateSetBreakpointsRequest(
  request: DebugSetBreakpointsRequest,
): DebugSessionError | null {
  if (
    typeof request.sourcePath !== "string" ||
    request.sourcePath.length === 0 ||
    request.sourcePath.length > MAX_DEBUG_SOURCE_PATH_LENGTH
  ) {
    return invalid("invalid-source");
  }
  if (!Array.isArray(request.breakpoints)) {
    return invalid("invalid-breakpoint");
  }
  if (request.breakpoints.length > MAX_DEBUG_BREAKPOINTS_PER_SOURCE) {
    return invalid("too-many-breakpoints");
  }
  for (const breakpoint of request.breakpoints) {
    if (
      typeof breakpoint.line !== "number" ||
      !Number.isSafeInteger(breakpoint.line) ||
      breakpoint.line < 1
    ) {
      return invalid("invalid-breakpoint");
    }
    if (
      breakpoint.column !== undefined &&
      (typeof breakpoint.column !== "number" ||
        !Number.isSafeInteger(breakpoint.column) ||
        breakpoint.column < 0)
    ) {
      return invalid("invalid-breakpoint");
    }
    if (breakpoint.condition !== undefined && typeof breakpoint.condition !== "string") {
      return invalid("invalid-breakpoint");
    }
    if (breakpoint.hitCondition !== undefined && typeof breakpoint.hitCondition !== "string") {
      return invalid("invalid-breakpoint");
    }
    if (breakpoint.logMessage !== undefined && typeof breakpoint.logMessage !== "string") {
      return invalid("invalid-breakpoint");
    }
  }
  return null;
}

export function validateLaunchOrAttachConfiguration(
  configuration: Readonly<Record<string, unknown>>,
): DebugSessionError | null {
  if (!isRecord(configuration)) {
    return invalid("invalid-configuration");
  }
  const keys = Object.keys(configuration);
  if (keys.length === 0 || keys.length > 64) {
    return invalid("invalid-configuration");
  }
  return null;
}

export function parseBreakpointsResponse(
  sourcePath: string,
  revision: number,
  body: unknown,
): Result<DebugSetBreakpointsResult, DebugSessionError> {
  if (!isRecord(body) || !Array.isArray(body.breakpoints)) {
    return err({ kind: "debug-adapter", code: "malformed-response" });
  }
  if (body.breakpoints.length > MAX_DEBUG_BREAKPOINTS_PER_SOURCE) {
    return err(invalid("too-many-breakpoints"));
  }
  const breakpoints: DebugBreakpoint[] = [];
  for (const item of body.breakpoints) {
    if (!isRecord(item) || typeof item.verified !== "boolean") {
      return err({ kind: "debug-adapter", code: "malformed-response" });
    }
    const line = item.line;
    if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) {
      return err({ kind: "debug-adapter", code: "malformed-response" });
    }
    breakpoints.push({
      id: typeof item.id === "number" && Number.isSafeInteger(item.id) ? item.id : null,
      verified: item.verified,
      line,
      column:
        typeof item.column === "number" && Number.isSafeInteger(item.column) ? item.column : null,
      message: typeof item.message === "string" ? item.message : null,
    });
  }
  return ok({ sourcePath, breakpoints, revision });
}

export function parseThreadsResponse(
  body: unknown,
): Result<readonly DebugThread[], DebugSessionError> {
  if (!isRecord(body) || !Array.isArray(body.threads)) {
    return err({ kind: "debug-adapter", code: "malformed-response" });
  }
  if (body.threads.length > MAX_DEBUG_THREADS) {
    return err({ kind: "debug-adapter", code: "capacity-exceeded" });
  }
  const threads: DebugThread[] = [];
  for (const item of body.threads) {
    if (
      !isRecord(item) ||
      typeof item.id !== "number" ||
      !Number.isSafeInteger(item.id) ||
      typeof item.name !== "string" ||
      item.name.length === 0 ||
      item.name.length > MAX_DEBUG_THREAD_NAME_LENGTH
    ) {
      return err({ kind: "debug-adapter", code: "malformed-response" });
    }
    threads.push({ id: item.id, name: item.name });
  }
  return ok(threads);
}

export function parseStackTraceResponse(
  body: unknown,
): Result<readonly DebugStackFrame[], DebugSessionError> {
  if (!isRecord(body) || !Array.isArray(body.stackFrames)) {
    return err({ kind: "debug-adapter", code: "malformed-response" });
  }
  if (body.stackFrames.length > MAX_DEBUG_STACK_FRAMES) {
    return err({ kind: "debug-adapter", code: "capacity-exceeded" });
  }
  const frames: DebugStackFrame[] = [];
  for (const item of body.stackFrames) {
    if (
      !isRecord(item) ||
      typeof item.id !== "number" ||
      !Number.isSafeInteger(item.id) ||
      typeof item.name !== "string" ||
      item.name.length === 0 ||
      item.name.length > MAX_DEBUG_FRAME_NAME_LENGTH ||
      typeof item.line !== "number" ||
      !Number.isSafeInteger(item.line) ||
      typeof item.column !== "number" ||
      !Number.isSafeInteger(item.column)
    ) {
      return err({ kind: "debug-adapter", code: "malformed-response" });
    }
    let sourcePath: string | null = null;
    if (isRecord(item.source) && typeof item.source.path === "string") {
      if (item.source.path.length > MAX_DEBUG_SOURCE_PATH_LENGTH) {
        return err(invalid("invalid-source"));
      }
      sourcePath = item.source.path;
    }
    frames.push({
      id: item.id,
      name: item.name,
      line: item.line,
      column: item.column,
      sourcePath,
    });
  }
  return ok(frames);
}

export function parseStoppedEventBody(
  body: unknown,
  generation: number,
): Result<DebugStoppedInfo, DebugSessionError> {
  if (!isRecord(body) || typeof body.reason !== "string" || body.reason.length === 0) {
    return err({ kind: "debug-adapter", code: "malformed-response" });
  }
  const threadId =
    typeof body.threadId === "number" && Number.isSafeInteger(body.threadId) ? body.threadId : null;
  return ok({
    generation,
    threadId,
    reason: body.reason,
    allThreadsStopped: body.allThreadsStopped === true,
  });
}

export function emptyDebugSessionSnapshot(): DebugSessionSnapshot {
  return {
    mode: "none",
    targetState: "idle",
    configurationDone: false,
    stopped: null,
    breakpointRevisions: {},
    threads: [],
  };
}
