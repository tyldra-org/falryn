/**
 * Debug-adapter session lifecycles (#97–#98).
 *
 * Launch/attach ownership, versioned breakpoints, threads, and stack frames
 * bound to a stopped generation. Scopes, variables, evaluation, and output
 * projections are #98. Termination, disconnect, cancellation, and process
 * cleanup are #99; artifact capture remains #100.
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
export const MAX_DEBUG_SCOPES = 64;
export const MAX_DEBUG_VARIABLES = 512;
export const MAX_DEBUG_VARIABLE_NAME_LENGTH = 256;
export const MAX_DEBUG_VARIABLE_VALUE_LENGTH = 4_096;
export const MAX_DEBUG_EVALUATE_EXPRESSION_LENGTH = 4_096;
export const MAX_DEBUG_OUTPUT_EVENTS = 64;
export const MAX_DEBUG_OUTPUT_TEXT_LENGTH = 4_096;
export const DEBUG_EVALUATE_CONTEXTS = ["watch", "repl", "hover", "clipboard"] as const;
export type DebugEvaluateContext = (typeof DEBUG_EVALUATE_CONTEXTS)[number];
export const REDACTED_VALUE = "[redacted]";

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
        | "invalid-stack"
        | "invalid-variable"
        | "invalid-expression"
        | "invalid-evaluate-context"
        | "invalid-cancel";
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

export type DebugScope = {
  readonly name: string;
  readonly variablesReference: number;
  readonly expensive: boolean;
  readonly namedVariables: number | null;
  readonly indexedVariables: number | null;
};

export type DebugVariable = {
  readonly name: string;
  readonly value: string;
  readonly type: string | null;
  readonly variablesReference: number;
  readonly sensitive: boolean;
};

/** Model/support projection: sensitive values are redacted. */
export type DebugVariableProjection = {
  readonly name: string;
  readonly value: string;
  readonly type: string | null;
  readonly variablesReference: number;
  readonly sensitive: boolean;
  readonly redacted: boolean;
};

export type DebugEvaluateRequest = {
  readonly expression: string;
  readonly stoppedGeneration: number;
  readonly frameId?: number | undefined;
  readonly context?: DebugEvaluateContext | undefined;
};

export type DebugEvaluateResult = {
  readonly result: string;
  readonly type: string | null;
  readonly variablesReference: number;
  readonly context: DebugEvaluateContext;
  readonly mayMutate: boolean;
  readonly sensitive: boolean;
  readonly redacted: boolean;
};

export type DebugOutputCategory = "console" | "stdout" | "stderr" | "telemetry" | "important";

export type DebugOutputEvent = {
  readonly category: DebugOutputCategory;
  readonly output: string;
  readonly sensitive: boolean;
  readonly redacted: boolean;
};

export type DebugTargetExit = {
  readonly kind: "exited" | "terminated";
  readonly exitCode: number | null;
};

export type DebugDisconnectRequest = {
  readonly restart?: boolean | undefined;
  readonly terminateDebuggee?: boolean | undefined;
};

export type DebugDisconnectOutcome = {
  readonly restart: boolean;
  readonly terminateDebuggee: boolean;
  readonly adapterAcknowledged: boolean;
  readonly processStopped: boolean;
  readonly detachUncertain: boolean;
};

export type DebugTerminateRequest = {
  readonly restart?: boolean | undefined;
};

export type DebugCancelRequest = {
  readonly requestId?: number | undefined;
  readonly progressId?: string | undefined;
};

