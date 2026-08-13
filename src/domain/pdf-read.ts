/**
 * Bounded PDF read contracts (#495).
 *
 * PDF output is a page-aware, non-executing projection over exact workspace
 * bytes. It keeps derived text, layout confidence, OCR requirements, and
 * unsupported content visible instead of presenting a lossy parse as a source
 * document.
 */

import { z } from "zod";

import { MAX_LOCAL_PATH_LENGTH } from "./filesystem.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import type { BoundWorkspacePath } from "./workspace-path.ts";
import type { WorkspaceReadError } from "./workspace-read.ts";

export const PDF_SELECTION_MODES = ["pages", "query"] as const;
export type PdfSelectionMode = (typeof PDF_SELECTION_MODES)[number];

export const PDF_EXTRACTION_METHODS = ["text", "ocr-required", "none"] as const;
export type PdfExtractionMethod = (typeof PDF_EXTRACTION_METHODS)[number];

export const PDF_LAYOUT_CONFIDENCES = ["high", "medium", "low", "unknown"] as const;
export type PdfLayoutConfidence = (typeof PDF_LAYOUT_CONFIDENCES)[number];

export const PDF_BLOCK_KINDS = ["text", "table", "link", "annotation", "embedded-image"] as const;
export type PdfBlockKind = (typeof PDF_BLOCK_KINDS)[number];

export const PDF_DIAGNOSTIC_CODES = [
  "malformed-header",
  "malformed-objects",
  "malformed-pages",
  "malformed-content",
  "encrypted",
  "unsupported-version",
  "unsupported-filter",
  "decompression-limit",
  "image-only",
  "ocr-required",
  "huge-page",
  "huge-output",
  "missing-page",
  "missing-coordinate",
] as const;
export type PdfDiagnosticCode = (typeof PDF_DIAGNOSTIC_CODES)[number];

export const PDF_OMISSION_KINDS = ["pages", "bytes", "objects", "content"] as const;
export type PdfOmissionKind = (typeof PDF_OMISSION_KINDS)[number];

export const PDF_OMISSION_REASONS = ["budget", "unselected", "not-found", "malformed"] as const;
export type PdfOmissionReason = (typeof PDF_OMISSION_REASONS)[number];

export const PDF_STOP_REASONS = ["cancelled", "budget", "decompression"] as const;
export type PdfStopReason = (typeof PDF_STOP_REASONS)[number];

export const PDF_EMPTY_REASONS = ["no-selected-pages", "no-query-matches"] as const;
export type PdfEmptyReason = (typeof PDF_EMPTY_REASONS)[number];

export const PDF_LIMIT_NAMES = [
  "maxSourceBytes",
  "maxPages",
  "maxOutputBytes",
  "maxPageOutputBytes",
  "maxDecompressedBytes",
  "maxObjects",
  "maxQueryLength",
  "maxDecompressionRatio",
] as const;
export type PdfLimitName = (typeof PDF_LIMIT_NAMES)[number];

export const DEFAULT_MAX_PDF_SOURCE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_PDF_PAGES = 16;
export const DEFAULT_MAX_PDF_OUTPUT_BYTES = 32 * 1024;
export const DEFAULT_MAX_PDF_PAGE_OUTPUT_BYTES = 16 * 1024;
export const DEFAULT_MAX_PDF_DECOMPRESSED_BYTES = 256 * 1024;
export const DEFAULT_MAX_PDF_OBJECTS = 4096;
export const DEFAULT_MAX_PDF_QUERY_LENGTH = 256;
export const DEFAULT_MAX_PDF_DECOMPRESSION_RATIO = 100;

export const MAX_PDF_SOURCE_BYTES = 4 * 1024 * 1024;
export const MAX_PDF_PAGES = 128;
export const MAX_PDF_OUTPUT_BYTES = 256 * 1024;
export const MAX_PDF_PAGE_OUTPUT_BYTES = 128 * 1024;
export const MAX_PDF_DECOMPRESSED_BYTES = 2 * 1024 * 1024;
export const MAX_PDF_OBJECTS = 16_384;
export const MAX_PDF_QUERY_LENGTH = 1024;
export const MAX_PDF_DECOMPRESSION_RATIO = 1000;
export const MAX_PDF_PAGE_NUMBER = 1_000_000;
export const MAX_PDF_PAGE_RANGES = 32;

