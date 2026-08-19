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
  type Result,
  type SessionCatalog,
  type SessionCatalogEdit,
  type SessionCatalogError,
  type SessionCatalogFilter,
  type SessionRepositoryPort,
  type WorkspaceId,
} from "../domain/index.ts";
import { containsRedactableSecret } from "./redaction.ts";

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
};

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
  return querySessionCatalog(
    {
      sessions: listed.value.map((record) => ({
        sessionId: record.sessionId,
        title: record.title,
        pinned: pinned.has(record.sessionId),
        startedAt: record.startedAt,
        closedAt: record.closedAt,
      })),
      filter: input.filter,
      search: input.search,
    },
    signal,
  );
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
