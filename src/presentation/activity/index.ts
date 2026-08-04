/**
 * The activity projection's contract, in one place.
 *
 * Everything here is plain data derived from facts the runtime already owns: its
 * scope lifecycle, its scheduler and queue reports, its shutdown state. Nothing
 * declares a second outcome vocabulary, nothing holds a runtime handle, and
 * nothing can restart anything — which is the strongest form the "resubscribe
 * without restarting the runtime" criterion can take.
 */

export type { ActivityEntry, ActivitySource } from "./entries.ts";
export {
  ACTIVITY_SOURCES,
  describeActivity,
  entryForEvent,
  foldEntry,
  isLive,
} from "./entries.ts";
export type {
  HealthFact,
  HealthInput,
  HealthLevel,
  RuntimeHealth,
  ShutdownState,
} from "./health.ts";
export { HEALTH_LEVELS, NO_HEALTH_INPUT, projectHealth } from "./health.ts";
export type { ActivityCursor, ActivityProjection } from "./reducer.ts";
export {
  ACTIVITY_PROJECTION_GENERATION,
  EMPTY_ACTIVITY,
  initialActivityCursor,
  liveEntries,
  MAX_SETTLED_ENTRIES,
  reduceActivity,
  resubscribeActivity,
  resumableActivity,
  settledEntries,
} from "./reducer.ts";
