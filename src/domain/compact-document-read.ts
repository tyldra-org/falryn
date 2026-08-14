/**
 * Bounded compact document read contracts (#493).
 *
 * Compact output is a deterministic projection over exact workspace text. It
 * never claims to be the complete document and keeps omitted source ranges
 * available for a later expansion.
 */

import { z } from "zod";

import { MAX_LOCAL_PATH_LENGTH } from "./filesystem.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import type { BoundWorkspacePath } from "./workspace-path.ts";
import type {
  LineRange,
  NewlineStyle,
  NumberedLine,
  WorkspaceReadError,
} from "./workspace-read.ts";

export const COMPACT_DOCUMENT_MODES = ["outline", "ranges", "head-tail", "relevant"] as const;
export type CompactDocumentMode = (typeof COMPACT_DOCUMENT_MODES)[number];

export const COMPACT_DOCUMENT_RANGE_KINDS = ["section", "symbol"] as const;
export type CompactDocumentRangeKind = (typeof COMPACT_DOCUMENT_RANGE_KINDS)[number];

export const COMPACT_DOCUMENT_FAMILIES = [
  "source",
  "markdown",
  "configuration",
  "log",
  "text",
] as const;
export type CompactDocumentFamily = (typeof COMPACT_DOCUMENT_FAMILIES)[number];

export const COMPACT_DOCUMENT_SPAN_KINDS = ["heading", "section", "symbol", "relevant"] as const;
export type CompactDocumentSpanKind = (typeof COMPACT_DOCUMENT_SPAN_KINDS)[number];

export const COMPACT_DOCUMENT_EXTRACTIONS = [
  "outline",
  "explicit-ranges",
  "head-tail",
  "relevant-spans",
] as const;
export type CompactDocumentExtraction = (typeof COMPACT_DOCUMENT_EXTRACTIONS)[number];

export const COMPACT_DOCUMENT_EMPTY_REASONS = [
  "empty-source",
  "no-headings",
  "no-matches",
  "no-range-content",
] as const;
export type CompactDocumentEmptyReason = (typeof COMPACT_DOCUMENT_EMPTY_REASONS)[number];

export const COMPACT_DOCUMENT_OMISSION_KINDS = ["lines", "bytes", "spans"] as const;
export type CompactDocumentOmissionKind = (typeof COMPACT_DOCUMENT_OMISSION_KINDS)[number];

export const COMPACT_DOCUMENT_BUDGETS = [
  "source-bytes",
  "output-bytes",
  "output-lines",
  "spans",
] as const;
export type CompactDocumentBudget = (typeof COMPACT_DOCUMENT_BUDGETS)[number];

export const DEFAULT_MAX_COMPACT_SOURCE_BYTES = 256 * 1024;
export const DEFAULT_MAX_COMPACT_OUTPUT_BYTES = 16 * 1024;
export const DEFAULT_MAX_COMPACT_OUTPUT_LINES = 256;
export const DEFAULT_MAX_COMPACT_SPANS = 32;
export const DEFAULT_MAX_COMPACT_CONTEXT_LINES = 1;
export const DEFAULT_COMPACT_HEAD_LINES = 32;
export const DEFAULT_COMPACT_TAIL_LINES = 32;
export const DEFAULT_MAX_COMPACT_QUERY_LENGTH = 256;

export const MAX_COMPACT_SOURCE_BYTES = 1024 * 1024;
export const MAX_COMPACT_OUTPUT_BYTES = 128 * 1024;
export const MAX_COMPACT_OUTPUT_LINES = 4096;
export const MAX_COMPACT_SPANS = 128;
export const MAX_COMPACT_CONTEXT_LINES = 8;
export const MAX_COMPACT_DOCUMENT_RANGES = 64;
export const MAX_COMPACT_DOCUMENT_LINE = 1_000_000;
export const MAX_COMPACT_QUERY_LENGTH = 1024;
export const MAX_COMPACT_LABEL_LENGTH = 256;

export const COMPACT_DOCUMENT_LIMIT_NAMES = [
  "maxSourceBytes",
  "maxOutputBytes",
  "maxOutputLines",
  "maxSpans",
  "maxContextLines",
] as const;
export type CompactDocumentLimitName = (typeof COMPACT_DOCUMENT_LIMIT_NAMES)[number];

