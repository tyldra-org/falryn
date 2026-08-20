/**
 * Shared projections.
 *
 * The area both the terminal interface and the headless renderers can consume
 * without either owning the other's shape. A projection here is plain data
 * derived from semantic events: no renderer, no React, no stream, no clock, no
 * database, and no colour — which `src/presentation-boundaries.test.ts` asserts
 * rather than trusts.
 *
 * The dependency direction is one-way and deliberate. This area imports from
 * `src/domain/` and nothing else in the tree imports *into* it from a layer
 * above. A transcript that could reach a renderer would be a transcript that
 * could only be tested with a terminal attached.
 */

export type {
  ActivityCursor,
  ActivityEntry,
  ActivityProjection,
  ActivitySource,
  HealthFact,
  HealthInput,
  HealthLevel,
  RuntimeHealth,
  ShutdownState,
} from "./activity/index.ts";
export {
  ACTIVITY_PROJECTION_GENERATION,
  ACTIVITY_SOURCES,
  describeActivity,
  EMPTY_ACTIVITY,
  entryForEvent,
  foldEntry,
  HEALTH_LEVELS,
  initialActivityCursor,
  isLive,
  liveEntries,
  MAX_SETTLED_ENTRIES,
  NO_HEALTH_INPUT,
  projectHealth,
  reduceActivity,
  resubscribeActivity,
  resumableActivity,
  settledEntries,
} from "./activity/index.ts";
export type {
  ChangeBucket,
  ChangeRow,
  ChangesDashboardInput,
  ChangesDashboardModel,
  ChangesTab,
  CheckpointRow,
  WorktreeRow,
} from "./git/dashboard.ts";
export {
  CHANGE_BUCKETS,
  CHANGES_TABS,
  changesDashboardFrom,
  rowsForTab,
} from "./git/dashboard.ts";
export type {
  TranscriptBlockAdmissionError,
  TranscriptBlockAdmissionErrorCode,
  TranscriptRecordInput,
} from "./transcript/admit.ts";
export {
  admitTranscriptRecord,
  describeTranscriptBlockAdmissionError,
  MAX_OBSERVED_KIND_CHARS,
  TRANSCRIPT_BLOCK_ADMISSION_ERROR_CODES,
} from "./transcript/admit.ts";
export {
  artifactOriginFor,
  blockOffersOpenArtifact,
  blockSelectsCodeViewer,
  primaryArtifactId,
} from "./transcript/artifact-open.ts";
export type {
  ArtifactBlock,
  BlockAnchor,
  BlockSensitivity,
  BlockSource,
  BlockStatus,
  DiagnosticBlock,
  FileChange,
  FileChangeBlock,
  ModelOutcomeBlock,
  ModelReasoningBlock,
  ModelTextBlock,
  NoticeBlock,
  ProcessExitBlock,
  ProcessStreamBlock,
  RepositoryActivity,
  RepositoryActivityBlock,
  TaskProgressBlock,
  ToolProgressBlock,
  ToolRequestBlock,
  ToolResultBlock,
  TranscriptBlock,
  TranscriptBlockKind,
  TranscriptRenderableKind,
  TurnOutcomeBlock,
  UnknownBlock,
  UserInputBlock,
} from "./transcript/blocks.ts";
export {
  BLOCK_SENSITIVITIES,
  BLOCK_SOURCES,
  BLOCK_STATUSES,
  blockKey,
  boundedTextsOf,
  describeBlock,
  expansionRoutesFor,
  FILE_CHANGES,
  isTranscriptBlockKind,
  outcomeOf,
  REPOSITORY_ACTIVITIES,
  TRANSCRIPT_BLOCK_KINDS,
  UNKNOWN_TRANSCRIPT_BLOCK_KIND,
} from "./transcript/blocks.ts";
export type { CoalescedTranscript } from "./transcript/coalesce.ts";
export { applyRevision, coalesce, EMPTY_TRANSCRIPT } from "./transcript/coalesce.ts";
export type {
  BoundedText,
  Disclosure,
  ExpansionRoute,
  Extent,
  RetentionLimits,
} from "./transcript/disclosure.ts";
export {
  bound,
  complete,
  describeDisclosure,
  EXPANSION_ROUTES,
  isComplete,
  measureExtent,
  omitted,
  RETENTION_LIMITS,
  redacted,
  routeOf,
} from "./transcript/disclosure.ts";
export type { ResumePoint, SequenceAnomaly } from "./transcript/gaps.ts";
export { describeAnomaly, detectAnomalies } from "./transcript/gaps.ts";
export type { TranscriptCursor } from "./transcript/generation.ts";
export {
  initialCursor,
  resumable,
  TRANSCRIPT_PROJECTION_GENERATION,
} from "./transcript/generation.ts";
export type { TranscriptIncludePick } from "./transcript/picks.ts";
export { includeBodiesOf, pickTranscriptIncludeBody } from "./transcript/picks.ts";
export type { TranscriptProjection } from "./transcript/reducer.ts";
export { blockFor, EMPTY_PROJECTION, reduceTranscript } from "./transcript/reducer.ts";
export type { CodeViewModel } from "./viewer/index.ts";
export { codeViewFrom } from "./viewer/index.ts";
