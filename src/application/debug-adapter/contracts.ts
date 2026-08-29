/** Public contracts for the supervised Debug Adapter Protocol client. */

import type {
  ArtifactStorePort,
  DebugAdapterError,
  DebugAdapterEvent,
  DebugAdapterSnapshot,
  DebugAdapterStartRequest,
  DebugAttachRequest,
  DebugCancelRequest,
  DebugConfirmation,
  DebugConfirmationKind,
  DebugConfirmationRequest,
  DebugDisconnectRequest,
  DebugEvaluateRequest,
  DebugEvaluateResult,
  DebugLaunchRequest,
  DebugScope,
  DebugSessionArtifactRef,
  DebugSetBreakpointsRequest,
  DebugSetBreakpointsResult,
  DebugStackFrame,
  DebugTerminateRequest,
  DebugThread,
  DebugVariableProjection,
  ManagedServiceId,
  ServiceGeneration,
} from "../../domain/index.ts";
import type { Result } from "../../domain/result.ts";

export type DebugAdapterListener = (event: DebugAdapterEvent) => void;

export type DebugAdapterSupervisorOptions = {
  readonly confirmationPolicy?: "require" | "auto-allow" | undefined;
  readonly artifacts?: ArtifactStorePort | null | undefined;
};

type DebugConfirmationOption = {
  readonly confirmation?: DebugConfirmation | undefined;
};

export type DebugAdapterSupervisor = {
  start(
    request: DebugAdapterStartRequest,
    signal?: AbortSignal,
  ): Promise<Result<DebugAdapterSnapshot, DebugAdapterError>>;
  prepareConfirmation(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    kind: DebugConfirmationKind,
    normalizedInput: Readonly<Record<string, unknown>>,
  ): Result<DebugConfirmationRequest, DebugAdapterError>;
  captureSessionArtifact(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    signal?: AbortSignal,
  ): Promise<Result<DebugSessionArtifactRef, DebugAdapterError>>;
  disconnect(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    options?: DebugDisconnectRequest &
      DebugConfirmationOption & {
        readonly signal?: AbortSignal | undefined;
      },
  ): Promise<Result<DebugAdapterSnapshot, DebugAdapterError>>;
  terminate(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request?: DebugTerminateRequest & DebugConfirmationOption,
    signal?: AbortSignal,
  ): Promise<Result<DebugAdapterSnapshot, DebugAdapterError>>;
  cancel(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: DebugCancelRequest,
    signal?: AbortSignal,
  ): Promise<Result<DebugAdapterSnapshot, DebugAdapterError>>;
  setBreakpoints(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: DebugSetBreakpointsRequest,
    signal?: AbortSignal,
  ): Promise<Result<DebugSetBreakpointsResult, DebugAdapterError>>;
  configurationDone(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    signal?: AbortSignal,
  ): Promise<Result<DebugAdapterSnapshot, DebugAdapterError>>;
  launch(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: DebugLaunchRequest,
    signal?: AbortSignal,
  ): Promise<Result<DebugAdapterSnapshot, DebugAdapterError>>;
  attachTarget(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: DebugAttachRequest,
    signal?: AbortSignal,
  ): Promise<Result<DebugAdapterSnapshot, DebugAdapterError>>;
  threads(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    signal?: AbortSignal,
  ): Promise<Result<readonly DebugThread[], DebugAdapterError>>;
  stackTrace(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: {
      readonly threadId: number;
      readonly stoppedGeneration: number;
      readonly startFrame?: number | undefined;
      readonly levels?: number | undefined;
    },
    signal?: AbortSignal,
  ): Promise<Result<readonly DebugStackFrame[], DebugAdapterError>>;
  continueExecution(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: { readonly threadId: number; readonly stoppedGeneration: number },
    signal?: AbortSignal,
  ): Promise<Result<DebugAdapterSnapshot, DebugAdapterError>>;
  scopes(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: { readonly frameId: number; readonly stoppedGeneration: number },
    signal?: AbortSignal,
  ): Promise<Result<readonly DebugScope[], DebugAdapterError>>;
  variables(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: { readonly variablesReference: number; readonly stoppedGeneration: number },
    signal?: AbortSignal,
  ): Promise<Result<readonly DebugVariableProjection[], DebugAdapterError>>;
  evaluate(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: DebugEvaluateRequest & DebugConfirmationOption,
    signal?: AbortSignal,
  ): Promise<Result<DebugEvaluateResult, DebugAdapterError>>;
  request(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    command: string,
    args?: unknown,
    signal?: AbortSignal,
  ): Promise<Result<unknown, DebugAdapterError>>;
  snapshot(serviceId: ManagedServiceId): DebugAdapterSnapshot | null;
  attach(
    serviceId: ManagedServiceId,
    listener: DebugAdapterListener,
  ): Result<{ detach(): void }, DebugAdapterError>;
};
