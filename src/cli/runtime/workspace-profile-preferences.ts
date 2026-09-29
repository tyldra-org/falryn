import { rootChild, sqliteDatabasePath } from "../../data/index.ts";
import { createWorkspaceProfilePreferences } from "../../data/workspace/profile-preferences.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import { isCleanClose } from "../../domain/storage/index.ts";
import { primaryWorkspaceRoot } from "../../domain/workspace/index.ts";
import { openSessionStore } from "../commands/storage.ts";
import type { Services } from "./services.ts";

export async function workspaceProfilePreference(
  graph: Services,
  signal?: AbortSignal,
  save?: { profile: string | null },
) {
  const stateRoot = rootChild(graph.localData.layout, "state");
  if (stateRoot === null) return err({ code: "workspace-preference-unavailable" });
  const databasePath = sqliteDatabasePath(stateRoot);
  if (databasePath === null) return err({ code: "workspace-preference-unavailable" });
  const database = await graph.fileSystem.stat(databasePath, signal);
  if (!database.ok) return err({ code: "workspace-preference-unavailable" });
  if (database.value === null)
    return save ? err({ code: "session-state-required" }) : ok({ profile: null, revision: 0 });
  const opened = await openSessionStore(() => graph, signal);
  if (!opened.ok) return err({ code: "workspace-preference-unavailable" });
  if (opened.kind === "absent")
    return save ? err({ code: "session-state-required" }) : ok({ profile: null, revision: 0 });
  const workspace = await graph.ensureWorkspaceSet(signal);
  if (!workspace.ok) {
    await opened.store.close();
    return err({ code: "workspace-unavailable" });
  }
  const identity = String(primaryWorkspaceRoot(workspace.value.set).rootId);
  const owner = createWorkspaceProfilePreferences(opened.store);
  let result = owner.read(identity);
  if (save && result.ok)
    result = owner.write(
      identity,
      save.profile,
      result.value.revision,
      signal ?? new AbortController().signal,
    );
  // A read does not wait for other processes' readers before closing; a save does.
  const closed = await opened.store.close(signal, { waitForReaders: save !== undefined });
  // A read committed nothing, so a close that could not truncate the log (another
  // Falryn process still reading) leaves its answer intact. A save keeps the strict
  // close so its caller never assumes a write landed when the store is unsettled.
  if (save && !isCleanClose(closed)) return err({ code: "workspace-preference-unavailable" });
  return result;
}
