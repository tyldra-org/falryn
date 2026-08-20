/**
 * Application boundary for session list, naming, pinning, filter, and search (#258).
 *
 * Secret-shaped titles and search text fail closed. Pin is a catalog overlay
 * supplied with the query; durable retention-GC pins remain later.
 */

import {
  editSessionCatalog,
  err,
  MAX_SESSION_CATALOG,
  ok,
  querySessionCatalog,
  type RecordError,
  type Result,
  type SessionCatalog,
  type SessionCatalogEdit,
  type SessionCatalogEntry,
  type SessionCatalogError,
  type SessionCatalogFilter,
  type SessionId,
  type SessionIsolationError,
  type SessionIsolationWarning,
  type SessionRepositoryPort,
  type WorkspaceId,
} from "../domain/index.ts";
import { containsRedactableSecret, redactText } from "./redaction.ts";
import { isolateWorkspaceSessions } from "./session-isolation.ts";

function catalogError(
  code: SessionCatalogError["code"],
  field: string | null,
): SessionCatalogError {
  return { kind: "session-catalog", code, field };
}

function secretInString(value: unknown, field: string): Result<null, SessionCatalogError> {
  if (typeof value === "string" && containsRedactableSecret(value)) {
    return err(catalogError("secret", field));
  }
  return ok(null);
}

export type QueryWorkspaceSessionsInput = {
  readonly workspaceId: WorkspaceId;
  readonly filter?: SessionCatalogFilter;
  readonly search?: string;
  readonly pinnedIds?: readonly string[];
  /** How many matched rows to keep. Defaults to the catalog maximum. */
  readonly limit?: number;
};

export type InspectWorkspaceSessionInput = {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly pinnedIds?: readonly string[];
  readonly root?: string | null;
  readonly gitIdentity?: string | null;
};

export type InspectedWorkspaceSession = {
  readonly entry: SessionCatalogEntry;
  readonly warnings: readonly SessionIsolationWarning[];
};

export type InspectWorkspaceSessionError =
  | SessionCatalogError
  | SessionIsolationError
  | RecordError;

export function queryWorkspaceSessions(
  sessions: SessionRepositoryPort,
  input: QueryWorkspaceSessionsInput,
  signal?: AbortSignal,
): Result<SessionCatalog, SessionCatalogError> {
  const search = secretInString(input.search, "search");
  if (!search.ok) {
    return search;
  }
  const listed = sessions.listByParent(input.workspaceId, MAX_SESSION_CATALOG);
  if (!listed.ok) {
    return err(catalogError("malformed", "sessions"));
  }
  const pinned = new Set(input.pinnedIds ?? []);
  const catalog = querySessionCatalog(
    {
      sessions: listed.value.map((record) => ({
        sessionId: record.sessionId,
        title: record.title === null ? null : redactText(record.title),
        pinned: pinned.has(record.sessionId),
        startedAt: record.startedAt,
        closedAt: record.closedAt,
      })),
      filter: input.filter,
      search: input.search,
    },
    signal,
  );
  if (!catalog.ok) {
    return catalog;
  }
  const limit = input.limit ?? MAX_SESSION_CATALOG;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SESSION_CATALOG) {
    return err(catalogError("oversized", "limit"));
  }
  if (catalog.value.sessions.length <= limit) {
    return catalog;
  }
  return ok({
    ...catalog.value,
    sessions: catalog.value.sessions.slice(0, limit),
    omitted: catalog.value.omitted + (catalog.value.sessions.length - limit),
  });
}

/**
 * Loads one session in the bound workspace. Isolation decides membership;
 * a foreign or absent id is `not-found`, never an empty success payload.
 */
export function inspectWorkspaceSession(
  sessions: SessionRepositoryPort,
  input: InspectWorkspaceSessionInput,
  signal?: AbortSignal,
): Result<InspectedWorkspaceSession, InspectWorkspaceSessionError> {
  const isolated = isolateWorkspaceSessions(
    sessions,
    {
      bound: {
        workspaceId: input.workspaceId,
        root: input.root ?? null,
        gitIdentity: input.gitIdentity ?? null,
      },
    },
    signal,
  );
  if (!isolated.ok) {
    return isolated;
  }
  const loaded = sessions.get(input.sessionId);
  if (!loaded.ok) {
    return loaded;
  }
  if (
    loaded.value === null ||
    !isolated.value.sessions.some((entry) => entry.sessionId === input.sessionId)
  ) {
    return err(catalogError("not-found", "sessionId"));
  }
  const record = loaded.value;
  const pinned = new Set(input.pinnedIds ?? []);
  return ok({
    entry: {
      sessionId: record.sessionId,
      title: record.title === null ? null : redactText(record.title),
      pinned: pinned.has(record.sessionId),
      startedAt: record.startedAt,
      closedAt: record.closedAt,
    },
    warnings: isolated.value.warnings,
  });
}

export function editWorkspaceSessionCatalog(
  sessions: SessionRepositoryPort,
  input: {
    readonly workspaceId: WorkspaceId;
    readonly edit: SessionCatalogEdit;
    readonly pinnedIds?: readonly string[];
  },
  signal?: AbortSignal,
): Result<SessionCatalog, SessionCatalogError> {
  if (input.edit.kind === "rename") {
    const title = secretInString(input.edit.title, "edit.title");
    if (!title.ok) {
      return title;
    }
  }
  const listed = sessions.listByParent(input.workspaceId, MAX_SESSION_CATALOG);
  if (!listed.ok) {
    return err(catalogError("malformed", "sessions"));
  }
  const pinned = new Set(input.pinnedIds ?? []);
  return editSessionCatalog(
    {
      sessions: listed.value.map((record) => ({
        sessionId: record.sessionId,
        title: record.title,
        pinned: pinned.has(record.sessionId),
        startedAt: record.startedAt,
        closedAt: record.closedAt,
      })),
      edit: input.edit,
    },
    signal,
  );
}
