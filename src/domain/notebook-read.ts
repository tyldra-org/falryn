/**
 * Bounded notebook read contracts (#494).
 *
 * Notebook output is a typed, non-executing projection over exact workspace
 * JSON. It preserves cell coordinates and provenance while making reductions,
 * malformed shapes, and unsafe or unknown content visible.
 */

import { z } from "zod";

import { MAX_LOCAL_PATH_LENGTH } from "./filesystem.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import type { BoundWorkspacePath } from "./workspace-path.ts";
import type { NewlineStyle, WorkspaceReadError } from "./workspace-read.ts";

export const NOTEBOOK_SELECTION_MODES = ["all", "indices", "ids", "range"] as const;
export type NotebookSelectionMode = (typeof NOTEBOOK_SELECTION_MODES)[number];

export const NOTEBOOK_CELL_TYPES = ["code", "markdown", "raw", "unknown"] as const;
export type NotebookCellType = (typeof NOTEBOOK_CELL_TYPES)[number];

export const NOTEBOOK_OUTPUT_KINDS = [
  "stream",
  "execute-result",
  "display-data",
  "error",
  "unknown",
] as const;
export type NotebookOutputKind = (typeof NOTEBOOK_OUTPUT_KINDS)[number];

export const NOTEBOOK_PREVIEW_KINDS = ["text", "json", "binary"] as const;
export type NotebookPreviewKind = (typeof NOTEBOOK_PREVIEW_KINDS)[number];

export const NOTEBOOK_DIAGNOSTIC_CODES = [
  "malformed-cell",
  "missing-id",
  "malformed-source",
  "unsupported-cell-type",
  "malformed-execution-count",
  "malformed-output",
  "unknown-output-type",
  "display-bundle",
  "widget",
  "unknown-mime-type",
  "huge-output",
  "malformed-attachment",
  "huge-attachment",
] as const;
export type NotebookDiagnosticCode = (typeof NOTEBOOK_DIAGNOSTIC_CODES)[number];

export const NOTEBOOK_OMISSION_KINDS = [
  "cells",
  "outputs",
  "attachments",
  "bytes",
  "metadata",
  "selection",
] as const;
export type NotebookOmissionKind = (typeof NOTEBOOK_OMISSION_KINDS)[number];

export const NOTEBOOK_OMISSION_REASONS = [
  "budget",
  "unselected",
  "not-found",
  "malformed",
] as const;
export type NotebookOmissionReason = (typeof NOTEBOOK_OMISSION_REASONS)[number];

export const NOTEBOOK_EMPTY_REASONS = [
  "empty-notebook",
  "no-selected-cells",
  "no-matching-ids",
] as const;
export type NotebookEmptyReason = (typeof NOTEBOOK_EMPTY_REASONS)[number];

export const NOTEBOOK_STOP_REASONS = ["cancelled", "budget"] as const;
export type NotebookStopReason = (typeof NOTEBOOK_STOP_REASONS)[number];

export const NOTEBOOK_LIMIT_NAMES = [
  "maxSourceBytes",
  "maxCells",
  "maxOutputs",
  "maxAttachments",
  "maxOutputBytes",
  "maxMetadataBytes",
  "maxCellSourceBytes",
  "maxMimeTypes",
] as const;
export type NotebookLimitName = (typeof NOTEBOOK_LIMIT_NAMES)[number];

export const DEFAULT_MAX_NOTEBOOK_SOURCE_BYTES = 256 * 1024;
export const DEFAULT_MAX_NOTEBOOK_CELLS = 32;
export const DEFAULT_MAX_NOTEBOOK_OUTPUTS = 32;
export const DEFAULT_MAX_NOTEBOOK_ATTACHMENTS = 16;
export const DEFAULT_MAX_NOTEBOOK_OUTPUT_BYTES = 16 * 1024;
export const DEFAULT_MAX_NOTEBOOK_METADATA_BYTES = 8 * 1024;
export const DEFAULT_MAX_NOTEBOOK_CELL_SOURCE_BYTES = 32 * 1024;
export const DEFAULT_MAX_NOTEBOOK_MIME_TYPES = 8;

export const MAX_NOTEBOOK_SOURCE_BYTES = 1024 * 1024;
export const MAX_NOTEBOOK_CELLS = 128;
export const MAX_NOTEBOOK_OUTPUTS = 256;
export const MAX_NOTEBOOK_ATTACHMENTS = 128;
export const MAX_NOTEBOOK_OUTPUT_BYTES = 128 * 1024;
export const MAX_NOTEBOOK_METADATA_BYTES = 64 * 1024;
export const MAX_NOTEBOOK_CELL_SOURCE_BYTES = 128 * 1024;
export const MAX_NOTEBOOK_MIME_TYPES = 32;
export const MAX_NOTEBOOK_CELL_INDEX = 1_000_000;
export const MAX_NOTEBOOK_ID_LENGTH = 256;
export const MAX_NOTEBOOK_ATTACHMENT_NAME_LENGTH = 256;

