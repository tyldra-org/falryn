/** Bun pipe-based managed service adapter. */

import type { ManagedServiceId, ServiceGeneration } from "../../domain/identity.ts";
import {
  invalidManagedServiceRequest,
  MAX_MANAGED_SERVICE_READINESS_BYTES,
  MAX_MANAGED_SERVICE_REPLAY_BYTES,
  MAX_MANAGED_SERVICE_WRITE_BYTES,
  MAX_MANAGED_SERVICES,
  MAX_RETAINED_MANAGED_SERVICES,
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
  serviceGeneration,
  validateManagedServiceRequest,
} from "../../domain/index.ts";
import { err, ok, type Result } from "../../domain/result.ts";
import type { OwnedProcessRegistry } from "../host-owned-process-registry.ts";
import { ownedTreeSpawnOptions } from "../host-process-tree.ts";
import {
  ByteReplay,
  evictInactive,
  type FailureIntent,
  failureError,
  fileSink,
  type HostFileSink,
  type HostSubprocess,
  type ManagedServiceEventDetail,
  readableStream,
  restartFailureReason,
  type ServiceStream,
  type StopIntent,
  safeHostCode,
  signalHostTree,
  signalText,
  waitForExit,
} from "./shared.ts";

export type HostManagedServicePortOptions = {
  readonly ownedProcesses?: OwnedProcessRegistry;
};

export function createHostManagedServicePort(
  options: HostManagedServicePortOptions = {},
): ManagedServicePort {
  const ownedProcesses = options.ownedProcesses;
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
      const service = new HostManagedService(request, ownedProcesses);
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

  private readonly ownedProcesses: OwnedProcessRegistry | undefined;

  constructor(
    private readonly request: ManagedServiceRequest,
    ownedProcesses?: OwnedProcessRegistry,
  ) {
    this.ownedProcesses = ownedProcesses;
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
        ...ownedTreeSpawnOptions(),
        env: this.request.environment,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      this.child = child;
      if (typeof child.pid === "number") {
        this.ownedProcesses?.adopt(child.pid, child.exited);
      }
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
      signalHostTree(this.child, "SIGTERM");
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
      signalHostTree(child, "SIGKILL");
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
      signalHostTree(child, "SIGTERM");
    } catch {
      this.failShutdown(generation);
      return err({ kind: "managed-service", code: "shutdown-timeout" });
    }
    const firstExit = await waitForExit(exitPromise, this.request.shutdownTimeoutMs);
    if (firstExit !== null) {
      return ok({ kind: "stopped", reason, exit: firstExit });
    }
    try {
      signalHostTree(child, "SIGKILL");
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
