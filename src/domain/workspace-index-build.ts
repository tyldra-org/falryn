/**
 * Rebuildable workspace lexical and symbol index contracts (#93).
 *
 * Extractors turn file text into index records. Builders inventory sources,
 * replace one atomic generation, and expose it through WorkspaceIndexPort.
 * Watchers, Tree-sitter, embeddings, and product tools remain later work.
 */

import { err, ok, type Result } from "./result.ts";
import type {
  IndexLifecycle,
  IndexRecordKind,
  WorkspaceIndexError,
  WorkspaceIndexGeneration,
  WorkspaceIndexRecord,
} from "./workspace-index.ts";

export const WORKSPACE_INDEX_SCHEMA = "workspace-index/v1";
export const MAX_INDEX_BUILD_FILES = 4_096;
export const MAX_INDEX_BUILD_FILE_BYTES = 512 * 1024;
export const MAX_INDEX_BUILD_RECORDS = 50_000;
export const MAX_INDEX_BUILD_NAME_LENGTH = 256;
export const MAX_INDEX_BUILD_TEXT_LENGTH = 4_096;

export type WorkspaceIndexBuildLimits = {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxRecords: number;
};

export const DEFAULT_INDEX_BUILD_LIMITS: WorkspaceIndexBuildLimits = {
  maxFiles: MAX_INDEX_BUILD_FILES,
  maxFileBytes: MAX_INDEX_BUILD_FILE_BYTES,
  maxRecords: MAX_INDEX_BUILD_RECORDS,
};

export type WorkspaceIndexBuildSource = {
  readonly logical: string;
  readonly text: string;
  readonly revision: string;
};

export type WorkspaceIndexBuildRequest = {
  readonly sources: readonly WorkspaceIndexBuildSource[];
  readonly limits?: WorkspaceIndexBuildLimits | undefined;
};

export type WorkspaceIndexBuildReport = {
  readonly generation: WorkspaceIndexGeneration;
  readonly fileCount: number;
  readonly recordCount: number;
  readonly omittedFiles: number;
  readonly omittedRecords: number;
};

export type WorkspaceIndexBuildError =
  | WorkspaceIndexError
  | { readonly code: "malformed-source" }
  | { readonly code: "capacity-exceeded"; readonly field: "files" | "records" | "file-bytes" }
  | { readonly code: "build-cancelled" }
  | { readonly code: "persist-failed"; readonly reason: string };

const SYMBOL_PATTERN =
  /\b(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/gm;

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateIndexBuildLimits(
  value: unknown,
): Result<WorkspaceIndexBuildLimits, WorkspaceIndexBuildError> {
  if (value === undefined) {
    return ok(DEFAULT_INDEX_BUILD_LIMITS);
  }
  if (!isRecord(value)) {
    return err({ code: "malformed-source" });
  }
  const maxFiles = value.maxFiles ?? DEFAULT_INDEX_BUILD_LIMITS.maxFiles;
  const maxFileBytes = value.maxFileBytes ?? DEFAULT_INDEX_BUILD_LIMITS.maxFileBytes;
  const maxRecords = value.maxRecords ?? DEFAULT_INDEX_BUILD_LIMITS.maxRecords;
  if (
    typeof maxFiles !== "number" ||
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > MAX_INDEX_BUILD_FILES ||
    typeof maxFileBytes !== "number" ||
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes < 1 ||
    maxFileBytes > MAX_INDEX_BUILD_FILE_BYTES ||
    typeof maxRecords !== "number" ||
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1 ||
    maxRecords > MAX_INDEX_BUILD_RECORDS
  ) {
    return err({ code: "malformed-source" });
  }
  return ok({ maxFiles, maxFileBytes, maxRecords });
}

export function extractIndexRecordsFromText(
  source: WorkspaceIndexBuildSource,
): readonly WorkspaceIndexRecord[] {
  const records: WorkspaceIndexRecord[] = [];
  const lines = source.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    SYMBOL_PATTERN.lastIndex = 0;
    let match = SYMBOL_PATTERN.exec(line);
    while (match !== null) {
      const name = match[1];
      if (name !== undefined && name.length > 0) {
        records.push({
          logical: source.logical,
          kind: "symbol",
          name: clip(name, MAX_INDEX_BUILD_NAME_LENGTH),
          text: clip(line.trim(), MAX_INDEX_BUILD_TEXT_LENGTH),
          startLine: lineNumber,
          endLine: lineNumber,
          revision: source.revision,
        });
      }
      match = SYMBOL_PATTERN.exec(line);
    }
  }

  HEADING_PATTERN.lastIndex = 0;
  let heading = HEADING_PATTERN.exec(source.text);
  while (heading !== null) {
    const title = heading[2]?.trim();
    if (title !== undefined && title.length > 0) {
      const before = source.text.slice(0, heading.index ?? 0);
      const startLine = before.length === 0 ? 1 : before.split("\n").length;
      records.push({
        logical: source.logical,
        kind: "heading",
        name: clip(title, MAX_INDEX_BUILD_NAME_LENGTH),
        text: clip(title, MAX_INDEX_BUILD_TEXT_LENGTH),
        startLine,
        endLine: startLine,
        revision: source.revision,
      });
    }
    heading = HEADING_PATTERN.exec(source.text);
  }

  // Lexical chunks: one record per non-empty line (bounded).
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line.length === 0) {
      continue;
    }
    records.push({
      logical: source.logical,
      kind: "chunk",
      name: clip(source.logical, MAX_INDEX_BUILD_NAME_LENGTH),
      text: clip(line, MAX_INDEX_BUILD_TEXT_LENGTH),
      startLine: index + 1,
      endLine: index + 1,
      revision: source.revision,
    });
  }

  return records;
}

export function buildIndexGeneration(
  request: WorkspaceIndexBuildRequest,
  generationId: string,
  lifecycle: IndexLifecycle = "ready",
): Result<WorkspaceIndexBuildReport, WorkspaceIndexBuildError> {
  const limits = validateIndexBuildLimits(request.limits);
  if (!limits.ok) {
    return limits;
  }
  if (!Array.isArray(request.sources)) {
    return err({ code: "malformed-source" });
  }
  if (request.sources.length > limits.value.maxFiles) {
    return err({ code: "capacity-exceeded", field: "files" });
  }

  const encoder = new TextEncoder();
  const records: WorkspaceIndexRecord[] = [];
  let omittedFiles = 0;
  let omittedRecords = 0;

  for (const source of request.sources) {
    if (
      typeof source.logical !== "string" ||
      source.logical.length === 0 ||
      typeof source.text !== "string" ||
      typeof source.revision !== "string" ||
      source.revision.length === 0
    ) {
      return err({ code: "malformed-source" });
    }
    const bytes = encoder.encode(source.text).byteLength;
    if (bytes > limits.value.maxFileBytes) {
      omittedFiles += 1;
      continue;
    }
    const extracted = extractIndexRecordsFromText(source);
    for (const record of extracted) {
      if (records.length >= limits.value.maxRecords) {
        omittedRecords += 1;
        continue;
      }
      records.push(record);
    }
  }

  const generation: WorkspaceIndexGeneration = {
    id: generationId,
    schema: WORKSPACE_INDEX_SCHEMA,
    lifecycle,
    records,
  };

  return ok({
    generation,
    fileCount: request.sources.length - omittedFiles,
    recordCount: records.length,
    omittedFiles,
    omittedRecords,
  });
}

export function indexRecordKinds(): readonly IndexRecordKind[] {
  return ["symbol", "heading", "chunk"];
}
