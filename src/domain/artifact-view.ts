/**
 * Typed artifact viewers (#117).
 *
 * The store returns stored bytes and a coding label. This owner is the one
 * that may expand `gzip`, bound that expansion, and project the result into
 * one of five kinds. OpenTUI's code and diff components remain the rendering
 * primitives; this module never highlights, layouts, or executes content.
 *
 * Export, replay, crash recovery, and retention stay later children of #115.
 */

import { z } from "zod";

import {
  type ArtifactEncoding,
  type ArtifactError,
  type ArtifactId,
  type ArtifactOrigin,
  type ArtifactRecord,
  artifactId,
} from "./artifact.ts";
import { err, ok, type Result } from "./result.ts";

export const ARTIFACT_VIEW_VERSION = "artifact-view.v1";

export const ARTIFACT_VIEW_KINDS = ["code", "diff", "document", "media", "diagnostic"] as const;
export type ArtifactViewKind = (typeof ARTIFACT_VIEW_KINDS)[number];

/**
 * One primary state, in the order a caller should believe.
 *
 * Missing, quarantined, and redacted win over anything learned from bytes.
 * Stale means the digest no longer matches and the body is still shown.
 * Truncated wins over transformed: a gzip expansion that then hit a view
 * budget is a partial view of decoded bytes, not a complete transform.
 */
export const ARTIFACT_VIEW_STATES = [
  "complete",
  "truncated",
  "transformed",
  "stale",
  "missing",
  "quarantined",
  "redacted",
] as const;
export type ArtifactViewState = (typeof ARTIFACT_VIEW_STATES)[number];

export const ARTIFACT_VIEW_LIMIT_NAMES = [
  "maxSourceBytes",
  "maxDecodedBytes",
  "maxViewBytes",
  "maxDecompressionRatio",
] as const;
export type ArtifactViewLimitName = (typeof ARTIFACT_VIEW_LIMIT_NAMES)[number];

export const DEFAULT_ARTIFACT_VIEW_LIMITS = {
  maxSourceBytes: 1024 * 1024,
  maxDecodedBytes: 2 * 1024 * 1024,
  maxViewBytes: 64 * 1024,
  maxDecompressionRatio: 32,
} as const;

export const MAX_ARTIFACT_VIEW_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_ARTIFACT_VIEW_DECODED_BYTES = 8 * 1024 * 1024;
export const MAX_ARTIFACT_VIEW_BYTES = 256 * 1024;
export const MAX_ARTIFACT_VIEW_DECOMPRESSION_RATIO = 256;

export type ArtifactViewLimits = {
  readonly maxSourceBytes: number;
  readonly maxDecodedBytes: number;
  readonly maxViewBytes: number;
  readonly maxDecompressionRatio: number;
};

const artifactViewLimitsSchema = z
  .object({
    maxSourceBytes: z.number().int().positive().max(MAX_ARTIFACT_VIEW_SOURCE_BYTES).optional(),
    maxDecodedBytes: z.number().int().positive().max(MAX_ARTIFACT_VIEW_DECODED_BYTES).optional(),
    maxViewBytes: z.number().int().positive().max(MAX_ARTIFACT_VIEW_BYTES).optional(),
    maxDecompressionRatio: z
      .number()
      .int()
      .positive()
      .max(MAX_ARTIFACT_VIEW_DECOMPRESSION_RATIO)
      .optional(),
  })
  .strict();

export type ArtifactViewLimitsInput = z.input<typeof artifactViewLimitsSchema>;

const MAX_ARTIFACT_VIEW_LIMITS: ArtifactViewLimits = {
  maxSourceBytes: MAX_ARTIFACT_VIEW_SOURCE_BYTES,
  maxDecodedBytes: MAX_ARTIFACT_VIEW_DECODED_BYTES,
  maxViewBytes: MAX_ARTIFACT_VIEW_BYTES,
  maxDecompressionRatio: MAX_ARTIFACT_VIEW_DECOMPRESSION_RATIO,
};

