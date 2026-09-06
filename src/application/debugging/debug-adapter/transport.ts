import {
  buildDebugConfirmationRequest,
  type createDapFrameDecoder,
  type DapMessage,
  type DapResponse,
  type DebugAdapterCapabilities,
  type DebugAdapterError,
  type DebugAdapterEvent,
  type DebugAdapterFailureReason,
  type DebugAdapterLimits,
  type DebugAdapterSnapshot,
  type DebugAdapterStartRequest,
  type DebugAdapterState,
  type DebugConfirmation,
  type DebugConfirmationKind,
  type DebugDisconnectOutcome,
  type DebugOutputEvent,
  type DebugSessionSnapshot,
  type DebugStoppedInfo,
  type DebugTargetExit,
  type DebugThread,
  emptyDebugSessionSnapshot,
  encodeDapFrame,
  MAX_DEBUG_OUTPUT_EVENTS,
  parseOutputEventBody,
  parseStoppedEventBody,
  parseTargetExitEvent,
  projectOutputForModel,
  resolveDebugConfirmation,
  validateLaunchOrAttachConfiguration,
} from "../../../domain/debugging/index.ts";
import type { ManagedServiceId, ServiceGeneration } from "../../../domain/foundation/index.ts";
import { err, ok, type Result } from "../../../domain/foundation/result.ts";
import type {
  ManagedServiceError,
  ManagedServiceEvent,
  ManagedServicePort,
} from "../../../domain/process/index.ts";
import type { DebugAdapterListener, DebugAdapterSupervisorOptions } from "./contracts.ts";