export const DEFAULT_NOTEBOOK_READ_LIMITS = {
  maxSourceBytes: DEFAULT_MAX_NOTEBOOK_SOURCE_BYTES,
  maxCells: DEFAULT_MAX_NOTEBOOK_CELLS,
  maxOutputs: DEFAULT_MAX_NOTEBOOK_OUTPUTS,
  maxAttachments: DEFAULT_MAX_NOTEBOOK_ATTACHMENTS,
  maxOutputBytes: DEFAULT_MAX_NOTEBOOK_OUTPUT_BYTES,
  maxMetadataBytes: DEFAULT_MAX_NOTEBOOK_METADATA_BYTES,
  maxCellSourceBytes: DEFAULT_MAX_NOTEBOOK_CELL_SOURCE_BYTES,
  maxMimeTypes: DEFAULT_MAX_NOTEBOOK_MIME_TYPES,
} as const;

export type NotebookReadLimits = {
  readonly maxSourceBytes: number;
  readonly maxCells: number;
  readonly maxOutputs: number;
  readonly maxAttachments: number;
  readonly maxOutputBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxCellSourceBytes: number;
  readonly maxMimeTypes: number;
};

const notebookLimitsSchema = z
  .object({
    maxSourceBytes: z.number().int().positive().max(MAX_NOTEBOOK_SOURCE_BYTES).optional(),
    maxCells: z.number().int().positive().max(MAX_NOTEBOOK_CELLS).optional(),
    maxOutputs: z.number().int().positive().max(MAX_NOTEBOOK_OUTPUTS).optional(),
    maxAttachments: z.number().int().positive().max(MAX_NOTEBOOK_ATTACHMENTS).optional(),
    maxOutputBytes: z.number().int().positive().max(MAX_NOTEBOOK_OUTPUT_BYTES).optional(),
    maxMetadataBytes: z.number().int().positive().max(MAX_NOTEBOOK_METADATA_BYTES).optional(),
    maxCellSourceBytes: z.number().int().positive().max(MAX_NOTEBOOK_CELL_SOURCE_BYTES).optional(),
    maxMimeTypes: z.number().int().positive().max(MAX_NOTEBOOK_MIME_TYPES).optional(),
  })
  .strict();

export type NotebookReadLimitsInput = z.input<typeof notebookLimitsSchema>;

const MAX_NOTEBOOK_LIMITS: NotebookReadLimits = {
  maxSourceBytes: MAX_NOTEBOOK_SOURCE_BYTES,
  maxCells: MAX_NOTEBOOK_CELLS,
  maxOutputs: MAX_NOTEBOOK_OUTPUTS,
  maxAttachments: MAX_NOTEBOOK_ATTACHMENTS,
  maxOutputBytes: MAX_NOTEBOOK_OUTPUT_BYTES,
  maxMetadataBytes: MAX_NOTEBOOK_METADATA_BYTES,
  maxCellSourceBytes: MAX_NOTEBOOK_CELL_SOURCE_BYTES,
  maxMimeTypes: MAX_NOTEBOOK_MIME_TYPES,
};

export type NotebookLimitError = {
  readonly code: "malformed-limits";
  readonly field: NotebookLimitName;
};

export function notebookReadLimits(
  input: NotebookReadLimitsInput | undefined = undefined,
): Result<NotebookReadLimits, NotebookLimitError> {
  const parsed = notebookLimitsSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (typeof field === "string" && NOTEBOOK_LIMIT_NAMES.includes(field as NotebookLimitName)) {
      return err({ code: "malformed-limits", field: field as NotebookLimitName });
    }
    return err({ code: "malformed-limits", field: "maxSourceBytes" });
  }

  const limits: NotebookReadLimits = {
    maxSourceBytes: parsed.data.maxSourceBytes ?? DEFAULT_NOTEBOOK_READ_LIMITS.maxSourceBytes,
    maxCells: parsed.data.maxCells ?? DEFAULT_NOTEBOOK_READ_LIMITS.maxCells,
    maxOutputs: parsed.data.maxOutputs ?? DEFAULT_NOTEBOOK_READ_LIMITS.maxOutputs,
    maxAttachments: parsed.data.maxAttachments ?? DEFAULT_NOTEBOOK_READ_LIMITS.maxAttachments,
    maxOutputBytes: parsed.data.maxOutputBytes ?? DEFAULT_NOTEBOOK_READ_LIMITS.maxOutputBytes,
    maxMetadataBytes: parsed.data.maxMetadataBytes ?? DEFAULT_NOTEBOOK_READ_LIMITS.maxMetadataBytes,
    maxCellSourceBytes:
      parsed.data.maxCellSourceBytes ?? DEFAULT_NOTEBOOK_READ_LIMITS.maxCellSourceBytes,
    maxMimeTypes: parsed.data.maxMimeTypes ?? DEFAULT_NOTEBOOK_READ_LIMITS.maxMimeTypes,
  };
  for (const field of NOTEBOOK_LIMIT_NAMES) {
    if (limits[field] > MAX_NOTEBOOK_LIMITS[field]) {
      return err({ code: "malformed-limits", field });
    }
  }
  return ok(limits);
}

