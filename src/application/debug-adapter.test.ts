import { describe, expect, test } from "bun:test";
import {
  configurationGeneration,
  createDapFrameDecoder,
  type DapMessage,
  type DebugAdapterEvent,
  encodeDapFrame,
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
import { createDebugAdapterSupervisor } from "./debug-adapter.ts";

type ProtocolHandler = (message: DapMessage, pushStdout: (bytes: Uint8Array) => void) => void;

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
      decoder: ReturnType<typeof createDapFrameDecoder>;
    }
  >();
  private nextPid = 2000;
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
      decoder: createDapFrameDecoder(),
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

function compliantDapHandler(message: DapMessage, pushStdout: (bytes: Uint8Array) => void): void {
  if (message.type === "request" && message.command === "initialize") {
    pushStdout(
      encodeDapFrame({
        seq: 1,
        type: "response",
        request_seq: message.seq,
        success: true,
        command: "initialize",
        body: { supportsConfigurationDoneRequest: true },
      }),
    );
    return;
  }
  if (message.type === "event" && message.event === "initialized") {
    return;
  }
  if (message.type === "request" && message.command === "disconnect") {
    pushStdout(
      encodeDapFrame({
        seq: 2,
        type: "response",
        request_seq: message.seq,
        success: true,
        command: "disconnect",
        body: {},
      }),
    );
    return;
  }
  if (message.type === "request") {
    pushStdout(
      encodeDapFrame({
        seq: 99,
        type: "response",
        request_seq: message.seq,
        success: false,
        command: message.command,
        message: "not supported",
      }),
    );
  }
}

const startRequest = {
  serviceId: managedServiceId.from("dap:fixture"),
  key: {
    workspaceRoot: "/tmp/falryn-dap",
    adapterName: "fixture",
    configurationGeneration: configurationGeneration.from(0),
  },
  executable: "/usr/bin/env",
  argv: ["true"],
  environment: {},
  initialize: {
    clientID: "falryn",
    clientName: "Falryn",
    adapterID: "fixture",
    pathFormat: "path" as const,
    linesStartAt1: true,
    columnsStartAt1: true,
  },
  limits: {
    initializeTimeoutMs: 2_000,
    disconnectTimeoutMs: 2_000,
    maxRestarts: 0,
  },
};

describe("createDebugAdapterSupervisor", () => {
  test("initializes over DAP framing and reaches ready", async () => {
    const events: DebugAdapterEvent["kind"][] = [];
    const port = new FakeManagedServicePort(compliantDapHandler);
    const supervisor = createDebugAdapterSupervisor(port);
    const attached = supervisor.attach(startRequest.serviceId, (event) => {
      events.push(event.kind);
    });
    // attach before start fails — session does not exist yet
    expect(attached.ok).toBe(false);

    const started = await supervisor.start(startRequest);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    expect(started.value.state).toBe("ready");
    expect(started.value.capabilities).toEqual({ supportsConfigurationDoneRequest: true });
    expect(started.value.pid).toBeGreaterThan(0);

    const listen = supervisor.attach(startRequest.serviceId, (event) => {
      events.push(event.kind);
    });
    expect(listen.ok).toBe(true);

    const disconnected = await supervisor.disconnect(
      startRequest.serviceId,
      started.value.generation,
    );
    expect(disconnected.ok).toBe(true);
    if (!disconnected.ok) {
      return;
    }
    expect(disconnected.value.state).toBe("stopped");
  });

  test("fails initialize when the adapter rejects the handshake", async () => {
    const port = new FakeManagedServicePort((message, pushStdout) => {
      if (message.type === "request" && message.command === "initialize") {
        pushStdout(
          encodeDapFrame({
            seq: 1,
            type: "response",
            request_seq: message.seq,
            success: false,
            command: "initialize",
            message: "nope",
          }),
        );
      }
    });
    const supervisor = createDebugAdapterSupervisor(port);
    const started = await supervisor.start(startRequest);
    expect(started.ok).toBe(false);
    if (started.ok) {
      return;
    }
    expect(started.error).toEqual({ kind: "debug-adapter", code: "initialization-failure" });
  });

  test("returns unsupported when adapter rejects a ready-state command", async () => {
    const port = new FakeManagedServicePort(compliantDapHandler);
    const supervisor = createDebugAdapterSupervisor(port);
    const started = await supervisor.start(startRequest);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const result = await supervisor.request(
      startRequest.serviceId,
      started.value.generation,
      "threads",
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toEqual({ kind: "debug-adapter", code: "unsupported" });
  });

  test("forwards successful request bodies after initialize", async () => {
    let adapterSeq = 1;
    const port = new FakeManagedServicePort((message, pushStdout) => {
      if (message.type === "request" && message.command === "initialize") {
        pushStdout(
          encodeDapFrame({
            seq: adapterSeq,
            type: "response",
            request_seq: message.seq,
            success: true,
            command: "initialize",
            body: { supportsConfigurationDoneRequest: true },
          }),
        );
        adapterSeq += 1;
        return;
      }
      if (message.type === "event") {
        return;
      }
      if (message.type === "request" && message.command === "threads") {
        pushStdout(
          encodeDapFrame({
            seq: adapterSeq,
            type: "response",
            request_seq: message.seq,
            success: true,
            command: "threads",
            body: { threads: [{ id: 1, name: "main" }] },
          }),
        );
        adapterSeq += 1;
        return;
      }
      if (message.type === "request" && message.command === "disconnect") {
        pushStdout(
          encodeDapFrame({
            seq: adapterSeq,
            type: "response",
            request_seq: message.seq,
            success: true,
            command: "disconnect",
            body: {},
          }),
        );
        adapterSeq += 1;
      }
    });
    const supervisor = createDebugAdapterSupervisor(port);
    const started = await supervisor.start(startRequest);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const threads = await supervisor.request(
      startRequest.serviceId,
      started.value.generation,
      "threads",
    );
    expect(threads).toEqual({
      ok: true,
      value: { threads: [{ id: 1, name: "main" }] },
    });
  });
});
