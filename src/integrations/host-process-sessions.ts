/**
 * Bun adapters for interactive PTYs and managed pipe-based services.
 *
 * This is the only module that owns Bun subprocess and terminal handles. The
 * domain sees copied bytes, lifecycle events, stable identities, and explicit
 * generations. Output is drained even when nobody is attached; replay is a
 * bounded convenience window, not an artifact store.
 */

import type { ManagedServiceId, PtySessionId, ServiceGeneration } from "../domain/identity.ts";
import {
  DEFAULT_PTY_TERMINAL_NAME,
  invalidManagedServiceRequest,
  invalidPtyRequest,
  MAX_MANAGED_SERVICE_READINESS_BYTES,
  MAX_MANAGED_SERVICE_REPLAY_BYTES,
  MAX_MANAGED_SERVICE_WRITE_BYTES,
  MAX_MANAGED_SERVICES,
  MAX_PTY_BACKLOG_BYTES,
  MAX_PTY_SESSIONS,
  MAX_PTY_WRITE_BYTES,
  MAX_RETAINED_MANAGED_SERVICES,
  MAX_RETAINED_PTY_SESSIONS,
  type ManagedServiceError,
  type ManagedServiceEvent,
  type ManagedServiceExit,
  type ManagedServiceListener,
  type ManagedServicePort,
  type ManagedServiceReplay,
  type ManagedServiceRequest,
  type ManagedServiceSnapshot,
  type ManagedServiceStopReport,
  type ManagedServiceWriteReport,
  nextServiceGeneration,
  PTY_TERMINATION_TIMEOUT_MS,
  type PtyAttachment,
  type PtyDimensions,
  type PtySessionError,
  type PtySessionEvent,
  type PtySessionListener,
  type PtySessionPort,
  type PtySessionRequest,
  type PtySessionSnapshot,
  type PtySignal,
  type PtySignalReport,
  type PtyTerminationReport,
  type PtyWriteReport,
  ptyDimensions,
  ptySessionId,
  serviceGeneration,
  validateManagedServiceRequest,
  validatePtySessionRequest,
} from "../domain/index.ts";
import { err, ok, type Result } from "../domain/result.ts";

type HostSubprocess = Bun.Subprocess;
type HostTerminal = NonNullable<HostSubprocess["terminal"]>;

type HostFileSink = {
  write(chunk: Uint8Array): number;
  flush(): number | Promise<number>;
  end(): number | Promise<number>;
};

type HostReadable = {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    releaseLock(): void;
  };
};

type ServiceStream = "stdout" | "stderr";
type PtyEventDetail = {
  [Kind in PtySessionEvent["kind"]]: Omit<
    Extract<PtySessionEvent, { readonly kind: Kind }>,
    "sessionId" | "order"
  >;
}[PtySessionEvent["kind"]];
type ManagedServiceEventDetail = {
  [Kind in ManagedServiceEvent["kind"]]: Omit<
    Extract<ManagedServiceEvent, { readonly kind: Kind }>,
    "serviceId" | "order"
  >;
}[ManagedServiceEvent["kind"]];
type StopIntent =
  | { readonly kind: "stop"; readonly reason: "requested" | "idle" | "shutdown" }
  | {
      readonly kind: "failure";
      readonly reason: "spawn-failed" | "readiness-timeout" | "readiness-output-exceeded";
    };
type FailureIntent = Extract<StopIntent, { readonly kind: "failure" }>;
type RestartFailureReason = "no-restart-policy" | "restart-budget-exhausted";