export type NotebookCellRange = {
  readonly start: number;
  readonly end: number;
};

const notebookCellRangeSchema = z
  .object({
    start: z.number().int().nonnegative().max(MAX_NOTEBOOK_CELL_INDEX),
    end: z.number().int().nonnegative().max(MAX_NOTEBOOK_CELL_INDEX),
  })
  .strict();

export type NotebookCellRangeInput = z.input<typeof notebookCellRangeSchema>;

const notebookReadRequestSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(MAX_LOCAL_PATH_LENGTH)
      .refine((value) => hasNoControlCharacters(value)),
    mode: z.enum(NOTEBOOK_SELECTION_MODES),
    indices: z
      .array(z.number().int().nonnegative().max(MAX_NOTEBOOK_CELL_INDEX))
      .max(MAX_NOTEBOOK_CELLS)
      .optional(),
    ids: z
      .array(
        z
          .string()
          .min(1)
          .max(MAX_NOTEBOOK_ID_LENGTH)
          .refine((value) => hasNoControlCharacters(value)),
      )
      .max(MAX_NOTEBOOK_CELLS)
      .optional(),
    range: notebookCellRangeSchema.optional(),
    limits: notebookLimitsSchema.optional(),
  })
  .strict();

export type NotebookReadRequest = z.input<typeof notebookReadRequestSchema>;

export type NotebookRequestField =
  | "request"
  | "path"
  | "mode"
  | "indices"
  | "ids"
  | "range"
  | "limits";

export type NotebookRequestError = {
  readonly code: "malformed-request";
  readonly field: NotebookRequestField;
};

