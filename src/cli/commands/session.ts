/** Session catalog command family. */

import {
  fromRecordError,
  fromSessionCatalogError,
  fromSessionIsolationError,
  fromUnknown,
  inspectWorkspaceSession,
  isolateWorkspaceSessions,
  queryWorkspaceSessions,
} from "../../application/index.ts";
import { createRecordRepositories } from "../../data/index.ts";
import {
  type FalrynError,
  MAX_SESSION_CATALOG,
  type RecordError,
  type SessionCatalogEntry,
  type SessionCatalogError,
  type SessionIsolationError,
  type SessionIsolationWarning,
} from "../../domain/index.ts";
import type { SessionCommandArguments } from "../command-tree.ts";
import type { CommandResultOf, CommandTruncation, CommandWarning } from "../result.ts";
import type { ServiceProvider } from "../services.ts";
import { resultFor, workspaceResolveError } from "./shared.ts";
import { openSessionStore } from "./storage.ts";

export type SessionListPayload = {
  readonly workspaceId: string;
  readonly filter: string;
  readonly search: string | null;
  readonly sessions: readonly SessionCatalogEntry[];
  readonly omitted: number;
  readonly warnings: readonly SessionIsolationWarning[];
};

export type SessionShowPayload = {
  readonly workspaceId: string;
  readonly session: SessionCatalogEntry;
  readonly warnings: readonly SessionIsolationWarning[];
};

export async function runSessionList(
  services: ServiceProvider,
  arguments_: Extract<SessionCommandArguments, { action: "list" }>,
  signal?: AbortSignal,
): Promise<CommandResultOf<"session.list", SessionListPayload>> {
  try {
    return await sessionListThroughStore(services, arguments_, signal);
  } catch (error) {
    return resultFor<"session.list", SessionListPayload>("session.list", null, [
      fromUnknown(error, { operation: "list sessions" }),
    ]);
  }
}

export async function runSessionShow(
  services: ServiceProvider,
  arguments_: Extract<SessionCommandArguments, { action: "show" }>,
  signal?: AbortSignal,
): Promise<CommandResultOf<"session.show", SessionShowPayload>> {
  try {
    return await sessionShowThroughStore(services, arguments_, signal);
  } catch (error) {
    return resultFor<"session.show", SessionShowPayload>("session.show", null, [
      fromUnknown(error, { operation: "show session" }),
    ]);
  }
}

async function sessionListThroughStore(
  services: ServiceProvider,
  arguments_: Extract<SessionCommandArguments, { action: "list" }>,
  signal: AbortSignal | undefined,
): Promise<CommandResultOf<"session.list", SessionListPayload>> {
  const opened = await openSessionStore(services, signal);
  if (!opened.ok) {
    return resultFor<"session.list", SessionListPayload>("session.list", null, opened.errors);
  }
  if (opened.kind === "absent") {
    return resultFor("session.list", {
      workspaceId: arguments_.workspaceId,
      filter: arguments_.filter,
      search: arguments_.search ?? null,
      sessions: [],
      omitted: 0,
      warnings: [],
    });
  }

  try {
    const sessions = createRecordRepositories(opened.store).sessions;
    const workspace = await services().ensureWorkspaceSet(signal);
    if (!workspace.ok) {
      return resultFor<"session.list", SessionListPayload>("session.list", null, [
        workspaceResolveError(workspace.error),
      ]);
    }
    const isolated = isolateWorkspaceSessions(
      sessions,
      {
        bound: {
          workspaceId: arguments_.workspaceId,
          root: services().workspaceRoot ?? null,
          gitIdentity: null,
        },
      },
      signal,
    );
    if (!isolated.ok) {
      return sessionListFailure(isolated.error);
    }
    const catalog = queryWorkspaceSessions(
      sessions,
      {
        workspaceId: arguments_.workspaceId,
        filter: arguments_.filter,
        ...(arguments_.search === undefined ? {} : { search: arguments_.search }),
        limit: arguments_.limit,
      },
      signal,
    );
    if (!catalog.ok) {
      return sessionListFailure(catalog.error);
    }
    const total = catalog.value.sessions.length + catalog.value.omitted;
    const truncation: CommandTruncation[] =
      catalog.value.omitted === 0
        ? []
        : [
            {
              of: "sessions",
              shown: catalog.value.sessions.length,
              total,
              expansion:
                arguments_.limit >= MAX_SESSION_CATALOG ? null : sessionListExpansion(arguments_),
            },
          ];
    return {
      ...resultFor("session.list", {
        workspaceId: arguments_.workspaceId,
        filter: catalog.value.filter,
        search: catalog.value.search,
        sessions: catalog.value.sessions,
        omitted: catalog.value.omitted,
        warnings: isolated.value.warnings,
      }),
      warnings: isolationWarnings(isolated.value.warnings),
      truncation,
      correlation: {
        workspaceId: arguments_.workspaceId,
        sessionId: null,
        turnId: null,
        traceId: null,
        scopeId: null,
        invocationId: null,
        capabilityId: null,
        eventId: null,
      },
    };
  } finally {
    await opened.store.close();
  }
}