export function createHostPtySessionPort(): PtySessionPort {
  const sessions = new Map<PtySessionId, HostPtySession>();
  let nextId = 1;

  return {
    open: async (
      request: PtySessionRequest,
    ): Promise<Result<PtySessionSnapshot, PtySessionError>> => {
      const invalid = validatePtySessionRequest(request);
      if (invalid !== null) {
        return invalidPtyRequest(invalid);
      }
      const active = [...sessions.values()].filter((session) => session.isRunning()).length;
      if (active >= MAX_PTY_SESSIONS) {
        return err({ kind: "pty", code: "capacity-exceeded", maximum: MAX_PTY_SESSIONS });
      }
      if (!evictInactive(sessions, MAX_RETAINED_PTY_SESSIONS, (session) => session.isRunning())) {
        return err({
          kind: "pty",
          code: "capacity-exceeded",
          maximum: MAX_RETAINED_PTY_SESSIONS,
        });
      }

      const sessionId = ptySessionId.from(`pty-${nextId}`);
      nextId += 1;
      const session = new HostPtySession(sessionId, request);
      try {
        const child = Bun.spawn([request.executable, ...request.argv], {
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          env: request.environment,
          terminal: {
            cols: request.dimensions.columns,
            rows: request.dimensions.rows,
            name: request.terminalName ?? DEFAULT_PTY_TERMINAL_NAME,
            data: (_terminal, data) => session.onData(data),
            exit: () => session.onEof(),
          },
        });
        const terminal = child.terminal;
        if (terminal === undefined) {
          child.kill("SIGKILL");
          return err({ kind: "pty", code: "unsupported" });
        }
        session.attachProcess(child, terminal);
        sessions.set(sessionId, session);
        session.announceOpened();
        void session.watchExit();
        return ok(session.snapshot());
      } catch (thrown) {
        return err({ kind: "pty", code: "spawn-failed", detail: safeHostCode(thrown) });
      }
    },

    attach(
      sessionId: PtySessionId,
      listener: PtySessionListener,
    ): Result<PtyAttachment, PtySessionError> {
      return sessions.get(sessionId)?.attach(listener) ?? err({ kind: "pty", code: "not-found" });
    },

    write(sessionId: PtySessionId, bytes: Uint8Array): Result<PtyWriteReport, PtySessionError> {
      return sessions.get(sessionId)?.write(bytes) ?? err({ kind: "pty", code: "not-found" });
    },

    resize(
      sessionId: PtySessionId,
      dimensions: PtyDimensions,
    ): Result<PtyDimensions, PtySessionError> {
      return sessions.get(sessionId)?.resize(dimensions) ?? err({ kind: "pty", code: "not-found" });
    },

    interrupt(sessionId: PtySessionId): Result<PtySignalReport, PtySessionError> {
      return sessions.get(sessionId)?.signal("SIGINT") ?? err({ kind: "pty", code: "not-found" });
    },

    async terminate(
      sessionId: PtySessionId,
      signal: PtySignal = "SIGTERM",
    ): Promise<Result<PtyTerminationReport, PtySessionError>> {
      return (
        (await sessions.get(sessionId)?.terminate(signal)) ??
        err({ kind: "pty", code: "not-found" })
      );
    },

    snapshot(sessionId: PtySessionId): PtySessionSnapshot | null {
      return sessions.get(sessionId)?.snapshot() ?? null;
    },
  };
}

class HostPtySession {
  private child: HostSubprocess | null = null;
  private terminal: HostTerminal | null = null;
  private readonly listeners = new Set<PtySessionListener>();
  private readonly backlog: ByteReplay;
  private readonly request: PtySessionRequest;
  private dimensions: PtyDimensions;
  private state: PtySessionSnapshot["state"] = "running";
  private exit: PtySessionSnapshot["exit"] = null;
  private order = 0;
  private opened = false;
  private eof = false;
  private pendingData: Uint8Array[] = [];
  private exitPromise: Promise<PtySessionSnapshot["exit"]> | null = null;

  constructor(
    private readonly sessionId: PtySessionId,
    request: PtySessionRequest,
  ) {
    this.request = request;
    this.dimensions = request.dimensions;
    this.backlog = new ByteReplay(request.backlogBytes ?? MAX_PTY_BACKLOG_BYTES);
  }

  attachProcess(child: HostSubprocess, terminal: HostTerminal): void {
    this.child = child;
    this.terminal = terminal;
  }

  announceOpened(): void {
    this.opened = true;
    this.emit({
      kind: "opened",
      pid: this.child?.pid ?? -1,
      dimensions: this.dimensions,
      terminalName: this.request.terminalName ?? DEFAULT_PTY_TERMINAL_NAME,
      encoding: this.request.encoding ?? "utf-8",
    });
    const pending = this.pendingData;
    this.pendingData = [];
    for (const bytes of pending) {
      this.emit({ kind: "data", bytes });
    }
  }

  onData(data: Uint8Array): void {
    const bytes = new Uint8Array(data);
    this.backlog.append(bytes);
    if (!this.opened) {
      this.pendingData.push(bytes);
      return;
    }
    this.emit({ kind: "data", bytes });
  }

  onEof(): void {
    if (this.eof) {
      return;
    }
    this.eof = true;
    this.emit({ kind: "eof" });
  }

