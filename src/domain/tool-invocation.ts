/**
 * Validate and normalize every tool invocation before dispatch (#49).
 *
 * Raw proposals resolve against the #48 capability registry, pass structural
 * and schema checks, respect manifest platform/version/byte limits, and become
 * an immutable dispatch-ready record. Reject outcomes are exhaustive and have
 * no effect. Policy and focused confirmation live in `tool-policy.ts` (#50).
 * Scheduling, execution, cancel, timeout, and join live in `tool-schedule.ts`
 * (#51). Typed results live in `tool-result.ts` (#52). Lifecycle hook points
 * live in `tool-hooks.ts` (#53).
 */

import type { InvocationId } from "./identity.ts";
import { assertNever } from "./result.ts";
import {
  type BoundToolInvocation,
  TOOL_PIPELINE_SCHEMA_VERSION,
  type ToolProposal,
} from "./tool-pipeline.ts";
import type {
  ToolPlatformArch,
  ToolPlatformOs,
  ToolRegistry,
  ToolRegistryEntry,
} from "./tool-registry.ts";
import type { ConflictKey } from "./work.ts";

/** Schema version this build writes for dispatch-ready invocations. */
export const TOOL_INVOCATION_SCHEMA_VERSION = TOOL_PIPELINE_SCHEMA_VERSION;

/**
 * Untrusted proposal before structural and schema validation.
 *
 * `arguments` may be any JSON value; non-objects fail closed.
 */
export type RawToolInvocation = {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: unknown;
  /** When set, must equal the registry entry's declared version. */
  readonly version?: number;
};

/** Host platform used for manifest platform constraints. */
export type HostPlatform = {
  readonly os: ToolPlatformOs;
  readonly arch: ToolPlatformArch;
};

/**
 * Immutable, validated invocation ready for later policy/schedule/execute
 * stages. No executor may run until this record exists.
 */
export type DispatchReadyInvocation = {
  readonly schemaVersion: typeof TOOL_INVOCATION_SCHEMA_VERSION;
  readonly invocationId: InvocationId;
  readonly proposal: ToolProposal;
  readonly entry: ToolRegistryEntry;
  readonly input: Readonly<Record<string, unknown>>;
  readonly conflictKeys: readonly ConflictKey[];
};

export type ToolValidateError =
  | {
      readonly code: "unknown-tool";
      readonly toolCallId: string;
      readonly name: string;
    }
  | {
      readonly code: "malformed-input";
      readonly toolCallId: string;
      readonly name: string;
      /** Structural Zod issue codes only — never rejected values. */
      readonly issues: readonly string[];
    }
  | {
      readonly code: "malformed-arguments";
      readonly toolCallId: string;
      readonly name: string;
      readonly reason: "not-object" | "null" | "array";
    }
  | { readonly code: "duplicate-tool-call-id"; readonly toolCallId: string }
  | { readonly code: "invalid-tool-call-id"; readonly toolCallId: string }
  | {
      readonly code: "queue-bound-exceeded";
      readonly maximum: number;
      readonly attempted: number;
    }
  | {
      readonly code: "unsupported-platform";
      readonly toolCallId: string;
      readonly name: string;
      readonly os: ToolPlatformOs;
      readonly arch: ToolPlatformArch;
    }
  | {
      readonly code: "unsupported-version";
      readonly toolCallId: string;
      readonly name: string;
      readonly requested: number;
      readonly available: number;
    }
  | {
      readonly code: "input-too-large";
      readonly toolCallId: string;
      readonly name: string;
      readonly maximum: number;
      readonly attempted: number;
    }
  | {
      readonly code: "invalid-path-argument";
      readonly toolCallId: string;
      readonly name: string;
      readonly field: string;
    }
  | {
      readonly code: "host-platform-required";
      readonly toolCallId: string;
      readonly name: string;
    };

export type ValidateAndNormalizeOptions = {
  readonly registry: ToolRegistry;
  readonly proposals: readonly RawToolInvocation[];
  readonly maxQueued: number;
  readonly nextInvocationId: (proposal: ToolProposal) => InvocationId;
  /**
   * Required when any resolved manifest declares a non-empty platform list.
   * Empty platform lists mean "all hosts".
   */
  readonly host?: HostPlatform;
};

export type ValidateAndNormalizeResult =
  | { readonly ok: true; readonly value: readonly DispatchReadyInvocation[] }
  | { readonly ok: false; readonly error: ToolValidateError };

const PATH_FIELD_NAMES = new Set(["path", "cwd", "workingdirectory", "working_directory"]);

