/** SQLite repository for exact-route provider continuation state (#856). */

import { err, modelId, ok, providerId, type SqliteStorePort } from "../domain/index.ts";
import {
  PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION,
  type ProviderContinuationStateKey,
  type ProviderContinuationStatePort,
  type ProviderContinuationStateRecord,
} from "../providers/index.ts";
import { PROVIDER_CONTINUATION_STATES_TABLE } from "./provider-continuation-schema.ts";

/** Per profile/destination bound. Old state is recovery data, not history. */
export const MAX_DURABLE_PROVIDER_CONTINUATIONS = 256;

function bindings(key: ProviderContinuationStateKey): Record<string, string> {
  return {
    profileId: key.profileId,
    providerId: String(key.providerId),
    destinationId: key.destinationId,
    transportCompatibilityId: key.transportCompatibilityId,
    modelId: String(key.modelId),
    toolCallId: key.toolCallId,
  };
}

function parse(row: Record<string, unknown>): ProviderContinuationStateRecord | null {
  if (
    typeof row.profileId !== "string" ||
    row.profileId.length === 0 ||
    typeof row.providerId !== "string" ||
    row.providerId.length === 0 ||
    typeof row.destinationId !== "string" ||
    row.destinationId.length === 0 ||
    typeof row.transportCompatibilityId !== "string" ||
    row.transportCompatibilityId.length === 0 ||
    typeof row.modelId !== "string" ||
    row.modelId.length === 0 ||
    typeof row.toolCallId !== "string" ||
    row.toolCallId.length === 0 ||
    row.stateSchemaVersion !== PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION ||
    typeof row.stateJson !== "string" ||
    row.stateJson.length === 0 ||
    typeof row.capturedAt !== "number" ||
    !Number.isSafeInteger(row.capturedAt) ||
    row.capturedAt < 0
  ) {
    return null;
  }
  return {
    schemaVersion: PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION,
    profileId: row.profileId,
    providerId: providerId.from(row.providerId),
    destinationId: row.destinationId,
    transportCompatibilityId: row.transportCompatibilityId,
    modelId: modelId.from(row.modelId),
    toolCallId: row.toolCallId,
    stateJson: row.stateJson,
    capturedAt: row.capturedAt,
  };
}

export function createProviderContinuationStateRepository(
  store: SqliteStorePort,
): ProviderContinuationStatePort {
  return {
    load(key) {
      const rows = store.read(
        `SELECT profile_id AS profileId, provider_id AS providerId,
           destination_id AS destinationId,
           transport_compatibility_id AS transportCompatibilityId,
           model_id AS modelId, tool_call_id AS toolCallId,
           state_schema_version AS stateSchemaVersion, state_json AS stateJson,
           captured_at AS capturedAt
         FROM ${PROVIDER_CONTINUATION_STATES_TABLE}
        WHERE profile_id = $profileId
          AND provider_id = $providerId
          AND destination_id = $destinationId
          AND transport_compatibility_id = $transportCompatibilityId
          AND model_id = $modelId
          AND tool_call_id = $toolCallId`,
        bindings(key),
      );
      if (!rows.ok) {
        return err({ code: "unavailable" });
      }
      const row = rows.value[0];
      if (row === undefined) {
        return ok(null);
      }
      const record = parse(row);
      return record === null ? err({ code: "malformed" }) : ok(record);
    },
    save(records) {
      if (records.length === 0) {
        return ok({ inserted: 0, replaced: 0 });
      }
      const written = store.write((statements) => {
        let inserted = 0;
        let replaced = 0;
        for (const record of records) {
          const existing = statements.all(
            `SELECT 1 AS found FROM ${PROVIDER_CONTINUATION_STATES_TABLE}
              WHERE profile_id = $profileId
                AND provider_id = $providerId
                AND destination_id = $destinationId
                AND transport_compatibility_id = $transportCompatibilityId
                AND model_id = $modelId
                AND tool_call_id = $toolCallId`,
            bindings(record),
          )[0];
          statements.run(
            `INSERT INTO ${PROVIDER_CONTINUATION_STATES_TABLE}
              (profile_id, provider_id, destination_id, transport_compatibility_id,
               model_id, tool_call_id, state_schema_version, state_json, captured_at)
             VALUES ($profileId, $providerId, $destinationId, $transportCompatibilityId,
               $modelId, $toolCallId, $stateSchemaVersion, $stateJson, $capturedAt)
             ON CONFLICT (
               profile_id, provider_id, destination_id, transport_compatibility_id,
               model_id, tool_call_id
             ) DO UPDATE SET
               state_schema_version = excluded.state_schema_version,
               state_json = excluded.state_json,
               captured_at = excluded.captured_at`,
            {
              ...bindings(record),
              stateSchemaVersion: record.schemaVersion,
              stateJson: record.stateJson,
              capturedAt: record.capturedAt,
            },
          );
          if (existing === undefined) {
            inserted += 1;
          } else {
            replaced += 1;
          }
        }
        const affectedRoutes = new Map(
          records.map((record) => [
            JSON.stringify([record.profileId, record.destinationId]),
            { profileId: record.profileId, destinationId: record.destinationId },
          ]),
        );
        for (const { profileId, destinationId } of affectedRoutes.values()) {
          statements.run(
            `DELETE FROM ${PROVIDER_CONTINUATION_STATES_TABLE}
              WHERE rowid IN (
                SELECT rowid FROM ${PROVIDER_CONTINUATION_STATES_TABLE}
                 WHERE profile_id = $profileId AND destination_id = $destinationId
                 ORDER BY captured_at DESC, tool_call_id DESC
                 LIMIT -1 OFFSET ${MAX_DURABLE_PROVIDER_CONTINUATIONS}
              )`,
            { profileId, destinationId },
          );
        }
        return { inserted, replaced };
      });
      return written.ok ? ok(written.value.value) : err({ code: "unavailable" });
    },
  };
}