  async watchExit(): Promise<void> {
    const child = this.child;
    if (child === null) {
      return;
    }
    this.exitPromise = child.exited.then((exitCode) => {
      const exit = {
        exitCode,
        signal: signalText(child.signalCode),
      };
      this.exit = exit;
      if (this.state !== "exited") {
        this.state = "exited";
      }
      this.closeTerminal();
      this.emit({ kind: "exited", exit });
      return exit;
    });
    await this.exitPromise;
  }

  isRunning(): boolean {
    return this.state !== "exited";
  }

  attach(listener: PtySessionListener): Result<PtyAttachment, PtySessionError> {
    this.listeners.add(listener);
    this.emit({ kind: "attached" });
    let detached = false;
    return ok({
      replay: this.backlog.snapshot(),
      detach: (): void => {
        if (detached) {
          return;
        }
        detached = true;
        this.emit({ kind: "detached" });
        this.listeners.delete(listener);
      },
    });
  }

  write(bytes: Uint8Array): Result<PtyWriteReport, PtySessionError> {
    if (bytes.byteLength > MAX_PTY_WRITE_BYTES) {
      return err({ kind: "pty", code: "input-too-large", maxBytes: MAX_PTY_WRITE_BYTES });
    }
    if (this.state !== "running") {
      return err({ kind: "pty", code: "not-running", state: this.state });
    }
    const terminal = this.terminal;
    if (terminal === null || terminal.closed) {
      return ok({ status: "closed", acceptedBytes: 0 });
    }
    try {
      const acceptedBytes = terminal.write(bytes);
      return ok({
        status: acceptedBytes === bytes.byteLength ? "accepted" : "closed",
        acceptedBytes,
      });
    } catch (thrown) {
      return err({ kind: "pty", code: "write-failed", detail: safeHostCode(thrown) });
    }
  }

  resize(dimensions: PtyDimensions): Result<PtyDimensions, PtySessionError> {
    if (this.state !== "running") {
      return err({ kind: "pty", code: "not-running", state: this.state });
    }
    const valid = ptyDimensions(dimensions.columns, dimensions.rows);
    if (!valid.ok) {
      return valid;
    }
    const terminal = this.terminal;
    if (terminal === null || terminal.closed) {
      return err({ kind: "pty", code: "resize-failed", detail: "closed" });
    }
    try {
      terminal.resize(dimensions.columns, dimensions.rows);
      this.dimensions = dimensions;
      this.emit({ kind: "resized", dimensions });
      return ok(dimensions);
    } catch (thrown) {
      return err({ kind: "pty", code: "resize-failed", detail: safeHostCode(thrown) });
    }
  }

  signal(signal: PtySignal): Result<PtySignalReport, PtySessionError> {
    if (this.state !== "running") {
      return err({ kind: "pty", code: "not-running", state: this.state });
    }
    const child = this.child;
    if (child === null) {
      return err({ kind: "pty", code: "spawn-failed", detail: "missing-child" });
    }
    try {
      child.kill(signal);
      this.emit({ kind: "interrupted", signal: "SIGINT" });
      return ok({ signal, state: this.state });
    } catch (thrown) {
      return err({ kind: "pty", code: "write-failed", detail: safeHostCode(thrown) });
    }
  }

  async terminate(signal: PtySignal): Promise<Result<PtyTerminationReport, PtySessionError>> {
    if (this.state === "exited") {
      return ok({ kind: "already-exited", exit: this.exit ?? { exitCode: null, signal: null } });
    }
    if (this.state === "uncertain") {
      return ok({ kind: "uncertain", signal, exit: this.exit });
    }
    const child = this.child;
    const exitPromise = this.exitPromise;
    if (child === null || exitPromise === null) {
      return err({ kind: "pty", code: "spawn-failed", detail: "missing-child" });
    }
    try {
      child.kill(signal);
      this.emit({ kind: "termination-requested", signal });
    } catch (thrown) {
      return err({ kind: "pty", code: "write-failed", detail: safeHostCode(thrown) });
    }
    const firstExit = await waitForExit(exitPromise, PTY_TERMINATION_TIMEOUT_MS);
    if (firstExit !== null) {
      this.closeTerminal();
      return ok({ kind: "terminated", signal, exit: firstExit });
    }
    try {
      child.kill("SIGKILL");
    } catch {
      this.state = "uncertain";
      this.closeTerminal();
      return ok({ kind: "uncertain", signal, exit: this.exit });
    }
    const finalExit = await waitForExit(exitPromise, PTY_TERMINATION_TIMEOUT_MS);
    if (finalExit === null) {
      this.state = "uncertain";
      this.closeTerminal();
      return ok({ kind: "uncertain", signal, exit: this.exit });
    }
    this.closeTerminal();
    return ok({ kind: "terminated", signal, exit: finalExit });
  }

