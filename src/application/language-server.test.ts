import { describe, expect, test } from "bun:test";
import {
  configurationGeneration,
  createJsonRpcFrameDecoder,
  createWorkspaceSet,
  encodeJsonRpcFrame,
  type JsonRpcMessage,
  type LanguageServerEvent,
  localPath,
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
  workspaceRootId,
} from "../domain/index.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { createLanguageServerSupervisor } from "./language-server.ts";
import {
  syncLanguageServerFoldersFromWorkspaceSet,
  workspaceFolderSyncSnapshot,
} from "./language-server-workspace.ts";

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

  test("syncs product workspace-set folders through changeWorkspaceFolders", async () => {
    const seen: string[] = [];
    const port = new FakeManagedServicePort((message, pushStdout) => {
      compliantLspHandler(message, pushStdout);
      if ("method" in message) {
        seen.push(message.method);
      }
    });
    const supervisor = createLanguageServerSupervisor(port);
    const request = startRequest("lsp:product-folders");
    const started = await supervisor.start(request);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    const previousSet = createWorkspaceSet([
      {
        rootId: workspaceRootId.from("root-a"),
        name: "demo",
        path: localPath("/tmp/demo"),
      },
    ]);
    const nextSet = createWorkspaceSet([
      {
        rootId: workspaceRootId.from("root-a"),
        name: "demo",
        path: localPath("/tmp/demo"),
      },
      {
        rootId: workspaceRootId.from("root-b"),
        name: "docs",
        path: localPath("/tmp/docs"),
      },
    ]);
    expect(previousSet.ok && nextSet.ok).toBe(true);
    if (!previousSet.ok || !nextSet.ok) {
      return;
    }

    const synced = await syncLanguageServerFoldersFromWorkspaceSet({
      supervisor,
      serviceId: request.serviceId,
      generation: started.value.generation,
      previous: workspaceFolderSyncSnapshot(previousSet.value, configurationGeneration.from(1)),
      next: workspaceFolderSyncSnapshot(nextSet.value, configurationGeneration.from(1)),
    });
    expect(synced.ok).toBe(true);
    if (!synced.ok) {
      return;
    }
    expect(synced.value.notified).toBe(true);
    expect(synced.value.snapshot?.workspaceFolders).toEqual([
      { uri: "file:///tmp/demo", name: "demo" },
      { uri: "file:///tmp/docs", name: "docs" },
    ]);
    expect(seen).toContain("workspace/didChangeWorkspaceFolders");

    const unchanged = await syncLanguageServerFoldersFromWorkspaceSet({
      supervisor,
      serviceId: request.serviceId,
      generation: started.value.generation,
      previous: synced.value.synced,
      next: synced.value.synced,
    });
    expect(unchanged).toEqual({
      ok: true,
      value: {
        snapshot: null,
        synced: synced.value.synced,
        notified: false,
      },
    });

    await supervisor.shutdown(request.serviceId, started.value.generation);
  });

  test("admits hover, definition, references, symbols, completion, and diagnostics", async () => {
    const port = new FakeManagedServicePort((message, pushStdout) => {
      compliantLspHandler(message, pushStdout);
      if (!("method" in message) || !("id" in message)) {
        return;
      }
      if (message.method === "textDocument/hover") {
        pushStdout(
          encodeJsonRpcFrame({
            jsonrpc: "2.0",
            id: message.id,
            result: { contents: { kind: "plaintext", value: "const x: number" } },
          }),
        );
        return;
      }
      if (message.method === "textDocument/definition") {
        pushStdout(
          encodeJsonRpcFrame({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              uri: "file:///tmp/demo/a.ts",
              range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
            },
          }),
        );
        return;
      }
      if (message.method === "textDocument/references") {
        pushStdout(
          encodeJsonRpcFrame({
            jsonrpc: "2.0",
            id: message.id,
            result: [
              {
                uri: "file:///tmp/demo/a.ts",
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
              },
            ],
          }),
        );
        return;
      }
      if (message.method === "textDocument/documentSymbol") {
        pushStdout(
          encodeJsonRpcFrame({
            jsonrpc: "2.0",
            id: message.id,
            result: [
              {
                name: "x",
                kind: 13,
                location: {
                  uri: "file:///tmp/demo/a.ts",
                  range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
                },
              },
            ],
          }),
        );
        return;
      }
      if (message.method === "textDocument/completion") {
        pushStdout(
          encodeJsonRpcFrame({
            jsonrpc: "2.0",
            id: message.id,
            result: { isIncomplete: false, items: [{ label: "x", kind: 6 }] },
          }),
        );
      }
    });
    const supervisor = createLanguageServerSupervisor(port);
    const request = startRequest("lsp:features");
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
      text: "const x = 1;\n",
    });
    expect(opened.ok).toBe(true);

    const position = { line: 0, character: 6 };
    const hovered = await supervisor.hover(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
      position,
    });
    expect(hovered).toEqual({
      ok: true,
      value: { contents: { kind: "plaintext", value: "const x: number" } },
    });

    const defined = await supervisor.definition(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
      position,
    });
    expect(defined.ok).toBe(true);
    if (defined.ok) {
      expect(defined.value).toHaveLength(1);
    }

    const refs = await supervisor.references(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
      position,
      includeDeclaration: true,
    });
    expect(refs.ok).toBe(true);

    const symbols = await supervisor.documentSymbols(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
    });
    expect(symbols).toEqual({
      ok: true,
      value: {
        kind: "information",
        symbols: [
          {
            name: "x",
            kind: 13,
            location: {
              uri: "file:///tmp/demo/a.ts",
              range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
            },
          },
        ],
      },
    });

    const completed = await supervisor.completion(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
      position,
    });
    expect(completed).toEqual({
      ok: true,
      value: { isIncomplete: false, items: [{ label: "x", kind: 6 }] },
    });

    const notOpen = await supervisor.hover(request.serviceId, generation, {
      uri: "file:///tmp/demo/missing.ts",
      position,
    });
    expect(notOpen).toEqual({
      ok: false,
      error: { kind: "language-server", code: "document-not-open" },
    });

    await supervisor.shutdown(request.serviceId, generation);
  });

  test("observes publishDiagnostics notifications", async () => {
    const port = new FakeManagedServicePort((message, pushStdout) => {
      compliantLspHandler(message, pushStdout);
      if ("method" in message && message.method === "textDocument/didOpen") {
        pushStdout(
          encodeJsonRpcFrame({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: {
              uri: "file:///tmp/demo/a.ts",
              version: 1,
              diagnostics: [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                  message: "unused",
                  severity: 2,
                },
              ],
            },
          }),
        );
      }
    });
    const supervisor = createLanguageServerSupervisor(port);
    const request = startRequest("lsp:diagnostics");
    const started = await supervisor.start(request);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const events: LanguageServerEvent[] = [];
    supervisor.attach(request.serviceId, (event) => events.push(event));

    const opened = await supervisor.openDocument(request.serviceId, started.value.generation, {
      uri: "file:///tmp/demo/a.ts",
      languageId: "typescript",
      text: "const x = 1;\n",
    });
    expect(opened.ok).toBe(true);

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const stored = supervisor.diagnostics(request.serviceId, "file:///tmp/demo/a.ts");
    expect(stored?.diagnostics).toEqual([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        message: "unused",
        severity: 2,
      },
    ]);
    expect(events.some((event) => event.kind === "diagnostics")).toBe(true);

    await supervisor.shutdown(request.serviceId, started.value.generation);
  });

  test("maps method-not-found feature responses to unsupported", async () => {
    const port = new FakeManagedServicePort((message, pushStdout) => {
      compliantLspHandler(message, pushStdout);
      if ("method" in message && "id" in message && message.method === "textDocument/hover") {
        pushStdout(
          encodeJsonRpcFrame({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32_601, message: "Method not found" },
          }),
        );
      }
    });
    const supervisor = createLanguageServerSupervisor(port);
    const request = startRequest("lsp:unsupported");
    const started = await supervisor.start(request);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    await supervisor.openDocument(request.serviceId, started.value.generation, {
      uri: "file:///tmp/demo/a.ts",
      languageId: "typescript",
      text: "const x = 1;\n",
    });
    const hovered = await supervisor.hover(request.serviceId, started.value.generation, {
      uri: "file:///tmp/demo/a.ts",
      position: { line: 0, character: 0 },
    });
    expect(hovered).toEqual({
      ok: false,
      error: { kind: "language-server", code: "unsupported" },
    });
    await supervisor.shutdown(request.serviceId, started.value.generation);
  });

  test("converts format, rename, and code-action edits into patch plans", async () => {
    const port = new FakeManagedServicePort((message, pushStdout) => {
      compliantLspHandler(message, pushStdout);
      if (!("method" in message) || !("id" in message)) {
        return;
      }
      if (
        message.method === "textDocument/formatting" ||
        message.method === "textDocument/rangeFormatting"
      ) {
        pushStdout(
          encodeJsonRpcFrame({
            jsonrpc: "2.0",
            id: message.id,
            result: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
                newText: "const x = 1;\n",
              },
            ],
          }),
        );
        return;
      }
      if (message.method === "textDocument/rename") {
        pushStdout(
          encodeJsonRpcFrame({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              documentChanges: [
                {
                  textDocument: { uri: "file:///tmp/demo/a.ts", version: 1 },
                  edits: [
                    {
                      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
                      newText: "y",
                    },
                  ],
                },
              ],
            },
          }),
        );
        return;
      }
      if (message.method === "textDocument/codeAction") {
        pushStdout(
          encodeJsonRpcFrame({
            jsonrpc: "2.0",
            id: message.id,
            result: [
              {
                title: "Fix",
                kind: "quickfix",
                edit: {
                  changes: {
                    "file:///tmp/demo/a.ts": [
                      {
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                        newText: "let",
                      },
                    ],
                  },
                },
                command: { title: "refresh", command: "typescript.restartTsServer" },
              },
            ],
          }),
        );
      }
    });
    const supervisor = createLanguageServerSupervisor(port);
    const request = startRequest("lsp:edits");
    const started = await supervisor.start(request);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const generation = started.value.generation;
    await supervisor.openDocument(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
      languageId: "typescript",
      text: "const x = 1;\n",
    });

    const formatted = await supervisor.formatDocument(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
    });
    expect(formatted.ok).toBe(true);
    if (formatted.ok) {
      expect(formatted.value.plan.targets[0]?.path).toBe("a.ts");
      expect(formatted.value.deferredCommands).toEqual([]);
    }

    const rangeFormatted = await supervisor.formatRange(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
    });
    expect(rangeFormatted.ok).toBe(true);
    if (rangeFormatted.ok) {
      expect(rangeFormatted.value.plan.targets[0]?.path).toBe("a.ts");
      expect(rangeFormatted.value.deferredCommands).toEqual([]);
    }

    const renamed = await supervisor.rename(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
      position: { line: 0, character: 6 },
      newName: "y",
    });
    expect(renamed.ok).toBe(true);
    if (renamed.ok) {
      expect(renamed.value.plan.targets[0]?.hunks[0]?.newLines).toEqual(["const y = 1;"]);
    }

    const stale = await supervisor.rename(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
      position: { line: 0, character: 6 },
      newName: "z",
    });
    // Server still returns version 1; after open version is 1 so still ok unless we bump.
    expect(stale.ok).toBe(true);

    const actions = await supervisor.codeActions(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    });
    expect(actions.ok).toBe(true);
    if (actions.ok) {
      expect(actions.value.patches).toHaveLength(1);
      expect(actions.value.patches[0]?.deferredCommands).toEqual([
        { title: "refresh", command: "typescript.restartTsServer" },
      ]);
      expect(actions.value.patches[0]?.plan.targets[0]?.hunks[0]?.newLines).toEqual(["let x = 1;"]);
    }

    await supervisor.shutdown(request.serviceId, generation);
  });

  test("routes only the closed extended language feature set", async () => {
    const methods: string[] = [];
    const port = new FakeManagedServicePort((message, pushStdout) => {
      compliantLspHandler(message, pushStdout);
      if (!("method" in message) || !("id" in message)) return;
      if (
        message.method === "textDocument/declaration" ||
        message.method === "workspace/symbol" ||
        message.method === "callHierarchy/incomingCalls"
      ) {
        methods.push(message.method);
        pushStdout(
          encodeJsonRpcFrame({
            jsonrpc: "2.0",
            id: message.id,
            result: [{ name: "value", uri: "file:///tmp/demo/a.ts" }],
          }),
        );
      }
    });
    const supervisor = createLanguageServerSupervisor(port);
    const request = startRequest("lsp:extended");
    const started = await supervisor.start(request);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const generation = started.value.generation;
    await supervisor.openDocument(request.serviceId, generation, {
      uri: "file:///tmp/demo/a.ts",
      languageId: "typescript",
      text: "const value = 1;\n",
    });

    const declaration = await supervisor.extendedFeature(request.serviceId, generation, {
      kind: "declaration",
      uri: "file:///tmp/demo/a.ts",
      position: { line: 0, character: 6 },
    });
    const symbols = await supervisor.extendedFeature(request.serviceId, generation, {
      kind: "workspace-symbols",
      query: "value",
    });
    const incoming = await supervisor.extendedFeature(request.serviceId, generation, {
      kind: "call-hierarchy-incoming",
      item: { name: "value", uri: "file:///tmp/demo/a.ts" },
    });
    expect(declaration.ok).toBe(true);
    expect(symbols.ok).toBe(true);
    expect(incoming.ok).toBe(true);
    expect(methods).toEqual([
      "textDocument/declaration",
      "workspace/symbol",
      "callHierarchy/incomingCalls",
    ]);

    const missing = await supervisor.extendedFeature(request.serviceId, generation, {
      kind: "declaration",
      uri: "file:///tmp/demo/missing.ts",
      position: { line: 0, character: 0 },
    });
    expect(missing).toEqual({
      ok: false,
      error: { kind: "language-server", code: "document-not-open" },
    });
    await supervisor.shutdown(request.serviceId, generation);
  });
});
