/**
 * Debug-adapter supervisor (#96–#100).
 *
 * Starts a managed process, speaks DAP over its stdio pipes, completes
 * initialize + initialized, then owns launch/attach, breakpoints, threads,
 * stacks, scopes, variables, evaluation, output projections, terminate,
 * cancel, disconnect/process cleanup, focused confirmation for consequential
 * actions, and bounded session artifact capture.
 */

export * from "./debug-adapter/contracts.ts";

import {
  buildDebugConfirmationRequest,
  buildDebugSessionArtifactDocument,
  bytesAsChunks,
  createDapFrameDecoder,
  DEBUG_ADAPTER_PROTOCOL,
  type DebugDisconnectOutcome,
  type DebugDisconnectRequest,
  debugAdapterLimits,
  debugSessionArtifactId,
  encodeDebugSessionArtifact,
  MAX_DEBUG_BREAKPOINT_SOURCES,
  parseBreakpointsResponse,
  parseDebugAdapterInitializeResult,
  parseEvaluateResponse,
  parseScopesResponse,
  parseStackTraceResponse,
  parseThreadsResponse,
  parseVariablesResponse,
  projectEvaluateForModel,
  projectVariableForModel,
  validateCancelRequest,
  validateDebugAdapterStartRequest,
  validateDisconnectRequest,
  validateEvaluateRequest,
  validateSetBreakpointsRequest,
  validateTerminateRequest,
} from "../../domain/debugging/index.ts";
import { duration } from "../../domain/foundation/index.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import type { ManagedServicePort } from "../../domain/process/index.ts";
import type {
  DebugAdapterSupervisor,
  DebugAdapterSupervisorOptions,
} from "./debug-adapter/contracts.ts";
import {
  createDebugTransport,
  type LiveAdapter,
  mapManagedStartError,
  sessionSnapshotOf,
} from "./debug-adapter/transport.ts";