  snapshot(): PtySessionSnapshot {
    return {
      sessionId: this.sessionId,
      pid: this.child?.pid ?? -1,
      state: this.state,
      dimensions: this.dimensions,
      terminalName: this.request.terminalName ?? DEFAULT_PTY_TERMINAL_NAME,
      encoding: this.request.encoding ?? "utf-8",
      replay: this.backlog.snapshot(),
      exit: this.exit,
    };
  }

  private closeTerminal(): void {
    try {
      this.terminal?.close();
    } catch {
      // The process result is the source of truth; closing an already-closed PTY
      // is a best-effort resource release.
    }
  }

  private emit(detail: PtyEventDetail): void {
    const event = {
      sessionId: this.sessionId,
      order: this.order + 1,
      ...detail,
    } as PtySessionEvent;
    this.order += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A consumer cannot be allowed to break Bun's PTY callback.
      }
    }
  }
}

export function createHostManagedServicePort(): ManagedServicePort {
  const services = new Map<ManagedServiceId, HostManagedService>();

  return {
    async start(
      request: ManagedServiceRequest,
    ): Promise<Result<ManagedServiceSnapshot, ManagedServiceError>> {
      const invalid = validateManagedServiceRequest(request);
      if (invalid !== null) {
        return invalidManagedServiceRequest(invalid);
      }
      const existing = services.get(request.serviceId);
      if (existing !== undefined) {
        if (existing.isActive()) {
          return err({ kind: "managed-service", code: "already-running" });
        }
        return existing.start();
      }
      const active = [...services.values()].filter((service) => service.isActive()).length;
      if (active >= MAX_MANAGED_SERVICES) {
        return err({
          kind: "managed-service",
          code: "capacity-exceeded",
          maximum: MAX_MANAGED_SERVICES,
        });
      }
      if (
        !evictInactive(services, MAX_RETAINED_MANAGED_SERVICES, (service) => service.isActive())
      ) {
        return err({
          kind: "managed-service",
          code: "capacity-exceeded",
          maximum: MAX_RETAINED_MANAGED_SERVICES,
        });
      }
      const service = new HostManagedService(request);
      services.set(request.serviceId, service);
      return service.start();
    },

    attach(
      serviceId: ManagedServiceId,
      listener: ManagedServiceListener,
    ): Result<{ replay: ManagedServiceReplay; detach(): void }, ManagedServiceError> {
      return (
        services.get(serviceId)?.attach(listener) ??
        err({ kind: "managed-service", code: "not-found" })
      );
    },

    async send(
      serviceId: ManagedServiceId,
      generation: ServiceGeneration,
      bytes: Uint8Array,
    ): Promise<Result<ManagedServiceWriteReport, ManagedServiceError>> {
      return (
        (await services.get(serviceId)?.send(generation, bytes)) ??
        err({ kind: "managed-service", code: "not-found" })
      );
    },

    async stop(
      serviceId: ManagedServiceId,
      generation: ServiceGeneration,
      reason: "requested" | "shutdown" = "requested",
    ): Promise<Result<ManagedServiceStopReport, ManagedServiceError>> {
      return (
        (await services.get(serviceId)?.stop(generation, reason)) ??
        err({ kind: "managed-service", code: "not-found" })
      );
    },

    snapshot(serviceId: ManagedServiceId): ManagedServiceSnapshot | null {
      return services.get(serviceId)?.snapshot() ?? null;
    },
  };
}

class HostManagedService {
  private readonly listeners = new Set<ManagedServiceListener>();
  private readonly request: ManagedServiceRequest;
  private generation: ServiceGeneration | null = null;
  private state: ManagedServiceSnapshot["state"] = "stopped";
  private child: HostSubprocess | null = null;
  private stdin: HostFileSink | null = null;
  private exit: ManagedServiceExit | null = null;
  private stdoutReplay = new ByteReplay(0);
  private stderrReplay = new ByteReplay(0);
  private order = 0;
  private restartTimes: number[] = [];
  private readinessTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readinessText = "";
  private readinessBytes = 0;
  private readinessDecoder = new TextDecoder();
  private intent: StopIntent | null = null;
  private pendingStart:
    | ((result: Result<ManagedServiceSnapshot, ManagedServiceError>) => void)
    | null = null;
  private exitPromise: Promise<ManagedServiceExit> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(request: ManagedServiceRequest) {
    this.request = request;
  }

