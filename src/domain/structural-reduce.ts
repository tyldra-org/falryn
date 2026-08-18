/**
 * Structural lossless reducers for files, diffs, diagnostics, and tools (#105).
 *
 * Projects JSON, configuration, unified diffs, diagnostic lists, and tool
 * results into a bounded view that keeps meaning and source ranges. Reductions
 * never claim exact-source. If the projection is not smaller than the original
 * bytes, the original is passed through. Compact-model summaries and product
 * tools remain later.
 */

import { z } from "zod";

import { ARTIFACT_SENSITIVITIES, type ContentDigest } from "./artifact.ts";
import type { ContentHasherPort } from "./blob.ts";
import {
  type EvidenceFidelity,
  type ExactSourceHandle,
  MAX_EVIDENCE_INLINE_BYTES,
} from "./context-evidence.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const STRUCTURAL_REDUCER_VERSION = "structural.v1";
export const DEFAULT_STRUCTURAL_MAX_BYTES = 8 * 1_024;
export const HARD_STRUCTURAL_MAX_BYTES = MAX_EVIDENCE_INLINE_BYTES;
export const DEFAULT_STRUCTURAL_MAX_KEYS = 32;
export const HARD_STRUCTURAL_MAX_KEYS = 128;
export const DEFAULT_STRUCTURAL_MAX_DEPTH = 4;
export const DEFAULT_STRUCTURAL_MAX_ARRAY = 16;
export const DEFAULT_STRUCTURAL_MAX_HUNKS = 8;
export const DEFAULT_STRUCTURAL_MAX_FILES = 16;
export const DEFAULT_STRUCTURAL_MAX_DIAGNOSTICS = 32;
export const HARD_STRUCTURAL_MAX_DIAGNOSTICS = 128;
export const DEFAULT_STRUCTURAL_MAX_ROWS = 16;

export const STRUCTURAL_FAMILIES = ["file", "diff", "diagnostic", "tool"] as const;
export type StructuralFamily = (typeof STRUCTURAL_FAMILIES)[number];

export const STRUCTURAL_FIDELITIES = ["passthrough", "structural", "raw-fallback"] as const;
export type StructuralFidelity = (typeof STRUCTURAL_FIDELITIES)[number];

export type StructuralErrorCode =
  | "malformed"
  | "unsupported"
  | "oversized"
  | "unavailable"
  | "secret"
  | "empty";

export type StructuralError = {
  readonly kind: "structural";
  readonly code: StructuralErrorCode;
  readonly field: string | null;
};

export type StructuralOmissionKind =
  | "keys"
  | "items"
  | "hunks"
  | "files"
  | "diagnostics"
  | "rows"
  | "depth";

export type StructuralOmission = {
  readonly kind: StructuralOmissionKind;
  readonly count: number;
  readonly path: string | null;
};

export type StructuralRange = {
  readonly path: string;
  readonly start: number;
  readonly end: number;
};

export type StructuralReduceInput = {
  readonly family: unknown;
  readonly text?: unknown;
  readonly sensitivity?: unknown;
  readonly maxBytes?: unknown;
  readonly keys?: unknown;
  readonly diagnostics?: unknown;
  readonly cancelled?: unknown;
};

export type StructuralReduceResult = {
  readonly family: StructuralFamily;
  readonly reducerVersion: typeof STRUCTURAL_REDUCER_VERSION;
  readonly fidelity: StructuralFidelity;
  readonly evidenceFidelity: EvidenceFidelity;
  readonly claimsExact: boolean;
  readonly complete: boolean;
  readonly text: string;
  readonly sourceBytes: number;
  readonly reducedBytes: number;
  readonly omissions: readonly StructuralOmission[];
  readonly ranges: readonly StructuralRange[];
  readonly expansion: ExactSourceHandle | null;
};

const encoder = new TextEncoder();

const diagnosticItemSchema = z.object({
  path: z.string().min(1).max(512).optional(),
  severity: z.union([z.string(), z.number()]).optional(),
  message: z.string().min(1).max(4_096),
  line: z.int().min(0).max(1_000_000).optional(),
  code: z.union([z.string(), z.number()]).optional(),
});

