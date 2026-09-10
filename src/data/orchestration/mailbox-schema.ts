import type { Migration } from "../../domain/storage/index.ts";

export const MAILBOX_TABLES = [
  "peer_endpoints",
  "peer_policies",
  "peer_messages",
  "peer_mailbox_events",
  "peer_subscriptions",
  "peer_delivery_attempts",
  "peer_notifications",
  "peer_cursors",
] as const;
export const MIGRATION_0018: Migration = {
  version: 18,
  name: "authenticated-peer-mailboxes",
  destructive: false,
  statements: [
    "CREATE TABLE peer_subscriptions (id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, deadline INTEGER NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL CHECK(length(CAST(record AS BLOB))<=4096)) STRICT",
    "CREATE INDEX peer_open_subscriptions ON peer_subscriptions(state,deadline)",
    "CREATE TABLE peer_endpoints (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session TEXT NOT NULL, agent TEXT NOT NULL, generation INTEGER NOT NULL, process_generation TEXT NOT NULL, fence_hash TEXT NOT NULL, public_key TEXT NOT NULL, address TEXT NOT NULL, lease_until INTEGER NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL CHECK(length(CAST(record AS BLOB))<=4096), UNIQUE(session,agent,generation)) STRICT",
    "CREATE INDEX peer_endpoint_identity ON peer_endpoints(session,agent,generation)",
    "CREATE TABLE peer_cursors (endpoint TEXT PRIMARY KEY REFERENCES peer_endpoints(id), after INTEGER NOT NULL CHECK(after>=0)) STRICT",
    "CREATE TABLE peer_policies (recipient TEXT NOT NULL REFERENCES peer_endpoints(id), sender TEXT NOT NULL REFERENCES peer_endpoints(id), mode TEXT NOT NULL CHECK(mode IN ('allow','hold','refuse')), muted INTEGER NOT NULL CHECK(muted IN (0,1)), per_minute INTEGER NOT NULL CHECK(per_minute BETWEEN 1 AND 64), PRIMARY KEY(recipient,sender)) STRICT",
    "CREATE TABLE peer_messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, sender TEXT NOT NULL REFERENCES peer_endpoints(id), recipient TEXT NOT NULL REFERENCES peer_endpoints(id), message_id TEXT NOT NULL, lane_sequence INTEGER NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted INTEGER NOT NULL DEFAULT 0 CHECK(accepted IN (0,1)), bytes INTEGER NOT NULL, payload TEXT CHECK(length(CAST(payload AS BLOB))<=32768), receipt TEXT NOT NULL CHECK(length(CAST(receipt AS BLOB))<=4096), UNIQUE(sender,recipient,message_id), UNIQUE(sender,recipient,lane_sequence)) STRICT",
    "CREATE INDEX peer_message_inbox ON peer_messages(recipient,sequence)",
    "CREATE INDEX peer_message_outbox ON peer_messages(sender,sequence)",
    "CREATE TABLE peer_notifications (id TEXT NOT NULL REFERENCES peer_messages(id), endpoint TEXT NOT NULL REFERENCES peer_endpoints(id), kind TEXT NOT NULL CHECK(kind IN ('arrival','settlement')), consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)), PRIMARY KEY(id,endpoint,kind)) STRICT",
    "CREATE TABLE peer_delivery_attempts (id TEXT NOT NULL REFERENCES peer_messages(id), attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3), started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT NOT NULL CHECK(outcome IN ('started','accepted','unavailable')), PRIMARY KEY(id,attempt)) STRICT",
    "CREATE TABLE peer_mailbox_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL REFERENCES peer_messages(id), revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 16), fact TEXT NOT NULL CHECK(fact IN ('transition','conflict')), receipt TEXT NOT NULL CHECK(length(CAST(receipt AS BLOB))<=4096), UNIQUE(id,revision)) STRICT",
  ],
};