  isActive(): boolean {
    return (
      this.child !== null ||
      this.state === "starting" ||
      this.state === "ready" ||
      this.state === "stopping"
    );
  }

  attach(
    listener: ManagedServiceListener,
  ): Result<{ replay: ManagedServiceReplay; detach(): void }, ManagedServiceError> {
    this.listeners.add(listener);
    let detached = false;
    return ok({
      replay: this.replay(),
      detach: (): void => {
        if (detached) {
          return;
        }
        detached = true;
        this.listeners.delete(listener);
      },
    });
  }

  start(): Promise<Result<ManagedServiceSnapshot, ManagedServiceError>> {
    if (this.isActive()) {
      return Promise.resolve(err({ kind: "managed-service", code: "already-running" }));
    }
    this.state = "starting";
    this.exit = null;
    this.intent = null;
    this.restartTimes = [];
    return new Promise((resolve) => {
      this.pendingStart = resolve;
      this.spawnGeneration(null);
    });
  }

  async send(
    generation: ServiceGeneration,
    bytes: Uint8Array,
  ): Promise<Result<ManagedServiceWriteReport, ManagedServiceError>> {
    if (this.generation !== generation) {
      return err({ kind: "managed-service", code: "stale-generation" });
    }
    if (bytes.byteLength > MAX_MANAGED_SERVICE_WRITE_BYTES) {
      return err({
        kind: "managed-service",
        code: "input-too-large",
        maxBytes: MAX_MANAGED_SERVICE_WRITE_BYTES,
      });
    }
    if (this.state !== "ready") {
      return err({ kind: "managed-service", code: "not-ready", state: this.state });
    }
    const stdin = this.stdin;
    if (stdin === null) {
      return err({ kind: "managed-service", code: "write-failed", detail: "stdin-closed" });
    }
    const data = new Uint8Array(bytes);
    let result: Result<ManagedServiceWriteReport, ManagedServiceError> = ok({
      acceptedBytes: 0,
    });
    this.writeChain = this.writeChain.then(async () => {
      try {
        const acceptedBytes = stdin.write(data);
        await stdin.flush();
        if (acceptedBytes !== data.byteLength) {
          result = err({
            kind: "managed-service",
            code: "write-failed",
            detail: "short-write",
          });
          return;
        }
        this.touchActivity();
        result = ok({ acceptedBytes });
      } catch (thrown) {
        result = err({
          kind: "managed-service",
          code: "write-failed",
          detail: safeHostCode(thrown),
        });
      }
    });
    await this.writeChain;
    return result;
  }

  async stop(
    generation: ServiceGeneration,
    reason: "requested" | "shutdown",
  ): Promise<Result<ManagedServiceStopReport, ManagedServiceError>> {
    if (this.generation !== generation) {
      return err({ kind: "managed-service", code: "stale-generation" });
    }
    if (this.state === "stopped") {
      return ok({ kind: "already-stopped", reason, exit: this.exit });
    }
    if (this.state === "failed" && this.child === null) {
      this.state = "stopped";
      return ok({ kind: "already-stopped", reason, exit: this.exit });
    }
    return this.stopCurrent(reason);
  }

  snapshot(): ManagedServiceSnapshot {
    return {
      serviceId: this.request.serviceId,
      protocol: this.request.protocol,
      generation: this.generation ?? serviceGeneration.from(1),
      pid: this.child?.pid ?? null,
      state: this.state,
      restartCount: this.restartTimes.length,
      lastExit: this.exit,
    };
  }

