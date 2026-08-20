/**
 * Session list, naming, pinning, filtering, and search (#258).
 *
 * List, resume, and rewind stay distinct. This module names existing sessions.
 * It does not continue a cursor, fork a lineage, or rewrite history.
 */

import { z } from "zod";

import { brandedString, timestampSchema } from "./branded-schema.ts";
import { type SessionId, sessionId } from "./identity.ts";
import { MAX_SESSION_TITLE_LENGTH } from "./records.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import type { Timestamp } from "./time.ts";

export const SESSION_CATALOG_VERSION = "session-catalog.v1";
export const SESSION_CATALOG_SOURCE = "deterministic-session-records";
export const MAX_SESSION_CATALOG = 256;
export const MAX_SESSION_SEARCH_BYTES = 256;
/** Default rows a list surface shows before declaring an expansion. */
export const DEFAULT_SESSION_LIST_LIMIT = 32;

export const SESSION_CATALOG_FILTERS = ["all", "open", "closed", "pinned"] as const;
export type SessionCatalogFilter = (typeof SESSION_CATALOG_FILTERS)[number];

export type SessionCatalogErrorCode =
  | "cancelled"
  | "empty"
  | "malformed"
  | "not-found"
  | "oversized"
  | "secret";

export type SessionCatalogError = {
  readonly kind: "session-catalog";
  readonly code: SessionCatalogErrorCode;
  readonly field: string | null;
};

export type SessionCatalogProvenance = {
  readonly version: typeof SESSION_CATALOG_VERSION;
  readonly source: typeof SESSION_CATALOG_SOURCE;
  readonly model: null;
};

export type SessionCatalogEntry = {
  readonly sessionId: SessionId;
  readonly title: string | null;
  readonly pinned: boolean;
  readonly startedAt: Timestamp;
  readonly closedAt: Timestamp | null;
};

export type SessionCatalog = {
  readonly filter: SessionCatalogFilter;
  readonly search: string | null;
  readonly sessions: readonly SessionCatalogEntry[];
  readonly omitted: number;
  readonly provenance: SessionCatalogProvenance;
};

export type SessionCatalogEdit =
  | { readonly kind: "rename"; readonly sessionId: unknown; readonly title: unknown }
  | { readonly kind: "pin"; readonly sessionId: unknown; readonly pinned: unknown };

export type SessionCatalogQueryInput = {
  readonly sessions: unknown;
  readonly filter?: unknown;
  readonly search?: unknown;
};

export type SessionCatalogEditInput = {
  readonly sessions: unknown;
  readonly edit: unknown;
};

const encoder = new TextEncoder();

function catalogError(code: SessionCatalogErrorCode, field: string | null): SessionCatalogError {
  return { kind: "session-catalog", code, field };
}

export function describeSessionCatalogError(error: SessionCatalogError): string {
  const field = error.field === null ? "catalog" : error.field;
  switch (error.code) {
    case "cancelled":
      return `cancelled ${field}`;
    case "empty":
      return `empty ${field}`;
    case "malformed":
      return `malformed ${field}`;
    case "not-found":
      return `not-found ${field}`;
    case "oversized":
      return `oversized ${field}`;
    case "secret":
      return `secret ${field}`;
    default:
      return assertNever(error.code, "unhandled session-catalog error");
  }
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function isFilter(value: unknown): value is SessionCatalogFilter {
  return (
    typeof value === "string" && (SESSION_CATALOG_FILTERS as readonly string[]).includes(value)
  );
}

const entrySchema = z
  .object({
    sessionId: brandedString(sessionId),
    title: z.string().max(MAX_SESSION_TITLE_LENGTH).nullable(),
    pinned: z.boolean(),
    startedAt: timestampSchema,
    closedAt: timestampSchema.nullable(),
  })
  .strict();

const renameSchema = z
  .object({
    kind: z.literal("rename"),
    sessionId: z.string(),
    title: z.string().nullable(),
  })
  .strict();

const pinSchema = z
  .object({
    kind: z.literal("pin"),
    sessionId: z.string(),
    pinned: z.boolean(),
  })
  .strict();

function parseEntries(value: unknown): Result<SessionCatalogEntry[], SessionCatalogError> {
  if (!Array.isArray(value)) {
    return err(catalogError("malformed", "sessions"));
  }
  if (value.length > MAX_SESSION_CATALOG) {
    return err(catalogError("oversized", "sessions"));
  }
  const seen = new Set<string>();
  const entries: SessionCatalogEntry[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = entrySchema.safeParse(item);
    if (!parsed.success) {
      return err(catalogError("malformed", `sessions.${index}`));
    }
    if (seen.has(parsed.data.sessionId)) {
      return err(catalogError("malformed", `sessions.${index}.sessionId`));
    }
    seen.add(parsed.data.sessionId);
    entries.push(parsed.data);
  }
  return ok(entries);
}

function parseSearch(value: unknown): Result<string | null, SessionCatalogError> {
  if (value === undefined || value === null) {
    return ok(null);
  }
  if (typeof value !== "string") {
    return err(catalogError("malformed", "search"));
  }
  if (value.includes("\0")) {
    return err(catalogError("malformed", "search"));
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return ok(null);
  }
  if (byteLength(trimmed) > MAX_SESSION_SEARCH_BYTES) {
    return err(catalogError("oversized", "search"));
  }
  return ok(trimmed);
}

function matchesFilter(entry: SessionCatalogEntry, filter: SessionCatalogFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "open":
      return entry.closedAt === null;
    case "closed":
      return entry.closedAt !== null;
    case "pinned":
      return entry.pinned;
    default:
      return assertNever(filter, "unhandled session-catalog filter");
  }
}