export type ArtifactViewLimitError = {
  readonly code: "malformed-limits";
  readonly field: ArtifactViewLimitName;
};

export function artifactViewLimits(
  input: ArtifactViewLimitsInput | undefined = undefined,
): Result<ArtifactViewLimits, ArtifactViewLimitError> {
  const parsed = artifactViewLimitsSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (
      typeof field === "string" &&
      ARTIFACT_VIEW_LIMIT_NAMES.includes(field as ArtifactViewLimitName)
    ) {
      return err({ code: "malformed-limits", field: field as ArtifactViewLimitName });
    }
    return err({ code: "malformed-limits", field: "maxSourceBytes" });
  }

  const limits: ArtifactViewLimits = {
    maxSourceBytes: parsed.data.maxSourceBytes ?? DEFAULT_ARTIFACT_VIEW_LIMITS.maxSourceBytes,
    maxDecodedBytes: parsed.data.maxDecodedBytes ?? DEFAULT_ARTIFACT_VIEW_LIMITS.maxDecodedBytes,
    maxViewBytes: parsed.data.maxViewBytes ?? DEFAULT_ARTIFACT_VIEW_LIMITS.maxViewBytes,
    maxDecompressionRatio:
      parsed.data.maxDecompressionRatio ?? DEFAULT_ARTIFACT_VIEW_LIMITS.maxDecompressionRatio,
  };
  for (const field of ARTIFACT_VIEW_LIMIT_NAMES) {
    if (limits[field] > MAX_ARTIFACT_VIEW_LIMITS[field]) {
      return err({ code: "malformed-limits", field });
    }
  }
  return ok(limits);
}

const artifactViewRequestSchema = z
  .object({
    artifactId: z.string().min(1),
    limits: artifactViewLimitsSchema.optional(),
  })
  .strict();

export type ArtifactViewRequest = z.input<typeof artifactViewRequestSchema>;
export type ArtifactViewRequestField = "request" | "artifactId" | "limits";

export type ArtifactViewRequestError = {
  readonly code: "malformed-request";
  readonly field: ArtifactViewRequestField;
};

export type NormalizedArtifactViewRequest = {
  readonly artifactId: ArtifactId;
  readonly limits: ArtifactViewLimits;
};

function requestField(path: readonly PropertyKey[]): ArtifactViewRequestField {
  const field = path[0];
  if (field === "artifactId" || field === "limits") {
    return field;
  }
  return "request";
}

export function parseArtifactViewRequest(
  value: unknown,
): Result<NormalizedArtifactViewRequest, ArtifactViewRequestError | ArtifactViewLimitError> {
  const parsed = artifactViewRequestSchema.safeParse(value);
  if (!parsed.success) {
    return err({
      code: "malformed-request",
      field: requestField(parsed.error.issues[0]?.path ?? []),
    });
  }
  const id = artifactId.parse(parsed.data.artifactId);
  if (!id.ok) {
    return err({ code: "malformed-request", field: "artifactId" });
  }
  const limits = artifactViewLimits(parsed.data.limits);
  if (!limits.ok) {
    return limits;
  }
  return ok({ artifactId: id.value, limits: limits.value });
}

export const ARTIFACT_VIEW_CODE_LANGUAGES = [
  "bash",
  "c",
  "cpp",
  "css",
  "go",
  "html",
  "java",
  "javascript",
  "json",
  "markdown",
  "python",
  "rust",
  "toml",
  "typescript",
  "xml",
  "yaml",
  "text",
] as const;
export type ArtifactViewCodeLanguage = (typeof ARTIFACT_VIEW_CODE_LANGUAGES)[number];

export const ARTIFACT_VIEW_DOCUMENT_FAMILIES = ["markdown", "html", "log", "text"] as const;
export type ArtifactViewDocumentFamily = (typeof ARTIFACT_VIEW_DOCUMENT_FAMILIES)[number];

