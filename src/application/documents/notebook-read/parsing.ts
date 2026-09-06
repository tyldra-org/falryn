import type { NotebookReadError } from "../../../domain/documents/index.ts";
import type { Result } from "../../../domain/foundation/index.ts";
import type { JsonRecord, ParsedNotebook } from "./contracts.ts";

const SUPPORTED_NOTEBOOK_FORMAT_MAJOR = 4;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNoControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) {
      return false;
    }
  }
  return true;
}

export function cellId(value: unknown): string | null {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    hasNoControlCharacters(value) &&
    value.trim() !== ""
  ) {
    return value;
  }
  return null;
}

export function cellIdAt(value: unknown): string | null {
  return isRecord(value) ? cellId(value.id) : null;
}

export function parseNotebookJson(text: string): Result<ParsedNotebook, NotebookReadError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: { code: "malformed-json" } };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: { code: "malformed-notebook", field: "cells" } };
  }

  const major = parsed.nbformat;
  const minor = parsed.nbformat_minor;
  if (typeof major !== "number" || !Number.isInteger(major) || major < 0) {
    return { ok: false, error: { code: "malformed-notebook", field: "nbformat" } };
  }
  if (typeof minor !== "number" || !Number.isInteger(minor) || minor < 0) {
    return { ok: false, error: { code: "malformed-notebook", field: "nbformat_minor" } };
  }
  if (major !== SUPPORTED_NOTEBOOK_FORMAT_MAJOR) {
    return { ok: false, error: { code: "unsupported-version", major, minor } };
  }
  if (!isRecord(parsed.metadata)) {
    return { ok: false, error: { code: "malformed-notebook", field: "metadata" } };
  }
  if (!Array.isArray(parsed.cells)) {
    return { ok: false, error: { code: "malformed-notebook", field: "cells" } };
  }
  return {
    ok: true,
    value: {
      format: { major, minor },
      metadata: parsed.metadata,
      cells: parsed.cells,
    },
  };
}
