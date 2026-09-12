/** Public contracts for this capability. Internal modules import their exact dependencies. */

export type { MemoryPersistencePort } from "./durable-memory-records.ts";
export { createDurableMemoryRecords } from "./durable-memory-records.ts";
export type { MemoryAdmissionPort } from "./memory-admission.ts";
export { createMemoryAdmission } from "./memory-admission.ts";
export type { MemoryIsolation } from "./memory-isolation.ts";
export { createMemoryIsolation } from "./memory-isolation.ts";
export type { OperationalLearning } from "./memory-learning.ts";
export { createOperationalLearning } from "./memory-learning.ts";
export type { MemoryLifecycle } from "./memory-lifecycle.ts";
export { createMemoryLifecycle } from "./memory-lifecycle.ts";
export type { MemoryRecallPort } from "./memory-recall.ts";
export { createMemoryRecall } from "./memory-recall.ts";
export type { MemoryRecords } from "./memory-record.ts";
export { createMemoryRecords } from "./memory-record.ts";
export type {
  ProductMemoryAdmissionResult,
  ProductMemoryRecallResult,
  ProductMemoryTurn,
  ProductMemoryTurnPorts,
} from "./product-memory-turn.ts";
export { composeProductMemoryTurn } from "./product-memory-turn.ts";
export type {
  ReflectionCoverage,
  ReflectionMetadata,
  ReflectionResponse,
} from "./reflection-actions.ts";
export { createReflectionActions } from "./reflection-actions.ts";
