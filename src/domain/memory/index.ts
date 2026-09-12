/** Public contracts for this capability. Internal modules import their exact dependencies. */

export type {
  MemoryAdmissionContextInput,
  MemoryAdmissionResult,
  MemorySourceKind,
} from "./memory-admission.ts";
export {
  admitMemoryCandidate,
  MEMORY_ADMISSION_VERSION,
  MEMORY_SOURCE_KINDS,
} from "./memory-admission.ts";
export type {
  MemoryExport,
  MemoryExportInput,
  MemoryTelemetryProjection,
} from "./memory-isolation.ts";
export {
  MEMORY_ISOLATION_VERSION,
  projectMemoryExport,
  projectMemoryTelemetry,
} from "./memory-isolation.ts";
export type {
  LatencyBucket,
  ObservationClass,
  ObservationOutcome,
  OperationalObservation,
  OperationalObservationInput,
  OperationalRecommendation,
  OperationalRecommendationInput,
} from "./memory-learning.ts";
export {
  defineOperationalObservation,
  defineOperationalRecommendation,
  LATENCY_BUCKETS,
  MAX_LEARNING_COUNTEREXAMPLES,
  MAX_LEARNING_SUPPORTING,
  MAX_OBSERVATION_IDENTITY_BYTES,
  MAX_OBSERVATION_SAMPLES,
  MAX_RECOMMENDATION_TEXT_BYTES,
  MEMORY_LEARNING_VERSION,
  OBSERVATION_CLASSES,
  OBSERVATION_OUTCOMES,
} from "./memory-learning.ts";
export type {
  MemoryCorrectionInput,
  MemoryDeletion,
  MemoryDeletionInput,
  MemoryExpiryInput,
  MemoryRetainedHandle,
  MemoryRetainedKind,
} from "./memory-lifecycle.ts";
export {
  MAX_MEMORY_RETAINED,
  MAX_MEMORY_RETAINED_LOCATOR_BYTES,
  MEMORY_LIFECYCLE_VERSION,
  MEMORY_RETAINED_KINDS,
  planMemoryCorrection,
  planMemoryDeletion,
  planMemoryExpiry,
  projectExpiredRecord,
} from "./memory-lifecycle.ts";
export type {
  MemoryContradiction,
  MemoryRecallHit,
  MemoryRecallInput,
  MemoryRecallOmission,
  MemoryRecallOmissionReason,
  MemoryRecallResult,
  MemoryRecallSignal,
} from "./memory-recall.ts";
export {
  DEFAULT_MEMORY_RECALL_MAX,
  describeMemoryRecallOmission,
  HARD_MEMORY_RECALL_MAX,
  MAX_MEMORY_RECALL_QUERY_BYTES,
  MEMORY_RECALL_OMISSION_REASONS,
  MEMORY_RECALL_SIGNALS,
  MEMORY_RECALL_VERSION,
  recallMemory,
} from "./memory-recall.ts";
export type {
  MemoryError,
  MemoryErrorCode,
  MemoryKind,
  MemoryOrigin,
  MemoryProvenance,
  MemoryRecord,
  MemoryRecordInput,
  MemoryScope,
  MemoryScopeKind,
} from "./memory-record.ts";
export {
  defineMemoryRecord,
  describeMemoryError,
  FIRST_MEMORY_GENERATION,
  MAX_MEMORY_CONTENT_BYTES,
  MAX_MEMORY_LOCATOR_BYTES,
  MAX_MEMORY_PROVENANCE,
  MAX_MEMORY_PROVENANCE_LOCATOR_BYTES,
  MAX_MEMORY_SUBJECT_BYTES,
  MAX_MEMORY_SUPERSEDES,
  MEMORY_KINDS,
  MEMORY_ORIGINS,
  MEMORY_RECORD_VERSION,
  MEMORY_SCOPE_KINDS,
  MEMORY_SENSITIVITIES,
  memoryScopeWorkspaceId,
} from "./memory-record.ts";

export type {
  ReflectionAuthority,
  ReflectionBinding,
  ReflectionCommand,
  ReflectionFence,
  ReflectionRecord,
  ReflectionRepository,
  ReflectionResult,
} from "./reflection.ts";
export {
  REFLECTION_LIMITS,
  reflectionCommandSchema,
  reflectionRecordSchema,
} from "./reflection.ts";
export type { ReflectionExport, ReflectionView } from "./reflection-export.ts";
export { replayReflection } from "./reflection-export.ts";