export function createDebugAdapterSupervisor(
  managedServices: ManagedServicePort,
  options: DebugAdapterSupervisorOptions = {},
): DebugAdapterSupervisor {
  const {
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
  } = createDebugTransport(managedServices, options);

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
        session: {
          mode: "none",
          targetState: "idle",
          configurationDone: false,
          stopped: null,
          breakpointRevisions: new Map(),
          threads: [],
          recentOutputs: [],
          targetExit: null,
          lastDisconnect: null,
          nextStoppedGeneration: 1,
          nextBreakpointRevision: 1,
          nextArtifactSequence: 1,
        },
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

    prepareConfirmation(serviceId, generation, kind, normalizedInput) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      return ok(buildDebugConfirmationRequest(kind, normalizedInput));
    },

    async captureSessionArtifact(serviceId, generation, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      if (artifacts === null) {
        return err({ kind: "debug-adapter", code: "artifact-unavailable" });
      }
      const adapter = ready.value;
      const sequence = adapter.session.nextArtifactSequence;
      adapter.session.nextArtifactSequence += 1;
      const document = buildDebugSessionArtifactDocument({
        serviceId: String(adapter.request.serviceId),
        generation: Number(adapter.generation),
        adapterState: adapter.state,
        session: sessionSnapshotOf(adapter),
        capturedAt: new Date().toISOString(),
      });
      const encoded = encodeDebugSessionArtifact(document);
      if (!encoded.ok) {
        return encoded;
      }
      const id = debugSessionArtifactId(
        String(adapter.request.serviceId),
        Number(adapter.generation),
        sequence,
      );
      const ingested = await artifacts.ingest(
        {
          artifactId: id,
          mediaType: "application/json",
          encoding: "identity",
          sensitivity: encoded.value.sensitivity,
          origin: "capture",
          invocationId: null,
          declaredByteLength: encoded.value.bytes.byteLength,
          content: bytesAsChunks(encoded.value.bytes),
        },
        signal,
      );
      if (!ingested.ok) {
        return err({ kind: "debug-adapter", code: "artifact-failed" });
      }
      return ok({
        artifactId: id,
        byteLength: encoded.value.bytes.byteLength,
        mediaType: "application/json",
        sensitivity: encoded.value.sensitivity,
        committed: true,
      });
    },

    async disconnect(serviceId, generation, options) {
      const adapter = adapters.get(serviceId);
      if (adapter === undefined) {
        return err({ kind: "debug-adapter", code: "not-found" });
      }
      if (adapter.generation !== generation) {
        return err({ kind: "debug-adapter", code: "stale-generation" });
      }
      if (adapter.state === "stopped") {
        return ok(snapshotOf(adapter));
      }
      if (adapter.state === "disconnecting") {
        return err({ kind: "debug-adapter", code: "already-disconnecting" });
      }

      const disconnectRequest: DebugDisconnectRequest = {
        ...(options?.restart === undefined ? {} : { restart: options.restart }),
        ...(options?.terminateDebuggee === undefined
          ? {}
          : { terminateDebuggee: options.terminateDebuggee }),
      };
      const invalidDisconnect = validateDisconnectRequest(disconnectRequest);
      if (invalidDisconnect !== null) {
        return err(invalidDisconnect);
      }

      const restart = options?.restart === true;
      const terminateDebuggee = options?.terminateDebuggee !== false;
      if (terminateDebuggee) {
        const confirmed = requireConfirmation(
          "disconnect-terminate",
          { restart, terminateDebuggee: true },
          options?.confirmation,
        );
        if (!confirmed.ok) {
          return confirmed;
        }
      }
      const wasCommunicating =
        adapter.state === "ready" ||
        adapter.state === "degraded" ||
        adapter.state === "initializing";

      setState(adapter, "disconnecting");

      let adapterAcknowledged = false;
      let detachUncertain = false;
      if (wasCommunicating) {
        const response = await sendRequest(
          adapter,
          "disconnect",
          { restart, terminateDebuggee },
          adapter.limits.disconnectTimeoutMs,
          options?.signal,
        );
        if (response.ok && response.value.success) {
          adapterAcknowledged = true;
        } else if (!terminateDebuggee) {
          // Detach without a confirmed adapter ack leaves debuggee ownership uncertain.
          detachUncertain = true;
        }
      }

      cancelPending(adapter);

      const stopped = await managedServices.stop(serviceId, generation, "shutdown");
      let processStopped = false;
      if (!stopped.ok) {
        if (stopped.error.code === "shutdown-timeout") {
          adapter.session.lastDisconnect = {
            restart,
            terminateDebuggee,
            adapterAcknowledged,
            processStopped: false,
            detachUncertain: true,
          };
          fail(adapter, "disconnect-timeout");
          return err({ kind: "debug-adapter", code: "disconnect-timeout" });
        }
        if (stopped.error.code !== "not-found" && stopped.error.code !== "stale-generation") {
          return err(mapManagedStartError(stopped.error));
        }
        processStopped = stopped.error.code === "not-found";
      } else {
        processStopped = true;
      }

      adapter.detachManaged?.();
      adapter.detachManaged = null;
      const lastDisconnect: DebugDisconnectOutcome = {
        restart,
        terminateDebuggee,
        adapterAcknowledged,
        processStopped,
        detachUncertain,
      };
      resetSession(adapter);
      adapter.session.lastDisconnect = lastDisconnect;
      setState(adapter, "stopped");
      emit(adapter, { kind: "stopped" });

      if (detachUncertain) {
        return err({ kind: "debug-adapter", code: "detach-uncertain" });
      }
      return ok(snapshotOf(adapter));
    },

    async terminate(serviceId, generation, request = {}, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const invalidTerminate = validateTerminateRequest(request);
      if (invalidTerminate !== null) {
        return err(invalidTerminate);
      }
      const confirmed = requireConfirmation(
        "terminate",
        { restart: request.restart === true },
        request.confirmation,
      );
      if (!confirmed.ok) {
        return confirmed;
      }
      const adapter = ready.value;
      if (adapter.session.mode === "none") {
        return err({ kind: "debug-adapter", code: "not-launched" });
      }
      if (adapter.session.targetState === "exited") {
        return err({ kind: "debug-adapter", code: "target-exited" });
      }
      const response = await sendRequest(
        adapter,
        "terminate",
        { restart: request.restart === true },
        adapter.limits.requestTimeoutMs,
        signal,
      );
      if (!response.ok) {
        return response;
      }
      if (!response.value.success) {
        return err({ kind: "debug-adapter", code: "unsupported" });
      }
      return ok(snapshotOf(adapter));
    },

    async cancel(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const invalidCancel = validateCancelRequest(request);
      if (invalidCancel !== null) {
        return err(invalidCancel);
      }
      const adapter = ready.value;
      const response = await sendRequest(
        adapter,
        "cancel",
        {
          ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
          ...(request.progressId === undefined ? {} : { progressId: request.progressId }),
        },
        adapter.limits.requestTimeoutMs,
        signal,
      );
      if (!response.ok) {
        return response;
      }
      if (!response.value.success) {
        return err({ kind: "debug-adapter", code: "unsupported" });
      }
      return ok(snapshotOf(adapter));
    },

    async setBreakpoints(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const invalidBp = validateSetBreakpointsRequest(request);
      if (invalidBp !== null) {
        return err(invalidBp);
      }
      const adapter = ready.value;
      if (
        !adapter.session.breakpointRevisions.has(request.sourcePath) &&
        adapter.session.breakpointRevisions.size >= MAX_DEBUG_BREAKPOINT_SOURCES
      ) {
        return err({ kind: "debug-adapter", code: "capacity-exceeded" });
      }
      const response = await sendRequest(
        adapter,
        "setBreakpoints",
        {
          source: { path: request.sourcePath },
          breakpoints: request.breakpoints.map((breakpoint) => ({
            line: breakpoint.line,
            ...(breakpoint.column === undefined ? {} : { column: breakpoint.column }),
            ...(breakpoint.condition === undefined ? {} : { condition: breakpoint.condition }),
            ...(breakpoint.hitCondition === undefined
              ? {}
              : { hitCondition: breakpoint.hitCondition }),
            ...(breakpoint.logMessage === undefined ? {} : { logMessage: breakpoint.logMessage }),
          })),
          ...(request.sourceModified === undefined
            ? {}
            : { sourceModified: request.sourceModified }),
        },
        adapter.limits.requestTimeoutMs,
        signal,
      );
      if (!response.ok) {
        return response;
      }
      if (!response.value.success) {
        return err({ kind: "debug-adapter", code: "unsupported" });
      }
      const revision = adapter.session.nextBreakpointRevision;
      adapter.session.nextBreakpointRevision += 1;
      const parsed = parseBreakpointsResponse(
        request.sourcePath,
        revision,
        response.value.body ?? {},
      );
      if (!parsed.ok) {
        return parsed;
      }
      adapter.session.breakpointRevisions.set(request.sourcePath, revision);
      emitSession(adapter);
      return parsed;
    },

    async configurationDone(serviceId, generation, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const adapter = ready.value;
      const response = await sendRequest(
        adapter,
        "configurationDone",
        {},
        adapter.limits.requestTimeoutMs,
        signal,
      );
      if (!response.ok) {
        return response;
      }
      if (!response.value.success) {
        return err({ kind: "debug-adapter", code: "unsupported" });
      }
      adapter.session.configurationDone = true;
      emitSession(adapter);
      return ok(snapshotOf(adapter));
    },

    async launch(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      return startTarget(
        ready.value,
        "launch",
        "launch",
        request.configuration,
        request.noDebug,
        signal,
      );
    },

    async attachTarget(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      return startTarget(ready.value, "attach", "attach", request.configuration, undefined, signal);
    },

    async threads(serviceId, generation, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const adapter = ready.value;
      if (adapter.session.mode === "none") {
        return err({ kind: "debug-adapter", code: "not-launched" });
      }
      if (adapter.session.targetState === "exited") {
        return err({ kind: "debug-adapter", code: "target-exited" });
      }
      const response = await sendRequest(
        adapter,
        "threads",
        {},
        adapter.limits.requestTimeoutMs,
        signal,
      );
      if (!response.ok) {
        return response;
      }
      if (!response.value.success) {
        return err({ kind: "debug-adapter", code: "unsupported" });
      }
      const parsed = parseThreadsResponse(response.value.body ?? {});
      if (!parsed.ok) {
        return parsed;
      }
      adapter.session.threads = [...parsed.value];
      emitSession(adapter);
      return parsed;
    },

    async stackTrace(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const stopped = requireStopped(ready.value, request.stoppedGeneration);
      if (!stopped.ok) {
        return stopped;
      }
      const adapter = stopped.value;
      if (
        typeof request.threadId !== "number" ||
        !Number.isSafeInteger(request.threadId) ||
        request.threadId < 1
      ) {
        return err({ kind: "debug-adapter", code: "invalid-request", reason: "invalid-thread" });
      }
      const response = await sendRequest(
        adapter,
        "stackTrace",
        {
          threadId: request.threadId,
          ...(request.startFrame === undefined ? {} : { startFrame: request.startFrame }),
          ...(request.levels === undefined ? {} : { levels: request.levels }),
        },
        adapter.limits.requestTimeoutMs,
        signal,
      );
      if (!response.ok) {
        return response;
      }
      if (!response.value.success) {
        return err({ kind: "debug-adapter", code: "unsupported" });
      }
      return parseStackTraceResponse(response.value.body ?? {});
    },

    async continueExecution(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const stopped = requireStopped(ready.value, request.stoppedGeneration);
      if (!stopped.ok) {
        return stopped;
      }
      const adapter = stopped.value;
      const response = await sendRequest(
        adapter,
        "continue",
        { threadId: request.threadId },
        adapter.limits.requestTimeoutMs,
        signal,
      );
      if (!response.ok) {
        return response;
      }
      if (!response.value.success) {
        return err({ kind: "debug-adapter", code: "unsupported" });
      }
      adapter.session.stopped = null;
      adapter.session.targetState = "running";
      emitSession(adapter);
      return ok(snapshotOf(adapter));
    },

    async scopes(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const stopped = requireStopped(ready.value, request.stoppedGeneration);
      if (!stopped.ok) {
        return stopped;
      }
      const adapter = stopped.value;
      if (
        typeof request.frameId !== "number" ||
        !Number.isSafeInteger(request.frameId) ||
        request.frameId < 0
      ) {
        return err({ kind: "debug-adapter", code: "invalid-request", reason: "invalid-frame" });
      }
      const response = await sendRequest(
        adapter,
        "scopes",
        { frameId: request.frameId },
        adapter.limits.requestTimeoutMs,
        signal,
      );
      if (!response.ok) {
        return response;
      }
      if (!response.value.success) {
        return err({ kind: "debug-adapter", code: "unsupported" });
      }
      return parseScopesResponse(response.value.body ?? {});
    },

    async variables(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const stopped = requireStopped(ready.value, request.stoppedGeneration);
      if (!stopped.ok) {
        return stopped;
      }
      const adapter = stopped.value;
      if (
        typeof request.variablesReference !== "number" ||
        !Number.isSafeInteger(request.variablesReference) ||
        request.variablesReference < 1
      ) {
        return err({ kind: "debug-adapter", code: "invalid-request", reason: "invalid-variable" });
      }
      const response = await sendRequest(
        adapter,
        "variables",
        { variablesReference: request.variablesReference },
        adapter.limits.requestTimeoutMs,
        signal,
      );
      if (!response.ok) {
        return response;
      }
      if (!response.value.success) {
        return err({ kind: "debug-adapter", code: "unsupported" });
      }
      const parsed = parseVariablesResponse(response.value.body ?? {});
      if (!parsed.ok) {
        return parsed;
      }
      return ok(parsed.value.map(projectVariableForModel));
    },

    async evaluate(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const invalidEval = validateEvaluateRequest(request);
      if (invalidEval !== null) {
        return err(invalidEval);
      }
      const stopped = requireStopped(ready.value, request.stoppedGeneration);
      if (!stopped.ok) {
        return stopped;
      }
      const adapter = stopped.value;
      const context = request.context ?? "watch";
      if (context === "repl") {
        const confirmed = requireConfirmation(
          "evaluate-repl",
          {
            expression: request.expression,
            context,
            ...(request.frameId === undefined ? {} : { frameId: request.frameId }),
          },
          request.confirmation,
        );
        if (!confirmed.ok) {
          return confirmed;
        }
      }
      const response = await sendRequest(
        adapter,
        "evaluate",
        {
          expression: request.expression,
          context,
          ...(request.frameId === undefined ? {} : { frameId: request.frameId }),
        },
        adapter.limits.requestTimeoutMs,
        signal,
      );
      if (!response.ok) {
        return response;
      }
      if (!response.value.success) {
        return err({ kind: "debug-adapter", code: "unsupported" });
      }
      const parsed = parseEvaluateResponse(response.value.body ?? {}, context);
      if (!parsed.ok) {
        return parsed;
      }
      return ok(projectEvaluateForModel(parsed.value));
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

export { describeDebugAdapterFailure } from "../../domain/debugging/index.ts";
