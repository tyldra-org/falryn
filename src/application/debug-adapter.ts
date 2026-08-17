/**
 * Debug-adapter supervisor (#96).
 *
 * Starts a managed process, speaks DAP over its stdio pipes, completes
 * initialize + initialized, exposes request/response transport, and disconnects
 * cleanly. Launch/attach/breakpoints remain #97.
 */

import {
  createDapFrameDecoder,
  type DapMessage,
  type DapResponse,
  DEBUG_ADAPTER_PROTOCOL,
  type DebugAdapterCapabilities,
  type DebugAdapterError,
  type DebugAdapterEvent,
  type DebugAdapterFailureReason,
  type DebugAdapterLimits,
  type DebugAdapterSnapshot,
  type DebugAdapterStartRequest,
  type DebugAdapterState,
  debugAdapterLimits,
  duration,
  encodeDapFrame,
  type ManagedServiceError,
  type ManagedServiceEvent,
  type ManagedServiceId,
  type ManagedServicePort,
  parseDebugAdapterInitializeResult,
  type ServiceGeneration,
  validateDebugAdapterStartRequest,
} from "../domain/index.ts";
import { err, ok, type Result } from "../domain/result.ts";

export type DebugAdapterListener = (event: DebugAdapterEvent) => void;

export type DebugAdapterSupervisor = {
  start(
    request: DebugAdapterStartRequest,
    signal?: AbortSignal,
  ): Promise<Result<DebugAdapterSnapshot, DebugAdapterError>>;
  disconnect(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    options?: {
      readonly restart?: boolean | undefined;
      readonly terminateDebuggee?: boolean | undefined;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<Result<DebugAdapterSnapshot, DebugAdapterError>>;
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

type LiveAdapter = {
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
  readonly decoder: ReturnType<typeof createDapFrameDecoder>;
  readonly listeners: Set<DebugAdapterListener>;
  detachManaged: (() => void) | null;
  readonly pending: Map<
    number,
    {
      readonly resolve: (response: DapResponse) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >;
};

function mapManagedStartError(error: ManagedServiceError): DebugAdapterError {
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

export function createDebugAdapterSupervisor(
  managedServices: ManagedServicePort,
): DebugAdapterSupervisor {
  const adapters = new Map<ManagedServiceId, LiveAdapter>();

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
        resolve: (message) => resolve(ok(message)),
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

  function handleMessage(adapter: LiveAdapter, message: DapMessage): void {
    if (message.type === "response") {
      const pending = adapter.pending.get(message.request_seq);
      if (pending === undefined) {
        return;
      }
      clearTimeout(pending.timer);
      adapter.pending.delete(message.request_seq);
      pending.resolve(message);
      return;
    }
    if (message.type === "event") {
      emit(adapter, {
        kind: "dap-event",
        event: message.event,
        body: message.body ?? null,
      });
      return;
    }
    // Adapter→client requests (e.g. runInTerminal) are deferred to later slices.
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

  return {
    async start(request, signal) {
      const invalid = validateDebugAdapterStartRequest(request);
      if (invalid !== null) {
        return err(invalid);
      }
      const limitsResult = debugAdapterLimits(request.limits ?? {});
      if (!limitsResult.ok) {
        return limitsResult;
      }
      if (adapters.has(request.serviceId)) {
        const existing = adapters.get(request.serviceId);
        if (existing !== undefined && existing.state !== "stopped" && existing.state !== "failed") {
          return err({ kind: "debug-adapter", code: "already-running" });
        }
      }

      const started = await managedServices.start({
        serviceId: request.serviceId,
        protocol: DEBUG_ADAPTER_PROTOCOL,
        executable: request.executable,
        argv: request.argv,
        environment: request.environment,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        readiness: { kind: "immediate" },
        idle: { kind: "disabled" },
        restart: {
          maxRestarts: limitsResult.value.maxRestarts,
          windowMs: duration(limitsResult.value.restartWindowMs),
        },
        shutdownTimeoutMs: duration(limitsResult.value.disconnectTimeoutMs),
        replayBytes: 64 * 1024,
      });
      if (!started.ok) {
        return err(mapManagedStartError(started.error));
      }

      const adapter: LiveAdapter = {
        request,
        limits: limitsResult.value,
        generation: started.value.generation,
        state: "starting",
        pid: started.value.pid,
        restartCount: started.value.restartCount,
        capabilities: null,
        failureReason: null,
        order: 0,
        nextSeq: 1,
        decoder: createDapFrameDecoder(limitsResult.value.maxFrameBytes),
        listeners: new Set(),
        detachManaged: null,
        pending: new Map(),
      };
      adapters.set(request.serviceId, adapter);
      setState(adapter, "starting");

      const attached = managedServices.attach(request.serviceId, (event) => {
        onManagedEvent(adapter, event);
      });
      if (!attached.ok) {
        return err(mapManagedStartError(attached.error));
      }
      adapter.detachManaged = attached.value.detach;
      if (attached.value.replay.stdout.byteLength > 0) {
        const decoded = adapter.decoder.push(attached.value.replay.stdout);
        if (!decoded.ok) {
          return err(fail(adapter, "malformed-response"));
        }
        for (const message of decoded.value) {
          handleMessage(adapter, message);
        }
      }

      setState(adapter, "initializing");
      const initialized = await sendRequest(
        adapter,
        "initialize",
        request.initialize,
        limitsResult.value.initializeTimeoutMs,
        signal,
      );
      if (!initialized.ok) {
        fail(
          adapter,
          initialized.error.code === "cancelled" ||
            initialized.error.code === "request-timeout" ||
            initialized.error.code === "disconnect-timeout"
            ? initialized.error.code === "cancelled"
              ? "cancelled"
              : "request-timeout"
            : "initialization-failure",
        );
        return err(initialized.error);
      }
      if (!initialized.value.success) {
        return err(fail(adapter, "initialization-failure"));
      }
      const parsed = parseDebugAdapterInitializeResult(initialized.value.body ?? {});
      if (!parsed.ok) {
        return err(fail(adapter, "malformed-response"));
      }
      adapter.capabilities = parsed.value.capabilities;
      const notified = await sendEvent(adapter, "initialized");
      if (!notified.ok) {
        return err(fail(adapter, "initialization-failure"));
      }
      setState(adapter, "ready");
      emit(adapter, { kind: "initialized", capabilities: parsed.value.capabilities });
      return ok(snapshotOf(adapter));
    },

    async disconnect(serviceId, generation, options) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const adapter = ready.value;
      setState(adapter, "disconnecting");
      const disconnected = await sendRequest(
        adapter,
        "disconnect",
        {
          restart: options?.restart === true,
          terminateDebuggee: options?.terminateDebuggee !== false,
        },
        adapter.limits.disconnectTimeoutMs,
        options?.signal,
      );
      if (!disconnected.ok && disconnected.error.code !== "request-timeout") {
        // Still stop the process so adapters cannot linger.
      }
      const stopped = await managedServices.stop(serviceId, generation);
      if (!stopped.ok) {
        return err(mapManagedStartError(stopped.error));
      }
      adapter.detachManaged?.();
      adapter.detachManaged = null;
      for (const pending of adapter.pending.values()) {
        clearTimeout(pending.timer);
      }
      adapter.pending.clear();
      setState(adapter, "stopped");
      emit(adapter, { kind: "stopped" });
      return ok(snapshotOf(adapter));
    },

    async request(serviceId, generation, command, args, signal) {
      if (typeof command !== "string" || command.length === 0) {
        return err({ kind: "debug-adapter", code: "invalid-request", reason: "invalid-command" });
      }
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const response = await sendRequest(
        ready.value,
        command,
        args,
        ready.value.limits.requestTimeoutMs,
        signal,
      );
      if (!response.ok) {
        return response;
      }
      if (!response.value.success) {
        return err({ kind: "debug-adapter", code: "unsupported" });
      }
      return ok(response.value.body ?? null);
    },

    snapshot(serviceId) {
      const adapter = adapters.get(serviceId);
      return adapter === undefined ? null : snapshotOf(adapter);
    },

    attach(serviceId, listener) {
      const adapter = adapters.get(serviceId);
      if (adapter === undefined) {
        return err({ kind: "debug-adapter", code: "not-found" });
      }
      adapter.listeners.add(listener);
      return ok({
        detach() {
          adapter.listeners.delete(listener);
        },
      });
    },
  };
}

export { describeDebugAdapterFailure } from "../domain/index.ts";
