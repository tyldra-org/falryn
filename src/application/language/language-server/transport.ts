import type { ManagedServiceId, ServiceGeneration } from "../../../domain/foundation/index.ts";
import { err, ok, type Result } from "../../../domain/foundation/result.ts";
import {
  type createJsonRpcFrameDecoder,
  encodeJsonRpcFrame,
  type JsonRpcId,
  type JsonRpcMessage,
  type LanguageServerClientInfo,
  type LanguageServerError,
  type LanguageServerEvent,
  type LanguageServerFailureReason,
  type LanguageServerLimits,
  type LanguageServerOpenDocument,
  type LanguageServerPublishDiagnostics,
  type LanguageServerRegisteredCapability,
  type LanguageServerSnapshot,
  type LanguageServerStartRequest,
  type LanguageServerState,
  type LanguageServerWorkspaceFolder,
  MAX_LANGUAGE_SERVER_REGISTERED_CAPABILITIES,
  parsePublishDiagnostics,
  parseRegisterCapabilityParams,
  parseUnregisterCapabilityParams,
} from "../../../domain/language/index.ts";
import type {
  ManagedServiceError,
  ManagedServiceEvent,
  ManagedServicePort,
} from "../../../domain/process/index.ts";
import type { LanguageServerListener } from "./contracts.ts";

export type LiveServer = {
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
  readonly diagnosticsByUri: Map<string, LanguageServerPublishDiagnostics>;
};

function pendingKey(id: JsonRpcId): string {
  return typeof id === "string" ? `s:${id}` : `n:${id}`;
}

export function mapManagedStartError(error: ManagedServiceError): LanguageServerError {
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

export function createLanguageTransport(managedServices: ManagedServicePort) {
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

  function mapEditFailure(
    code:
      | "document-not-open"
      | "stale-document"
      | "capacity-exceeded"
      | "invalid-uri"
      | "invalid-position"
      | "invalid-range"
      | "invalid-edit"
      | "invalid-workspace-edit"
      | "invalid-code-action"
      | "invalid-rename"
      | "result-too-large"
      | "unsupported-resource-operation"
      | "overlapping-edits"
      | "path-outside-workspace",
  ): LanguageServerError {
    if (code === "document-not-open" || code === "stale-document" || code === "capacity-exceeded") {
      return { kind: "language-server", code };
    }
    return { kind: "language-server", code: "invalid-request", reason: code };
  }

  function workspaceFolderUris(server: LiveServer): readonly string[] {
    return server.workspaceFolders.map((folder) => folder.uri);
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
            const errorCode =
              typeof message.error === "object" &&
              message.error !== null &&
              "code" in message.error &&
              typeof (message.error as { readonly code: unknown }).code === "number"
                ? (message.error as { readonly code: number }).code
                : null;
            if (method === "initialize") {
              resolve(err({ kind: "language-server", code: "initialization-failure" }));
              return;
            }
            if (errorCode === -32_601) {
              resolve(err({ kind: "language-server", code: "unsupported" }));
              return;
            }
            resolve(err({ kind: "language-server", code: "malformed-response" }));
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
      if (message.method === "textDocument/publishDiagnostics") {
        const parsed = parsePublishDiagnostics(message.params);
        if (!parsed.ok) {
          emit(server, {
            kind: "notification",
            method: message.method,
            params: message.params ?? null,
          });
          return;
        }
        server.diagnosticsByUri.set(parsed.value.uri, parsed.value);
        emit(server, {
          kind: "diagnostics",
          uri: parsed.value.uri,
          version: parsed.value.version,
          diagnostics: parsed.value.diagnostics,
        });
        return;
      }
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
          server.diagnosticsByUri.clear();
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
    servers,
    emit,
    setState,
    snapshotOf,
    fail,
    requireReady,
    mapEditFailure,
    workspaceFolderUris,
    sendRequest,
    sendNotification,
    handleMessage,
    onManagedEvent,
  };
}
