/**
 * Language-server supervisor (#89 lifecycle + #90 document sync).
 *
 * Starts a managed process, speaks JSON-RPC over its stdio pipes, completes
 * initialize, synchronizes documents/workspace folders/dynamic capabilities,
 * and performs shutdown/exit. Feature requests and edits-as-patches remain
 * later children of #88.
 */

import {
  applyContentChanges,
  createJsonRpcFrameDecoder,
  describeLanguageServerFailure,
  duration,
  encodeJsonRpcFrame,
  type JsonRpcId,
  type JsonRpcMessage,
  LANGUAGE_SERVER_PROTOCOL,
  type LanguageServerChangeDocumentRequest,
  type LanguageServerClientInfo,
  type LanguageServerCloseDocumentRequest,
  type LanguageServerError,
  type LanguageServerEvent,
  type LanguageServerFailureReason,
  type LanguageServerLimits,
  type LanguageServerOpenDocument,
  type LanguageServerOpenDocumentRequest,
  type LanguageServerRegisteredCapability,
  type LanguageServerSaveDocumentRequest,
  type LanguageServerSnapshot,
  type LanguageServerStartRequest,
  type LanguageServerState,
  type LanguageServerWorkspaceFolder,
  type LanguageServerWorkspaceFoldersChange,
  languageServerLimits,
  MAX_LANGUAGE_SERVER_OPEN_DOCUMENTS,
  MAX_LANGUAGE_SERVER_REGISTERED_CAPABILITIES,
  type ManagedServiceError,
  type ManagedServiceEvent,
  type ManagedServiceId,
  type ManagedServicePort,
  mergeWorkspaceFolders,
  parseLanguageServerInitializeResult,
  parseRegisterCapabilityParams,
  parseUnregisterCapabilityParams,
  type ServiceGeneration,
  validateChangeDocumentRequest,
  validateDocumentUri,
  validateLanguageServerStartRequest,
  validateOpenDocumentRequest,
  validateWorkspaceFoldersChange,
} from "../domain/index.ts";
import { err, ok, type Result } from "../domain/result.ts";

export type LanguageServerListener = (event: LanguageServerEvent) => void;

export type LanguageServerSupervisor = {
  start(
    request: LanguageServerStartRequest,
    signal?: AbortSignal,
  ): Promise<Result<LanguageServerSnapshot, LanguageServerError>>;
  shutdown(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    signal?: AbortSignal,
  ): Promise<Result<LanguageServerSnapshot, LanguageServerError>>;
  openDocument(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerOpenDocumentRequest,
  ): Promise<Result<LanguageServerSnapshot, LanguageServerError>>;
  changeDocument(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerChangeDocumentRequest,
  ): Promise<Result<LanguageServerSnapshot, LanguageServerError>>;
  saveDocument(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerSaveDocumentRequest,
  ): Promise<Result<LanguageServerSnapshot, LanguageServerError>>;
  closeDocument(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerCloseDocumentRequest,
  ): Promise<Result<LanguageServerSnapshot, LanguageServerError>>;
  changeWorkspaceFolders(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    change: LanguageServerWorkspaceFoldersChange,
  ): Promise<Result<LanguageServerSnapshot, LanguageServerError>>;
  snapshot(serviceId: ManagedServiceId): LanguageServerSnapshot | null;
  attach(
    serviceId: ManagedServiceId,
    listener: LanguageServerListener,
  ): Result<{ detach(): void }, LanguageServerError>;
};

