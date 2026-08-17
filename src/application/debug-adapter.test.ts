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

function sessionCapableHandler(
  message: DapMessage,
  pushStdout: (bytes: Uint8Array) => void,
  adapterSeq: { value: number },
): void {
  const reply = (response: DapMessage): void => {
    pushStdout(encodeDapFrame(response));
  };
  if (message.type === "event") {
    return;
  }
  if (message.type !== "request") {
    return;
  }
  if (message.command === "initialize") {
    reply({
      seq: adapterSeq.value,
      type: "response",
      request_seq: message.seq,
      success: true,
      command: "initialize",
      body: { supportsConfigurationDoneRequest: true },
    });
    adapterSeq.value += 1;
    return;
  }
  if (message.command === "setBreakpoints") {
    const args = message.arguments as { breakpoints?: { line: number }[] };
    reply({
      seq: adapterSeq.value,
      type: "response",
      request_seq: message.seq,
      success: true,
      command: "setBreakpoints",
      body: {
        breakpoints: (args.breakpoints ?? []).map((breakpoint, index) => ({
          id: index + 1,
          verified: true,
          line: breakpoint.line,
        })),
      },
    });
    adapterSeq.value += 1;
    return;
  }
  if (message.command === "configurationDone") {
    reply({
      seq: adapterSeq.value,
      type: "response",
      request_seq: message.seq,
      success: true,
      command: "configurationDone",
      body: {},
    });
    adapterSeq.value += 1;
    return;
  }
  if (message.command === "launch" || message.command === "attach") {
    reply({
      seq: adapterSeq.value,
      type: "response",
      request_seq: message.seq,
      success: true,
      command: message.command,
      body: {},
    });
    adapterSeq.value += 1;
    // Simulate a stop after launch/attach.
    reply({
      seq: adapterSeq.value,
      type: "event",
      event: "stopped",
      body: { reason: "breakpoint", threadId: 1, allThreadsStopped: true },
    });
    adapterSeq.value += 1;
    return;
  }
  if (message.command === "threads") {
    reply({
      seq: adapterSeq.value,
      type: "response",
      request_seq: message.seq,
      success: true,
      command: "threads",
      body: { threads: [{ id: 1, name: "main" }] },
    });
    adapterSeq.value += 1;
    return;
  }
  if (message.command === "stackTrace") {
    reply({
      seq: adapterSeq.value,
      type: "response",
      request_seq: message.seq,
      success: true,
      command: "stackTrace",
      body: {
        stackFrames: [
          {
            id: 10,
            name: "entry",
            line: 4,
            column: 1,
            source: { path: "/tmp/app.ts" },
          },
        ],
      },
    });
    adapterSeq.value += 1;
    return;
  }
  if (message.command === "continue") {
    reply({
      seq: adapterSeq.value,
      type: "response",
      request_seq: message.seq,
      success: true,
      command: "continue",
      body: { allThreadsContinued: true },
    });
    adapterSeq.value += 1;
    reply({
      seq: adapterSeq.value,
      type: "event",
      event: "continued",
      body: { threadId: 1 },
    });
    adapterSeq.value += 1;
    return;
  }
  if (message.command === "scopes") {
    reply({
      seq: adapterSeq.value,
      type: "response",
      request_seq: message.seq,
      success: true,
      command: "scopes",
      body: {
        scopes: [{ name: "Locals", variablesReference: 100, expensive: false }],
      },
    });
    adapterSeq.value += 1;
    return;
  }
  if (message.command === "variables") {
    reply({
      seq: adapterSeq.value,
      type: "response",
      request_seq: message.seq,
      success: true,
      command: "variables",
      body: {
        variables: [
          { name: "count", value: "3", type: "number", variablesReference: 0 },
          { name: "password", value: "hunter2", type: "string", variablesReference: 0 },
        ],
      },
    });
    adapterSeq.value += 1;
    return;
  }
  if (message.command === "evaluate") {
    const args =
      message.arguments !== null &&
      typeof message.arguments === "object" &&
      !Array.isArray(message.arguments)
        ? (message.arguments as Record<string, unknown>)
        : {};
    const expression = typeof args.expression === "string" ? args.expression : "";
    reply({
      seq: adapterSeq.value,
      type: "response",
      request_seq: message.seq,
      success: true,
      command: "evaluate",
      body: {
        result: expression === "secret" ? "Bearer tok.xyz" : `eval(${expression})`,
        type: "string",
        variablesReference: 0,
      },
    });
    adapterSeq.value += 1;
    return;
  }
  if (message.command === "disconnect") {
    reply({
      seq: adapterSeq.value,
      type: "response",
      request_seq: message.seq,
      success: true,
      command: "disconnect",
      body: {},
    });
    adapterSeq.value += 1;
    return;
  }
  reply({
    seq: adapterSeq.value,
    type: "response",
    request_seq: message.seq,
    success: false,
    command: message.command,
    message: "not supported",
  });
  adapterSeq.value += 1;
}