export const DEFAULT_COMPACT_DOCUMENT_LIMITS = {
  maxSourceBytes: DEFAULT_MAX_COMPACT_SOURCE_BYTES,
  maxOutputBytes: DEFAULT_MAX_COMPACT_OUTPUT_BYTES,
  maxOutputLines: DEFAULT_MAX_COMPACT_OUTPUT_LINES,
  maxSpans: DEFAULT_MAX_COMPACT_SPANS,
  maxContextLines: DEFAULT_MAX_COMPACT_CONTEXT_LINES,
} as const;

export type CompactDocumentLimits = {
  readonly maxSourceBytes: number;
  readonly maxOutputBytes: number;
  readonly maxOutputLines: number;
  readonly maxSpans: number;
  readonly maxContextLines: number;
};

export type CompactDocumentLimitError = {
  readonly code: "malformed-limits";
  readonly field: CompactDocumentLimitName;
};

const compactDocumentLimitsSchema = z
  .object({
    maxSourceBytes: z.number().int().positive().max(MAX_COMPACT_SOURCE_BYTES).optional(),
    maxOutputBytes: z.number().int().positive().max(MAX_COMPACT_OUTPUT_BYTES).optional(),
    maxOutputLines: z.number().int().positive().max(MAX_COMPACT_OUTPUT_LINES).optional(),
    maxSpans: z.number().int().positive().max(MAX_COMPACT_SPANS).optional(),
    maxContextLines: z.number().int().nonnegative().max(MAX_COMPACT_CONTEXT_LINES).optional(),
  })
  .strict();

export type CompactDocumentLimitsInput = z.input<typeof compactDocumentLimitsSchema>;

const MAX_COMPACT_LIMITS: CompactDocumentLimits = {
  maxSourceBytes: MAX_COMPACT_SOURCE_BYTES,
  maxOutputBytes: MAX_COMPACT_OUTPUT_BYTES,
  maxOutputLines: MAX_COMPACT_OUTPUT_LINES,
  maxSpans: MAX_COMPACT_SPANS,
  maxContextLines: MAX_COMPACT_CONTEXT_LINES,
};

export function compactDocumentLimits(
  input: CompactDocumentLimitsInput | undefined = undefined,
): Result<CompactDocumentLimits, CompactDocumentLimitError> {
  const parsed = compactDocumentLimitsSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (
      typeof field === "string" &&
      COMPACT_DOCUMENT_LIMIT_NAMES.includes(field as CompactDocumentLimitName)
    ) {
      return err({ code: "malformed-limits", field: field as CompactDocumentLimitName });
    }
    return err({ code: "malformed-limits", field: "maxSourceBytes" });
  }

  const candidate: CompactDocumentLimits = {
    maxSourceBytes: parsed.data.maxSourceBytes ?? DEFAULT_COMPACT_DOCUMENT_LIMITS.maxSourceBytes,
    maxOutputBytes: parsed.data.maxOutputBytes ?? DEFAULT_COMPACT_DOCUMENT_LIMITS.maxOutputBytes,
    maxOutputLines: parsed.data.maxOutputLines ?? DEFAULT_COMPACT_DOCUMENT_LIMITS.maxOutputLines,
    maxSpans: parsed.data.maxSpans ?? DEFAULT_COMPACT_DOCUMENT_LIMITS.maxSpans,
    maxContextLines: parsed.data.maxContextLines ?? DEFAULT_COMPACT_DOCUMENT_LIMITS.maxContextLines,
  };

  for (const field of COMPACT_DOCUMENT_LIMIT_NAMES) {
    const selected = candidate[field];
    const maximum = MAX_COMPACT_LIMITS[field];
    if (selected > maximum) {
      return err({ code: "malformed-limits", field });
    }
  }
  return ok(candidate);
}

export type CompactDocumentRange = {
  readonly start: number;
  readonly end: number;
  readonly kind: CompactDocumentRangeKind;
  readonly label: string | null;
};

const compactDocumentRangeSchema = z
  .object({
    start: z.number().int().positive().max(MAX_COMPACT_DOCUMENT_LINE),
    end: z.number().int().positive().max(MAX_COMPACT_DOCUMENT_LINE),
    kind: z.enum(COMPACT_DOCUMENT_RANGE_KINDS).optional(),
    label: z
      .string()
      .min(1)
      .max(MAX_COMPACT_LABEL_LENGTH)
      .refine((value) => hasNoControlCharacters(value))
      .optional(),
  })
  .strict();