function matchesSearch(entry: SessionCatalogEntry, search: string | null): boolean {
  if (search === null) {
    return true;
  }
  if (entry.title === null) {
    return false;
  }
  return entry.title.toLowerCase().includes(search.toLowerCase());
}

function sortCatalog(entries: readonly SessionCatalogEntry[]): SessionCatalogEntry[] {
  return [...entries].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    if (left.startedAt !== right.startedAt) {
      return right.startedAt.localeCompare(left.startedAt);
    }
    return left.sessionId.localeCompare(right.sessionId);
  });
}

function catalogOf(
  filter: SessionCatalogFilter,
  search: string | null,
  entries: readonly SessionCatalogEntry[],
): SessionCatalog {
  return {
    filter,
    search,
    sessions: entries,
    omitted: 0,
    provenance: {
      version: SESSION_CATALOG_VERSION,
      source: SESSION_CATALOG_SOURCE,
      model: null,
    },
  };
}

/**
 * Filters, searches, and sorts a declared session list. Pin is a catalog fact
 * supplied with the records; resume and rewind remain later children.
 */
export function querySessionCatalog(
  input: SessionCatalogQueryInput,
  signal?: AbortSignal,
): Result<SessionCatalog, SessionCatalogError> {
  if (signal?.aborted) {
    return err(catalogError("cancelled", "signal"));
  }
  const filter = input.filter === undefined ? "all" : input.filter;
  if (!isFilter(filter)) {
    return err(catalogError("malformed", "filter"));
  }
  const search = parseSearch(input.search);
  if (!search.ok) {
    return search;
  }
  const entries = parseEntries(input.sessions);
  if (!entries.ok) {
    return entries;
  }
  const matched = sortCatalog(
    entries.value.filter(
      (entry) => matchesFilter(entry, filter) && matchesSearch(entry, search.value),
    ),
  );
  return ok(catalogOf(filter, search.value, matched));
}

/**
 * Renames or pins one declared session in the catalog snapshot.
 * The result is still a catalog: it does not resume, fork, or write Git.
 */
export function editSessionCatalog(
  input: SessionCatalogEditInput,
  signal?: AbortSignal,
): Result<SessionCatalog, SessionCatalogError> {
  if (signal?.aborted) {
    return err(catalogError("cancelled", "signal"));
  }
  const entries = parseEntries(input.sessions);
  if (!entries.ok) {
    return entries;
  }
  if (input.edit === null || typeof input.edit !== "object") {
    return err(catalogError("malformed", "edit"));
  }
  const kind = "kind" in input.edit ? input.edit.kind : undefined;
  switch (kind) {
    case "rename": {
      const parsed = renameSchema.safeParse(input.edit);
      if (!parsed.success) {
        return err(catalogError("malformed", "edit"));
      }
      const id = brandedString(sessionId).safeParse(parsed.data.sessionId);
      if (!id.success) {
        return err(catalogError("malformed", "edit.sessionId"));
      }
      let title: string | null = parsed.data.title;
      if (title !== null) {
        if (title.includes("\0")) {
          return err(catalogError("malformed", "edit.title"));
        }
        const trimmed = title.trim();
        if (trimmed.length === 0) {
          return err(catalogError("empty", "edit.title"));
        }
        if (byteLength(trimmed) > MAX_SESSION_TITLE_LENGTH) {
          return err(catalogError("oversized", "edit.title"));
        }
        title = trimmed;
      }
      const index = entries.value.findIndex((entry) => entry.sessionId === id.data);
      if (index < 0) {
        return err(catalogError("not-found", "edit.sessionId"));
      }
      const current = entries.value[index];
      if (current === undefined) {
        return err(catalogError("not-found", "edit.sessionId"));
      }
      const next = [...entries.value];
      next[index] = { ...current, title };
      return ok(catalogOf("all", null, sortCatalog(next)));
    }
    case "pin": {
      const parsed = pinSchema.safeParse(input.edit);
      if (!parsed.success) {
        return err(catalogError("malformed", "edit"));
      }
      const id = brandedString(sessionId).safeParse(parsed.data.sessionId);
      if (!id.success) {
        return err(catalogError("malformed", "edit.sessionId"));
      }
      const index = entries.value.findIndex((entry) => entry.sessionId === id.data);
      if (index < 0) {
        return err(catalogError("not-found", "edit.sessionId"));
      }
      const current = entries.value[index];
      if (current === undefined) {
        return err(catalogError("not-found", "edit.sessionId"));
      }
      const next = [...entries.value];
      next[index] = { ...current, pinned: parsed.data.pinned };
      return ok(catalogOf("all", null, sortCatalog(next)));
    }
    default:
      return err(catalogError("malformed", "edit.kind"));
  }
}