/**
 * Validate and normalize every proposal against the registry. Fail closed
 * before any executor can run.
 */
export function validateAndNormalizeInvocations(
  options: ValidateAndNormalizeOptions,
): ValidateAndNormalizeResult {
  const { registry, proposals, maxQueued, nextInvocationId, host } = options;

  if (proposals.length > maxQueued) {
    return {
      ok: false,
      error: {
        code: "queue-bound-exceeded",
        maximum: maxQueued,
        attempted: proposals.length,
      },
    };
  }

  const seen = new Set<string>();
  const ready: DispatchReadyInvocation[] = [];

  for (const raw of proposals) {
    if (raw.toolCallId.length === 0 || !/^[!-~]+$/.test(raw.toolCallId)) {
      return {
        ok: false,
        error: { code: "invalid-tool-call-id", toolCallId: raw.toolCallId },
      };
    }
    if (seen.has(raw.toolCallId)) {
      return {
        ok: false,
        error: { code: "duplicate-tool-call-id", toolCallId: raw.toolCallId },
      };
    }
    seen.add(raw.toolCallId);

    if (raw.name.length === 0) {
      return {
        ok: false,
        error: {
          code: "unknown-tool",
          toolCallId: raw.toolCallId,
          name: raw.name,
        },
      };
    }

    const entry = registry.resolveByName(raw.name);
    if (entry === null) {
      return {
        ok: false,
        error: {
          code: "unknown-tool",
          toolCallId: raw.toolCallId,
          name: raw.name,
        },
      };
    }

    const platformError = checkPlatform(raw, entry, host);
    if (platformError !== null) {
      return { ok: false, error: platformError };
    }

    if (raw.version !== undefined && raw.version !== entry.manifest.version) {
      return {
        ok: false,
        error: {
          code: "unsupported-version",
          toolCallId: raw.toolCallId,
          name: raw.name,
          requested: raw.version,
          available: entry.manifest.version,
        },
      };
    }

    const argumentsShape = classifyArguments(raw.arguments);
    if (argumentsShape !== "object") {
      return {
        ok: false,
        error: {
          code: "malformed-arguments",
          toolCallId: raw.toolCallId,
          name: raw.name,
          reason: argumentsShape,
        },
      };
    }

    const argumentObject = raw.arguments as Readonly<Record<string, unknown>>;
    const attemptedBytes = utf8JsonByteLength(argumentObject);
    const maximum = entry.manifest.limits.maxInputBytes;
    if (attemptedBytes > maximum) {
      return {
        ok: false,
        error: {
          code: "input-too-large",
          toolCallId: raw.toolCallId,
          name: raw.name,
          maximum,
          attempted: attemptedBytes,
        },
      };
    }

    const parsed = entry.manifest.inputSchema.safeParse(argumentObject);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "malformed-input",
          toolCallId: raw.toolCallId,
          name: raw.name,
          issues: parsed.error.issues.map((issue) => issue.code),
        },
      };
    }

    const normalized = normalizeValidatedInput(parsed.data);
    if (!normalized.ok) {
      return {
        ok: false,
        error: {
          code: "invalid-path-argument",
          toolCallId: raw.toolCallId,
          name: raw.name,
          field: normalized.field,
        },
      };
    }

    const input = normalized.value;
    const conflictKeys = entry.manifest.conflictKeysFor?.(input) ?? [];
    const proposal: ToolProposal = {
      toolCallId: raw.toolCallId,
      name: raw.name,
      arguments: argumentObject,
    };

    ready.push({
      schemaVersion: TOOL_INVOCATION_SCHEMA_VERSION,
      invocationId: nextInvocationId(proposal),
      proposal,
      entry,
      input,
      conflictKeys,
    });
  }

  return { ok: true, value: ready };
}

/** Project a dispatch-ready record onto the #44 bind shape for the tool-call loop. */
export function toBoundToolInvocation(ready: DispatchReadyInvocation): BoundToolInvocation {
  return {
    schemaVersion: ready.schemaVersion,
    invocationId: ready.invocationId,
    proposal: ready.proposal,
    descriptor: ready.entry.descriptor,
    input: ready.input,
    conflictKeys: ready.conflictKeys,
  };
}

