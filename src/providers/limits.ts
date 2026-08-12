/**
 * Declared bounds for provider-boundary payloads.
 *
 * These limits are part of the contract: narrowing one is a breaking change for
 * readers of normalized requests and stream events, so each value is named and
 * asserted by tests rather than inlined at a use site.
 */

/** Stable name of the provider request/event schema family. */
export const PROVIDER_BOUNDARY_SCHEMA_FAMILY = "falryn.provider-boundary";

/** Schema version this build writes and fully interprets. */
export const PROVIDER_BOUNDARY_SCHEMA_VERSION = 1;

/** Oldest schema version this build accepts. */
export const PROVIDER_BOUNDARY_MINIMUM_SCHEMA_VERSION = 1;

/** Maximum UTF-16 length of a single message text or delta fragment. */
export const MAX_MESSAGE_TEXT_LENGTH = 256 * 1024;

/** Maximum messages on one model request. */
export const MAX_REQUEST_MESSAGES = 512;

/** Maximum tool definitions on one model request. */
export const MAX_REQUEST_TOOLS = 128;

/** Maximum length of a tool name. */
export const MAX_TOOL_NAME_LENGTH = 128;

/** Maximum JSON-schema / argument fragment size, in UTF-16 code units. */
export const MAX_TOOL_ARGUMENT_FRAGMENT_LENGTH = 256 * 1024;

/** Maximum length of a finish-reason token. */
export const MAX_FINISH_REASON_LENGTH = 64;

/** Maximum length of provider metadata keys/values that may appear in events. */
export const MAX_PROVIDER_METADATA_ENTRY_LENGTH = 256;

/** Maximum provider metadata entries on one event. */
export const MAX_PROVIDER_METADATA_ENTRIES = 32;