export type DebugSessionSnapshot = {
  readonly mode: DebugSessionMode;
  readonly targetState: DebugTargetState;
  readonly configurationDone: boolean;
  readonly stopped: DebugStoppedInfo | null;
  readonly breakpointRevisions: Readonly<Record<string, number>>;
  readonly threads: readonly DebugThread[];
  readonly recentOutputs: readonly DebugOutputEvent[];
  readonly targetExit: DebugTargetExit | null;
  readonly lastDisconnect: DebugDisconnectOutcome | null;
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
    | "invalid-stack"
    | "invalid-variable"
    | "invalid-expression"
    | "invalid-evaluate-context"
    | "invalid-cancel",
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

const SENSITIVE_NAME_PATTERN =
  /password|passwd|secret|token|credential|api[_-]?key|authorization|private[_-]?key/i;

export function variableNameLooksSensitive(name: string): boolean {
  return SENSITIVE_NAME_PATTERN.test(name);
}

export function evaluateMayMutate(context: DebugEvaluateContext): boolean {
  return context === "repl";
}

export function projectVariableForModel(variable: DebugVariable): DebugVariableProjection {
  const sensitive = variable.sensitive || variableNameLooksSensitive(variable.name);
  return {
    name: variable.name,
    value: sensitive ? REDACTED_VALUE : variable.value,
    type: variable.type,
    variablesReference: variable.variablesReference,
    sensitive,
    redacted: sensitive,
  };
}

export function projectEvaluateForModel(result: DebugEvaluateResult): DebugEvaluateResult {
  if (!result.sensitive) {
    return result;
  }
  return {
    ...result,
    result: REDACTED_VALUE,
    redacted: true,
  };
}

export function projectOutputForModel(event: DebugOutputEvent): DebugOutputEvent {
  if (!event.sensitive) {
    return event;
  }
  return {
    ...event,
    output: REDACTED_VALUE,
    redacted: true,
  };
}

export function validateEvaluateRequest(request: DebugEvaluateRequest): DebugSessionError | null {
  if (
    typeof request.expression !== "string" ||
    request.expression.length === 0 ||
    request.expression.length > MAX_DEBUG_EVALUATE_EXPRESSION_LENGTH
  ) {
    return invalid("invalid-expression");
  }
  if (
    typeof request.stoppedGeneration !== "number" ||
    !Number.isSafeInteger(request.stoppedGeneration) ||
    request.stoppedGeneration < 1
  ) {
    return invalid("invalid-frame");
  }
  if (
    request.frameId !== undefined &&
    (typeof request.frameId !== "number" ||
      !Number.isSafeInteger(request.frameId) ||
      request.frameId < 0)
  ) {
    return invalid("invalid-frame");
  }
  if (
    request.context !== undefined &&
    !(DEBUG_EVALUATE_CONTEXTS as readonly string[]).includes(request.context)
  ) {
    return invalid("invalid-evaluate-context");
  }
  return null;
}

function clipText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function parseScopesResponse(
  body: unknown,
): Result<readonly DebugScope[], DebugSessionError> {
  if (!isRecord(body) || !Array.isArray(body.scopes)) {
    return err({ kind: "debug-adapter", code: "malformed-response" });
  }
  if (body.scopes.length > MAX_DEBUG_SCOPES) {
    return err({ kind: "debug-adapter", code: "capacity-exceeded" });
  }
  const scopes: DebugScope[] = [];
  for (const item of body.scopes) {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      item.name.length === 0 ||
      typeof item.variablesReference !== "number" ||
      !Number.isSafeInteger(item.variablesReference) ||
      item.variablesReference < 0
    ) {
      return err({ kind: "debug-adapter", code: "malformed-response" });
    }
    scopes.push({
      name: item.name,
      variablesReference: item.variablesReference,
      expensive: item.expensive === true,
      namedVariables:
        typeof item.namedVariables === "number" && Number.isSafeInteger(item.namedVariables)
          ? item.namedVariables
          : null,
      indexedVariables:
        typeof item.indexedVariables === "number" && Number.isSafeInteger(item.indexedVariables)
          ? item.indexedVariables
          : null,
    });
  }
  return ok(scopes);
}

export function parseVariablesResponse(
  body: unknown,
): Result<readonly DebugVariable[], DebugSessionError> {
  if (!isRecord(body) || !Array.isArray(body.variables)) {
    return err({ kind: "debug-adapter", code: "malformed-response" });
  }
  if (body.variables.length > MAX_DEBUG_VARIABLES) {
    return err({ kind: "debug-adapter", code: "capacity-exceeded" });
  }
  const variables: DebugVariable[] = [];
  for (const item of body.variables) {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      item.name.length === 0 ||
      item.name.length > MAX_DEBUG_VARIABLE_NAME_LENGTH ||
      typeof item.value !== "string" ||
      typeof item.variablesReference !== "number" ||
      !Number.isSafeInteger(item.variablesReference) ||
      item.variablesReference < 0
    ) {
      return err({ kind: "debug-adapter", code: "malformed-response" });
    }
    const name = item.name;
    variables.push({
      name,
      value: clipText(item.value, MAX_DEBUG_VARIABLE_VALUE_LENGTH),
      type: typeof item.type === "string" ? item.type : null,
      variablesReference: item.variablesReference,
      sensitive: variableNameLooksSensitive(name),
    });
  }
  return ok(variables);
}

