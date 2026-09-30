import {
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  rootChild,
  sqliteDatabasePath,
} from "../../data/index.ts";
import { isRootUsable } from "../../domain/storage/index.ts";
import { openBunSqlite } from "../../integrations/index.ts";
import type { Services } from "../runtime/services.ts";

export type ExtensionStateStore = Extract<
  Awaited<ReturnType<typeof openSqliteStore>>,
  { ok: true }
>["value"];

/**
 * Create the product database on first confirmed write. Inspection never calls this: a read
 * against an absent database answers from empty stores instead of creating one.
 */
export async function createExtensionStateStore(
  services: Services,
  signal: AbortSignal | undefined,
): Promise<ExtensionStateStore | null> {
  const roots = await services.localData.prepareRoots(["state"], signal);
  if (!roots.every(isRootUsable)) return null;
  const stateRoot = rootChild(services.localData.layout, "state");
  const path = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
  if (path === null || stateRoot === null) return null;
  const created = await openSqliteStore(
    {
      open: openBunSqlite,
      clock: services.clock,
      databasePath: path,
      backupDirectory: stateRoot,
      migrations: PRODUCTION_MIGRATIONS,
      create: true,
    },
    signal,
  );
  return created.ok ? created.value : null;
}