function parseFamily(value: unknown): Result<StructuralFamily, StructuralError> {
  for (const family of STRUCTURAL_FAMILIES) {
    if (value === family) {
      return ok(family);
    }
  }
  return err(structuralError("malformed", "family"));
}

function structuralError(code: StructuralErrorCode, field: string | null): StructuralError {
  return { kind: "structural", code, field };
}

export function describeStructuralError(error: StructuralError): string {
  const field = error.field === null ? "structural" : error.field;
  switch (error.code) {
    case "malformed":
      return `malformed ${field}`;
    case "unsupported":
      return `unsupported ${field}`;
    case "oversized":
      return `oversized ${field}`;
    case "unavailable":
      return `unavailable ${field}`;
    case "secret":
      return `secret ${field}`;
    case "empty":
      return `empty ${field}`;
    default:
      return assertNever(error.code, "unhandled structural error");
  }
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function parseBound(
  value: unknown,
  field: string,
  fallback: number,
  maximum: number,
  minimum = 1,
): Result<number, StructuralError> {
  if (value === undefined) {
    return ok(fallback);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    return err(structuralError("malformed", field));
  }
  if (value > maximum) {
    return err(structuralError("oversized", field));
  }
  return ok(value);
}

function hashBytes(hasher: ContentHasherPort, bytes: Uint8Array): ContentDigest {
  const hash = hasher.create();
  hash.update(bytes);
  return hash.digest();
}

function passthrough(
  family: StructuralFamily,
  original: string,
  hasher: ContentHasherPort,
): StructuralReduceResult {
  const bytes = encoder.encode(original);
  return {
    family,
    reducerVersion: STRUCTURAL_REDUCER_VERSION,
    fidelity: "passthrough",
    evidenceFidelity: "exact-source",
    claimsExact: true,
    complete: true,
    text: original,
    sourceBytes: bytes.byteLength,
    reducedBytes: bytes.byteLength,
    omissions: [],
    ranges: [],
    expansion: { kind: "inline", digest: hashBytes(hasher, bytes), byteLength: bytes.byteLength },
  };
}

function finish(
  family: StructuralFamily,
  original: string,
  projected: string,
  omissions: readonly StructuralOmission[],
  ranges: readonly StructuralRange[],
  hasher: ContentHasherPort,
): StructuralReduceResult {
  const sourceBytes = byteLength(original);
  const reducedBytes = byteLength(projected);
  if (reducedBytes >= sourceBytes || projected === original) {
    return passthrough(family, original, hasher);
  }
  const bytes = encoder.encode(original);
  return {
    family,
    reducerVersion: STRUCTURAL_REDUCER_VERSION,
    fidelity: "structural",
    evidenceFidelity: "deterministic-transform",
    claimsExact: false,
    complete: omissions.length === 0,
    text: projected,
    sourceBytes,
    reducedBytes,
    omissions,
    ranges,
    expansion: { kind: "inline", digest: hashBytes(hasher, bytes), byteLength: bytes.byteLength },
  };
}

type JsonWalk = {
  value: unknown;
  omissions: StructuralOmission[];
  ranges: StructuralRange[];
};

function walkJson(
  value: unknown,
  path: string,
  depth: number,
  maxDepth: number,
  maxKeys: number,
  maxArray: number,
  keyFilter: ReadonlySet<string> | null,
): JsonWalk {
  if (depth > maxDepth) {
    return {
      value: null,
      omissions: [{ kind: "depth", count: 1, path }],
      ranges: [{ path, start: 0, end: 0 }],
    };
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, maxArray);
    const omitted = value.length - kept.length;
    const children = kept.map((item, index) =>
      walkJson(item, `${path}[${index}]`, depth + 1, maxDepth, maxKeys, maxArray, null),
    );
    const omissions = children.flatMap((child) => [...child.omissions]);
    const ranges = children.flatMap((child) => [...child.ranges]);
    if (omitted > 0) {
      omissions.push({ kind: "items", count: omitted, path });
      ranges.push({ path, start: maxArray, end: value.length });
    }
    return { value: children.map((child) => child.value), omissions, ranges };
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const selected =
      keyFilter === null ? entries : entries.filter(([key]) => keyFilter.has(key) || path !== "$");
    const capped = selected.slice(0, maxKeys);
    const omitted = (keyFilter === null ? entries.length : selected.length) - capped.length;
    const droppedByFilter =
      keyFilter === null
        ? 0
        : entries.filter(([key]) => path === "$" && !keyFilter.has(key)).length;
    const object: Record<string, unknown> = {};
    const omissions: StructuralOmission[] = [];
    const ranges: StructuralRange[] = [];
    for (const [key, child] of capped) {
      const walked = walkJson(
        child,
        `${path}.${key}`,
        depth + 1,
        maxDepth,
        maxKeys,
        maxArray,
        null,
      );
      object[key] = walked.value;
      omissions.push(...walked.omissions);
      ranges.push(...walked.ranges);
    }
    if (omitted > 0) {
      omissions.push({ kind: "keys", count: omitted, path });
      ranges.push({ path, start: capped.length, end: capped.length + omitted });
    }
    if (droppedByFilter > 0) {
      omissions.push({ kind: "keys", count: droppedByFilter, path: "$" });
    }
    return { value: object, omissions, ranges };
  }
  return { value, omissions: [], ranges: [] };
}

