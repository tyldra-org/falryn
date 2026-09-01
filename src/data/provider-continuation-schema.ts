/** Durable provider continuation state added by migration 0010 (#856). */

import type { Migration } from "../domain/index.ts";

export const PROVIDER_CONTINUATION_STATES_TABLE = "provider_continuation_states";
export const PROVIDER_CONTINUATION_SCHEMA_VERSION = 10;

const CREATE_PROVIDER_CONTINUATION_STATES = `CREATE TABLE ${PROVIDER_CONTINUATION_STATES_TABLE} (
  profile_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  transport_compatibility_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  state_schema_version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (
    profile_id, provider_id, destination_id, transport_compatibility_id,
    model_id, tool_call_id
  ),
  CHECK (length(profile_id) > 0),
  CHECK (length(provider_id) > 0),
  CHECK (length(destination_id) > 0),
  CHECK (length(transport_compatibility_id) > 0),
  CHECK (length(model_id) > 0),
  CHECK (length(tool_call_id) > 0),
  CHECK (state_schema_version = 1),
  CHECK (length(state_json) > 0),
  CHECK (captured_at >= 0)
) STRICT`;

const CREATE_PROVIDER_CONTINUATION_STATES_BY_AGE = `CREATE INDEX provider_continuation_states_by_age
  ON ${PROVIDER_CONTINUATION_STATES_TABLE}
  (profile_id, destination_id, captured_at DESC, tool_call_id)`;

export const MIGRATION_0010: Migration = {
  version: PROVIDER_CONTINUATION_SCHEMA_VERSION,
  name: "create-provider-continuation-states",
  statements: [CREATE_PROVIDER_CONTINUATION_STATES, CREATE_PROVIDER_CONTINUATION_STATES_BY_AGE],
  destructive: false,
};
