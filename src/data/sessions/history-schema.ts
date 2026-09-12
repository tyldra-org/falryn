/** Index semantic artifact references in the authoritative event payload. */
import type { Migration } from "../../domain/storage/index.ts";
export const MIGRATION_0026: Migration = {
  version: 26,
  name: "index-semantic-history-artifacts",
  destructive: false,
  statements: [
    `CREATE INDEX history_restore_points ON events (stream_id, json_extract(payload, '$.payload.restorePointId'), sequence) WHERE kind = 'history.recorded'`,
    `CREATE INDEX history_artifacts_by_stream ON events
      (stream_id, json_extract(payload, '$.payload.evidence.artifactId'))
      WHERE kind = 'history.recorded'`,
  ],
};

/** A tombstone retires recovery coverage even while maintenance has not removed bytes. */
const LIVE_REFERENCE = `NOT EXISTS (SELECT 1 FROM events retired WHERE retired.stream_id = e.stream_id AND retired.kind = 'history.recorded' AND json_extract(retired.payload, '$.payload.restorePointId') = json_extract(e.payload, '$.payload.restorePointId') AND json_extract(retired.payload, '$.payload.stage') IN ('expired', 'deleted'))`;
function seeds(includeRetired: boolean) {
  const policy = includeRetired ? "1" : LIVE_REFERENCE;
  return `SELECT a.artifact_id AS artifactId FROM artifacts a JOIN invocations i ON i.invocation_id = a.invocation_id JOIN turns t ON t.turn_id = i.turn_id WHERE t.session_id = $sessionId
  UNION
  SELECT json_extract(e.payload, '$.payload.evidence.artifactId') AS artifactId FROM events e JOIN sessions s ON s.stream_id = e.stream_id WHERE s.session_id = $sessionId AND e.kind = 'history.recorded' AND json_extract(e.payload, '$.payload.evidence.artifactId') IS NOT NULL AND ${policy}
  UNION
  SELECT json_extract(r.value, '$.artifactId') AS artifactId FROM events e JOIN sessions s ON s.stream_id = e.stream_id, json_each(e.payload, '$.payload.references') r WHERE s.session_id = $sessionId AND e.kind = 'history.recorded' AND json_extract(r.value, '$.availability') = 'retained' AND ${policy}
  LIMIT $limit`;
}
export const SESSION_ARTIFACT_SEEDS = seeds(false);
/** Export inventories count retired references as explicit omissions. */
export const ALL_SESSION_ARTIFACT_SEEDS = seeds(true);

export function historyArtifactRetirement(
  store: import("../../domain/storage/index.ts").SqliteStorePort,
  sessionId: string | null,
  artifactId: string,
) {
  const rows = store.read(
    `SELECT 1 AS retired FROM events e JOIN sessions s ON s.stream_id = e.stream_id WHERE ($sessionId IS NULL OR s.session_id = $sessionId) AND e.kind = 'history.recorded' AND NOT (${LIVE_REFERENCE}) AND (json_extract(e.payload, '$.payload.evidence.artifactId') = $artifactId OR EXISTS (SELECT 1 FROM json_each(e.payload, '$.payload.references') r WHERE json_extract(r.value, '$.artifactId') = $artifactId)) LIMIT 1`,
    { sessionId, artifactId },
  );
  return rows.ok ? { ok: true as const, value: rows.value.length > 0 } : rows;
}