function reduceJsonFile(
  original: string,
  maxBytes: number,
  keys: readonly string[] | null,
): Result<
  { text: string; omissions: StructuralOmission[]; ranges: StructuralRange[] },
  StructuralError
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(original) as unknown;
  } catch {
    return err(structuralError("malformed", "text"));
  }
  const keyFilter = keys === null ? null : new Set(keys);
  const walked = walkJson(
    parsed,
    "$",
    0,
    DEFAULT_STRUCTURAL_MAX_DEPTH,
    DEFAULT_STRUCTURAL_MAX_KEYS,
    DEFAULT_STRUCTURAL_MAX_ARRAY,
    keyFilter,
  );
  const text = JSON.stringify(walked.value);
  if (byteLength(text) > maxBytes) {
    return err(structuralError("oversized", "projection"));
  }
  return ok({ text, omissions: walked.omissions, ranges: walked.ranges });
}

function reduceTableOrConfig(
  original: string,
  maxBytes: number,
): { text: string; omissions: StructuralOmission[]; ranges: StructuralRange[] } {
  const lines = original.split(/\r?\n/);
  const isTable = lines[0]?.includes(",") === true || lines[0]?.includes("\t") === true;
  if (isTable) {
    const header = lines[0] ?? "";
    const rows = lines.slice(1).filter((line) => line.length > 0);
    const kept = rows.slice(0, DEFAULT_STRUCTURAL_MAX_ROWS);
    const omitted = rows.length - kept.length;
    const text = [header, ...kept].join("\n");
    const omissions: StructuralOmission[] =
      omitted > 0 ? [{ kind: "rows", count: omitted, path: null }] : [];
    const ranges: StructuralRange[] =
      omitted > 0 ? [{ path: "rows", start: DEFAULT_STRUCTURAL_MAX_ROWS, end: rows.length }] : [];
    if (byteLength(text) > maxBytes) {
      return {
        text: text.slice(0, maxBytes),
        omissions: [...omissions, { kind: "rows", count: 1, path: "bytes" }],
        ranges,
      };
    }
    return { text, omissions, ranges };
  }
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#") && !trimmed.startsWith("//");
  });
  const omitted = lines.length - kept.length;
  let text = kept.join("\n");
  const omissions: StructuralOmission[] =
    omitted > 0 ? [{ kind: "rows", count: omitted, path: "comments" }] : [];
  if (byteLength(text) > maxBytes) {
    text = text.slice(0, maxBytes);
    omissions.push({ kind: "rows", count: 1, path: "bytes" });
  }
  return { text, omissions, ranges: [] };
}

function reduceFile(
  original: string,
  maxBytes: number,
  keys: readonly string[] | null,
): Result<
  { text: string; omissions: StructuralOmission[]; ranges: StructuralRange[] },
  StructuralError