export const ARTIFACT_VIEW_DIFF_MODES = ["unified"] as const;
export type ArtifactViewDiffMode = (typeof ARTIFACT_VIEW_DIFF_MODES)[number];

export type ArtifactViewBody =
  | {
      readonly kind: "code";
      readonly language: ArtifactViewCodeLanguage;
      readonly lineCount: number;
      readonly text: string;
    }
  | {
      readonly kind: "diff";
      readonly mode: ArtifactViewDiffMode;
      readonly hunkCount: number;
      readonly text: string;
    }
  | {
      readonly kind: "document";
      readonly family: ArtifactViewDocumentFamily;
      readonly text: string;
    }
  | {
      readonly kind: "media";
      readonly format: string;
      readonly visual: "summary";
      readonly storedByteLength: number;
      readonly hexPreview: string;
    }
  | {
      readonly kind: "diagnostic";
      readonly parsed: boolean;
      readonly level: string | null;
      readonly code: string | null;
      readonly subsystem: string | null;
      readonly text: string;
    };

export type ArtifactView = {
  readonly schemaVersion: typeof ARTIFACT_VIEW_VERSION;
  readonly artifactId: ArtifactId;
  readonly record: ArtifactRecord;
  readonly kind: ArtifactViewKind;
  readonly status: ArtifactViewState;
  /** True when stored gzip bytes were expanded into the body. */
  readonly transformed: boolean;
  readonly sourceByteLength: number;
  readonly decodedByteLength: number | null;
  readonly viewByteLength: number;
  readonly body: ArtifactViewBody | null;
};

export type ArtifactViewError =
  | ArtifactError
  | ArtifactViewRequestError
  | ArtifactViewLimitError
  | {
      readonly kind: "artifact-view";
      readonly code: "decompression-limit" | "malformed-encoding" | "cancelled";
      readonly artifactId: ArtifactId | null;
      readonly field: string | null;
    };

export function isArtifactViewKind(value: unknown): value is ArtifactViewKind {
  return typeof value === "string" && (ARTIFACT_VIEW_KINDS as readonly string[]).includes(value);
}

export function mediaTypeEssence(mediaType: string): string {
  const [essence] = mediaType.split(";", 1);
  return (essence ?? mediaType).trim().toLowerCase();
}

/**
 * Selects a viewer from validated media type and origin, never from bytes.
 *
 * Guessing a language from a snippet is how a secret becomes "just text".
 * Origin `diagnostic` wins so a JSON health dump is not a code viewer.
 */
export function selectArtifactViewKind(
  mediaType: string,
  origin: ArtifactOrigin,
): ArtifactViewKind {
  const type = mediaTypeEssence(mediaType);
  if (origin === "diagnostic" || DIAGNOSTIC_MEDIA_TYPES.has(type)) {
    return "diagnostic";
  }
  if (DIFF_MEDIA_TYPES.has(type) || type.endsWith("+diff")) {
    return "diff";
  }
  if (isMediaViewType(type)) {
    return "media";
  }
  if (CODE_MEDIA_TYPES.has(type) || type.startsWith("text/x-") || type.endsWith("+json")) {
    return "code";
  }
  if (type.startsWith("text/") || DOCUMENT_MEDIA_TYPES.has(type)) {
    return "document";
  }
  return "media";
}

export function artifactViewStatus(input: {
  readonly availability: ArtifactRecord["availability"];
  readonly sensitivity: ArtifactRecord["sensitivity"];
  readonly truncated: boolean;
  readonly transformed: boolean;
  readonly stale: boolean;
}): ArtifactViewState {
  if (input.availability === "missing" || input.availability === "reserved") {
    return "missing";
  }
  if (input.availability === "quarantined") {
    return "quarantined";
  }
  if (input.sensitivity === "restricted") {
    return "redacted";
  }
  if (input.stale) {
    return "stale";
  }
  if (input.truncated) {
    return "truncated";
  }
  if (input.transformed) {
    return "transformed";
  }
  return "complete";
}