async function sessionShowThroughStore(
  services: ServiceProvider,
  arguments_: Extract<SessionCommandArguments, { action: "show" }>,
  signal: AbortSignal | undefined,
): Promise<CommandResultOf<"session.show", SessionShowPayload>> {
  const opened = await openSessionStore(services, signal);
  if (!opened.ok) {
    return resultFor<"session.show", SessionShowPayload>("session.show", null, opened.errors);
  }
  if (opened.kind === "absent") {
    return sessionShowFailure({ kind: "session-catalog", code: "not-found", field: "sessionId" });
  }

  try {
    const workspace = await services().ensureWorkspaceSet(signal);
    if (!workspace.ok) {
      return resultFor<"session.show", SessionShowPayload>("session.show", null, [
        workspaceResolveError(workspace.error),
      ]);
    }
    const inspected = inspectWorkspaceSession(
      createRecordRepositories(opened.store).sessions,
      {
        workspaceId: arguments_.workspaceId,
        sessionId: arguments_.sessionId,
        root: services().workspaceRoot ?? null,
        gitIdentity: null,
      },
      signal,
    );
    if (!inspected.ok) {
      return sessionShowFailure(inspected.error);
    }
    return {
      ...resultFor("session.show", {
        workspaceId: arguments_.workspaceId,
        session: inspected.value.entry,
        warnings: inspected.value.warnings,
      }),
      warnings: isolationWarnings(inspected.value.warnings),
      correlation: {
        workspaceId: arguments_.workspaceId,
        sessionId: arguments_.sessionId,
        turnId: null,
        traceId: null,
        scopeId: null,
        invocationId: null,
        capabilityId: null,
        eventId: null,
      },
    };
  } finally {
    await opened.store.close();
  }
}

function sessionListExpansion(
  arguments_: Extract<SessionCommandArguments, { action: "list" }>,
): string {
  const parts = [`falryn session list --limit ${MAX_SESSION_CATALOG}`];
  if (arguments_.filter !== "all") {
    parts.push(`--filter ${arguments_.filter}`);
  }
  if (arguments_.workspaceId !== "cli") {
    parts.push(`--workspace-id ${arguments_.workspaceId}`);
  }
  return parts.join(" ");
}

function isolationWarnings(warnings: readonly SessionIsolationWarning[]): CommandWarning[] {
  return warnings.map((code) => ({
    code,
    message:
      code === "stale-root"
        ? "The bound workspace root no longer matches what this session last observed."
        : "The bound Git identity no longer matches what this session last observed.",
  }));
}

function sessionListFailure(
  error: SessionCatalogError | SessionIsolationError | RecordError,
): CommandResultOf<"session.list", SessionListPayload> {
  return resultFor<"session.list", SessionListPayload>("session.list", null, [
    translateSessionBoundary(error),
  ]);
}

function sessionShowFailure(
  error: SessionCatalogError | SessionIsolationError | RecordError,
): CommandResultOf<"session.show", SessionShowPayload> {
  return resultFor<"session.show", SessionShowPayload>("session.show", null, [
    translateSessionBoundary(error),
  ]);
}

function translateSessionBoundary(
  error: SessionCatalogError | SessionIsolationError | RecordError,
): FalrynError {
  if (error.kind === "record") {
    return fromRecordError(error, { operation: "read sessions" });
  }
  if (error.kind === "session-isolation") {
    return fromSessionIsolationError(error, { operation: "isolate sessions" });
  }
  return fromSessionCatalogError(error, { operation: "read session catalog" });
}

/* -------------------------------------------------------------------------- */
/* artifact                                                                    */
/* -------------------------------------------------------------------------- */

/** Whether stdout carried artifact bytes instead of a rendered result. */