> {
  const trimmed = original.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const json = reduceJsonFile(original, maxBytes, keys);
    if (json.ok) {
      return json;
    }
    if (json.error.code !== "malformed") {
      return json;
    }
  }
  return ok(reduceTableOrConfig(original, maxBytes));
}

type DiffHunk = { readonly header: string; readonly lines: readonly string[] };
type DiffFile = { readonly headers: readonly string[]; readonly hunks: readonly DiffHunk[] };

function parseUnifiedDiff(text: string): DiffFile[] {
  const lines = text.split(/\r?\n/);
  const files: DiffFile[] = [];
  let headers: string[] = [];
  let hunks: DiffHunk[] = [];
  let hunk: { header: string; lines: string[] } | null = null;
  const flushFile = () => {
    if (headers.length === 0 && hunks.length === 0) {
      return;
    }
    files.push({ headers, hunks });
    headers = [];
    hunks = [];
  };
  for (const line of lines) {
    if (
      line.startsWith("diff ") ||
      (line.startsWith("--- ") && hunk === null && headers.length === 0)
    ) {
      if (hunk !== null) {
        hunks.push(hunk);
        hunk = null;
      }
      if (headers.length > 0 || hunks.length > 0) {
        flushFile();
      }
      headers = [line];
      continue;
    }
    if (line.startsWith("@@")) {
      if (hunk !== null) {
        hunks.push(hunk);
      }
      hunk = { header: line, lines: [] };
      continue;
    }
    if (hunk !== null) {
      hunk.lines.push(line);
      continue;
    }
    if (headers.length > 0) {
      headers.push(line);
    }
  }
  if (hunk !== null) {
    hunks.push(hunk);
  }
  flushFile();
  return files;
}

function reduceDiff(
  original: string,
  maxBytes: number,
): { text: string; omissions: StructuralOmission[]; ranges: StructuralRange[] } {
  const files = parseUnifiedDiff(original);
  const keptFiles = files.slice(0, DEFAULT_STRUCTURAL_MAX_FILES);
  const omittedFiles = files.length - keptFiles.length;
  const parts: string[] = [];
  const omissions: StructuralOmission[] = [];
  const ranges: StructuralRange[] = [];
  for (const file of keptFiles) {
    const path =
      file.headers.find((line) => line.startsWith("--- ") || line.startsWith("diff ")) ?? "file";
    const keptHunks = file.hunks.slice(0, DEFAULT_STRUCTURAL_MAX_HUNKS);
    const omittedHunks = file.hunks.length - keptHunks.length;
    parts.push(...file.headers);
    for (const hunk of keptHunks) {
      parts.push(hunk.header, ...hunk.lines);
    }
    if (omittedHunks > 0) {
      omissions.push({ kind: "hunks", count: omittedHunks, path });
      ranges.push({ path, start: DEFAULT_STRUCTURAL_MAX_HUNKS, end: file.hunks.length });
    }
  }
  if (omittedFiles > 0) {
    omissions.push({ kind: "files", count: omittedFiles, path: null });
  }
  let text = parts.join("\n");
  if (byteLength(text) > maxBytes) {
    text = text.slice(0, maxBytes);
    omissions.push({ kind: "hunks", count: 1, path: "bytes" });
  }
  return { text, omissions, ranges };
}

function severityRank(value: unknown): number {
  if (value === 1 || value === "error") {
    return 0;
  }
  if (value === 2 || value === "warning") {
    return 1;
  }
  if (value === 3 || value === "info") {
    return 2;
  }
  return 3;
}

function formatDiagnostic(item: {
  readonly path?: string;
  readonly severity?: string | number;
  readonly message: string;
  readonly line?: number;
  readonly code?: string | number;
}): string {
  const path = item.path ?? "<unknown>";
  const line = item.line === undefined ? "" : `:${item.line}`;
  const severity = item.severity === undefined ? "" : ` ${String(item.severity)}`;
  const code = item.code === undefined ? "" : ` ${String(item.code)}`;
  return `${path}${line}:${severity}${code} ${item.message}`.replace(/ +/g, " ").trim();
}