export type CompactDocumentRangeInput = z.input<typeof compactDocumentRangeSchema>;

const compactDocumentReadRequestSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(MAX_LOCAL_PATH_LENGTH)
      .refine((value) => hasNoControlCharacters(value)),
    mode: z.enum(COMPACT_DOCUMENT_MODES),
    ranges: z.array(compactDocumentRangeSchema).max(MAX_COMPACT_DOCUMENT_RANGES).optional(),
    headLines: z.number().int().nonnegative().max(MAX_COMPACT_OUTPUT_LINES).optional(),
    tailLines: z.number().int().nonnegative().max(MAX_COMPACT_OUTPUT_LINES).optional(),
    query: z
      .string()
      .min(1)
      .max(MAX_COMPACT_QUERY_LENGTH)
      .refine((value) => hasNoControlCharacters(value))
      .optional(),
    limits: compactDocumentLimitsSchema.optional(),
  })
  .strict();

export type CompactDocumentReadRequest = z.input<typeof compactDocumentReadRequestSchema>;

export type CompactDocumentRequestField =
  | "request"
  | "path"
  | "mode"
  | "ranges"
  | "headLines"
  | "tailLines"
  | "query"
  | "limits";

export type CompactDocumentRequestError = {
  readonly code: "malformed-request";
  readonly field: CompactDocumentRequestField;
};

