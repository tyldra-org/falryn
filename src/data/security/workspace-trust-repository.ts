import { err, ok } from "../../domain/foundation/result.ts";
import {
  type WorkspaceDecision,
  type WorkspaceTrustStore,
  workspaceDecisionKey,
  workspaceDecisionSchema,
} from "../../domain/security/workspace-trust.ts";
import type { Migration, SqliteStorePort } from "../../domain/storage/index.ts";

export const WORKSPACE_TRUST_TABLE = "workspace_trust_decisions";
export const MIGRATION_0013: Migration = {
  version: 13,
  name: "create-workspace-trust-decisions",
  destructive: false,
  statements: [
    `CREATE TABLE ${WORKSPACE_TRUST_TABLE} (decision_key TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0), decision_json TEXT NOT NULL CHECK (length(CAST(decision_json AS BLOB)) BETWEEN 1 AND 1048576)) STRICT`,
  ],
};
function decode(row: Record<string, unknown>, key: string): WorkspaceDecision | null {
  if (
    typeof row.decision_json !== "string" ||
    new TextEncoder().encode(row.decision_json).length > 1_048_576
  )
    return null;
  try {
    const value = workspaceDecisionSchema.safeParse(JSON.parse(row.decision_json));
    return value.success &&
      value.data.revision === row.revision &&
      workspaceDecisionKey(value.data.inventory.identity, value.data.actor) === key
      ? value.data
      : null;
  } catch {
    return null;
  }
}
export function readWorkspaceTrustDecision(store: Pick<SqliteStorePort, "read">, key: string) {
  const read = store.read(
    "SELECT revision, decision_json FROM workspace_trust_decisions WHERE decision_key = $key",
    { key },
  );
  if (!read.ok) return err({ code: "unavailable" });
  const row = read.value[0];
  if (row === undefined) return ok(null);
  const value = decode(row, key);
  return value === null ? err({ code: "malformed" }) : ok(value);
}
export function createWorkspaceTrustRepository(store: SqliteStorePort): WorkspaceTrustStore {
  return {
    get: (key) => readWorkspaceTrustDecision(store, key),
    replace(key, revision, decision, signal) {
      if (signal?.aborted) return err({ code: "cancelled" });
      const json = JSON.stringify(decision);
      if (
        decision.revision !== revision + 1 ||
        decode({ decision_json: json, revision: decision.revision }, key) === null
      )
        return err({ code: "malformed" });
      const write = store.write((tx) => {
        const previous = tx.all(
          "SELECT revision, decision_json FROM workspace_trust_decisions WHERE decision_key = $key",
          { key },
        )[0];
        if (previous !== undefined && decode(previous, key) === null) return "malformed";
        if ((previous?.revision ?? 0) !== revision) return "conflict";
        tx.run(
          "INSERT INTO workspace_trust_decisions (decision_key, revision, decision_json) VALUES ($key, $revision, $json) ON CONFLICT(decision_key) DO UPDATE SET revision = excluded.revision, decision_json = excluded.decision_json",
          { key, revision: decision.revision, json },
        );
        return null;
      }, signal);
      if (!write.ok)
        return err({ code: write.error.effect === "uncertain" ? "uncertain" : "unavailable" });
      return write.value.value === null ? ok(null) : err({ code: write.value.value });
    },
  };
}