export type LiveAdapter = {
  readonly request: DebugAdapterStartRequest;
  readonly limits: DebugAdapterLimits;
  generation: ServiceGeneration;
  state: DebugAdapterState;
  pid: number | null;
  restartCount: number;
  capabilities: DebugAdapterCapabilities | null;
  failureReason: DebugAdapterFailureReason | null;
  order: number;
  nextSeq: number;
  session: {
    mode: DebugSessionSnapshot["mode"];
    targetState: DebugSessionSnapshot["targetState"];
    configurationDone: boolean;
    stopped: DebugStoppedInfo | null;
    readonly breakpointRevisions: Map<string, number>;
    threads: DebugThread[];
    recentOutputs: DebugOutputEvent[];
    targetExit: DebugTargetExit | null;
    lastDisconnect: DebugDisconnectOutcome | null;
    nextStoppedGeneration: number;
    nextBreakpointRevision: number;
    nextArtifactSequence: number;
  };
  readonly decoder: ReturnType<typeof createDapFrameDecoder>;
  readonly listeners: Set<DebugAdapterListener>;
  detachManaged: (() => void) | null;
  readonly pending: Map<
    number,
    {
      readonly settle: (result: Result<DapResponse, DebugAdapterError>) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >;
};

export function mapManagedStartError(error: ManagedServiceError): DebugAdapterError {
  switch (error.code) {
    case "invalid-request":
      if (error.reason === "invalid-executable") {
        return { kind: "debug-adapter", code: "missing-executable" };
      }
      return { kind: "debug-adapter", code: "spawn-failed" };
    case "capacity-exceeded":
      return { kind: "debug-adapter", code: "capacity-exceeded" };
    case "already-running":
      return { kind: "debug-adapter", code: "already-running" };
    case "spawn-failed":
      return { kind: "debug-adapter", code: "spawn-failed" };
    case "readiness-timeout":
    case "readiness-output-exceeded":
      return { kind: "debug-adapter", code: "spawn-failed" };
    case "no-restart-policy":
    case "restart-budget-exhausted":
      return { kind: "debug-adapter", code: "restart-exhaustion" };
    case "not-found":
      return { kind: "debug-adapter", code: "not-found" };
    case "stale-generation":
      return { kind: "debug-adapter", code: "stale-generation" };
    case "not-ready":
      return { kind: "debug-adapter", code: "not-ready" };
    case "input-too-large":
    case "write-failed":
      return { kind: "debug-adapter", code: "spawn-failed" };
    case "shutdown-timeout":
      return { kind: "debug-adapter", code: "disconnect-timeout" };
    default:
      return { kind: "debug-adapter", code: "spawn-failed" };
  }
}

export function sessionSnapshotOf(adapter: LiveAdapter): DebugSessionSnapshot {
  const revisions: Record<string, number> = {};
  for (const [path, revision] of adapter.session.breakpointRevisions) {
    revisions[path] = revision;
  }
  return {
    mode: adapter.session.mode,
    targetState: adapter.session.targetState,
    configurationDone: adapter.session.configurationDone,
    stopped: adapter.session.stopped,
    breakpointRevisions: revisions,
    threads: [...adapter.session.threads],
    recentOutputs: [...adapter.session.recentOutputs],
    targetExit: adapter.session.targetExit,
    lastDisconnect: adapter.session.lastDisconnect,
  };
}

export function createDebugTransport(
  managedServices: ManagedServicePort,
  options: DebugAdapterSupervisorOptions = {},
) {
  const adapters = new Map<ManagedServiceId, LiveAdapter>();
  const confirmationPolicy = options.confirmationPolicy ?? "require";
  const artifacts = options.artifacts ?? null;

  type DebugAdapterEventDetail = {
    [Kind in DebugAdapterEvent["kind"]]: Omit<
      Extract<DebugAdapterEvent, { readonly kind: Kind }>,
      "serviceId" | "generation" | "order"
    >;
  }[DebugAdapterEvent["kind"]];

  function emit(adapter: LiveAdapter, event: DebugAdapterEventDetail): void {
    adapter.order += 1;
    const full = {
      ...event,
      serviceId: adapter.request.serviceId,
      generation: adapter.generation,
      order: adapter.order,
    } as DebugAdapterEvent;
    for (const listener of [...adapter.listeners]) {
      try {
        listener(full);
      } catch {
        // Observers must not break the supervisor.
      }
    }
  }

  function setState(adapter: LiveAdapter, state: DebugAdapterState): void {
    adapter.state = state;
    emit(adapter, { kind: "state", state });
  }

  function emitSession(adapter: LiveAdapter): void {
    emit(adapter, { kind: "session", session: sessionSnapshotOf(adapter) });
  }

  function snapshotOf(adapter: LiveAdapter): DebugAdapterSnapshot {
    return {
      serviceId: adapter.request.serviceId,
      key: adapter.request.key,
      generation: adapter.generation,
      state: adapter.state,
      pid: adapter.pid,
      restartCount: adapter.restartCount,
      capabilities: adapter.capabilities,
      failureReason: adapter.failureReason,
      session: sessionSnapshotOf(adapter),
    };
  }

  function fail(adapter: LiveAdapter, reason: DebugAdapterFailureReason): DebugAdapterError {
    adapter.failureReason = reason;
    setState(adapter, "failed");
    emit(adapter, { kind: "failed", reason });
    return { kind: "debug-adapter", code: reason };
  }

  function requireReady(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
  ): Result<LiveAdapter, DebugAdapterError> {
    const adapter = adapters.get(serviceId);
    if (adapter === undefined) {
      return err({ kind: "debug-adapter", code: "not-found" });
    }
    if (adapter.generation !== generation) {
      return err({ kind: "debug-adapter", code: "stale-generation" });
    }
    if (adapter.state !== "ready" && adapter.state !== "degraded") {
      return err({ kind: "debug-adapter", code: "not-ready" });
    }
    return ok(adapter);
  }

  function resetSession(adapter: LiveAdapter): void {
    const empty = emptyDebugSessionSnapshot();
    adapter.session.mode = empty.mode;
    adapter.session.targetState = empty.targetState;
    adapter.session.configurationDone = empty.configurationDone;
    adapter.session.stopped = empty.stopped;
    adapter.session.breakpointRevisions.clear();
    adapter.session.threads = [];
    adapter.session.recentOutputs = [];
    adapter.session.targetExit = empty.targetExit;
    adapter.session.lastDisconnect = empty.lastDisconnect;
    adapter.session.nextStoppedGeneration = 1;
    adapter.session.nextBreakpointRevision = 1;
    adapter.session.nextArtifactSequence = 1;
  }

  function requireConfirmation(
    kind: DebugConfirmationKind,
    normalizedInput: Readonly<Record<string, unknown>>,
    confirmation: DebugConfirmation | undefined,
  ): Result<void, DebugAdapterError> {
    if (confirmationPolicy === "auto-allow") {
      return ok(undefined);
    }
    const request = buildDebugConfirmationRequest(kind, normalizedInput);
    return resolveDebugConfirmation({
      request,
      current: request,
      confirmation,
    });
  }

  function cancelPending(
    adapter: LiveAdapter,
    reason: DebugAdapterError = { kind: "debug-adapter", code: "cancelled" },
  ): void {
    for (const pending of adapter.pending.values()) {
      clearTimeout(pending.timer);
      pending.settle(err(reason));
    }
    adapter.pending.clear();
  }

  function requireStopped(
    adapter: LiveAdapter,
    stoppedGeneration: number,
  ): Result<LiveAdapter, DebugAdapterError> {
    if (adapter.session.mode === "none") {
      return err({ kind: "debug-adapter", code: "not-launched" });
    }
    if (adapter.session.targetState === "exited") {
      return err({ kind: "debug-adapter", code: "target-exited" });
    }
    if (adapter.session.targetState !== "stopped" || adapter.session.stopped === null) {
      return err({ kind: "debug-adapter", code: "not-ready" });
    }
    if (adapter.session.stopped.generation !== stoppedGeneration) {
      return err({ kind: "debug-adapter", code: "stale-stopped-generation" });
    }
    return ok(adapter);
  }

  async function sendRequest(
    adapter: LiveAdapter,
    command: string,
    args: unknown,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<Result<DapResponse, DebugAdapterError>> {
    if (signal?.aborted === true) {
      return err({ kind: "debug-adapter", code: "cancelled" });
    }
    const seq = adapter.nextSeq;
    adapter.nextSeq += 1;
    const frame = encodeDapFrame({
      seq,
      type: "request",
      command,
      ...(args === undefined ? {} : { arguments: args }),
    });
    const response = new Promise<Result<DapResponse, DebugAdapterError>>((resolve) => {
      const timer = setTimeout(() => {
        adapter.pending.delete(seq);
        resolve(
          err({
            kind: "debug-adapter",
            code: command === "disconnect" ? "disconnect-timeout" : "request-timeout",
          }),
        );
      }, timeoutMs);
      adapter.pending.set(seq, {
        settle: resolve,
        timer,
      });
    });

    const written = await managedServices.send(
      adapter.request.serviceId,
      adapter.generation,
      frame,
    );
    if (!written.ok) {
      const pending = adapter.pending.get(seq);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        adapter.pending.delete(seq);
      }
      return err(mapManagedStartError(written.error));
    }

    if (signal !== undefined) {
      const aborted = new Promise<Result<DapResponse, DebugAdapterError>>((resolve) => {
        const onAbort = (): void => {
          const pending = adapter.pending.get(seq);
          if (pending !== undefined) {
            clearTimeout(pending.timer);
            adapter.pending.delete(seq);
          }
          resolve(err({ kind: "debug-adapter", code: "cancelled" }));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return Promise.race([response, aborted]);
    }
    return response;
  }

  async function sendEvent(
    adapter: LiveAdapter,
    event: string,
    body?: unknown,
  ): Promise<Result<void, DebugAdapterError>> {
    const seq = adapter.nextSeq;
    adapter.nextSeq += 1;
    const frame = encodeDapFrame({
      seq,
      type: "event",
      event,
      ...(body === undefined ? {} : { body }),
    });
    const written = await managedServices.send(
      adapter.request.serviceId,
      adapter.generation,
      frame,
    );
    if (!written.ok) {
      return err(mapManagedStartError(written.error));
    }
    return ok(undefined);
  }

  function handleDapEvent(adapter: LiveAdapter, event: string, body: unknown): void {
    if (event === "stopped") {
      const generation = adapter.session.nextStoppedGeneration;
      adapter.session.nextStoppedGeneration += 1;
      const parsed = parseStoppedEventBody(body, generation);
      if (!parsed.ok) {
        return;
      }
      adapter.session.stopped = parsed.value;
      adapter.session.targetState = "stopped";
      emit(adapter, { kind: "target-stopped", stopped: parsed.value });
      emitSession(adapter);
      return;
    }
    if (event === "continued") {
      adapter.session.stopped = null;
      if (adapter.session.targetState === "stopped") {
        adapter.session.targetState = "running";
      }
      emitSession(adapter);
      return;
    }
    if (event === "exited" || event === "terminated") {
      const parsed = parseTargetExitEvent(event, body);
      if (!parsed.ok) {
        return;
      }
      adapter.session.targetExit = parsed.value;
      adapter.session.targetState = "exited";
      adapter.session.stopped = null;
      emitSession(adapter);
      return;
    }
    if (event === "thread") {
      emitSession(adapter);
      return;
    }
    if (event === "output") {
      const parsed = parseOutputEventBody(body);
      if (!parsed.ok) {
        return;
      }
      adapter.session.recentOutputs.push(projectOutputForModel(parsed.value));
      if (adapter.session.recentOutputs.length > MAX_DEBUG_OUTPUT_EVENTS) {
        adapter.session.recentOutputs.splice(
          0,
          adapter.session.recentOutputs.length - MAX_DEBUG_OUTPUT_EVENTS,
        );
      }
      emitSession(adapter);
    }
  }

  function handleMessage(adapter: LiveAdapter, message: DapMessage): void {
    if (message.type === "response") {
      const pending = adapter.pending.get(message.request_seq);
      if (pending === undefined) {
        return;
      }
      clearTimeout(pending.timer);
      adapter.pending.delete(message.request_seq);
      pending.settle(ok(message));
      return;
    }
    if (message.type === "event") {
      emit(adapter, {
        kind: "dap-event",
        event: message.event,
        body: message.body ?? null,
      });
      handleDapEvent(adapter, message.event, message.body ?? null);
    }
  }

  function onManagedEvent(adapter: LiveAdapter, event: ManagedServiceEvent): void {
    if (event.generation !== adapter.generation && event.kind !== "restarted") {
      return;
    }
    switch (event.kind) {
      case "started":
      case "restarted":
        adapter.pid = event.pid;
        if (event.kind === "restarted") {
          adapter.generation = event.generation;
          adapter.restartCount += 1;
          adapter.decoder.reset();
          resetSession(adapter);
          setState(adapter, "restarting");
        }
        return;
      case "output":
        if (event.stream !== "stdout") {
          return;
        }
        {
          const decoded = adapter.decoder.push(event.bytes);
          if (!decoded.ok) {
            fail(adapter, "malformed-response");
            return;
          }
          for (const message of decoded.value) {
            handleMessage(adapter, message);
          }
        }
        return;
      case "ready":
        return;
      case "crashed":
        if (adapter.state === "disconnecting" || adapter.state === "stopped") {
          return;
        }
        fail(adapter, "crash");
        return;
      case "stopping":
        if (adapter.state !== "disconnecting") {
          setState(adapter, "disconnecting");
        }
        return;
      case "stopped":
        setState(adapter, "stopped");
        emit(adapter, { kind: "stopped" });
        return;
      case "failed":
        if (adapter.state !== "failed" && adapter.state !== "stopped") {
          fail(
            adapter,
            event.reason === "restart-budget-exhausted" || event.reason === "no-restart-policy"
              ? "restart-exhaustion"
              : event.reason === "shutdown-timeout"
                ? "disconnect-timeout"
                : "spawn-failed",
          );
        }
        return;
      default:
        return;
    }
  }

  async function startTarget(
    adapter: LiveAdapter,
    mode: "launch" | "attach",
    command: "launch" | "attach",
    configuration: Readonly<Record<string, unknown>>,
    noDebug: boolean | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Result<DebugAdapterSnapshot, DebugAdapterError>> {
    if (adapter.session.mode !== "none") {
      return err({ kind: "debug-adapter", code: "already-launched" });
    }
    if (adapter.session.targetState === "exited") {
      return err({ kind: "debug-adapter", code: "target-exited" });
    }
    const invalidConfig = validateLaunchOrAttachConfiguration(configuration);
    if (invalidConfig !== null) {
      return err(invalidConfig);
    }
    const args =
      command === "launch"
        ? { ...configuration, ...(noDebug === undefined ? {} : { noDebug }) }
        : configuration;
    const response = await sendRequest(
      adapter,
      command,
      args,
      adapter.limits.requestTimeoutMs,
      signal,
    );
    if (!response.ok) {
      return response;
    }
    if (!response.value.success) {
      return err({ kind: "debug-adapter", code: "unsupported" });
    }
    adapter.session.mode = mode;
    if (adapter.session.targetState !== "stopped") {
      adapter.session.targetState = "running";
    }
    emitSession(adapter);
    return ok(snapshotOf(adapter));
  }

  return {
    adapters,
    artifacts,
    emit,
    setState,
    emitSession,
    snapshotOf,
    fail,
    requireReady,
    resetSession,
    requireConfirmation,
    cancelPending,
    requireStopped,
    sendRequest,
    sendEvent,
    handleMessage,
    onManagedEvent,
    startTarget,
  };
}
