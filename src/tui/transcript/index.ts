/**
 * The transcript surface's contract, in one place.
 *
 * Everything exported here is a pure value or function: rows, spans, anchors,
 * and a reducer over intent. The component that mounts them is
 * `../components/transcript.tsx`, and it is the only part of this surface that
 * needs a renderer — which is why every rule this surface promises can be
 * asserted without one.
 */

export type {
  TranscriptIncludeDraftRequest,
  TranscriptIncludeDraftResult,
} from "./include.ts";
export { includeTranscriptInDraft } from "./include.ts";
export type { BlockInspection, InspectionFact, InspectionFamily } from "./inspect.ts";
export {
  describeTerminalOutcome,
  hasDiagnostics,
  INSPECTABLE_KINDS,
  inspectBlock,
  inspectionFor,
  isInspectableKind,
  sliceInspection,
} from "./inspect.ts";
export type { DrawableLine } from "./lines.ts";
export { drawableLine, drawableLines } from "./lines.ts";
export type { BlockDescriptor, HeightBatch, HeightKind, HeightRecord } from "./measure.ts";
export { EMPTY_HEIGHT_BATCH, reconcileHeights } from "./measure.ts";
export { commandForRoute, describeRouteWith } from "./routes.ts";
export type { DisclosureNotice, RowsRequest, TranscriptRow } from "./rows.ts";
export {
  collapsedRows,
  disclosureNotice,
  EXPANSION_INDENT,
  relativeTime,
  rowsForBlock,
  statusOfBlock,
} from "./rows.ts";
export type { TranscriptSurfaceAction, TranscriptSurfaceState } from "./surface.ts";
export {
  INITIAL_TRANSCRIPT_STATE,
  keysOf,
  neighbourKey,
  transcriptSurfaceReducer,
} from "./surface.ts";
export type {
  BlockSpan,
  SpanIndex,
  TranscriptAnchor,
  TranscriptWindow,
  WindowRequest,
} from "./window.ts";
export {
  anchorAt,
  anchorOn,
  anchorRevealing,
  DEFAULT_OVERSCAN,
  LATEST,
  scrolledBy,
  spanIndexOf,
  startRowOf,
  topRowOf,
  topRowOn,
  totalRowsOf,
  windowFor,
  windowOn,
} from "./window.ts";