export type NormalizedCompactDocumentReadRequest = {
  readonly path: string;
  readonly mode: CompactDocumentMode;
  readonly ranges: readonly CompactDocumentRange[];
  readonly headLines: number;
  readonly tailLines: number;
  readonly query: string | null;
  readonly limits: CompactDocumentLimits;
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

function requestFieldFromIssue(path: readonly PropertyKey[]): CompactDocumentRequestField {
  const field = path[0];
  if (
    field === "path" ||
    field === "mode" ||
    field === "ranges" ||
    field === "headLines" ||
    field === "tailLines" ||
    field === "query" ||
    field === "limits"
  ) {
    return field;
  }
  return "request";
}

export function parseCompactDocumentReadRequest(
  value: unknown,
): Result<
  NormalizedCompactDocumentReadRequest,
  CompactDocumentRequestError | CompactDocumentLimitError
> {
  const parsed = compactDocumentReadRequestSchema.safeParse(value);
  if (!parsed.success) {
    return err({
      code: "malformed-request",
      field: requestFieldFromIssue(parsed.error.issues[0]?.path ?? []),
    });
  }

  const limits = compactDocumentLimits(parsed.data.limits);
  if (!limits.ok) {
    return limits;
  }

  const ranges = (parsed.data.ranges ?? []).map((range) => ({
    start: range.start,
    end: range.end,
    kind: range.kind ?? "section",
    label: range.label ?? null,
  }));
  if (ranges.some((range) => range.end < range.start)) {
    return err({ code: "malformed-request", field: "ranges" });
  }

  const query = parsed.data.query?.trim() ?? null;
  if (parsed.data.query !== undefined && query === "") {
    return err({ code: "malformed-request", field: "query" });
  }
  if (parsed.data.mode === "ranges" && ranges.length === 0) {
    return err({ code: "malformed-request", field: "ranges" });
  }
  if (parsed.data.mode !== "ranges" && parsed.data.ranges !== undefined) {
    return err({ code: "malformed-request", field: "ranges" });
  }
  if (parsed.data.mode === "relevant" && query === null) {
    return err({ code: "malformed-request", field: "query" });
  }
  if (parsed.data.mode !== "relevant" && query !== null) {
    return err({ code: "malformed-request", field: "query" });
  }
  if (
    parsed.data.mode === "head-tail" &&
    (parsed.data.headLines ?? DEFAULT_COMPACT_HEAD_LINES) === 0 &&
    (parsed.data.tailLines ?? DEFAULT_COMPACT_TAIL_LINES) === 0
  ) {
    return err({ code: "malformed-request", field: "mode" });
  }
  if (
    parsed.data.mode !== "head-tail" &&
    (parsed.data.headLines !== undefined || parsed.data.tailLines !== undefined)
  ) {
    return err({ code: "malformed-request", field: "mode" });
  }

  return ok({
    path: parsed.data.path,
    mode: parsed.data.mode,
    ranges,
    headLines: parsed.data.headLines ?? DEFAULT_COMPACT_HEAD_LINES,
    tailLines: parsed.data.tailLines ?? DEFAULT_COMPACT_TAIL_LINES,
    query,
    limits: limits.value,
  });
}

export type CompactDocumentHeading = {
  readonly kind: "heading" | "symbol";
  readonly level: number;
  readonly title: string;
  readonly range: LineRange;
  readonly headingPath: readonly string[];
  readonly symbolPath: readonly string[];
};

type RawHeading = {
  readonly kind: CompactDocumentHeading["kind"];
  readonly level: number;
  readonly title: string;
  readonly range: LineRange;
};

function indentLevel(line: NumberedLine, base = 1): number {
  const prefix = line.text.match(/^\s*/)?.[0] ?? "";
  let columns = 0;
  for (const character of prefix) {
    columns += character === "\t" ? 2 : 1;
  }
  return Math.min(6, base + Math.floor(columns / 2));
}

function hashHeading(line: NumberedLine): RawHeading | null {
  const match = /^( {0,3})(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line.text);
  const markers = match?.[2];
  const body = match?.[3];
  if (markers === undefined || body === undefined || body.trim() === "") {
    return null;
  }
  const title = body
    .trim()
    .replace(/[ \t]+#+[ \t]*$/, "")
    .trim();
  if (title === "") {
    return null;
  }
  return {
    kind: "heading",
    level: markers.length,
    title,
    range: { start: line.number, end: line.number },
  };
}

function markdownHeadings(lines: readonly NumberedLine[]): readonly RawHeading[] {
  const headings: RawHeading[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const atx = hashHeading(line);
    if (atx !== null) {
      headings.push(atx);
      continue;
    }
    const next = lines[index + 1];
    if (line.text.trim() === "" || next === undefined) {
      continue;
    }
    const underline = /^( {0,3})(=+|-+)[ \t]*$/.exec(next.text);
    if (underline !== null) {
      headings.push({
        kind: "heading",
        level: underline[2]?.startsWith("=") === true ? 1 : 2,
        title: line.text.trim(),
        range: { start: line.number, end: line.number },
      });
    }
  }
  return headings;
}

function sourceHeadings(lines: readonly NumberedLine[]): readonly RawHeading[] {
  const headings: RawHeading[] = [];
  for (const line of lines) {
    const declaration =
      /^\s*(?:(?:export|default|public|private|protected|static|abstract|async|declare|readonly)\s+)*(class|interface|type|enum|namespace|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(
        line.text,
      );
    const pythonDeclaration = /^\s*(?:(?:async)\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
      line.text,
    );
    const goDeclaration = /^\s*func(?:\s+\([^)]*\))?\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line.text);
    const variable =
      /^\s*(?:(?:export|default)\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/.exec(
        line.text,
      );
    const title = declaration?.[2] ?? pythonDeclaration?.[1] ?? goDeclaration?.[1] ?? variable?.[1];
    if (title === undefined) {
      continue;
    }
    headings.push({
      kind: "symbol",
      level: indentLevel(line),
      title,
      range: { start: line.number, end: line.number },
    });
  }
  return headings;
}

function configurationHeadings(lines: readonly NumberedLine[]): readonly RawHeading[] {
  const headings: RawHeading[] = [];
  for (const line of lines) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line.text);
    const key = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*$/.exec(line.text);
    const title = section?.[1]?.trim() || key?.[1]?.trim();
    if (title === undefined || title === "") {
      continue;
    }
    headings.push({
      kind: "heading",
      level: section === null ? indentLevel(line) : Math.min(6, title.split(".").length),
      title,
      range: { start: line.number, end: line.number },
    });
  }
  return headings;
}

function logHeadings(lines: readonly NumberedLine[]): readonly RawHeading[] {
  const headings: RawHeading[] = [];
  for (const line of lines) {
    const hash = hashHeading(line);
    const decorated = /^\s*={3,}\s*(.+?)\s*={3,}\s*$/.exec(line.text);
    const named = /^\s*\[(?:section|phase|group)\s*:\s*(.+)\]\s*$/i.exec(line.text);
    const title = hash?.title ?? decorated?.[1]?.trim() ?? named?.[1]?.trim();
    if (title === undefined || title === "") {
      continue;
    }
    headings.push(
      hash ?? {
        kind: "heading",
        level: 1,
        title,
        range: { start: line.number, end: line.number },
      },
    );
  }
  return headings;
}

