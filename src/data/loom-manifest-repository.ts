/** SQLite repository for validated Loom manifests (#788). */

import {
  type ClockPort,
  commitLoomManifest,
  err,
  type LoomManifest,
  ok,
  type Result,
  type SqliteStorePort,
} from "../domain/index.ts";
import { LOOM_MANIFESTS_TABLE } from "./loom-schema.ts";

export type LoomManifestStorageError = {
  readonly code: "conflict" | "malformed" | "unavailable";
};

export type LoomManifestRepository = {
  get(id: string): Result<LoomManifest | null, LoomManifestStorageError>;
  insert(manifest: LoomManifest): Result<null, LoomManifestStorageError>;
};

export type LoomManifestRepositoryOptions = {
  readonly store: SqliteStorePort;
  readonly clock: ClockPort;
};

function parseManifest(value: unknown): Result<LoomManifest, LoomManifestStorageError> {
  if (typeof value !== "string") {
    return err({ code: "malformed" });
  }
  try {
    const raw = JSON.parse(value) as LoomManifest;
    const parsed = commitLoomManifest({
      id: raw.id,
      workspaceId: raw.workspaceId,
      sessionId: raw.sessionId,
      members: raw.members,
      generation: raw.generation,
      ...(raw.retentionUntil === null ? {} : { retentionUntil: raw.retentionUntil }),
    });
    return parsed.ok ? ok(parsed.value) : err({ code: "malformed" });
  } catch {
    return err({ code: "malformed" });
  }
}

export function createLoomManifestRepository(
  options: LoomManifestRepositoryOptions,
): LoomManifestRepository {
  const store = options.store;
  return {
    get(id) {
      const rows = store.read(
        `SELECT manifest_json AS manifestJson
           FROM ${LOOM_MANIFESTS_TABLE}
          WHERE manifest_id = $id`,
        { id },
      );
      if (!rows.ok) {
        return err({ code: "unavailable" });
      }
      const row = rows.value[0];
      return row === undefined ? ok(null) : parseManifest(row.manifestJson);
    },
    insert(manifest) {
      const written = store.write((statements) => {
        const existing = statements.all(
          `SELECT manifest_id FROM ${LOOM_MANIFESTS_TABLE} WHERE manifest_id = $id`,
          { id: manifest.id },
        );
        if (existing.length > 0) {
          return "conflict" as const;
        }
        statements.run(
          `INSERT INTO ${LOOM_MANIFESTS_TABLE}
            (manifest_id, workspace_id, session_id, manifest_json, created_at)
           VALUES ($id, $workspaceId, $sessionId, $manifestJson, $createdAt)`,
          {
            id: manifest.id,
            workspaceId: manifest.workspaceId,
            sessionId: manifest.sessionId,
            manifestJson: JSON.stringify(manifest),
            createdAt: options.clock.now(),
          },
        );
        return "inserted" as const;
      });
      if (!written.ok) {
        return err({ code: "unavailable" });
      }
      return written.value.value === "conflict" ? err({ code: "conflict" }) : ok(null);
    },
  };
}