export const DEFAULT_PDF_READ_LIMITS = {
  maxSourceBytes: DEFAULT_MAX_PDF_SOURCE_BYTES,
  maxPages: DEFAULT_MAX_PDF_PAGES,
  maxOutputBytes: DEFAULT_MAX_PDF_OUTPUT_BYTES,
  maxPageOutputBytes: DEFAULT_MAX_PDF_PAGE_OUTPUT_BYTES,
  maxDecompressedBytes: DEFAULT_MAX_PDF_DECOMPRESSED_BYTES,
  maxObjects: DEFAULT_MAX_PDF_OBJECTS,
  maxQueryLength: DEFAULT_MAX_PDF_QUERY_LENGTH,
  maxDecompressionRatio: DEFAULT_MAX_PDF_DECOMPRESSION_RATIO,
} as const;

export type PdfReadLimits = {
  readonly maxSourceBytes: number;
  readonly maxPages: number;
  readonly maxOutputBytes: number;
  readonly maxPageOutputBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxObjects: number;
  readonly maxQueryLength: number;
  readonly maxDecompressionRatio: number;
};

const pdfLimitsSchema = z
  .object({
    maxSourceBytes: z.number().int().positive().max(MAX_PDF_SOURCE_BYTES).optional(),
    maxPages: z.number().int().positive().max(MAX_PDF_PAGES).optional(),
    maxOutputBytes: z.number().int().positive().max(MAX_PDF_OUTPUT_BYTES).optional(),
    maxPageOutputBytes: z.number().int().positive().max(MAX_PDF_PAGE_OUTPUT_BYTES).optional(),
    maxDecompressedBytes: z.number().int().positive().max(MAX_PDF_DECOMPRESSED_BYTES).optional(),
    maxObjects: z.number().int().positive().max(MAX_PDF_OBJECTS).optional(),
    maxQueryLength: z.number().int().positive().max(MAX_PDF_QUERY_LENGTH).optional(),
    maxDecompressionRatio: z.number().int().positive().max(MAX_PDF_DECOMPRESSION_RATIO).optional(),
  })
  .strict();

export type PdfReadLimitsInput = z.input<typeof pdfLimitsSchema>;

const MAX_PDF_LIMITS: PdfReadLimits = {
  maxSourceBytes: MAX_PDF_SOURCE_BYTES,
  maxPages: MAX_PDF_PAGES,
  maxOutputBytes: MAX_PDF_OUTPUT_BYTES,
  maxPageOutputBytes: MAX_PDF_PAGE_OUTPUT_BYTES,
  maxDecompressedBytes: MAX_PDF_DECOMPRESSED_BYTES,
  maxObjects: MAX_PDF_OBJECTS,
  maxQueryLength: MAX_PDF_QUERY_LENGTH,
  maxDecompressionRatio: MAX_PDF_DECOMPRESSION_RATIO,
};

export type PdfLimitError = {
  readonly code: "malformed-limits";
  readonly field: PdfLimitName;
};

export function pdfReadLimits(
  input: PdfReadLimitsInput | undefined = undefined,
): Result<PdfReadLimits, PdfLimitError> {
  const parsed = pdfLimitsSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (typeof field === "string" && PDF_LIMIT_NAMES.includes(field as PdfLimitName)) {
      return err({ code: "malformed-limits", field: field as PdfLimitName });
    }
    return err({ code: "malformed-limits", field: "maxSourceBytes" });
  }

  const limits: PdfReadLimits = {
    maxSourceBytes: parsed.data.maxSourceBytes ?? DEFAULT_PDF_READ_LIMITS.maxSourceBytes,
    maxPages: parsed.data.maxPages ?? DEFAULT_PDF_READ_LIMITS.maxPages,
    maxOutputBytes: parsed.data.maxOutputBytes ?? DEFAULT_PDF_READ_LIMITS.maxOutputBytes,
    maxPageOutputBytes:
      parsed.data.maxPageOutputBytes ?? DEFAULT_PDF_READ_LIMITS.maxPageOutputBytes,
    maxDecompressedBytes:
      parsed.data.maxDecompressedBytes ?? DEFAULT_PDF_READ_LIMITS.maxDecompressedBytes,
    maxObjects: parsed.data.maxObjects ?? DEFAULT_PDF_READ_LIMITS.maxObjects,
    maxQueryLength: parsed.data.maxQueryLength ?? DEFAULT_PDF_READ_LIMITS.maxQueryLength,
    maxDecompressionRatio:
      parsed.data.maxDecompressionRatio ?? DEFAULT_PDF_READ_LIMITS.maxDecompressionRatio,
  };
  for (const field of PDF_LIMIT_NAMES) {
    if (limits[field] > MAX_PDF_LIMITS[field]) {
      return err({ code: "malformed-limits", field });
    }
  }
  return ok(limits);
}