function genericHeadings(lines: readonly NumberedLine[]): readonly RawHeading[] {
  return lines.flatMap((line) => {
    const heading = hashHeading(line);
    return heading === null ? [] : [heading];
  });
}

function headingCandidates(
  lines: readonly NumberedLine[],
  family: CompactDocumentFamily,
): readonly RawHeading[] {
  switch (family) {
    case "source":
      return sourceHeadings(lines);
    case "markdown":
      return markdownHeadings(lines);
    case "configuration":
      return configurationHeadings(lines);
    case "log":
      return logHeadings(lines);
    case "text":
      return genericHeadings(lines);
    default:
      return assertNever(family, "unhandled compact document family");
  }
}

export function extractCompactDocumentHeadings(
  lines: readonly NumberedLine[],
  family: CompactDocumentFamily,
): readonly CompactDocumentHeading[] {
  const stack: RawHeading[] = [];
  return headingCandidates(lines, family).map((heading) => {
    while (stack.at(-1)?.level !== undefined && (stack.at(-1)?.level ?? 0) >= heading.level) {
      stack.pop();
    }
    stack.push(heading);
    return {
      ...heading,
      headingPath: stack.map((item) => item.title),
      symbolPath: stack.filter((item) => item.kind === "symbol").map((item) => item.title),
    };
  });
}

export function compactDocumentFamily(path: string): CompactDocumentFamily {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (["md", "markdown", "mdx"].includes(extension)) {
    return "markdown";
  }
  if (
    ["json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env"].includes(
      extension,
    )
  ) {
    return "configuration";
  }
  if (["log", "out", "err", "trace"].includes(extension)) {
    return "log";
  }
  if (
    [
      "c",
      "cc",
      "cpp",
      "cxx",
      "go",
      "java",
      "js",
      "jsx",
      "mjs",
      "cjs",
      "py",
      "rb",
      "swift",
      "ts",
      "tsx",
    ].includes(extension)
  ) {
    return "source";
  }
  return "text";
}

export type CompactDocumentDocument = {
  readonly requested: string;
  readonly bound: BoundWorkspacePath;
  readonly family: CompactDocumentFamily;
  readonly byteLength: number;
  readonly newline: NewlineStyle;
};

export type CompactDocumentSpan = {
  readonly kind: CompactDocumentSpanKind;
  readonly label: string | null;
  readonly sourceRange: LineRange;
  readonly text: string;
  readonly headingPath: readonly string[];
  readonly symbolPath: readonly string[];
  readonly truncated: boolean;
};

export type CompactDocumentOmission = {
  readonly kind: CompactDocumentOmissionKind;
  readonly count: number;
  readonly range: LineRange | null;
};

export type CompactDocumentRead =
  | {
      readonly capability: "read_compact";
      readonly status: "complete" | "partial";
      readonly projection: "compact";
      readonly complete: false;
      readonly mode: CompactDocumentMode;
      readonly extraction: CompactDocumentExtraction;
      readonly document: CompactDocumentDocument;
      readonly spans: readonly CompactDocumentSpan[];
      readonly omissions: readonly CompactDocumentOmission[];
      readonly recoveryRanges: readonly LineRange[];
    }
  | {
      readonly capability: "read_compact";
      readonly status: "empty";
      readonly projection: "compact";
      readonly complete: false;
      readonly mode: CompactDocumentMode;
      readonly extraction: CompactDocumentExtraction;
      readonly document: CompactDocumentDocument;
      readonly spans: readonly [];
      readonly omissions: readonly CompactDocumentOmission[];
      readonly recoveryRanges: readonly LineRange[];
      readonly emptyReason: CompactDocumentEmptyReason;
    };

export type CompactDocumentReadError =
  | WorkspaceReadError
  | CompactDocumentRequestError
  | CompactDocumentLimitError
  | { readonly code: "budget-exhausted"; readonly budget: CompactDocumentBudget };

export function describeCompactDocumentReadError(error: CompactDocumentReadError): string {
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
    case "malformed-request":
      return `malformed-request:${error.field}`;
    case "malformed-limits":
      return `malformed-limits:${error.field}`;
    case "budget-exhausted":
      return `budget-exhausted:${error.budget}`;
    default:
      return assertNever(error, "unhandled compact document read error");
  }
}