function parseDiagnosticLines(text: string): Array<{
  path?: string;
  severity?: string;
  message: string;
  line?: number;
}> {
  const items: Array<{ path?: string; severity?: string; message: string; line?: number }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const matched = line.match(/^(.+?):(\d+)(?::\d+)?:\s*(error|warning|info|hint)?:?\s*(.*)$/i);
    if (matched === null) {
      items.push({ message: line });
      continue;
    }
    const item: { path?: string; severity?: string; message: string; line?: number } = {
      message: matched[4] ?? line,
    };
    if (matched[1] !== undefined) {
      item.path = matched[1];
    }
    if (matched[2] !== undefined) {
      item.line = Number(matched[2]);
    }
    if (matched[3] !== undefined) {
      item.severity = matched[3].toLowerCase();
    }
    items.push(item);
  }
  return items;
}

function reduceDiagnostics(
  original: string,
  diagnostics: unknown,
  maxBytes: number,
): Result<
  { text: string; omissions: StructuralOmission[]; ranges: StructuralRange[] },
  StructuralError
> {
  let items: Array<{
    path?: string;
    severity?: string | number;
    message: string;
    line?: number;
    code?: string | number;
  }>;
  if (diagnostics !== undefined) {
    const parsed = z
      .array(diagnosticItemSchema)
      .max(HARD_STRUCTURAL_MAX_DIAGNOSTICS)
      .safeParse(diagnostics);
    if (!parsed.success) {
      return err(structuralError("malformed", "diagnostics"));
    }
    items = parsed.data.map((item) => {
      const next: {
        path?: string;
        severity?: string | number;
        message: string;
        line?: number;
        code?: string | number;
      } = { message: item.message };
      if (item.path !== undefined) {
        next.path = item.path;
      }
      if (item.severity !== undefined) {
        next.severity = item.severity;
      }
      if (item.line !== undefined) {
        next.line = item.line;
      }
      if (item.code !== undefined) {
        next.code = item.code;
      }
      return next;
    });
  } else {
    items = parseDiagnosticLines(original);
  }
  if (items.length === 0) {
    return err(structuralError("empty", "diagnostics"));
  }
  const sorted = [...items].sort(
    (left, right) => severityRank(left.severity) - severityRank(right.severity),
  );
  const kept = sorted.slice(0, DEFAULT_STRUCTURAL_MAX_DIAGNOSTICS);
  const omitted = sorted.length - kept.length;
  const errorsKept = kept.some((item) => severityRank(item.severity) === 0);
  const errorsOriginal = sorted.some((item) => severityRank(item.severity) === 0);
  const text = kept.map(formatDiagnostic).join("\n");
  const omissions: StructuralOmission[] =
    omitted > 0 ? [{ kind: "diagnostics", count: omitted, path: null }] : [];
  const ranges: StructuralRange[] =
    omitted > 0
      ? [{ path: "diagnostics", start: DEFAULT_STRUCTURAL_MAX_DIAGNOSTICS, end: sorted.length }]
      : [];
  if (errorsOriginal && !errorsKept) {
    return err(structuralError("malformed", "diagnostics"));
  }
  if (byteLength(text) > maxBytes) {
    return err(structuralError("oversized", "projection"));
  }
  return ok({ text, omissions, ranges });
}