function compliantDapHandler(message: DapMessage, pushStdout: (bytes: Uint8Array) => void): void {
  const seq = { value: 1 };
  if (message.type === "event") {
    return;
  }
  if (message.type === "request" && message.command === "initialize") {
    pushStdout(
      encodeDapFrame({
        seq: seq.value,
        type: "response",
        request_seq: message.seq,
        success: true,
        command: "initialize",
        body: { supportsConfigurationDoneRequest: true },
      }),
    );
    return;
  }
  if (message.type === "request" && message.command === "disconnect") {
    pushStdout(
      encodeDapFrame({
        seq: seq.value,
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
        seq: seq.value,
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

  test("sets breakpoints, launches, reads stack, and rejects stale stopped generation", async () => {
    const seq = { value: 1 };
    const port = new FakeManagedServicePort((message, pushStdout) => {
      sessionCapableHandler(message, pushStdout, seq);
    });
    const supervisor = createDebugAdapterSupervisor(port);
    const started = await supervisor.start(startRequest);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    expect(started.value.session.mode).toBe("none");

    const breakpoints = await supervisor.setBreakpoints(
      startRequest.serviceId,
      started.value.generation,
      { sourcePath: "/tmp/app.ts", breakpoints: [{ line: 4 }] },
    );
    expect(breakpoints.ok).toBe(true);
    if (!breakpoints.ok) {
      return;
    }
    expect(breakpoints.value.revision).toBe(1);
    expect(breakpoints.value.breakpoints[0]?.verified).toBe(true);

    const configured = await supervisor.configurationDone(
      startRequest.serviceId,
      started.value.generation,
    );
    expect(configured.ok).toBe(true);

    const launched = await supervisor.launch(startRequest.serviceId, started.value.generation, {
      configuration: { program: "/tmp/app.ts" },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) {
      return;
    }
    expect(launched.value.session.mode).toBe("launch");
    expect(launched.value.session.targetState).toBe("stopped");
    expect(launched.value.session.stopped?.generation).toBe(1);

    const again = await supervisor.launch(startRequest.serviceId, started.value.generation, {
      configuration: { program: "/tmp/app.ts" },
    });
    expect(again.ok).toBe(false);
    if (again.ok) {
      return;
    }
    expect(again.error).toEqual({ kind: "debug-adapter", code: "already-launched" });

    const threadList = await supervisor.threads(startRequest.serviceId, started.value.generation);
    expect(threadList).toEqual({
      ok: true,
      value: [{ id: 1, name: "main" }],
    });

    const frames = await supervisor.stackTrace(startRequest.serviceId, started.value.generation, {
      threadId: 1,
      stoppedGeneration: 1,
    });
    expect(frames.ok).toBe(true);
    if (!frames.ok) {
      return;
    }
    expect(frames.value[0]?.name).toBe("entry");

    const stale = await supervisor.stackTrace(startRequest.serviceId, started.value.generation, {
      threadId: 1,
      stoppedGeneration: 99,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) {
      return;
    }
    expect(stale.error).toEqual({ kind: "debug-adapter", code: "stale-stopped-generation" });

    const continued = await supervisor.continueExecution(
      startRequest.serviceId,
      started.value.generation,
      { threadId: 1, stoppedGeneration: 1 },
    );
    expect(continued.ok).toBe(true);
    if (!continued.ok) {
      return;
    }
    expect(continued.value.session.targetState).toBe("running");
    expect(continued.value.session.stopped).toBeNull();
  });

  test("reads scopes and variables, evaluates with mutation flag, and redacts outputs", async () => {
    const seq = { value: 1 };
    const port = new FakeManagedServicePort((message, pushStdout) => {
      sessionCapableHandler(message, pushStdout, seq);
      if (message.type === "request" && message.command === "launch") {
        pushStdout(
          encodeDapFrame({
            seq: seq.value,
            type: "event",
            event: "output",
            body: { category: "stdout", output: "token=abc123" },
          }),
        );
        seq.value += 1;
      }
    });
    const supervisor = createDebugAdapterSupervisor(port);
    const started = await supervisor.start(startRequest);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    const launched = await supervisor.launch(startRequest.serviceId, started.value.generation, {
      configuration: { program: "/tmp/app.ts" },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) {
      return;
    }
    expect(launched.value.session.recentOutputs).toEqual([
      {
        category: "stdout",
        output: "[redacted]",
        sensitive: true,
        redacted: true,
      },
    ]);

    const scopes = await supervisor.scopes(startRequest.serviceId, started.value.generation, {
      frameId: 10,
      stoppedGeneration: 1,
    });
    expect(scopes).toEqual({
      ok: true,
      value: [
        {
          name: "Locals",
          variablesReference: 100,
          expensive: false,
          namedVariables: null,
          indexedVariables: null,
        },
      ],
    });

    const variables = await supervisor.variables(startRequest.serviceId, started.value.generation, {
      variablesReference: 100,
      stoppedGeneration: 1,
    });
    expect(variables.ok).toBe(true);
    if (!variables.ok) {
      return;
    }
    expect(variables.value).toEqual([
      {
        name: "count",
        value: "3",
        type: "number",
        variablesReference: 0,
        sensitive: false,
        redacted: false,
      },
      {
        name: "password",
        value: "[redacted]",
        type: "string",
        variablesReference: 0,
        sensitive: true,
        redacted: true,
      },
    ]);

    const watch = await supervisor.evaluate(startRequest.serviceId, started.value.generation, {
      expression: "count + 1",
      stoppedGeneration: 1,
      context: "watch",
      frameId: 10,
    });
    expect(watch.ok).toBe(true);
    if (!watch.ok) {
      return;
    }
    expect(watch.value.mayMutate).toBe(false);
    expect(watch.value.result).toBe("eval(count + 1)");

    const secret = await supervisor.evaluate(startRequest.serviceId, started.value.generation, {
      expression: "secret",
      stoppedGeneration: 1,
      context: "hover",
    });
    expect(secret.ok).toBe(true);
    if (!secret.ok) {
      return;
    }
    expect(secret.value.result).toBe("[redacted]");
    expect(secret.value.redacted).toBe(true);

    const repl = await supervisor.evaluate(startRequest.serviceId, started.value.generation, {
      expression: "x = 1",
      stoppedGeneration: 1,
      context: "repl",
    });
    expect(repl.ok).toBe(true);
    if (!repl.ok) {
      return;
    }
    expect(repl.value.mayMutate).toBe(true);

    const stale = await supervisor.scopes(startRequest.serviceId, started.value.generation, {
      frameId: 10,
      stoppedGeneration: 99,
    });
    expect(stale).toEqual({
      ok: false,
      error: { kind: "debug-adapter", code: "stale-stopped-generation" },
    });
  });
});
