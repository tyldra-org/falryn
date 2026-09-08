/** Durable task metadata and notification delivery. Artifact bytes retain their existing owner. */
import type { Result } from "../foundation/result.ts";
import type { ProcessStreamName } from "../process/process-capture.ts";
import type {
  ProcessTaskArtifact,
  ProcessTaskFence,
  ProcessTaskHandle,
  ProcessTaskSnapshot,
  ProcessTaskTransition,
} from "./process-task.ts";

export type ProcessTaskStoreError = {
  readonly code:
    | "invalid-record"
    | "not-found"
    | "stale-generation"
    | "stale-revision"
    | "ownership-unavailable"
    | "invalid-transition"
    | "sealed"
    | "capacity"
    | "busy"
    | "cancelled"
    | "storage-unavailable"
    | "event-rejected"
    | "notification-unavailable";
};
export type ProcessTaskWrite<Value> = {
  readonly value: Value;
  readonly cancelledAfterCommit: boolean;
};
export type ProcessTaskChunk = {
  readonly handle: ProcessTaskHandle;
  readonly stream: ProcessStreamName;
  readonly offset: number;
  readonly artifact: ProcessTaskArtifact;
};
export type ProcessTaskWake = {
  readonly notificationId: string;
  readonly handle: ProcessTaskHandle;
  readonly terminalEventId: string;
  readonly attempts: number;
  readonly state: "pending" | "acknowledged" | "unavailable";
};
export type ProcessTaskRecoveryReason = "supervisor-vanished" | "supervisor-replaced";

/** The caller supplies current authority separately; stored ownership never grants permission. */
export type ProcessTaskStore = {
  create(
    task: ProcessTaskSnapshot,
    signal?: AbortSignal,
  ): Result<ProcessTaskWrite<ProcessTaskSnapshot>, ProcessTaskStoreError>;
  get(handle: ProcessTaskHandle): Result<ProcessTaskSnapshot, ProcessTaskStoreError>;
  cleaned(handle: ProcessTaskHandle): Result<ProcessTaskSnapshot, ProcessTaskStoreError>;
  list(): Result<readonly ProcessTaskSnapshot[], ProcessTaskStoreError>;
  transition(
    fence: ProcessTaskFence,
    change: ProcessTaskTransition,
    now: number,
    signal?: AbortSignal,
  ): Result<ProcessTaskWrite<ProcessTaskSnapshot>, ProcessTaskStoreError>;
  renew(
    fence: ProcessTaskFence,
    now: number,
    signal?: AbortSignal,
  ): Result<ProcessTaskWrite<ProcessTaskSnapshot>, ProcessTaskStoreError>;
  /** Compare the exact observed snapshot, including its lease, before sealing interrupted ownership. */
  reconcile(
    expected: ProcessTaskSnapshot,
    reason: ProcessTaskRecoveryReason,
    now: number,
    signal?: AbortSignal,
  ): Result<ProcessTaskWrite<ProcessTaskSnapshot>, ProcessTaskStoreError>;
  appendChunk(
    fence: ProcessTaskFence,
    chunk: ProcessTaskChunk,
    now: number,
    signal?: AbortSignal,
  ): Result<ProcessTaskWrite<null>, ProcessTaskStoreError>;
  chunks(
    handle: ProcessTaskHandle,
    stream: ProcessStreamName,
  ): Result<readonly ProcessTaskChunk[], ProcessTaskStoreError>;
  wake(handle: ProcessTaskHandle): Result<ProcessTaskWake, ProcessTaskStoreError>;
  claimWake(
    handle: ProcessTaskHandle,
    signal?: AbortSignal,
  ): Result<ProcessTaskWrite<ProcessTaskWake>, ProcessTaskStoreError>;
  acknowledgeWake(
    handle: ProcessTaskHandle,
    notificationId: string,
    signal?: AbortSignal,
  ): Result<ProcessTaskWrite<ProcessTaskWake>, ProcessTaskStoreError>;
  cleanup(
    handle: ProcessTaskHandle,
    expectedRevision: number,
    now: number,
    signal?: AbortSignal,
  ): Result<ProcessTaskWrite<null>, ProcessTaskStoreError>;
};
