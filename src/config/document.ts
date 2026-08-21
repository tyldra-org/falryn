/**
 * Configuration document shape, assignment, and serialization.
 *
 * Files are nested JSONC objects keyed by dotted paths (`diagnostics.level` lives
 * under `diagnostics`). The serializer produces a canonical indented document
 * with schema version fields every writer includes.
 */

import type { ConfigurationValue } from "../domain/index.ts";
import { parseJsonc } from "./jsonc.ts";
import {
  CONFIGURATION_SCHEMA_VERSION,
  MINIMUM_READER_FIELD,
  RESERVED_DOCUMENT_FIELDS,
  SCHEMA_VERSION_FIELD,
} from "./schema-family.ts";

/** Document every writer creates or preserves when absent. */
export function createEmptyConfigurationDocument(): Record<string, unknown> {
  return {
    [SCHEMA_VERSION_FIELD]: CONFIGURATION_SCHEMA_VERSION,
    [MINIMUM_READER_FIELD]: CONFIGURATION_SCHEMA_VERSION,
  };
}

/** Parses JSONC text into a document object, or `null` when empty. */
export function parseConfigurationDocument(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = parseJsonc(text);
  if (!parsed.ok) {
    return null;
  }
  if (parsed.value === undefined) {
    return null;
  }
  if (!isPlainObject(parsed.value)) {
    return null;
  }
  return { ...parsed.value };
}

/**
 * Sets one declared key's value in a nested document.
 *
 * Intermediate objects are created when missing. The key path is a canonical
 * dotted path, not a walk through unknown prefixes.
 */
export function assignConfigurationValue(
  document: Readonly<Record<string, unknown>>,
  keyPath: string,
  value: ConfigurationValue,
): Record<string, unknown> {
  const segments = keyPath.split(".");
  const head = segments[0];
  if (head === undefined || head.length === 0) {
    return document;
  }
  if (segments.length === 1) {
    return { ...document, [head]: value };
  }
  const existing = document[head];
  const nested = isPlainObject(existing) ? { ...existing } : {};
  return {
    ...document,
    [head]: assignConfigurationValue(nested, segments.slice(1).join("."), value),
  };
}

/**
 * Serializes a document to canonical JSONC bytes.
 *
 * Comments from a hand-edited file are not preserved on write; the output is
 * deterministic and indented for human editing.
 */
export function serializeConfigurationDocument(
  document: Readonly<Record<string, unknown>>,
): string {
  const ordered = orderDocumentFields(document);
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function orderDocumentFields(document: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const field of RESERVED_DOCUMENT_FIELDS) {
    if (document[field] !== undefined) {
      ordered[field] = document[field];
    }
  }
  for (const [key, value] of Object.entries(document)) {
    if (!RESERVED_DOCUMENT_FIELDS.includes(key)) {
      ordered[key] = value;
    }
  }
  return ordered;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
