/**
 * Workspace source reads and bounded expansion contracts (#59).
 *
 * A read keeps the source identity, revision, digest, actual range, and
 * completeness beside its projection. Inline output is bounded; exact larger
 * source can be expanded through an artifact without pretending the inline
 * projection is the whole file.
 */

import type { FileKind } from "./filesystem.ts";
import type { ArtifactId, ContentDigest } from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import type { BoundWorkspacePath, WorkspacePathBindError } from "./workspace-path.ts";

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
export const DEFAULT_MAX_AGGREGATE_READ_BYTES = 1024 * 1024;
export const DEFAULT_READ_CONCURRENCY = 4;
export const DEFAULT_MAX_EXPANSION_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_EXPANSION_CHUNK_BYTES = 64 * 1024;
export const DEFAULT_MAX_STALE_RETRIES = 1;
export const MAX_READ_MANY_TARGETS = 64;
export const MAX_WORKSPACE_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_WORKSPACE_AGGREGATE_BYTES = 256 * 1024 * 1024;
export const MAX_WORKSPACE_EXPANSION_BYTES = 64 * 1024 * 1024;
export const MAX_WORKSPACE_EXPANSION_CHUNK_BYTES = 1024 * 1024;
export const MAX_WORKSPACE_STALE_RETRIES = 2;

export type NewlineStyle = "lf" | "crlf" | "cr" | "mixed" | "none";

export type WorkspaceReadEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "binary";

export type WorkspaceReadCompleteness = "complete" | "partial";

export type WorkspaceReadFidelity = "exact";

export type WorkspaceReadContinuation = {
  readonly kind: "byte";
  readonly offset: number;
  readonly length: number;
  readonly reason: "inline-limit";
};

export type WorkspaceReadExpansion = {
  readonly kind: "artifact";
  readonly artifactId: ArtifactId;
  readonly digest: ContentDigest;
  readonly byteLength: number;
  readonly mediaType: "text/plain" | "application/octet-stream";
};

export type WorkspaceReadDiagnostic = {
  readonly code: "inline-limit";
  readonly returnedBytes: number;
  readonly sourceBytes: number;
};

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
  | {
      readonly code: "malformed-limit";
      readonly field: WorkspaceReadLimitName;
      readonly reason: "not-positive" | "not-safe-integer" | "above-hard-maximum";
    }
  | { readonly code: "stale"; readonly attempts: number }
  | { readonly code: "filesystem"; readonly reason: string };

export type WorkspaceReadLimitName =
  | "maxFileBytes"
  | "maxAggregateBytes"
  | "maxConcurrency"
  | "maxExpansionBytes"
  | "maxExpansionChunkBytes"
  | "maxStaleRetries";

export type WorkspaceReadLimits = {
  readonly maxFileBytes: number;
  readonly maxAggregateBytes: number;
  readonly maxConcurrency: number;
  readonly maxExpansionBytes: number;
  readonly maxExpansionChunkBytes: number;
  readonly maxStaleRetries: number;
};

export const DEFAULT_READ_LIMITS: WorkspaceReadLimits = {
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  maxAggregateBytes: DEFAULT_MAX_AGGREGATE_READ_BYTES,
  maxConcurrency: DEFAULT_READ_CONCURRENCY,
  maxExpansionBytes: DEFAULT_MAX_EXPANSION_BYTES,
  maxExpansionChunkBytes: DEFAULT_MAX_EXPANSION_CHUNK_BYTES,
  maxStaleRetries: DEFAULT_MAX_STALE_RETRIES,
};

export function readLimits(overrides: Partial<WorkspaceReadLimits> = {}): WorkspaceReadLimits {
  return {
    maxFileBytes: overrides.maxFileBytes ?? DEFAULT_READ_LIMITS.maxFileBytes,
    maxAggregateBytes: overrides.maxAggregateBytes ?? DEFAULT_READ_LIMITS.maxAggregateBytes,
    maxConcurrency: overrides.maxConcurrency ?? DEFAULT_READ_LIMITS.maxConcurrency,
    maxExpansionBytes: overrides.maxExpansionBytes ?? DEFAULT_READ_LIMITS.maxExpansionBytes,
    maxExpansionChunkBytes:
      overrides.maxExpansionChunkBytes ?? DEFAULT_READ_LIMITS.maxExpansionChunkBytes,
    maxStaleRetries: overrides.maxStaleRetries ?? DEFAULT_READ_LIMITS.maxStaleRetries,
  };
}

const HARD_LIMITS: Readonly<Record<WorkspaceReadLimitName, number>> = {
  maxFileBytes: MAX_WORKSPACE_FILE_BYTES,
  maxAggregateBytes: MAX_WORKSPACE_AGGREGATE_BYTES,
  maxConcurrency: DEFAULT_READ_CONCURRENCY * 4,
  maxExpansionBytes: MAX_WORKSPACE_EXPANSION_BYTES,
  maxExpansionChunkBytes: MAX_WORKSPACE_EXPANSION_CHUNK_BYTES,
  maxStaleRetries: MAX_WORKSPACE_STALE_RETRIES,
};

