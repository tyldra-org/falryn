/**
 * Compose a session navigation controller from the local SQLite store (#722).
 *
 * Keeps SQLite opening in the CLI launch path; the TUI controller only sees
 * domain ports.
 */

import { fromUnknown } from "../application/index.ts";
import {
  createRecordRepositories,
  createSqliteEventStore,
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  probeStorage,
  rootChild,
  sqliteDatabasePath,
} from "../data/index.ts";
import {
  blocksLocalData,
  DEFAULT_BUSY_TIMEOUT_MS,
  type FalrynError,
  type WorkspaceId,
} from "../domain/index.ts";
import { openBunSqlite } from "../integrations/index.ts";
import {
  createSessionNavigationController,
  type SessionNavigationController,
} from "../tui/session-nav/controller.ts";
import type { ServiceProvider } from "./services.ts";

type SessionStore = Extract<Awaited<ReturnType<typeof openSqliteStore>>, { ok: true }>["value"];

type Opened =
  | { readonly ok: true; readonly kind: "absent" }
  | { readonly ok: true; readonly kind: "open"; readonly store: SessionStore }
  | { readonly ok: false; readonly errors: readonly FalrynError[] };

export type SessionNavigationControllerBundle = {
  readonly controller: SessionNavigationController;
  readonly close: (signal?: AbortSignal) => Promise<void>;
};

async function openStore(
  services: ServiceProvider,
  signal: AbortSignal | undefined,
): Promise<Opened> {
  const { localData, clock } = services();
  const inspections = await localData.inspectRoots();
  const state = inspections.find((inspection) => inspection.root === "state");
  if (state !== undefined && blocksLocalData(state)) {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("the state root is unusable"), { operation: "inspect state root" }),
      ],
    };
  }
  const stateRoot = rootChild(localData.layout, "state");
  const databasePath = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
  if (stateRoot === null || databasePath === null) {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("a state root could not be resolved"), {
          operation: "resolve session store",
        }),
      ],
    };
  }
  const probe = await probeStorage({ open: openBunSqlite, databasePath });
  if (probe.kind === "absent") {
    return { ok: true, kind: "absent" };
  }
  if (probe.kind !== "present") {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("the local database could not be read"), {
          operation: "probe session store",
        }),
      ],
    };
  }
  const opened = await openSqliteStore(
    {
      open: openBunSqlite,
      clock,
      databasePath,
      backupDirectory: stateRoot,
      migrations: PRODUCTION_MIGRATIONS,
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
      create: false,
    },
    signal,
  );
  if (!opened.ok) {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("the local database could not be opened"), {
          operation: "open local database",
        }),
      ],
    };
  }
  return { ok: true, kind: "open", store: opened.value };
}

/** Opens the local store when present and returns a controller bundle, else undefined. */
export async function composeSessionNavigationController(
  services: ServiceProvider,
  workspaceId: WorkspaceId,
  signal?: AbortSignal,
): Promise<SessionNavigationControllerBundle | undefined> {
  const opened = await openStore(services, signal);
  if (!opened.ok || opened.kind === "absent") {
    return undefined;
  }
  const repositories = createRecordRepositories(opened.store);
  const events = createSqliteEventStore(opened.store);
  return {
    controller: createSessionNavigationController({
      sessions: repositories.sessions,
      turns: repositories.turns,
      events,
      workspaceId,
    }),
    close: async (closeSignal) => {
      await opened.store.close(closeSignal);
    },
  };
}