type LiveServer = {
  readonly request: LanguageServerStartRequest;
  readonly limits: LanguageServerLimits;
  generation: ServiceGeneration;
  state: LanguageServerState;
  pid: number | null;
  restartCount: number;
  capabilities: Readonly<Record<string, unknown>> | null;
  serverInfo: LanguageServerClientInfo | null;
  failureReason: LanguageServerFailureReason | null;
  order: number;
  nextRequestId: number;
  readonly decoder: ReturnType<typeof createJsonRpcFrameDecoder>;
  readonly listeners: Set<LanguageServerListener>;
  detachManaged: (() => void) | null;
  readonly pending: Map<
    string,
    {
      readonly resolve: (message: Extract<JsonRpcMessage, { readonly id: JsonRpcId }>) => void;
      readonly reject: (error: LanguageServerError) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >;
  readonly openDocuments: Map<string, LanguageServerOpenDocument>;
  workspaceFolders: LanguageServerWorkspaceFolder[];
  readonly registeredCapabilities: Map<string, LanguageServerRegisteredCapability>;
};

function pendingKey(id: JsonRpcId): string {
  return typeof id === "string" ? `s:${id}` : `n:${id}`;
}

function mapManagedStartError(error: ManagedServiceError): LanguageServerError {
  switch (error.code) {
    case "invalid-request":
      if (error.reason === "invalid-executable") {
        return { kind: "language-server", code: "missing-executable" };
      }
      return { kind: "language-server", code: "spawn-failed" };
    case "capacity-exceeded":
      return { kind: "language-server", code: "capacity-exceeded" };
    case "already-running":
      return { kind: "language-server", code: "already-running" };
    case "spawn-failed":
      return { kind: "language-server", code: "spawn-failed" };
    case "readiness-timeout":
    case "readiness-output-exceeded":
      return { kind: "language-server", code: "spawn-failed" };
    case "no-restart-policy":
    case "restart-budget-exhausted":
      return { kind: "language-server", code: "restart-exhaustion" };
    case "not-found":
      return { kind: "language-server", code: "not-found" };
    case "stale-generation":
      return { kind: "language-server", code: "stale-generation" };
    case "not-ready":
      return { kind: "language-server", code: "not-ready" };
    case "input-too-large":
    case "write-failed":
      return { kind: "language-server", code: "spawn-failed" };
    case "shutdown-timeout":
      return { kind: "language-server", code: "shutdown-timeout" };
    default:
      return { kind: "language-server", code: "spawn-failed" };
  }
}

export function createLanguageServerSupervisor(
  managedServices: ManagedServicePort,
): LanguageServerSupervisor {
  const servers = new Map<ManagedServiceId, LiveServer>();

  type LanguageServerEventDetail = {
    [Kind in LanguageServerEvent["kind"]]: Omit<
      Extract<LanguageServerEvent, { readonly kind: Kind }>,
      "serviceId" | "generation" | "order"
    >;
  }[LanguageServerEvent["kind"]];

  function emit(server: LiveServer, event: LanguageServerEventDetail): void {
    server.order += 1;
    const full = {
      ...event,
      serviceId: server.request.serviceId,
      generation: server.generation,
      order: server.order,
    } as LanguageServerEvent;
    for (const listener of [...server.listeners]) {
      try {
        listener(full);
      } catch {
        // Observers must not break the supervisor.
      }
    }
  }

  function setState(server: LiveServer, state: LanguageServerState): void {
    server.state = state;
    emit(server, { kind: "state", state });
  }

  function snapshotOf(server: LiveServer): LanguageServerSnapshot {
    return {
      serviceId: server.request.serviceId,
      key: server.request.key,
      generation: server.generation,
      state: server.state,
      pid: server.pid,
      restartCount: server.restartCount,
      capabilities: server.capabilities,
      serverInfo: server.serverInfo,
      failureReason: server.failureReason,
      openDocuments: [...server.openDocuments.values()].map((document) => ({
        uri: document.uri,
        languageId: document.languageId,
        version: document.version,
      })),
      workspaceFolders: [...server.workspaceFolders],
      registeredCapabilities: [...server.registeredCapabilities.values()].map((capability) => ({
        id: capability.id,
        method: capability.method,
      })),
    };
  }

  function fail(server: LiveServer, reason: LanguageServerFailureReason): LanguageServerError {
    server.failureReason = reason;
    setState(server, "failed");
    emit(server, { kind: "failed", reason });
    return { kind: "language-server", code: reason };
  }

  function requireReady(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
  ): Result<LiveServer, LanguageServerError> {
    const server = servers.get(serviceId);
    if (server === undefined) {
      return err({ kind: "language-server", code: "not-found" });
    }
    if (server.generation !== generation) {
      return err({ kind: "language-server", code: "stale-generation" });
    }
    if (server.state !== "ready" && server.state !== "degraded") {
      return err({ kind: "language-server", code: "not-ready" });
    }
    return ok(server);
  }

  async function sendRequest(
    server: LiveServer,
    method: string,
    params: unknown,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<Result<unknown, LanguageServerError>> {
    if (signal?.aborted === true) {
      return err({ kind: "language-server", code: "cancelled" });
    }
    const id = server.nextRequestId;
    server.nextRequestId += 1;
    const frame = encodeJsonRpcFrame({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    const response = new Promise<Result<unknown, LanguageServerError>>((resolve) => {
      const timer = setTimeout(() => {
        server.pending.delete(pendingKey(id));
        resolve(err({ kind: "language-server", code: "request-timeout" }));
      }, timeoutMs);
      server.pending.set(pendingKey(id), {
        resolve: (message) => {
          if ("error" in message) {
            resolve(
              err({
                kind: "language-server",
                code: method === "initialize" ? "initialization-failure" : "malformed-response",
              }),
            );
            return;
          }
          if (!("result" in message)) {
            resolve(err({ kind: "language-server", code: "malformed-response" }));
            return;
          }
          resolve(ok(message.result));
        },
        reject: (error) => resolve(err(error)),
        timer,
      });
    });

    const written = await managedServices.send(server.request.serviceId, server.generation, frame);
    if (!written.ok) {
      const pending = server.pending.get(pendingKey(id));
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        server.pending.delete(pendingKey(id));
      }
      return err(mapManagedStartError(written.error));
    }

    if (signal !== undefined) {
      const aborted = new Promise<Result<unknown, LanguageServerError>>((resolve) => {
        const onAbort = (): void => {
          const pending = server.pending.get(pendingKey(id));
          if (pending !== undefined) {
            clearTimeout(pending.timer);
            server.pending.delete(pendingKey(id));
          }
          resolve(err({ kind: "language-server", code: "cancelled" }));
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

  async function sendNotification(
    server: LiveServer,
    method: string,
    params?: unknown,
  ): Promise<Result<void, LanguageServerError>> {
    const frame = encodeJsonRpcFrame({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
    const written = await managedServices.send(server.request.serviceId, server.generation, frame);
    if (!written.ok) {
      return err(mapManagedStartError(written.error));
    }
    return ok(undefined);
  }

  async function sendResponse(
    server: LiveServer,
    id: JsonRpcId,
    result: unknown,
  ): Promise<Result<void, LanguageServerError>> {
    const frame = encodeJsonRpcFrame({
      jsonrpc: "2.0",
      id,
      result,
    });
    const written = await managedServices.send(server.request.serviceId, server.generation, frame);
    if (!written.ok) {
      return err(mapManagedStartError(written.error));
    }
    return ok(undefined);
  }

  async function handleServerRequest(
    server: LiveServer,
    message: JsonRpcRequestLike,
  ): Promise<void> {
    if (message.method === "client/registerCapability") {
      const parsed = parseRegisterCapabilityParams(message.params);
      if (!parsed.ok) {
        await sendResponse(server, message.id, null);
        return;
      }
      if (
        server.registeredCapabilities.size + parsed.value.length >
        MAX_LANGUAGE_SERVER_REGISTERED_CAPABILITIES
      ) {
        await sendResponse(server, message.id, null);
        return;
      }
      for (const capability of parsed.value) {
        server.registeredCapabilities.set(capability.id, capability);
        emit(server, {
          kind: "capability-registered",
          id: capability.id,
          method: capability.method,
        });
      }
      await sendResponse(server, message.id, null);
      return;
    }
    if (message.method === "client/unregisterCapability") {
      const parsed = parseUnregisterCapabilityParams(message.params);
      if (!parsed.ok) {
        await sendResponse(server, message.id, null);
        return;
      }
      for (const id of parsed.value) {
        if (server.registeredCapabilities.delete(id)) {
          emit(server, { kind: "capability-unregistered", id });
        }
      }
      await sendResponse(server, message.id, null);
      return;
    }
    // Unknown server→client requests are acknowledged empty so the peer does not hang.
    await sendResponse(server, message.id, null);
  }

  type JsonRpcRequestLike = {
    readonly id: JsonRpcId;
    readonly method: string;
    readonly params?: unknown;
  };

  function handleMessage(server: LiveServer, message: JsonRpcMessage): void {
    if ("method" in message && "id" in message) {
      void handleServerRequest(server, message as JsonRpcRequestLike);
      return;
    }
    if ("method" in message && !("id" in message)) {
      emit(server, {
        kind: "notification",
        method: message.method,
        params: message.params ?? null,
      });
      return;
    }
    if ("id" in message && message.id !== null && ("result" in message || "error" in message)) {
      const pending = server.pending.get(pendingKey(message.id));
      if (pending === undefined) {
        return;
      }
      clearTimeout(pending.timer);
      server.pending.delete(pendingKey(message.id));
      pending.resolve(message as Extract<JsonRpcMessage, { readonly id: JsonRpcId }>);
    }
  }

  function onManagedEvent(server: LiveServer, event: ManagedServiceEvent): void {
    if (event.generation !== server.generation && event.kind !== "restarted") {
      return;
    }
    switch (event.kind) {
      case "started":
      case "restarted":
        server.pid = event.pid;
        if (event.kind === "restarted") {
          server.generation = event.generation;
          server.restartCount += 1;
          server.decoder.reset();
          server.openDocuments.clear();
          server.registeredCapabilities.clear();
          setState(server, "restarting");
        }
        return;
      case "output":
        if (event.stream !== "stdout") {
          return;
        }
        {
          const decoded = server.decoder.push(event.bytes);
          if (!decoded.ok) {
            fail(server, "malformed-response");
            return;
          }
          for (const message of decoded.value) {
            handleMessage(server, message);
          }
        }
        return;
      case "ready":
        return;
      case "crashed":
        if (server.state === "shutting-down" || server.state === "stopped") {
          return;
        }
        fail(server, "crash");
        return;
      case "stopping":
        if (server.state !== "shutting-down") {
          setState(server, "shutting-down");
        }
        return;
      case "stopped":
        setState(server, "stopped");
        emit(server, { kind: "stopped" });
        return;
      case "failed":
        if (server.state !== "failed" && server.state !== "stopped") {
          fail(
            server,
            event.reason === "restart-budget-exhausted" || event.reason === "no-restart-policy"
              ? "restart-exhaustion"
              : event.reason === "shutdown-timeout"
                ? "shutdown-timeout"
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
      const invalid = validateLanguageServerStartRequest(request);
      if (invalid !== null) {
        return err(invalid);
      }
      const limitsResult = languageServerLimits(request.limits ?? {});
      if (!limitsResult.ok) {
        return limitsResult;
      }
      if (servers.has(request.serviceId)) {
        const existing = servers.get(request.serviceId);
        if (existing !== undefined && existing.state !== "stopped" && existing.state !== "failed") {
          return err({ kind: "language-server", code: "already-running" });
        }
      }

      const started = await managedServices.start({
        serviceId: request.serviceId,
        protocol: LANGUAGE_SERVER_PROTOCOL,
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
        shutdownTimeoutMs: duration(limitsResult.value.shutdownTimeoutMs),
        replayBytes: 64 * 1024,
      });
      if (!started.ok) {
        return err(mapManagedStartError(started.error));
      }

      const initialFolders = request.initialize.workspaceFolders ?? [];
      const server: LiveServer = {
        request,
        limits: limitsResult.value,
        generation: started.value.generation,
        state: "starting",
        pid: started.value.pid,
        restartCount: started.value.restartCount,
        capabilities: null,
        serverInfo: null,
        failureReason: null,
        order: 0,
        nextRequestId: 1,
        decoder: createJsonRpcFrameDecoder(limitsResult.value.maxFrameBytes),
        listeners: new Set(),
        detachManaged: null,
        pending: new Map(),
        openDocuments: new Map(),
        workspaceFolders: [...initialFolders],
        registeredCapabilities: new Map(),
      };
      servers.set(request.serviceId, server);
      setState(server, "starting");

      const attached = managedServices.attach(request.serviceId, (event) => {
        onManagedEvent(server, event);
      });
      if (!attached.ok) {
        return err(mapManagedStartError(attached.error));
      }
      server.detachManaged = attached.value.detach;
      if (attached.value.replay.stdout.byteLength > 0) {
        const decoded = server.decoder.push(attached.value.replay.stdout);
        if (!decoded.ok) {
          return err(fail(server, "malformed-response"));
        }
        for (const message of decoded.value) {
          handleMessage(server, message);
        }
      }

      setState(server, "initializing");
      const initialized = await sendRequest(
        server,
        "initialize",
        request.initialize,
        limitsResult.value.initializeTimeoutMs,
        signal,
      );
      if (!initialized.ok) {
        fail(
          server,
          initialized.error.kind === "language-server" &&
            initialized.error.code !== "invalid-request" &&
            initialized.error.code !== "invalid-limits" &&
            initialized.error.code !== "transport"
            ? initialized.error.code
            : "initialization-failure",
        );
        await managedServices.stop(request.serviceId, server.generation, "requested");
        return err(initialized.error);
      }

      const parsed = parseLanguageServerInitializeResult(initialized.value);
      if (!parsed.ok) {
        fail(server, "malformed-response");
        await managedServices.stop(request.serviceId, server.generation, "requested");
        return parsed;
      }

      const notified = await sendNotification(server, "initialized", {});
      if (!notified.ok) {
        fail(server, "initialization-failure");
        await managedServices.stop(request.serviceId, server.generation, "requested");
        return notified;
      }

      server.capabilities = parsed.value.capabilities;
      server.serverInfo = parsed.value.serverInfo;
      setState(server, "ready");
      emit(server, {
        kind: "initialized",
        capabilities: parsed.value.capabilities,
        serverInfo: parsed.value.serverInfo,
      });
      return ok(snapshotOf(server));
    },

    async shutdown(serviceId, generation, signal) {
      const server = servers.get(serviceId);
      if (server === undefined) {
        return err({ kind: "language-server", code: "not-found" });
      }
      if (server.generation !== generation) {
        return err({ kind: "language-server", code: "stale-generation" });
      }
      if (server.state === "stopped") {
        return ok(snapshotOf(server));
      }
      if (server.state === "failed") {
        const stopped = await managedServices.stop(serviceId, generation, "shutdown");
        if (!stopped.ok && stopped.error.code !== "not-found") {
          return err(mapManagedStartError(stopped.error));
        }
        setState(server, "stopped");
        return ok(snapshotOf(server));
      }

      const wasReady = server.state === "ready" || server.state === "degraded";
      setState(server, "shutting-down");
      if (wasReady) {
        await sendRequest(server, "shutdown", null, server.limits.shutdownTimeoutMs, signal);
        await sendNotification(server, "exit");
      }

      const stopped = await managedServices.stop(serviceId, generation, "shutdown");
      if (!stopped.ok) {
        if (stopped.error.code === "shutdown-timeout") {
          fail(server, "shutdown-timeout");
          return err({ kind: "language-server", code: "shutdown-timeout" });
        }
        if (stopped.error.code !== "not-found" && stopped.error.code !== "stale-generation") {
          return err(mapManagedStartError(stopped.error));
        }
      }
      for (const pending of server.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject({ kind: "language-server", code: "cancelled" });
      }
      server.pending.clear();
      server.openDocuments.clear();
      server.registeredCapabilities.clear();
      server.detachManaged?.();
      server.detachManaged = null;
      setState(server, "stopped");
      emit(server, { kind: "stopped" });
      return ok(snapshotOf(server));
    },

    async openDocument(serviceId, generation, request) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const server = ready.value;
      const invalid = validateOpenDocumentRequest(request);
      if (invalid !== null) {
        return err({ kind: "language-server", code: "invalid-request", reason: invalid });
      }
      if (server.openDocuments.has(request.uri)) {
        return err({ kind: "language-server", code: "document-already-open" });
      }
      if (server.openDocuments.size >= MAX_LANGUAGE_SERVER_OPEN_DOCUMENTS) {
        return err({ kind: "language-server", code: "capacity-exceeded" });
      }
      const version = request.version ?? 1;
      const notified = await sendNotification(server, "textDocument/didOpen", {
        textDocument: {
          uri: request.uri,
          languageId: request.languageId,
          version,
          text: request.text,
        },
      });
      if (!notified.ok) {
        return notified;
      }
      server.openDocuments.set(request.uri, {
        uri: request.uri,
        languageId: request.languageId,
        version,
        text: request.text,
      });
      emit(server, {
        kind: "document-opened",
        uri: request.uri,
        languageId: request.languageId,
        version,
      });
      return ok(snapshotOf(server));
    },

    async changeDocument(serviceId, generation, request) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const server = ready.value;
      const invalid = validateChangeDocumentRequest(request);
      if (invalid !== null) {
        return err({ kind: "language-server", code: "invalid-request", reason: invalid });
      }
      const current = server.openDocuments.get(request.uri);
      if (current === undefined) {
        return err({ kind: "language-server", code: "document-not-open" });
      }
      if (request.version !== current.version + 1) {
        return err({ kind: "language-server", code: "stale-document" });
      }
      const nextText = applyContentChanges(current.text, request.contentChanges);
      if (!nextText.ok) {
        return err({
          kind: "language-server",
          code: "invalid-request",
          reason:
            nextText.error.code === "invalid-request" ? nextText.error.reason : "invalid-change",
        });
      }
      const notified = await sendNotification(server, "textDocument/didChange", {
        textDocument: { uri: request.uri, version: request.version },
        contentChanges: request.contentChanges.map((change) =>
          change.kind === "full"
            ? { text: change.text }
            : { text: change.text, range: change.range },
        ),
      });
      if (!notified.ok) {
        return notified;
      }
      server.openDocuments.set(request.uri, {
        ...current,
        version: request.version,
        text: nextText.value,
      });
      emit(server, {
        kind: "document-changed",
        uri: request.uri,
        version: request.version,
      });
      return ok(snapshotOf(server));
    },

    async saveDocument(serviceId, generation, request) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const server = ready.value;
      const uriInvalid = validateDocumentUri(request.uri);
      if (uriInvalid !== null) {
        return err({ kind: "language-server", code: "invalid-request", reason: uriInvalid });
      }
      if (!server.openDocuments.has(request.uri)) {
        return err({ kind: "language-server", code: "document-not-open" });
      }
      const notified = await sendNotification(server, "textDocument/didSave", {
        textDocument: { uri: request.uri },
        ...(request.text === undefined ? {} : { text: request.text }),
      });
      if (!notified.ok) {
        return notified;
      }
      emit(server, { kind: "document-saved", uri: request.uri });
      return ok(snapshotOf(server));
    },

    async closeDocument(serviceId, generation, request) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const server = ready.value;
      if (!server.openDocuments.has(request.uri)) {
        return err({ kind: "language-server", code: "document-not-open" });
      }
      const notified = await sendNotification(server, "textDocument/didClose", {
        textDocument: { uri: request.uri },
      });
      if (!notified.ok) {
        return notified;
      }
      server.openDocuments.delete(request.uri);
      emit(server, { kind: "document-closed", uri: request.uri });
      return ok(snapshotOf(server));
    },

    async changeWorkspaceFolders(serviceId, generation, change) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const server = ready.value;
      const invalid = validateWorkspaceFoldersChange(change);
      if (invalid !== null) {
        return err({ kind: "language-server", code: "invalid-request", reason: invalid });
      }
      const merged = mergeWorkspaceFolders(server.workspaceFolders, change);
      if (!merged.ok) {
        if (merged.error.code === "invalid-request") {
          return err({
            kind: "language-server",
            code: "invalid-request",
            reason: merged.error.reason,
          });
        }
        return err({ kind: "language-server", code: merged.error.code });
      }
      const notified = await sendNotification(server, "workspace/didChangeWorkspaceFolders", {
        event: {
          added: change.added,
          removed: change.removed,
        },
      });
      if (!notified.ok) {
        return notified;
      }
      server.workspaceFolders = [...merged.value];
      emit(server, {
        kind: "workspace-folders-changed",
        folders: server.workspaceFolders,
      });
      return ok(snapshotOf(server));
    },

    snapshot(serviceId) {
      const server = servers.get(serviceId);
      return server === undefined ? null : snapshotOf(server);
    },

    attach(serviceId, listener) {
      const server = servers.get(serviceId);
      if (server === undefined) {
        return err({ kind: "language-server", code: "not-found" });
      }
      server.listeners.add(listener);
      let detached = false;
      return ok({
        detach: (): void => {
          if (detached) {
            return;
          }
          detached = true;
          server.listeners.delete(listener);
        },
      });
    },
  };
}

export { describeLanguageServerFailure };