  private spawnGeneration(previousGeneration: ServiceGeneration | null): void {
    const generation =
      this.generation === null ? serviceGeneration.from(1) : nextServiceGeneration(this.generation);
    this.generation = generation;
    this.state = "starting";
    this.child = null;
    this.stdin = null;
    this.intent = null;
    this.stdoutReplay = new ByteReplay(
      this.request.replayBytes ?? MAX_MANAGED_SERVICE_REPLAY_BYTES,
    );
    this.stderrReplay = new ByteReplay(
      this.request.replayBytes ?? MAX_MANAGED_SERVICE_REPLAY_BYTES,
    );
    this.readinessText = "";
    this.readinessBytes = 0;
    this.readinessDecoder = new TextDecoder();
    this.clearReadinessTimer();
    this.clearIdleTimer();

    try {
      const child = Bun.spawn([this.request.executable, ...this.request.argv], {
        ...(this.request.cwd === undefined ? {} : { cwd: this.request.cwd }),
        env: this.request.environment,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      this.child = child;
      this.stdin = fileSink(child.stdin);
      this.emit({ kind: "started", pid: child.pid, generation });
      if (previousGeneration !== null) {
        this.emit({ kind: "restarted", previousGeneration, pid: child.pid, generation });
      }
      this.consume(child.stdout, "stdout", generation);
      this.consume(child.stderr, "stderr", generation);
      this.exitPromise = child.exited.then((exitCode) => {
        const exit = { exitCode, signal: signalText(child.signalCode) };
        this.handleExit(generation, exit);
        return exit;
      });

      if (this.request.readiness.kind === "immediate") {
        this.markReady(generation);
      } else {
        this.readinessTimer = setTimeout(() => {
          if (this.generation === generation && this.state === "starting") {
            this.requestFailure({ kind: "failure", reason: "readiness-timeout" });
          }
        }, this.request.readiness.timeoutMs);
      }
    } catch {
      this.finishFailure(generation, {
        kind: "failure",
        reason: "spawn-failed",
      });
    }
  }

  private consume(
    stream: HostSubprocess["stdout"] | HostSubprocess["stderr"],
    channel: ServiceStream,
    generation: ServiceGeneration,
  ): void {
    if (!readableStream(stream)) {
      return;
    }
    void (async () => {
      const reader = stream.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done || chunk.value === undefined) {
            return;
          }
          this.onOutput(generation, channel, chunk.value);
        }
      } catch {
        // The child may close a pipe while it is being terminated.
      } finally {
        reader.releaseLock();
      }
    })();
  }

  private onOutput(generation: ServiceGeneration, channel: ServiceStream, data: Uint8Array): void {
    if (this.generation !== generation) {
      return;
    }
    const bytes = new Uint8Array(data);
    if (channel === "stdout") {
      this.stdoutReplay.append(bytes);
    } else {
      this.stderrReplay.append(bytes);
    }
    this.emit({ kind: "output", stream: channel, bytes, generation });
    this.touchActivity();

    if (this.state !== "starting" || this.request.readiness.kind !== "output-marker") {
      return;
    }
    if (this.request.readiness.stream !== "any" && this.request.readiness.stream !== channel) {
      return;
    }
    this.readinessBytes += bytes.byteLength;
    if (this.readinessBytes > MAX_MANAGED_SERVICE_READINESS_BYTES) {
      this.requestFailure({ kind: "failure", reason: "readiness-output-exceeded" });
      return;
    }
    this.readinessText += this.readinessDecoder.decode(bytes, { stream: true });
    if (this.readinessText.includes(this.request.readiness.marker)) {
      this.markReady(generation);
    }
  }

  private markReady(generation: ServiceGeneration): void {
    if (this.generation !== generation || this.state !== "starting") {
      return;
    }
    this.state = "ready";
    this.clearReadinessTimer();
    this.touchActivity();
    this.emit({ kind: "ready", generation });
    this.resolveStart({ ok: true, value: this.snapshot() });
  }

  private requestFailure(intent: FailureIntent): void {
    if (this.intent !== null || this.child === null || this.generation === null) {
      return;
    }
    this.intent = intent;
    this.clearReadinessTimer();
    try {
      this.child.kill("SIGTERM");
      void this.awaitFailureCleanup(this.generation, intent);
    } catch {
      this.finishUncertainFailure(this.generation);
    }
  }

  private async awaitFailureCleanup(
    generation: ServiceGeneration,
    intent: FailureIntent,
  ): Promise<void> {
    const child = this.child;
    const exitPromise = this.exitPromise;
    if (child === null || exitPromise === null) {
      return;
    }
    const firstExit = await waitForExit(exitPromise, this.request.shutdownTimeoutMs);
    if (firstExit !== null || this.generation !== generation || this.intent !== intent) {
      return;
    }
    try {
      child.kill("SIGKILL");
    } catch {
      this.finishUncertainFailure(generation);
      return;
    }
    const finalExit = await waitForExit(exitPromise, this.request.shutdownTimeoutMs);
    if (finalExit === null && this.generation === generation && this.intent === intent) {
      this.finishUncertainFailure(generation);
    }
  }

  private handleExit(generation: ServiceGeneration, exit: ManagedServiceExit): void {
    if (this.generation !== generation) {
      return;
    }
    if (this.state === "failed" && this.intent === null) {
      this.exit = exit;
      this.child = null;
      this.stdin = null;
      return;
    }
    this.exit = exit;
    this.child = null;
    this.stdin = null;
    const intent = this.intent;
    this.intent = null;
    if (intent?.kind === "stop") {
      this.state = "stopped";
      this.clearIdleTimer();
      this.emit({ kind: "stopped", reason: intent.reason, exit, generation });
      this.resolveStart({
        ok: false,
        error: { kind: "managed-service", code: "not-ready", state: "stopped" },
      });
      return;
    }
    if (intent?.kind === "failure") {
      this.finishFailure(generation, intent);
      return;
    }
    const restartScheduled = this.reserveRestart();
    this.emit({ kind: "crashed", exit, restartScheduled, generation });
    if (restartScheduled) {
      this.spawnGeneration(generation);
      return;
    }
    const failureReason = restartFailureReason(this.request.restart.maxRestarts);
    this.state = "failed";
    this.clearIdleTimer();
    this.emit({ kind: "failed", reason: failureReason, generation });
    this.resolveStart({
      ok: false,
      error: { kind: "managed-service", code: failureReason },
    });
  }

  private finishFailure(generation: ServiceGeneration, intent: FailureIntent): void {
    if (this.generation !== generation) {
      return;
    }
    this.child = null;
    this.stdin = null;
    this.intent = null;
    this.emit({ kind: "failed", reason: intent.reason, generation });
    if (this.reserveRestart()) {
      this.spawnGeneration(generation);
      return;
    }
    this.state = "failed";
    this.resolveStart({
      ok: false,
      error: failureError(intent.reason),
    });
  }

  private finishUncertainFailure(generation: ServiceGeneration): void {
    if (this.generation !== generation) {
      return;
    }
    this.state = "failed";
    this.clearReadinessTimer();
    this.clearIdleTimer();
    this.stdin = null;
    this.intent = null;
    this.emit({ kind: "failed", reason: "shutdown-timeout", generation });
    this.resolveStart({
      ok: false,
      error: { kind: "managed-service", code: "shutdown-timeout" },
    });
  }

  private async stopCurrent(
    reason: "requested" | "idle" | "shutdown",
  ): Promise<Result<ManagedServiceStopReport, ManagedServiceError>> {
    const child = this.child;
    const exitPromise = this.exitPromise;
    const generation = this.generation;
    if (child === null || exitPromise === null || generation === null) {
      this.state = "stopped";
      return ok({ kind: "already-stopped", reason, exit: this.exit });
    }
    this.state = "stopping";
    this.intent = { kind: "stop", reason };
    this.clearReadinessTimer();
    this.clearIdleTimer();
    this.emit({ kind: "stopping", reason, generation });
    try {
      this.stdin?.end();
    } catch {
      // SIGTERM below remains the authoritative stop request.
    }
    try {
      child.kill("SIGTERM");
    } catch {
      this.failShutdown(generation);
      return err({ kind: "managed-service", code: "shutdown-timeout" });
    }
    const firstExit = await waitForExit(exitPromise, this.request.shutdownTimeoutMs);
    if (firstExit !== null) {
      return ok({ kind: "stopped", reason, exit: firstExit });
    }
    try {
      child.kill("SIGKILL");
    } catch {
      this.failShutdown(generation);
      return err({ kind: "managed-service", code: "shutdown-timeout" });
    }
    const finalExit = await waitForExit(exitPromise, this.request.shutdownTimeoutMs);
    if (finalExit === null) {
      this.failShutdown(generation);
      return err({ kind: "managed-service", code: "shutdown-timeout" });
    }
    return ok({ kind: "stopped", reason, exit: finalExit });
  }

  private failShutdown(generation: ServiceGeneration): void {
    if (this.generation !== generation) {
      return;
    }
    this.state = "failed";
    this.resolveStart({
      ok: false,
      error: { kind: "managed-service", code: "shutdown-timeout" },
    });
    this.emit({ kind: "failed", reason: "shutdown-timeout", generation });
  }

  private reserveRestart(): boolean {
    const now = Date.now();
    const cutoff = now - this.request.restart.windowMs;
    this.restartTimes = this.restartTimes.filter((startedAt) => startedAt >= cutoff);
    if (this.restartTimes.length >= this.request.restart.maxRestarts) {
      return false;
    }
    this.restartTimes.push(now);
    return true;
  }

  private touchActivity(): void {
    if (
      this.state !== "ready" ||
      this.request.idle.kind !== "timeout" ||
      this.generation === null
    ) {
      return;
    }
    this.clearIdleTimer();
    const generation = this.generation;
    this.idleTimer = setTimeout(() => {
      if (this.generation === generation && this.state === "ready") {
        void this.stopCurrent("idle");
      }
    }, this.request.idle.timeoutMs);
  }

  private resolveStart(result: Result<ManagedServiceSnapshot, ManagedServiceError>): void {
    const resolve = this.pendingStart;
    if (resolve === null) {
      return;
    }
    this.pendingStart = null;
    resolve(result);
  }

  private clearReadinessTimer(): void {
    if (this.readinessTimer !== null) {
      clearTimeout(this.readinessTimer);
      this.readinessTimer = null;
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private replay(): ManagedServiceReplay {
    const stdout = this.stdoutReplay.snapshot();
    const stderr = this.stderrReplay.snapshot();
    return {
      stdout: stdout.bytes,
      stderr: stderr.bytes,
      droppedStdoutBytes: stdout.droppedBytes,
      droppedStderrBytes: stderr.droppedBytes,
    };
  }

  private emit(detail: ManagedServiceEventDetail): void {
    if (this.generation === null) {
      return;
    }
    const event = {
      serviceId: this.request.serviceId,
      order: this.order + 1,
      ...detail,
    } as ManagedServiceEvent;
    this.order += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A protocol observer cannot break process supervision.
      }
    }
  }
}