export function parseReadLimits(
  overrides: Partial<WorkspaceReadLimits> = {},
):
  | { readonly ok: true; readonly value: WorkspaceReadLimits }
  | { readonly ok: false; readonly error: WorkspaceReadError } {
  const values = readLimits(overrides);
  for (const name of Object.keys(HARD_LIMITS) as WorkspaceReadLimitName[]) {
    const value = values[name];
    if (!Number.isSafeInteger(value)) {
      return {
        ok: false,
        error: { code: "malformed-limit", field: name, reason: "not-safe-integer" },
      };
    }
    if (value < (name === "maxStaleRetries" ? 0 : 1)) {
      return {
        ok: false,
        error: { code: "malformed-limit", field: name, reason: "not-positive" },
      };
    }
    if (value > HARD_LIMITS[name]) {
      return {
        ok: false,
        error: { code: "malformed-limit", field: name, reason: "above-hard-maximum" },
      };
    }
  }
  if (values.maxExpansionChunkBytes > values.maxExpansionBytes) {
    return {
      ok: false,
      error: {
        code: "malformed-limit",
        field: "maxExpansionChunkBytes",
        reason: "above-hard-maximum",
      },
    };
  }
  return { ok: true, value: values };
}

export type WorkspaceFileRead = {
  readonly bound: BoundWorkspacePath;
  readonly kind: FileKind;
  readonly byteLength: number;
  readonly requestedTarget: string;
  readonly resolvedTarget: string;
  readonly sourceIdentity: string;
  readonly revision: string;
  readonly digest: ContentDigest;
  readonly completeness: WorkspaceReadCompleteness;
  readonly fidelity: WorkspaceReadFidelity;
  readonly encoding: Exclude<WorkspaceReadEncoding, "binary">;
  readonly newline: NewlineStyle;
  /** The caller's requested range, or `null` for a complete-source request. */
  readonly range: WorkspaceReadRange | null;
  /** The source range represented by the returned lines. */
  readonly actualRange: WorkspaceReadRange | null;
  readonly inlineByteLength: number;
  readonly lines: readonly NumberedLine[];
  readonly truncated: boolean;
  readonly continuation: WorkspaceReadContinuation | null;
  readonly expansion: WorkspaceReadExpansion | null;
  readonly diagnostics: readonly WorkspaceReadDiagnostic[];
};

export type WorkspaceBytesRead = {
  readonly bound: BoundWorkspacePath;
  readonly kind: FileKind;
  readonly byteLength: number;
  readonly requestedTarget: string;
  readonly resolvedTarget: string;
  readonly sourceIdentity: string;
  readonly revision: string;
  readonly digest: ContentDigest;
  readonly completeness: WorkspaceReadCompleteness;
  readonly fidelity: WorkspaceReadFidelity;
  readonly encoding: "binary";
  readonly range: ByteRange;
  readonly actualRange: ByteRange;
  readonly inlineByteLength: number;
  readonly bytes: Uint8Array;
  readonly continuation: WorkspaceReadContinuation | null;
  readonly expansion: WorkspaceReadExpansion | null;
  readonly diagnostics: readonly WorkspaceReadDiagnostic[];
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
  readonly aggregateBytes: number;
  readonly completeness: WorkspaceReadCompleteness;
  readonly limitReached: boolean;
};

export type DecodedWorkspaceText = {
  readonly text: string;
  readonly encoding: Exclude<WorkspaceReadEncoding, "binary">;
};

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  if (bytes.byteLength % 2 !== 0) {
    throw new TypeError("odd utf-16 byte count");
  }
  const chunks: string[] = [];
  const codeUnits: number[] = [];
  for (let index = 0; index < bytes.byteLength; index += 2) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    codeUnits.push(littleEndian ? first | (second << 8) : (first << 8) | second);
    if (codeUnits.length === 8_192) {
      chunks.push(String.fromCharCode(...codeUnits));
      codeUnits.length = 0;
    }
  }
  if (codeUnits.length > 0) {
    chunks.push(String.fromCharCode(...codeUnits));
  }
  return chunks.join("");
}

/** Decodes only declared text encodings and refuses replacement characters. */
export function decodeWorkspaceText(
  bytes: Uint8Array,
): Result<DecodedWorkspaceText, "malformed-encoding"> {
  try {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return ok({
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3)),
        encoding: "utf-8-bom",
      });
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      if ((bytes.byteLength - 2) % 2 !== 0) {
        return err("malformed-encoding");
      }
      return ok({
        text: decodeUtf16(bytes.subarray(2), true),
        encoding: "utf-16le",
      });
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      if ((bytes.byteLength - 2) % 2 !== 0) {
        return err("malformed-encoding");
      }
      return ok({
        text: decodeUtf16(bytes.subarray(2), false),
        encoding: "utf-16be",
      });
    }
    return ok({
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf-8",
    });
  } catch {
    return err("malformed-encoding");
  }
}

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
    case "malformed-limit":
      return `malformed-limit:${error.field}:${error.reason}`;
    case "stale":
      return `stale:${error.attempts}`;
    case "filesystem":
      return `filesystem:${error.reason}`;
    default:
      return assertNever(error, "unhandled workspace read error");
  }
}