export function isToolValidateErrorCode(value: unknown): value is ToolValidateError["code"] {
  return (
    typeof value === "string" &&
    (value === "unknown-tool" ||
      value === "malformed-input" ||
      value === "malformed-arguments" ||
      value === "duplicate-tool-call-id" ||
      value === "invalid-tool-call-id" ||
      value === "queue-bound-exceeded" ||
      value === "unsupported-platform" ||
      value === "unsupported-version" ||
      value === "input-too-large" ||
      value === "invalid-path-argument" ||
      value === "host-platform-required")
  );
}

function classifyArguments(value: unknown): "object" | "null" | "array" | "not-object" {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "object") {
    return "object";
  }
  return "not-object";
}

function checkPlatform(
  raw: RawToolInvocation,
  entry: ToolRegistryEntry,
  host: HostPlatform | undefined,
): ToolValidateError | null {
  const platforms = entry.manifest.platforms;
  if (platforms.length === 0) {
    return null;
  }
  if (host === undefined) {
    return {
      code: "host-platform-required",
      toolCallId: raw.toolCallId,
      name: raw.name,
    };
  }
  for (const constraint of platforms) {
    const osOk = constraint.os.length === 0 || constraint.os.includes(host.os);
    const archOk = constraint.arch.length === 0 || constraint.arch.includes(host.arch);
    if (osOk && archOk) {
      return null;
    }
  }
  return {
    code: "unsupported-platform",
    toolCallId: raw.toolCallId,
    name: raw.name,
    os: host.os,
    arch: host.arch,
  };
}

function utf8JsonByteLength(value: Readonly<Record<string, unknown>>): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

type NormalizeInputResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly field: string };

/**
 * Normalize path-like string fields after schema validation.
 *
 * Collapses separators, drops empty/`.` segments, rejects NUL. Does not resolve
 * against a workspace root — that belongs to later product adapters.
 */
function normalizeValidatedInput(input: Readonly<Record<string, unknown>>): NormalizeInputResult {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = normalizeField(key, value);
    if (!normalized.ok) {
      return normalized;
    }
    result[key] = normalized.value;
  }
  return { ok: true, value: result };
}

function normalizeField(
  key: string,
  value: unknown,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly field: string } {
  if (isPathFieldName(key) && typeof value === "string") {
    const path = normalizeToolPathArgument(value);
    if (path === null) {
      return { ok: false, field: key };
    }
    return { ok: true, value: path };
  }
  if (key.toLowerCase() === "paths" && Array.isArray(value)) {
    const paths: unknown[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") {
        paths.push(entry);
        continue;
      }
      const path = normalizeToolPathArgument(entry);
      if (path === null) {
        return { ok: false, field: key };
      }
      paths.push(path);
    }
    return { ok: true, value: paths };
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const nested: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const child = normalizeField(childKey, childValue);
      if (!child.ok) {
        return child;
      }
      nested[childKey] = child.value;
    }
    return { ok: true, value: nested };
  }
  return { ok: true, value };
}

function isPathFieldName(key: string): boolean {
  return PATH_FIELD_NAMES.has(key.toLowerCase());
}

/**
 * Textual path cleanup for tool arguments. Returns `null` when the value
 * cannot name a path (NUL). Never echoes the rejected text.
 */
export function normalizeToolPathArgument(value: string): string | null {
  if (value.includes("\0")) {
    return null;
  }
  const forward = value.replace(/\\/g, "/");
  const absolute = forward.startsWith("/");
  const windows = /^[A-Za-z]:\//.exec(forward)?.[0] ?? null;
  const body =
    windows !== null ? forward.slice(windows.length) : absolute ? forward.slice(1) : forward;

  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  if (windows !== null) {
    return `${windows}${joined}`;
  }
  if (absolute) {
    return `/${joined}`;
  }
  return joined;
}

/** Exhaustiveness helper for callers switching on validate errors. */
export function describeToolValidateError(error: ToolValidateError): string {
  switch (error.code) {
    case "unknown-tool":
      return "unknown-tool";
    case "malformed-input":
      return "malformed-input";
    case "malformed-arguments":
      return "malformed-arguments";
    case "duplicate-tool-call-id":
      return "duplicate-tool-call-id";
    case "invalid-tool-call-id":
      return "invalid-tool-call-id";
    case "queue-bound-exceeded":
      return "queue-bound-exceeded";
    case "unsupported-platform":
      return "unsupported-platform";
    case "unsupported-version":
      return "unsupported-version";
    case "input-too-large":
      return "input-too-large";
    case "invalid-path-argument":
      return "invalid-path-argument";
    case "host-platform-required":
      return "host-platform-required";
    default:
      return assertNever(error, "unhandled tool validate error");
  }
}
