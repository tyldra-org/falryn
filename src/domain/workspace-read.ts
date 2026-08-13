/**
 * Workspace one-file and multi-file read contracts (#56).
 *
 * Numbered text, ranges, and budgets only. Artifact spill, digests, and
 * specialized readers remain later #54 children.
 */

import type { FileKind } from "./filesystem.ts";
import { assertNever } from "./result.ts";
import type { BoundWorkspacePath, WorkspacePathBindError } from "./workspace-path.ts";

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
export const DEFAULT_MAX_AGGREGATE_READ_BYTES = 1024 * 1024;
export const DEFAULT_READ_CONCURRENCY = 4;
export const MAX_READ_MANY_TARGETS = 64;

export type NewlineStyle = "lf" | "crlf" | "cr" | "mixed" | "none";

export type LineRange = {
  readonly start: number;
  readonly end: number;
};

export type ByteRange = {
  readonly start: number;
  readonly end: number;
};

export type WorkspaceReadRange =
  | { readonly kind: "line"; readonly range: LineRange }
  | { readonly kind: "byte"; readonly range: ByteRange };

export type NumberedLine = {
  readonly number: number;
  readonly text: string;
};

export type WorkspaceReadError =
  | WorkspacePathBindError
  | { readonly code: "symlink-escape" }
  | { readonly code: "not-found" }
  | { readonly code: "not-a-file" }
  | { readonly code: "oversized"; readonly byteLength: number }
  | { readonly code: "binary" }
  | { readonly code: "malformed-encoding" }
  | { readonly code: "malformed-range" }
  | { readonly code: "cancelled" }
  | { readonly code: "too-many-targets" }
  | { readonly code: "filesystem"; readonly reason: string };

export type WorkspaceReadLimits = {
  readonly maxFileBytes: number;
  readonly maxAggregateBytes: number;
  readonly maxConcurrency: number;
};

export const DEFAULT_READ_LIMITS: WorkspaceReadLimits = {
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  maxAggregateBytes: DEFAULT_MAX_AGGREGATE_READ_BYTES,
  maxConcurrency: DEFAULT_READ_CONCURRENCY,
};

export function readLimits(overrides: Partial<WorkspaceReadLimits> = {}): WorkspaceReadLimits {
  return {
    maxFileBytes: overrides.maxFileBytes ?? DEFAULT_READ_LIMITS.maxFileBytes,
    maxAggregateBytes: overrides.maxAggregateBytes ?? DEFAULT_READ_LIMITS.maxAggregateBytes,
    maxConcurrency: overrides.maxConcurrency ?? DEFAULT_READ_LIMITS.maxConcurrency,
  };
}

export type WorkspaceFileRead = {
  readonly bound: BoundWorkspacePath;
  readonly kind: FileKind;
  readonly byteLength: number;
  readonly newline: NewlineStyle;
  readonly range: WorkspaceReadRange | null;
  readonly lines: readonly NumberedLine[];
  readonly truncated: boolean;
};

export type WorkspaceReadTarget = {
  readonly path: unknown;
  readonly range?: WorkspaceReadRange;
};

export type WorkspaceReadManyItem =
  | { readonly index: number; readonly status: "read"; readonly value: WorkspaceFileRead }
  | { readonly index: number; readonly status: "failed"; readonly error: WorkspaceReadError }
  | { readonly index: number; readonly status: "unscheduled"; readonly error: WorkspaceReadError };

export type WorkspaceReadManyResult = {
  readonly items: readonly WorkspaceReadManyItem[];
};

export function detectNewline(text: string): NewlineStyle {
  const crlf = text.includes("\r\n");
  const stripped = crlf ? text.replaceAll("\r\n", "") : text;
  const cr = stripped.includes("\r");
  const lf = stripped.includes("\n");
  if (crlf && (cr || lf)) {
    return "mixed";
  }
  if (cr && lf) {
    return "mixed";
  }
  if (crlf) {
    return "crlf";
  }
  if (cr) {
    return "cr";
  }
  if (lf) {
    return "lf";
  }
  return "none";
}

export function isBinaryText(text: string): boolean {
  return text.includes("\0");
}

export function splitLines(text: string): readonly string[] {
  if (text.length === 0) {
    return [""];
  }
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const parts = normalized.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") {
    return parts.slice(0, -1);
  }
  return parts;
}

export function numberLines(text: string, start = 1): readonly NumberedLine[] {
  return splitLines(text).map((line, index) => ({ number: start + index, text: line }));
}

export function applyLineRange(
  text: string,
  range: LineRange,
):
  | { readonly lines: readonly NumberedLine[]; readonly truncated: boolean }
  | { readonly error: "malformed-range" } {
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 1 ||
    range.end < range.start
  ) {
    return { error: "malformed-range" };
  }
  const all = numberLines(text);
  const slice = all.filter((line) => line.number >= range.start && line.number <= range.end);
  return { lines: slice, truncated: range.end < all.length };
}

export function applyByteRange(
  text: string,
  range: ByteRange,
):
  | { readonly text: string; readonly truncated: boolean }
  | { readonly error: "malformed-range" | "malformed-encoding" } {
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start
  ) {
    return { error: "malformed-range" };
  }
  const encoded = Buffer.from(text, "utf8");
  if (range.start > encoded.byteLength) {
    return { text: "", truncated: false };
  }
  const end = Math.min(range.end, encoded.byteLength);
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(range.start, end)),
      truncated: end < encoded.byteLength,
    };
  } catch {
    return { error: "malformed-encoding" };
  }
}

export function describeWorkspaceReadError(error: WorkspaceReadError): string {
  switch (error.code) {
    case "malformed":
      return `malformed:${error.reason}`;
    case "escaped":
      return "escaped";
    case "absolute-unscoped":
      return "absolute-unscoped";
    case "symlink-escape":
      return "symlink-escape";
    case "not-found":
      return "not-found";
    case "not-a-file":
      return "not-a-file";
    case "oversized":
      return `oversized:${error.byteLength}`;
    case "binary":
      return "binary";
    case "malformed-encoding":
      return "malformed-encoding";
    case "malformed-range":
      return "malformed-range";
    case "cancelled":
      return "cancelled";
    case "too-many-targets":
      return "too-many-targets";
    case "filesystem":
      return `filesystem:${error.reason}`;
    default:
      return assertNever(error, "unhandled workspace read error");
  }
}