export type PdfPageRange = {
  readonly start: number;
  readonly end: number;
};

const pdfPageRangeSchema = z
  .object({
    start: z.number().int().positive().max(MAX_PDF_PAGE_NUMBER),
    end: z.number().int().positive().max(MAX_PDF_PAGE_NUMBER),
  })
  .strict();

export type PdfPageRangeInput = z.input<typeof pdfPageRangeSchema>;

const pdfReadRequestSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(MAX_LOCAL_PATH_LENGTH)
      .refine((value) => hasNoControlCharacters(value)),
    mode: z.enum(PDF_SELECTION_MODES),
    pages: z.array(pdfPageRangeSchema).max(MAX_PDF_PAGE_RANGES).optional(),
    query: z
      .string()
      .min(1)
      .max(MAX_PDF_QUERY_LENGTH)
      .refine((value) => hasNoControlCharacters(value))
      .optional(),
    limits: pdfLimitsSchema.optional(),
  })
  .strict();

export type PdfReadRequest = z.input<typeof pdfReadRequestSchema>;

export type PdfRequestField = "request" | "path" | "mode" | "pages" | "query" | "limits";

export type PdfRequestError = {
  readonly code: "malformed-request";
  readonly field: PdfRequestField;
};

export type NormalizedPdfReadRequest = {
  readonly path: string;
  readonly mode: PdfSelectionMode;
  readonly pages: readonly PdfPageRange[];
  readonly query: string | null;
  readonly limits: PdfReadLimits;
};

function hasNoControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) {
      return false;
    }
  }
  return true;
}

function requestFieldFromIssue(path: readonly PropertyKey[]): PdfRequestField {
  const field = path[0];
  if (
    field === "path" ||
    field === "mode" ||
    field === "pages" ||
    field === "query" ||
    field === "limits"
  ) {
    return field;
  }
  return "request";
}

function overlaps(left: PdfPageRange, right: PdfPageRange): boolean {
  return left.start <= right.end && right.start <= left.end;
}

export function parsePdfReadRequest(
  value: unknown,
): Result<NormalizedPdfReadRequest, PdfRequestError | PdfLimitError> {
  const parsed = pdfReadRequestSchema.safeParse(value);
  if (!parsed.success) {
    return err({
      code: "malformed-request",
      field: requestFieldFromIssue(parsed.error.issues[0]?.path ?? []),
    });
  }
  const limits = pdfReadLimits(parsed.data.limits);
  if (!limits.ok) {
    return limits;
  }

  const pages = parsed.data.pages ?? [];
  if (pages.some((range) => range.end < range.start)) {
    return err({ code: "malformed-request", field: "pages" });
  }
  for (let index = 1; index < pages.length; index += 1) {
    const previous = pages[index - 1];
    const current = pages[index];
    if (previous !== undefined && current !== undefined && overlaps(previous, current)) {
      return err({ code: "malformed-request", field: "pages" });
    }
  }
  const query = parsed.data.query?.trim() ?? null;
  if (parsed.data.query !== undefined && query === "") {
    return err({ code: "malformed-request", field: "query" });
  }
  if (query !== null && query.length > limits.value.maxQueryLength) {
    return err({ code: "malformed-limits", field: "maxQueryLength" });
  }
  if (parsed.data.mode === "pages" && (pages.length === 0 || query !== null)) {
    return err({ code: "malformed-request", field: pages.length === 0 ? "pages" : "mode" });
  }
  if (parsed.data.mode === "query" && (query === null || parsed.data.pages !== undefined)) {
    return err({ code: "malformed-request", field: query === null ? "query" : "mode" });
  }
  return ok({
    path: parsed.data.path,
    mode: parsed.data.mode,
    pages,
    query,
    limits: limits.value,
  });
}

export type PdfDocument = {
  readonly requested: string;
  readonly bound: BoundWorkspacePath;
  readonly byteLength: number;
  readonly digest: string;
  readonly format: {
    readonly major: number;
    readonly minor: number;
  };
  readonly pageCount: number;
  readonly selectedPages: readonly number[];
  readonly scannedPages: readonly number[];
};

export type PdfCoordinate = {
  readonly pageNumber: number;
  readonly objectNumber: number | null;
  readonly byteOffset: number | null;
};