export type ArtifactViewProjectionInput = {
  readonly record: ArtifactRecord;
  readonly bytes: Uint8Array | null;
  readonly transformed: boolean;
  readonly truncated: boolean;
  readonly stale: boolean;
  readonly limits: ArtifactViewLimits;
};

/**
 * Projects already-decoded bytes into a viewer. Encoding expansion happens
 * in the application layer so this module stays free of zlib.
 */
export function projectArtifactView(input: ArtifactViewProjectionInput): ArtifactView {
  const kind = selectArtifactViewKind(input.record.mediaType, input.record.origin);
  const status = artifactViewStatus({
    availability: input.record.availability,
    sensitivity: input.record.sensitivity,
    truncated: input.truncated,
    transformed: input.transformed,
    stale: input.stale,
  });
  const withhold =
    status === "missing" ||
    status === "quarantined" ||
    status === "redacted" ||
    input.bytes === null;
  const body = withhold
    ? null
    : bodyFor(kind, input.record, input.bytes, input.limits.maxViewBytes);
  return {
    schemaVersion: ARTIFACT_VIEW_VERSION,
    artifactId: input.record.artifactId,
    record: input.record,
    kind,
    status,
    transformed: input.transformed,
    sourceByteLength: input.record.byteLength,
    decodedByteLength: input.bytes?.byteLength ?? null,
    viewByteLength: body === null ? 0 : viewBytesOf(body),
    body,
  };
}

export function maximumDecodedBytes(sourceByteLength: number, limits: ArtifactViewLimits): number {
  const ratioMaximum = Math.max(sourceByteLength, sourceByteLength * limits.maxDecompressionRatio);
  return Math.min(limits.maxDecodedBytes, ratioMaximum);
}

function bodyFor(
  kind: ArtifactViewKind,
  record: ArtifactRecord,
  bytes: Uint8Array,
  maxViewBytes: number,
): ArtifactViewBody {
  switch (kind) {
    case "code": {
      const clipped = clipBytes(bytes, maxViewBytes);
      const text = utf8(clipped);
      return {
        kind: "code",
        language: languageFor(record.mediaType),
        lineCount: lineCountOf(text),
        text,
      };
    }
    case "diff": {
      const clipped = clipBytes(bytes, maxViewBytes);
      const text = utf8(clipped);
      return {
        kind: "diff",
        mode: "unified",
        hunkCount: hunkCountOf(text),
        text,
      };
    }
    case "document": {
      const clipped = clipBytes(bytes, maxViewBytes);
      const text = utf8(clipped);
      return {
        kind: "document",
        family: documentFamilyFor(record.mediaType),
        text,
      };
    }
    case "media":
      return {
        kind: "media",
        format: mediaTypeEssence(record.mediaType),
        visual: "summary",
        storedByteLength: record.byteLength,
        hexPreview: hexPreview(clipBytes(bytes, Math.min(32, maxViewBytes))),
      };
    case "diagnostic": {
      const clipped = clipBytes(bytes, maxViewBytes);
      const text = utf8(clipped);
      const parsed = diagnosticFacts(text);
      return {
        kind: "diagnostic",
        parsed: parsed.parsed,
        level: parsed.level,
        code: parsed.code,
        subsystem: parsed.subsystem,
        text,
      };
    }
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function viewBytesOf(body: ArtifactViewBody): number {
  switch (body.kind) {
    case "code":
    case "diff":
    case "document":
    case "diagnostic":
      return new TextEncoder().encode(body.text).byteLength;
    case "media":
      return new TextEncoder().encode(body.hexPreview).byteLength;
    default: {
      const exhaustive: never = body;
      return exhaustive;
    }
  }
}

function clipBytes(bytes: Uint8Array, maximum: number): Uint8Array {
  return bytes.byteLength > maximum ? bytes.subarray(0, maximum) : bytes;
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function lineCountOf(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let lines = 1;
  for (const character of text) {
    if (character === "\n") {
      lines += 1;
    }
  }
  return text.endsWith("\n") ? lines - 1 : lines;
}

function hunkCountOf(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@ ")) {
      count += 1;
    }
  }
  return count;
}

function hexPreview(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(" ");
}

function languageFor(mediaType: string): ArtifactViewCodeLanguage {
  const type = mediaTypeEssence(mediaType);
  const mapped = CODE_LANGUAGES[type];
  if (mapped !== undefined) {
    return mapped;
  }
  if (type.startsWith("text/x-")) {
    const name = type.slice("text/x-".length);
    if ((ARTIFACT_VIEW_CODE_LANGUAGES as readonly string[]).includes(name)) {
      return name as ArtifactViewCodeLanguage;
    }
  }
  return "text";
}

function documentFamilyFor(mediaType: string): ArtifactViewDocumentFamily {
  const type = mediaTypeEssence(mediaType);
  if (type === "text/markdown" || type === "text/x-markdown") {
    return "markdown";
  }
  if (type === "text/html" || type === "application/xhtml+xml") {
    return "html";
  }
  if (type === "text/log" || type === "text/x-log") {
    return "log";
  }
  return "text";
}

function diagnosticFacts(text: string): {
  readonly parsed: boolean;
  readonly level: string | null;
  readonly code: string | null;
  readonly subsystem: string | null;
} {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { parsed: false, level: null, code: null, subsystem: null };
    }
    const record = value as Record<string, unknown>;
    return {
      parsed: true,
      level: stringField(record.level ?? record.severity),
      code: stringField(record.code ?? record.ruleId),
      subsystem: stringField(record.subsystem),
    };
  } catch {
    return { parsed: false, level: null, code: null, subsystem: null };
  }
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isMediaViewType(type: string): boolean {
  return (
    type.startsWith("image/") ||
    type.startsWith("audio/") ||
    type.startsWith("video/") ||
    MEDIA_MEDIA_TYPES.has(type)
  );
}