class ByteReplay {
  private readonly chunks: Uint8Array[] = [];
  private retainedBytes = 0;
  private droppedBytes = 0;

  constructor(private readonly maximumBytes: number) {}

  append(data: Uint8Array): void {
    if (this.maximumBytes === 0) {
      this.droppedBytes += data.byteLength;
      return;
    }
    const bytes = new Uint8Array(data);
    if (bytes.byteLength >= this.maximumBytes) {
      this.droppedBytes += this.retainedBytes + bytes.byteLength - this.maximumBytes;
      this.chunks.length = 0;
      this.retainedBytes = 0;
      const tail = bytes.slice(bytes.byteLength - this.maximumBytes);
      this.chunks.push(tail);
      this.retainedBytes = tail.byteLength;
      return;
    }
    while (this.chunks.length > 0 && this.retainedBytes + bytes.byteLength > this.maximumBytes) {
      const first = this.chunks.shift();
      if (first === undefined) {
        break;
      }
      this.retainedBytes -= first.byteLength;
      this.droppedBytes += first.byteLength;
    }
    this.chunks.push(bytes);
    this.retainedBytes += bytes.byteLength;
  }

  snapshot(): { bytes: Uint8Array; droppedBytes: number } {
    const bytes = new Uint8Array(this.retainedBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, droppedBytes: this.droppedBytes };
  }
}

