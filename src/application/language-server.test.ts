import { describe, expect, test } from "bun:test";
import {
  configurationGeneration,
  createJsonRpcFrameDecoder,
  encodeJsonRpcFrame,
  type JsonRpcMessage,
  type LanguageServerEvent,
  type ManagedServiceAttachment,
  type ManagedServiceError,
  type ManagedServiceEvent,
  type ManagedServiceListener,
  type ManagedServicePort,
  type ManagedServiceRequest,
  type ManagedServiceSnapshot,
  type ManagedServiceStopReport,
  type ManagedServiceWriteReport,
  managedServiceId,
  type ServiceGeneration,
  serviceGeneration,
} from "../domain/index.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { createLanguageServerSupervisor } from "./language-server.ts";

type ProtocolHandler = (message: JsonRpcMessage, pushStdout: (bytes: Uint8Array) => void) => void;

class FakeManagedServicePort implements ManagedServicePort {
  private readonly services = new Map<
    string,
    {
      request: ManagedServiceRequest;
      generation: ServiceGeneration;
      state: ManagedServiceSnapshot["state"];
      pid: number;
      listeners: Set<ManagedServiceListener>;
      order: number;
      stdout: Uint8Array;
      decoder: ReturnType<typeof createJsonRpcFrameDecoder>;
    }
  >();
  private nextPid = 1000;
  private handler: ProtocolHandler;

  constructor(handler: ProtocolHandler) {
    this.handler = handler;
  }

  async start(
    request: ManagedServiceRequest,
  ): Promise<Result<ManagedServiceSnapshot, ManagedServiceError>> {
    const key = String(request.serviceId);
    if (this.services.has(key) && this.services.get(key)?.state !== "stopped") {
      return err({ kind: "managed-service", code: "already-running" });
    }
    const generation = serviceGeneration.from(1);
    const pid = this.nextPid;
    this.nextPid += 1;
    const service = {
      request,
      generation,
      state: "ready" as const,
      pid,
      listeners: new Set<ManagedServiceListener>(),
      order: 0,
      stdout: new Uint8Array(0),
      decoder: createJsonRpcFrameDecoder(),
    };
    this.services.set(key, service);
    this.emit(service, { kind: "started", pid, generation });
    this.emit(service, { kind: "ready", generation });
    return ok({
      serviceId: request.serviceId,
      protocol: request.protocol,
      generation,
      pid,
      state: "ready",
      restartCount: 0,
      lastExit: null,
    });
  }

  attach(
    serviceId: ReturnType<typeof managedServiceId.from>,
    listener: ManagedServiceListener,
  ): Result<ManagedServiceAttachment, ManagedServiceError> {
    const service = this.services.get(String(serviceId));
    if (service === undefined) {
      return err({ kind: "managed-service", code: "not-found" });
    }
    service.listeners.add(listener);
    return ok({
      replay: {
        stdout: service.stdout,
        stderr: new Uint8Array(0),
        droppedStdoutBytes: 0,
        droppedStderrBytes: 0,
      },
      detach: (): void => {
        service.listeners.delete(listener);
      },
    });
  }

  async send(
    serviceId: ReturnType<typeof managedServiceId.from>,
    generation: ServiceGeneration,
    bytes: Uint8Array,
  ): Promise<Result<ManagedServiceWriteReport, ManagedServiceError>> {
    const service = this.services.get(String(serviceId));
    if (service === undefined) {
      return err({ kind: "managed-service", code: "not-found" });
    }
    if (service.generation !== generation) {
      return err({ kind: "managed-service", code: "stale-generation" });
    }
    if (service.state !== "ready") {
      return err({ kind: "managed-service", code: "not-ready", state: service.state });
    }
    const decoded = service.decoder.push(bytes);
    if (decoded.ok) {
      for (const message of decoded.value) {
        this.handler(message, (response) => this.pushStdout(service, response));
      }
    }
    return ok({ acceptedBytes: bytes.byteLength });
  }

  async stop(
    serviceId: ReturnType<typeof managedServiceId.from>,
    generation: ServiceGeneration,
    reason: "requested" | "shutdown" = "requested",
  ): Promise<Result<ManagedServiceStopReport, ManagedServiceError>> {
    const service = this.services.get(String(serviceId));
    if (service === undefined) {
      return err({ kind: "managed-service", code: "not-found" });
    }
    if (service.generation !== generation) {
      return err({ kind: "managed-service", code: "stale-generation" });
    }
    this.emit(service, { kind: "stopping", reason, generation });
    service.state = "stopped";
    const exit = { exitCode: 0, signal: null };
    this.emit(service, { kind: "stopped", reason, exit, generation });
    return ok({ kind: "stopped", reason, exit });
  }