export type PdfDiagnostic = {
  readonly code: PdfDiagnosticCode;
  readonly coordinate: PdfCoordinate | null;
};

export type PdfTextBlock = {
  readonly kind: "text";
  readonly coordinate: PdfCoordinate;
  readonly text: string;
  readonly truncated: boolean;
};

export type PdfTableBlock = {
  readonly kind: "table";
  readonly coordinate: PdfCoordinate;
  readonly rows: readonly (readonly string[])[];
  readonly truncated: boolean;
};

export type PdfLinkBlock = {
  readonly kind: "link";
  readonly coordinate: PdfCoordinate;
  readonly uri: string;
  readonly rect: readonly number[] | null;
};

export type PdfAnnotationBlock = {
  readonly kind: "annotation";
  readonly coordinate: PdfCoordinate;
  readonly subtype: string;
  readonly contents: string | null;
  readonly rect: readonly number[] | null;
};

export type PdfImageBlock = {
  readonly kind: "embedded-image";
  readonly coordinate: PdfCoordinate;
  readonly mimeType: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly encodedBytes: number;
};

export type PdfBlock =
  | PdfTextBlock
  | PdfTableBlock
  | PdfLinkBlock
  | PdfAnnotationBlock
  | PdfImageBlock;

export type PdfPage = {
  readonly pageNumber: number;
  readonly pageObjectNumber: number | null;
  readonly extractionMethod: PdfExtractionMethod;
  readonly layoutConfidence: PdfLayoutConfidence;
  readonly ocrRequired: boolean;
  readonly blocks: readonly PdfBlock[];
  readonly diagnostics: readonly PdfDiagnostic[];
  readonly truncated: boolean;
};

export type PdfOmission = {
  readonly kind: PdfOmissionKind;
  readonly count: number;
  readonly pages: PdfPageRange | null;
  readonly reason: PdfOmissionReason;
};

export type PdfRead =
  | {
      readonly capability: "read_pdf";
      readonly projection: "pdf";
      readonly complete: false;
      readonly status: "complete" | "partial";
      readonly mode: PdfSelectionMode;
      readonly document: PdfDocument;
      readonly pages: readonly PdfPage[];
      readonly omissions: readonly PdfOmission[];
      readonly recoveryRanges: readonly PdfPageRange[];
      readonly stopReason: PdfStopReason | null;
    }
  | {
      readonly capability: "read_pdf";
      readonly projection: "pdf";
      readonly complete: false;
      readonly status: "empty";
      readonly mode: PdfSelectionMode;
      readonly document: PdfDocument;
      readonly pages: readonly [];
      readonly omissions: readonly PdfOmission[];
      readonly recoveryRanges: readonly PdfPageRange[];
      readonly stopReason: PdfStopReason | null;
      readonly emptyReason: PdfEmptyReason;
    };

export type PdfReadError =
  | WorkspaceReadError
  | PdfRequestError
  | PdfLimitError
  | { readonly code: "not-pdf" }
  | { readonly code: "malformed-header" }
  | { readonly code: "malformed-objects" }
  | { readonly code: "malformed-pages" }
  | { readonly code: "object-limit"; readonly count: number; readonly maximum: number }
  | { readonly code: "encrypted" }
  | { readonly code: "unsupported-version"; readonly major: number; readonly minor: number }
  | { readonly code: "unsupported-filter"; readonly filter: string }
  | {
      readonly code: "decompression-limit";
      readonly objectNumber: number | null;
      readonly compressedBytes: number;
      readonly maximumBytes: number;
    }
  | { readonly code: "cancelled" };

export function describePdfReadError(error: PdfReadError): string {
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
    case "malformed-request":
      return `malformed-request:${error.field}`;
    case "malformed-limits":
      return `malformed-limits:${error.field}`;
    case "not-pdf":
      return "not-pdf";
    case "malformed-header":
      return "malformed-header";
    case "malformed-objects":
      return "malformed-objects";
    case "malformed-pages":
      return "malformed-pages";
    case "object-limit":
      return `object-limit:${error.maximum}`;
    case "encrypted":
      return "encrypted";
    case "unsupported-version":
      return `unsupported-version:${error.major}.${error.minor}`;
    case "unsupported-filter":
      return `unsupported-filter:${error.filter}`;
    case "decompression-limit":
      return `decompression-limit:${error.maximumBytes}`;
    default:
      return assertNever(error, "unhandled PDF read error");
  }
}