function readableStream(value: unknown): value is HostReadable {
  return typeof value === "object" && value !== null && "getReader" in value;
}

function fileSink(value: HostSubprocess["stdin"]): HostFileSink | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("write" in value) ||
    !("flush" in value) ||
    !("end" in value)
  ) {
    return null;
  }
  return value as HostFileSink;
}

function signalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function evictInactive<Key, Value>(
  entries: Map<Key, Value>,
  maximum: number,
  isActive: (value: Value) => boolean,
): boolean {
  while (entries.size >= maximum) {
    const candidate = [...entries.entries()].find(([, value]) => !isActive(value));
    if (candidate === undefined) {
      return false;
    }
    entries.delete(candidate[0]);
  }
  return true;
}

function safeHostCode(thrown: unknown): string | null {
  if (typeof thrown !== "object" || thrown === null || !("code" in thrown)) {
    return null;
  }
  const code = thrown.code;
  return typeof code === "string" && /^[A-Z]{2,16}$/.test(code) ? code : null;
}

async function waitForExit(
  exit: Promise<ManagedServiceExit | PtySessionSnapshot["exit"]>,
  timeoutMs: number,
): Promise<ManagedServiceExit | PtySessionSnapshot["exit"] | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([exit, timeout]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

function restartFailureReason(maxRestarts: number): RestartFailureReason {
  return maxRestarts === 0 ? "no-restart-policy" : "restart-budget-exhausted";
}

function failureError(
  reason: Extract<StopIntent, { kind: "failure" }>["reason"],
): ManagedServiceError {
  switch (reason) {
    case "spawn-failed":
      return { kind: "managed-service", code: "spawn-failed", detail: null };
    case "readiness-timeout":
      return { kind: "managed-service", code: "readiness-timeout" };
    case "readiness-output-exceeded":
      return { kind: "managed-service", code: "readiness-output-exceeded" };
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
