/**
 * Declared bounds for the runtime-event schema family.
 *
 * Every bound here is part of the contract: narrowing one is a breaking change
 * for readers, so each limit is named, exported, and asserted by tests rather
 * than inlined at a use site.
 */

/**
 * Stable name of this schema family.
 *
 * Its source owner is `src/domain/wire.ts`; every other representation of a
 * runtime event, including the persisted row, is a derivative of it.
 */
export const RUNTIME_EVENT_SCHEMA_FAMILY = "falryn.runtime-event";

/** Schema version this build writes and is able to fully interpret. */
export const RUNTIME_EVENT_SCHEMA_VERSION = 1;

/**
 * Lowest `schemaVersion` this build accepts. Older durable events are migrated
 * by their producer, not silently reinterpreted here.
 */
export const RUNTIME_EVENT_MINIMUM_SCHEMA_VERSION = 1;

/** Maximum encoded size of a single event, in bytes. */
export const MAX_EVENT_BYTES = 64 * 1024;

/** Maximum length of any branded identifier, in UTF-16 code units. */
export const MAX_IDENTIFIER_LENGTH = 128;

/** Maximum number of events one `EventStorePort.readFrom` call may return. */
export const MAX_STREAM_READ_LIMIT = 1000;

/**
 * Maximum queued follow-up entries on one session (#611).
 *
 * Overflow refuses the new entry without mutating the existing queue.
 */
export const MAX_FOLLOW_UP_QUEUE_ENTRIES = 8;

/**
 * Maximum total UTF-16 code units across all queued follow-up request texts
 * on one session (#611).
 */
export const MAX_FOLLOW_UP_QUEUE_TEXT_UNITS = 64 * 1024;