  snapshot(serviceId: ReturnType<typeof managedServiceId.from>): ManagedServiceSnapshot | null {
    const service = this.services.get(String(serviceId));
    if (service === undefined) {
      return null;
    }
    return {
      serviceId: service.request.serviceId,
      protocol: service.request.protocol,
      generation: service.generation,
      pid: service.pid,
      state: service.state,
      restartCount: 0,
      lastExit: null,
    };
  }

  private pushStdout(
    service: {
      request: ManagedServiceRequest;
      generation: ServiceGeneration;
      listeners: Set<ManagedServiceListener>;
      order: number;
      stdout: Uint8Array;
    },
    bytes: Uint8Array,
  ): void {
    const next = new Uint8Array(service.stdout.byteLength + bytes.byteLength);
    next.set(service.stdout, 0);
    next.set(bytes, service.stdout.byteLength);
    service.stdout = next;
    this.emit(service, {
      kind: "output",
      stream: "stdout",
      bytes,
      generation: service.generation,
    });
  }

  private emit(
    service: {
      request: ManagedServiceRequest;
      listeners: Set<ManagedServiceListener>;
      order: number;
    },
    detail: {
      [Kind in ManagedServiceEvent["kind"]]: Omit<
        Extract<ManagedServiceEvent, { readonly kind: Kind }>,
        "serviceId" | "order"
      >;
    }[ManagedServiceEvent["kind"]],
  ): void {
    service.order += 1;
    const event = {
      ...detail,
      serviceId: service.request.serviceId,
      order: service.order,
    } as ManagedServiceEvent;
    for (const listener of [...service.listeners]) {
      listener(event);
    }
  }
}

function compliantLspHandler(
  message: JsonRpcMessage,
  pushStdout: (bytes: Uint8Array) => void,
): void {
  if (!("method" in message) || !("id" in message)) {
    return;
  }
  if (message.method === "initialize") {
    pushStdout(
      encodeJsonRpcFrame({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: { hoverProvider: true, textDocumentSync: 1 },
          serverInfo: { name: "fake-lsp", version: "9.9.9" },
        },
      }),
    );
    return;
  }
  if (message.method === "shutdown") {
    pushStdout(
      encodeJsonRpcFrame({
        jsonrpc: "2.0",
        id: message.id,
        result: null,
      }),
    );
  }
}

function startRequest(serviceId = "lsp:demo") {
  return {
    serviceId: managedServiceId.from(serviceId),
    key: {
      workspaceRoot: "/tmp/demo",
      serverName: "fake-lsp",
      configurationGeneration: configurationGeneration.from(0),
    },
    executable: "/usr/bin/fake-lsp",
    argv: ["--stdio"],
    environment: { PATH: "/usr/bin" },
    initialize: {
      processId: null,
      rootUri: "file:///tmp/demo",
      workspaceFolders: [{ uri: "file:///tmp/demo", name: "demo" }],
      capabilities: { workspace: { workspaceFolders: true } },
      clientInfo: { name: "falryn", version: "0.0.0" },
    },
    limits: {
      initializeTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
      maxRestarts: 0,
    },
  };
}

