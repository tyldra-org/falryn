/** Public contracts for this capability. Internal modules import their exact dependencies. */

export type {
  BriefComposer,
  BriefComposerError,
  BriefComposerResult,
} from "./brief.ts";
export { briefSection, createBriefComposer } from "./brief.ts";
export type {
  CavemanIntensity,
  CavemanPolicyError,
  CavemanSourcePort,
  PinnedCavemanPolicy,
} from "./brief-comparison.ts";
export {
  CAVEMAN_ADAPTER_VERSION,
  CAVEMAN_INTENSITIES,
  CAVEMAN_PINNED_COMMIT,
  CAVEMAN_PINNED_SKILL_DIGEST,
  CAVEMAN_PINNED_SKILL_PATH,
  loadPinnedCavemanPolicy,
} from "./brief-comparison.ts";
export type {
  CompactLaneError,
  CompactLaneRequest,
  CompactLanes,
  HistoryLaneRequest,
  OverflowLaneRequest,
  WindowPreviewRequest,
} from "./compact-lanes.ts";
export { compactToEvidence, createCompactLanes } from "./compact-lanes.ts";
export type {
  CompressionEvalPort,
  CompressionEvalPortError,
} from "./compression-eval.ts";
export {
  createCompressionEvaluator,
  observationFromCompact,
  observationFromHistoryCheckpoint,
  observationFromStructural,
} from "./compression-eval.ts";
export type {
  HushEvidenceRequest,
  HushIntegrator,
  HushIntegratorOptions,
  HushObservation,
  HushObservationError,
  HushObserveRequest,
  HushOrigin,
  HushReduceRequest,
} from "./hush.ts";
export { createHushIntegrator, expectedFamiliesForOrigin, HUSH_ORIGINS } from "./hush.ts";
export type {
  LoomAdoptMember,
  LoomAdoptRequest,
  LoomEvidenceRequest,
  LoomIngestMember,
  LoomIngestRequest,
  LoomIngestResult,
  LoomManifestPersistencePort,
  LoomPort,
  LoomPortError,
  LoomPortOptions,
  LoomRetrieveRequest,
} from "./loom.ts";
export { createLoomPort, loomProjectionToEvidence } from "./loom.ts";
export type {
  ProductBriefContextState,
  ProductBriefControls,
  ProductBriefControlsOptions,
  ProductBriefFrontendMode,
  ProductBriefMode,
  ProductBriefModeError,
  ProductBriefTurnInput,
} from "./product-brief.ts";
export {
  briefNeedAfterContext,
  briefNeedAfterToolResults,
  classifyProductBriefComplexity,
  composeProductBriefControls,
  deriveProductBriefNeed,
  describeBriefVerbosityModes,
  isProductBriefFrontendMode,
  isProductBriefMode,
  PRODUCT_BRIEF_FRONTEND_MODES,
  PRODUCT_BRIEF_MODES,
  PRODUCT_BRIEF_OWNER,
  productBriefModeFromFrontend,
} from "./product-brief.ts";
export type { ProductHushHarnessProjection } from "./product-hush-projection.ts";
export {
  PRODUCT_HUSH_PROJECTION_OWNER,
  projectHushForHarness,
} from "./product-hush-projection.ts";
export type {
  ProductLoomContext,
  ProductLoomContextPorts,
  ProductLoomRecoveryHandle,
} from "./product-loom.ts";
export { composeProductLoomContext, PRODUCT_LOOM_OWNER } from "./product-loom.ts";
export type {
  ProductEngineFrontendState,
  ProductOutputControlError,
  ProductOutputControls,
  ProductOutputControlsOptions,
} from "./product-output-controls.ts";
export {
  composeProductOutputControls,
  PRODUCT_ENGINE_FRONTEND_STATES,
} from "./product-output-controls.ts";
export type {
  ProductProcessObservation,
  ProductProcessOutputMode,
  ProductProcessOutputPorts,
  ProductProcessRecoveryHandle,
} from "./product-process-output.ts";
export {
  MAX_PRODUCT_PROCESS_HUSH_BYTES,
  MAX_PRODUCT_PROCESS_MODEL_BYTES,
  MAX_PRODUCT_PROCESS_RAW_INLINE_BYTES,
  PRODUCT_PROCESS_OUTPUT_MODES,
  PRODUCT_PROCESS_OUTPUT_OWNER,
  projectProductProcessOutput,
} from "./product-process-output.ts";
export type {
  StructuralEvidenceRequest,
  StructuralPortError,
  StructuralReduceRequest,
  StructuralReducer,
} from "./structural-reduce.ts";
export { createStructuralReducer, structuralToEvidence } from "./structural-reduce.ts";