function reduceTool(
  original: string,
  maxBytes: number,
): Result<
  { text: string; omissions: StructuralOmission[]; ranges: StructuralRange[] },
  StructuralError
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(original) as unknown;
  } catch {
    return err(structuralError("malformed", "text"));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return reduceJsonFile(original, maxBytes, null);
  }
  const record = parsed as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of ["status", "effect", "error", "errorCode", "ok"] as const) {
    if (record[key] !== undefined) {
      projected[key] = record[key];
    }
  }
  if (Array.isArray(record.artifacts)) {
    projected.artifacts = record.artifacts.map((item) => {
      if (item !== null && typeof item === "object" && "artifactId" in item) {
        return { artifactId: (item as { artifactId: unknown }).artifactId };
      }
      return item;
    });
  }
  if (Array.isArray(record.diagnostics)) {
    projected.diagnostics = record.diagnostics.map((item) => {
      if (item !== null && typeof item === "object" && "code" in item) {
        const diagnostic = item as { code: unknown; level?: unknown };
        return diagnostic.level === undefined
          ? { code: diagnostic.code }
          : { code: diagnostic.code, level: diagnostic.level };
      }
      return item;
    });
  }
  if (record.value !== undefined) {
    const walked = walkJson(
      record.value,
      "$.value",
      0,
      DEFAULT_STRUCTURAL_MAX_DEPTH,
      DEFAULT_STRUCTURAL_MAX_KEYS,
      DEFAULT_STRUCTURAL_MAX_ARRAY,
      null,
    );
    projected.value = walked.value;
    const text = JSON.stringify(projected);
    if (byteLength(text) > maxBytes) {
      return err(structuralError("oversized", "projection"));
    }
    return ok({ text, omissions: walked.omissions, ranges: walked.ranges });
  }
  const text = JSON.stringify(projected);
  if (byteLength(text) > maxBytes) {
    return err(structuralError("oversized", "projection"));
  }
  return ok({ text, omissions: [], ranges: [] });
}

export function reduceStructural(
  input: StructuralReduceInput,
  hasher: ContentHasherPort,
): Result<StructuralReduceResult, StructuralError> {
  if (input.cancelled === true) {
    return err(structuralError("unavailable", "signal"));
  }
  const family = parseFamily(input.family);
  if (!family.ok) {
    return family;
  }
  const selectedFamily = family.value;
  if (input.sensitivity !== undefined) {
    if (typeof input.sensitivity !== "string") {
      return err(structuralError("malformed", "sensitivity"));
    }
    if (!(ARTIFACT_SENSITIVITIES as readonly string[]).includes(input.sensitivity)) {
      return err(structuralError("malformed", "sensitivity"));
    }
    if (input.sensitivity === "restricted") {
      return err(structuralError("secret", "sensitivity"));
    }
  }
  if (typeof input.text !== "string") {
    return err(structuralError("malformed", "text"));
  }
  if (input.text.length === 0) {
    return err(structuralError("empty", "text"));
  }
  if (input.text.includes("\0")) {
    return err(structuralError("unsupported", "text"));
  }
  const maxBytes = parseBound(
    input.maxBytes,
    "maxBytes",
    DEFAULT_STRUCTURAL_MAX_BYTES,
    HARD_STRUCTURAL_MAX_BYTES,
  );
  if (!maxBytes.ok) {
    return maxBytes;
  }
  const original = input.text;
  if (byteLength(original) > HARD_STRUCTURAL_MAX_BYTES) {
    return err(structuralError("oversized", "text"));
  }
  let keys: readonly string[] | null = null;
  if (input.keys !== undefined) {
    const parsed = z
      .array(z.string().min(1).max(128))
      .max(HARD_STRUCTURAL_MAX_KEYS)
      .safeParse(input.keys);
    if (!parsed.success) {
      return err(structuralError("malformed", "keys"));
    }
    keys = parsed.data;
  }

  let reduced: Result<
    { text: string; omissions: StructuralOmission[]; ranges: StructuralRange[] },
    StructuralError
  >;
  switch (selectedFamily) {
    case "file":
      reduced = reduceFile(original, maxBytes.value, keys);
      break;
    case "diff":
      reduced = ok(reduceDiff(original, maxBytes.value));
      break;
    case "diagnostic":
      reduced = reduceDiagnostics(original, input.diagnostics, maxBytes.value);
      break;
    case "tool":
      reduced = reduceTool(original, maxBytes.value);
      break;
    default:
      return assertNever(selectedFamily, "unhandled structural family");
  }
  if (!reduced.ok) {
    return reduced;
  }
  if (reduced.value.text.length === 0) {
    return err(structuralError("empty", "projection"));
  }
  return ok(
    finish(
      selectedFamily,
      original,
      reduced.value.text,
      reduced.value.omissions,
      reduced.value.ranges,
      hasher,
    ),
  );
}