describe("language-server supervisor", () => {
  test("starts through initialize and shuts down cleanly", async () => {
    const port = new FakeManagedServicePort(compliantLspHandler);
    const supervisor = createLanguageServerSupervisor(port);
    const request = startRequest();
    const events: LanguageServerEvent[] = [];

    const started = await supervisor.start(request);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    expect(started.value.state).toBe("ready");
    expect(started.value.capabilities).toEqual({
      hoverProvider: true,
      textDocumentSync: 1,
    });
    expect(started.value.serverInfo).toEqual({ name: "fake-lsp", version: "9.9.9" });

    const attached = supervisor.attach(request.serviceId, (event) => events.push(event));
    expect(attached.ok).toBe(true);

    const stopped = await supervisor.shutdown(request.serviceId, started.value.generation);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) {
      return;
    }
    expect(stopped.value.state).toBe("stopped");
    expect(events.some((event) => event.kind === "stopped")).toBe(true);
  });

  test("fails initialize on request timeout", async () => {
    const port = new FakeManagedServicePort(() => {
      // Never answer initialize.
    });
    const supervisor = createLanguageServerSupervisor(port);
    const request = startRequest("lsp:timeout");
    const started = await supervisor.start({
      ...request,
      limits: { ...request.limits, initializeTimeoutMs: 50 },
    });
    expect(started.ok).toBe(false);
    if (started.ok) {
      return;
    }
    expect(started.error).toEqual({ kind: "language-server", code: "request-timeout" });
  });

  test("rejects relative executables before spawning", async () => {
    const port = new FakeManagedServicePort(compliantLspHandler);
    const supervisor = createLanguageServerSupervisor(port);
    const request = startRequest("lsp:relative");
    const started = await supervisor.start({
      ...request,
      executable: "tsserver",
    });
    expect(started.ok).toBe(false);
    if (started.ok) {
      return;
    }
    expect(started.error).toMatchObject({
      kind: "language-server",
      code: "invalid-request",
      reason: "invalid-executable",
    });
  });

  test("surfaces initialize error responses", async () => {
    const port = new FakeManagedServicePort((message, pushStdout) => {
      if ("method" in message && "id" in message && message.method === "initialize") {
        pushStdout(
          encodeJsonRpcFrame({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32_602, message: "invalid params" },
          }),
        );
      }
    });
    const supervisor = createLanguageServerSupervisor(port);
    const started = await supervisor.start(startRequest("lsp:init-error"));
    expect(started.ok).toBe(false);
    if (started.ok) {
      return;
    }
    expect(started.error).toEqual({ kind: "language-server", code: "initialization-failure" });
  });

  test("opens, changes, saves, and closes documents with monotonic versions", async () => {
    const seen: string[] = [];
    const port = new FakeManagedServicePort((message, pushStdout) => {
      compliantLspHandler(message, pushStdout);
      if ("method" in message) {
        seen.push(message.method);
      }
    });
    const supervisor = createLanguageServerSupervisor(port);
    const request = startRequest("lsp:docs");
    const started = await supervisor.start(request);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const generation = started.value.generation;
    const events: LanguageServerEvent[] = [];
    supervisor.attach(request.serviceId, (event) => events.push(event));

    const opened = await supervisor.openDocument(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
      languageId: "typescript",
      text: " cons x = 1;\n",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }
    expect(opened.value.openDocuments).toEqual([
      { uri: "file:///tmp/demo/a.ts", languageId: "typescript", version: 1 },
    ]);

    const stale = await supervisor.changeDocument(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
      version: 3,
      contentChanges: [{ kind: "full", text: "const x = 2;\n" }],
    });
    expect(stale).toEqual({
      ok: false,
      error: { kind: "language-server", code: "stale-document" },
    });

    const changed = await supervisor.changeDocument(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
      version: 2,
      contentChanges: [{ kind: "full", text: "const x = 2;\n" }],
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) {
      return;
    }
    expect(changed.value.openDocuments[0]?.version).toBe(2);

    const saved = await supervisor.saveDocument(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
    });
    expect(saved.ok).toBe(true);

    const closed = await supervisor.closeDocument(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
    });
    expect(closed.ok).toBe(true);
    if (!closed.ok) {
      return;
    }
    expect(closed.value.openDocuments).toEqual([]);
    expect(seen).toContain("textDocument/didOpen");
    expect(seen).toContain("textDocument/didChange");
    expect(seen).toContain("textDocument/didSave");
    expect(seen).toContain("textDocument/didClose");
    expect(events.some((event) => event.kind === "document-opened")).toBe(true);
    expect(events.some((event) => event.kind === "document-changed")).toBe(true);
    expect(events.some((event) => event.kind === "document-closed")).toBe(true);

    await supervisor.shutdown(request.serviceId, generation);
  });

  test("updates workspace folders and accepts dynamic capability registration", async () => {
    const port = new FakeManagedServicePort((message, pushStdout) => {
      compliantLspHandler(message, pushStdout);
      if ("method" in message && "id" in message && message.method === "initialized") {
        // no-op
      }
      if ("method" in message && message.method === "initialized") {
        pushStdout(
          encodeJsonRpcFrame({
            jsonrpc: "2.0",
            id: 100,
            method: "client/registerCapability",
            params: {
              registrations: [
                { id: "diag-1", method: "textDocument/diagnostic", registerOptions: null },
              ],
            },
          }),
        );
      }
    });
    const supervisor = createLanguageServerSupervisor(port);
    const request = startRequest("lsp:folders");
    const started = await supervisor.start(request);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    // Allow the registerCapability request to be processed.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const afterRegister = supervisor.snapshot(request.serviceId);
    expect(afterRegister?.registeredCapabilities).toEqual([
      { id: "diag-1", method: "textDocument/diagnostic" },
    ]);

    const folders = await supervisor.changeWorkspaceFolders(
      request.serviceId,
      started.value.generation,
      {
        added: [{ uri: "file:///tmp/other", name: "other" }],
        removed: [],
      },
    );
    expect(folders.ok).toBe(true);
    if (!folders.ok) {
      return;
    }
    expect(folders.value.workspaceFolders).toEqual([
      { uri: "file:///tmp/demo", name: "demo" },
      { uri: "file:///tmp/other", name: "other" },
    ]);

    await supervisor.shutdown(request.serviceId, started.value.generation);
  });
});
