import { err, ok } from "../../domain/foundation/result.ts";
import type { Migration, SqliteStorePort } from "../../domain/storage/index.ts";

export const WORKSPACE_PROFILE_TABLE = "workspace_profile_preferences";
export const MIGRATION_0028: Migration = {
  version: 28,
  name: "create-workspace-profile-preferences",
  destructive: false,
  statements: [
    `CREATE TABLE ${WORKSPACE_PROFILE_TABLE} (workspace_id TEXT PRIMARY KEY, profile TEXT, revision INTEGER NOT NULL CHECK (revision > 0)) STRICT`,
  ],
};

/** Personal workspace choice, separate from trusted project configuration. */
export function createWorkspaceProfilePreferences(store: SqliteStorePort) {
  return {
    read(workspace: string) {
      const rows = store.read(
        `SELECT profile, revision FROM ${WORKSPACE_PROFILE_TABLE} WHERE workspace_id = $workspace`,
        { workspace },
      );
      if (!rows.ok) return err({ code: "workspace-preference-unavailable" });
      const row = rows.value[0];
      if (!row) return ok({ profile: null, revision: 0 });
      if (
        (row.profile !== null &&
          (typeof row.profile !== "string" ||
            !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(row.profile))) ||
        !Number.isSafeInteger(row.revision)
      )
        return err({ code: "workspace-preference-malformed" });
      return ok({ profile: row.profile as string | null, revision: row.revision as number });
    },
    write(workspace: string, profile: string | null, revision: number, signal: AbortSignal) {
      if (signal.aborted) return err({ code: "cancelled" });
      if (
        !workspace ||
        workspace.length > 256 ||
        (profile !== null && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profile))
      )
        return err({ code: "workspace-preference-invalid" });
      const written = store.write((tx) => {
        const previous = tx.all(
          `SELECT revision FROM ${WORKSPACE_PROFILE_TABLE} WHERE workspace_id = $workspace`,
          { workspace },
        )[0];
        if ((previous?.revision ?? 0) !== revision) return false;
        tx.run(
          `INSERT INTO ${WORKSPACE_PROFILE_TABLE} (workspace_id, profile, revision) VALUES ($workspace, $profile, $revision) ON CONFLICT(workspace_id) DO UPDATE SET profile = excluded.profile, revision = excluded.revision`,
          { workspace, profile, revision: revision + 1 },
        );
        return true;
      }, signal);
      return written.ok && written.value.value
        ? ok({ profile, revision: revision + 1 })
        : err({
            code: written.ok ? "workspace-preference-conflict" : "workspace-preference-unavailable",
          });
    },
  };
}