export type NormalizedNotebookReadRequest = {
  readonly path: string;
  readonly mode: NotebookSelectionMode;
  readonly indices: readonly number[];
  readonly ids: readonly string[];
  readonly range: NotebookCellRange | null;
  readonly limits: NotebookReadLimits;
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

function hasDuplicates(values: readonly (number | string)[]): boolean {
  return new Set(values).size !== values.length;
}

function requestFieldFromIssue(path: readonly PropertyKey[]): NotebookRequestField {
  const field = path[0];
  if (
    field === "path" ||
    field === "mode" ||
    field === "indices" ||
    field === "ids" ||
    field === "range" ||
    field === "limits"
  ) {
    return field;
  }
  return "request";
}

export function parseNotebookReadRequest(
  value: unknown,
): Result<NormalizedNotebookReadRequest, NotebookRequestError | NotebookLimitError> {
  const parsed = notebookReadRequestSchema.safeParse(value);
  if (!parsed.success) {
    return err({
      code: "malformed-request",
      field: requestFieldFromIssue(parsed.error.issues[0]?.path ?? []),
    });
  }

  const limits = notebookReadLimits(parsed.data.limits);
  if (!limits.ok) {
    return limits;
  }

  const indices = parsed.data.indices ?? [];
  const ids = parsed.data.ids ?? [];
  const range = parsed.data.range ?? null;
  if (range !== null && range.end < range.start) {
    return err({ code: "malformed-request", field: "range" });
  }
  if (hasDuplicates(indices)) {
    return err({ code: "malformed-request", field: "indices" });
  }
  if (hasDuplicates(ids)) {
    return err({ code: "malformed-request", field: "ids" });
  }

  if (parsed.data.mode === "all") {
    if (parsed.data.indices !== undefined || parsed.data.ids !== undefined || range !== null) {
      return err({ code: "malformed-request", field: "mode" });
    }
  }
  if (parsed.data.mode === "indices") {
    if (indices.length === 0 || parsed.data.ids !== undefined || range !== null) {
      return err({ code: "malformed-request", field: "indices" });
    }
  }
  if (parsed.data.mode === "ids") {
    if (ids.length === 0 || parsed.data.indices !== undefined || range !== null) {
      return err({ code: "malformed-request", field: "ids" });
    }
  }
  if (parsed.data.mode === "range") {
    if (range === null || parsed.data.indices !== undefined || parsed.data.ids !== undefined) {
      return err({ code: "malformed-request", field: "range" });
    }
  }

  return ok({
    path: parsed.data.path,
    mode: parsed.data.mode,
    indices,
    ids,
    range,
    limits: limits.value,
  });
}

export type NotebookJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly NotebookJsonValue[]
  | { readonly [key: string]: NotebookJsonValue };

export type NotebookMetadata = {
  readonly value: NotebookJsonValue | null;
  readonly preview: string;
  readonly truncated: boolean;
};

export type NotebookDocument = {
  readonly requested: string;
  readonly bound: BoundWorkspacePath;
  readonly format: {
    readonly major: number;
    readonly minor: number;
  };
  readonly byteLength: number;
  readonly newline: NewlineStyle;
  readonly metadata: NotebookMetadata;
};

export type NotebookCellCoordinate = {
  readonly cellIndex: number;
  readonly cellId: string | null;
};

export type NotebookOutputCoordinate = NotebookCellCoordinate & {
  readonly outputIndex: number;
};

export type NotebookMimeCoordinate = NotebookOutputCoordinate & {
  readonly mimeType: string;
};

export type NotebookAttachmentCoordinate = NotebookCellCoordinate & {
  readonly attachmentName: string;
};

export type NotebookDiagnosticCoordinate = {
  readonly cellIndex: number;
  readonly cellId: string | null;
  readonly outputIndex: number | null;
  readonly attachmentName: string | null;
  readonly mimeType: string | null;
};

export type NotebookDiagnostic = {
  readonly code: NotebookDiagnosticCode;
  readonly coordinate: NotebookDiagnosticCoordinate;
};

export type NotebookOutputPart = {
  readonly coordinate: NotebookMimeCoordinate;
  readonly preview: string;
  readonly previewKind: NotebookPreviewKind;
  readonly truncated: boolean;
};

export type NotebookOutput = {
  readonly coordinate: NotebookOutputCoordinate;
  readonly kind: NotebookOutputKind;
  readonly executionCount: number | null;
  readonly freshness: "stored";
  readonly parts: readonly NotebookOutputPart[];
  readonly truncated: boolean;
  readonly diagnostics: readonly NotebookDiagnostic[];
};

export type NotebookAttachment = {
  readonly coordinate: NotebookAttachmentCoordinate;
  readonly mimeType: string;
  readonly preview: string;
  readonly previewKind: NotebookPreviewKind;
  readonly truncated: boolean;
  readonly diagnostics: readonly NotebookDiagnostic[];
};

export type NotebookCell = {
  readonly coordinate: NotebookCellCoordinate;
  readonly type: NotebookCellType;
  readonly stableId: boolean;
  readonly source: string;
  readonly sourceTruncated: boolean;
  readonly executionCount: number | null;
  readonly outputs: readonly NotebookOutput[];
  readonly attachments: readonly NotebookAttachment[];
  readonly diagnostics: readonly NotebookDiagnostic[];
};

export type NotebookOmission = {
  readonly kind: NotebookOmissionKind;
  readonly count: number;
  readonly range: NotebookCellRange | null;
  readonly reason: NotebookOmissionReason;
};

export type NotebookRead =
  | {
      readonly capability: "read_notebook";
      readonly projection: "notebook";
      readonly complete: false;
      readonly status: "complete" | "partial";
      readonly mode: NotebookSelectionMode;
      readonly document: NotebookDocument;
      readonly cells: readonly NotebookCell[];
      readonly omissions: readonly NotebookOmission[];
      readonly recoveryRanges: readonly NotebookCellRange[];
      readonly stopReason: NotebookStopReason | null;
    }
  | {
      readonly capability: "read_notebook";
      readonly projection: "notebook";
      readonly complete: false;
      readonly status: "empty";
      readonly mode: NotebookSelectionMode;
      readonly document: NotebookDocument;
      readonly cells: readonly [];
      readonly omissions: readonly NotebookOmission[];
      readonly recoveryRanges: readonly NotebookCellRange[];
      readonly stopReason: NotebookStopReason | null;
      readonly emptyReason: NotebookEmptyReason;
    };

export type NotebookReadError =
  | WorkspaceReadError
  | NotebookRequestError
  | NotebookLimitError
  | { readonly code: "not-notebook" }
  | { readonly code: "malformed-json" }
  | {
      readonly code: "malformed-notebook";
      readonly field: "nbformat" | "nbformat_minor" | "metadata" | "cells";
    }
  | { readonly code: "unsupported-version"; readonly major: number; readonly minor: number };

export function describeNotebookReadError(error: NotebookReadError): string {
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
    case "not-notebook":
      return "not-notebook";
    case "malformed-json":
      return "malformed-json";
    case "malformed-notebook":
      return `malformed-notebook:${error.field}`;
    case "unsupported-version":
      return `unsupported-version:${error.major}.${error.minor}`;
    default:
      return assertNever(error, "unhandled notebook read error");
  }
}
