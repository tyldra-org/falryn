/** Public contracts for this capability. Internal modules import their exact dependencies. */

export type {
  InspectedWorkspaceSession,
  InspectWorkspaceSessionError,
  InspectWorkspaceSessionInput,
  QueryWorkspaceSessionsInput,
} from "./session-catalog.ts";
export {
  editWorkspaceSessionCatalog,
  inspectWorkspaceSession,
  queryWorkspaceSessions,
} from "./session-catalog.ts";
export type { WorkspaceBinding } from "./session-isolation.ts";
export { isolateWorkspaceSessions } from "./session-isolation.ts";
export type { PlanWorkspaceSessionRecoveryInput } from "./session-recovery.ts";
export { planWorkspaceSessionRecovery } from "./session-recovery.ts";
export type { ControlWorkspaceSessionReplayInput } from "./session-replay-control.ts";
export { controlWorkspaceSessionReplay } from "./session-replay-control.ts";
export type { ResumeWorkspaceSessionInput } from "./session-resume.ts";
export { resumeWorkspaceSession } from "./session-resume.ts";
export type { RewindWorkspaceSessionInput } from "./session-rewind.ts";
export { rewindWorkspaceSession } from "./session-rewind.ts";
export type {
  OpenSessionInput,
  SessionCommandInput,
  SessionRuntime,
  SessionRuntimeError,
  SessionRuntimeResult,
} from "./session-runtime.ts";
export { createSessionRuntime } from "./session-runtime.ts";
export type {
  ProducerError,
  ProducerExecutionProfileInput,
  ProducerModelAttemptInput,
  ProducerResult,
  ProducerSessionInput,
  ProducerToolInvocationInput,
  ProducerTurnInput,
  SessionTurnTranscriptProducer,
  SessionTurnTranscriptProducerOptions,
} from "./session-turn-transcript-producer.ts";
export { createSessionTurnTranscriptProducer } from "./session-turn-transcript-producer.ts";