export function parseEvaluateResponse(
  body: unknown,
  context: DebugEvaluateContext,
): Result<DebugEvaluateResult, DebugSessionError> {
  if (!isRecord(body) || typeof body.result !== "string") {
    return err({ kind: "debug-adapter", code: "malformed-response" });
  }
  const variablesReference =
    typeof body.variablesReference === "number" && Number.isSafeInteger(body.variablesReference)
      ? body.variablesReference
      : 0;
  if (variablesReference < 0) {
    return err({ kind: "debug-adapter", code: "malformed-response" });
  }
  const resultText = clipText(body.result, MAX_DEBUG_VARIABLE_VALUE_LENGTH);
  const sensitive =
    variableNameLooksSensitive(resultText) || /bearer\s+[a-z0-9._-]+/i.test(resultText);
  return ok({
    result: resultText,
    type: typeof body.type === "string" ? body.type : null,
    variablesReference,
    context,
    mayMutate: evaluateMayMutate(context),
    sensitive,
    redacted: false,
  });
}

export function parseOutputEventBody(body: unknown): Result<DebugOutputEvent, DebugSessionError> {
  if (!isRecord(body) || typeof body.output !== "string") {
    return err({ kind: "debug-adapter", code: "malformed-response" });
  }
  const categoryRaw = typeof body.category === "string" ? body.category : "console";
  const category: DebugOutputCategory =
    categoryRaw === "stdout" ||
    categoryRaw === "stderr" ||
    categoryRaw === "telemetry" ||
    categoryRaw === "important"
      ? categoryRaw
      : "console";
  const output = clipText(body.output, MAX_DEBUG_OUTPUT_TEXT_LENGTH);
  const sensitive =
    variableNameLooksSensitive(output) || /api[_-]?key|password|secret|token/i.test(output);
  return ok({
    category,
    output,
    sensitive,
    redacted: false,
  });
}

export function parseTargetExitEvent(
  event: "exited" | "terminated",
  body: unknown,
): Result<DebugTargetExit, DebugSessionError> {
  if (event === "terminated") {
    return ok({ kind: "terminated", exitCode: null });
  }
  if (!isRecord(body)) {
    return err({ kind: "debug-adapter", code: "malformed-response" });
  }
  const exitCode =
    typeof body.exitCode === "number" && Number.isSafeInteger(body.exitCode) ? body.exitCode : null;
  return ok({ kind: "exited", exitCode });
}

export function validateDisconnectRequest(
  request: DebugDisconnectRequest,
): DebugSessionError | null {
  if (request.restart !== undefined && typeof request.restart !== "boolean") {
    return invalid("invalid-configuration");
  }
  if (request.terminateDebuggee !== undefined && typeof request.terminateDebuggee !== "boolean") {
    return invalid("invalid-configuration");
  }
  return null;
}

export function validateTerminateRequest(request: DebugTerminateRequest): DebugSessionError | null {
  if (request.restart !== undefined && typeof request.restart !== "boolean") {
    return invalid("invalid-configuration");
  }
  return null;
}

export function validateCancelRequest(request: DebugCancelRequest): DebugSessionError | null {
  const hasRequestId = request.requestId !== undefined;
  const hasProgressId = request.progressId !== undefined;
  if (!hasRequestId && !hasProgressId) {
    return invalid("invalid-cancel");
  }
  if (
    hasRequestId &&
    (typeof request.requestId !== "number" ||
      !Number.isSafeInteger(request.requestId) ||
      request.requestId < 1)
  ) {
    return invalid("invalid-cancel");
  }
  if (
    hasProgressId &&
    (typeof request.progressId !== "string" || request.progressId.length === 0)
  ) {
    return invalid("invalid-cancel");
  }
  return null;
}

export function emptyDebugSessionSnapshot(): DebugSessionSnapshot {
  return {
    mode: "none",
    targetState: "idle",
    configurationDone: false,
    stopped: null,
    breakpointRevisions: {},
    threads: [],
    recentOutputs: [],
    targetExit: null,
    lastDisconnect: null,
  };
}