const DIFF_MEDIA_TYPES = new Set([
  "text/x-diff",
  "text/x-patch",
  "application/x-patch",
  "application/diff",
]);

const DIAGNOSTIC_MEDIA_TYPES = new Set([
  "application/sarif+json",
  "application/vnd.falryn.diagnostic+json",
]);

const DOCUMENT_MEDIA_TYPES = new Set(["text/csv", "application/xhtml+xml"]);

const MEDIA_MEDIA_TYPES = new Set([
  "application/pdf",
  "application/octet-stream",
  "application/zip",
  "application/vnd.jupyter.notebook+json",
]);

const CODE_MEDIA_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/toml",
  "text/javascript",
  "text/typescript",
  "text/css",
  "text/xml",
  "text/yaml",
  "text/x-python",
  "text/x-rust",
  "text/x-go",
  "text/x-java",
  "text/x-c",
  "text/x-c++",
  "text/x-sh",
  "text/x-shellscript",
]);

const CODE_LANGUAGES: Readonly<Record<string, ArtifactViewCodeLanguage>> = {
  "application/json": "json",
  "application/javascript": "javascript",
  "application/typescript": "typescript",
  "application/xml": "xml",
  "application/yaml": "yaml",
  "application/toml": "toml",
  "text/javascript": "javascript",
  "text/typescript": "typescript",
  "text/css": "css",
  "text/html": "html",
  "text/xml": "xml",
  "text/yaml": "yaml",
  "text/x-python": "python",
  "text/x-rust": "rust",
  "text/x-go": "go",
  "text/x-java": "java",
  "text/x-c": "c",
  "text/x-c++": "cpp",
  "text/x-sh": "bash",
  "text/x-shellscript": "bash",
  "text/markdown": "markdown",
};

export function encodingNeedsDecode(encoding: ArtifactEncoding): boolean {
  return encoding === "gzip";
}
