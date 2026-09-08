/**
 * Host adapter for ordered process-output capture.
 *
 * Spawns through Bun with an explicit argv or Bash interpreter, drains stdout
 * and stderr together so neither pipe can stall the child, and feeds copied
 * bytes into the domain collector. Credential-safe CommandRunnerPort is
 * unchanged: this adapter is the observation path that may retain stderr and
 * spill exact overflow to artifacts.
 */

import { createHash, randomUUID } from "node:crypto";

import type { ArtifactStorePort } from "../../domain/artifacts/artifact.ts";
import type { ClockPort } from "../../domain/foundation/clock.ts";
import { createSystemClock } from "../../domain/foundation/clock.ts";
import { processCaptureId } from "../../domain/foundation/index.ts";
import { err, ok, type Result } from "../../domain/foundation/result.ts";
import {
  type CapturePressure,
  createProcessCaptureCollector,
  invalidProcessCaptureRequest,
  type ProcessCaptureError,
  type ProcessCaptureListener,
  type ProcessCapturePort,
  type ProcessCaptureReport,
  type ProcessCaptureRequest,
  type ProcessCaptureStop,
  type ProcessKillStage,
  type ProcessStreamName,
  resolveProcessCaptureLimits,
  validateProcessCaptureRequest,
} from "../../domain/process/index.ts";
import { sameProcessBirth } from "../../domain/process/process-identity.ts";
import type { OwnedProcessRegistry } from "./host-owned-process-registry.ts";
import { createHostProcessIdentityPort } from "./host-process-identity.ts";
import {
  escalateOwnedTree,
  ownedTreeSpawnOptions,
  settleOwnedGroupAfterLeader,
  signalOwnedTree,
} from "./host-process-tree.ts";

export type HostProcessCaptureOptions = {
  readonly artifacts?: ArtifactStorePort;
  readonly clock?: ClockPort;
  readonly ownedProcesses?: OwnedProcessRegistry;
};

export function createHostProcessCapturePort(
  options: HostProcessCaptureOptions = {},
): ProcessCapturePort {
  const clock = options.clock ?? createSystemClock();
  const artifacts = options.artifacts ?? null;
  const ownedProcesses = options.ownedProcesses;
  const identities = createHostProcessIdentityPort();
  return {
    supportsOwnership: process.platform === "linux" || process.platform === "darwin",
    async run(
      request: ProcessCaptureRequest,
      listener?: ProcessCaptureListener,
    ): Promise<Result<ProcessCaptureReport, ProcessCaptureError>> {
      const invalid = validateProcessCaptureRequest(request);
      if (invalid !== null) {
        return invalidProcessCaptureRequest(invalid);
      }
      if (
        request.ownership !== undefined &&
        (await identities.inspect(process.pid)).kind !== "present"
      )
        return err({ kind: "process-capture", code: "ownership-unavailable" });
      if (request.signal?.aborted === true) {
        return cancelledWithoutProcess(clock, artifacts, request, listener);
      }

      const captureId = captureIdFor(request);
      const controller = new AbortController();
      let ended: ProcessCaptureStop | null = null;
      let started = false;
      let child: Bun.Subprocess | null = null;
      let treeStop: Promise<{ readonly stage: ProcessKillStage }> | null = null;
      let forceRequested = false;

      const stopFor = (reason: ProcessCaptureStop, force = false): void => {
        if (force && child !== null && typeof child.pid === "number") {
          forceRequested = true;
          signalOwnedTree(child.pid, "SIGKILL");
        }
        if (ended !== null && reason.kind === "uncertain") {
          // A later evidence failure must survive an earlier cancellation request.
          ended = reason;
          return;
        }
        if (ended === null) {
          ended = reason;
          controller.abort();
          if (child !== null && typeof child.pid === "number") {
            treeStop = escalateOwnedTree({ pid: child.pid, exited: child.exited });
          }
        }
      };

      const collector = createProcessCaptureCollector({
        captureId,
        ...(request.invocationId === undefined ? {} : { invocationId: request.invocationId }),
        ...(request.retainChunkEvents === undefined
          ? {}
          : { retainChunkEvents: request.retainChunkEvents }),
        limits: resolveProcessCaptureLimits(request),
        artifacts,
        listener: async (event) => {
          try {
            await request.ownership?.event(event);
          } catch {
            stopFor({ kind: "uncertain", reason: "owner-persistence-failed" });
          }
          await listener?.(event);
        },
      });

      const timer = setTimeout(() => {
        stopFor({ kind: "timed-out", timeoutMs: request.timeoutMs });
      }, request.timeoutMs);
      const onAbort = (): void => {
        stopFor({ kind: "cancelled" });
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const spawned = Bun.spawn(spawnArgv(request), {
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          ...ownedTreeSpawnOptions(),
          env: request.environment,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          signal: controller.signal,
        });
        child = spawned;
        if (typeof spawned.pid === "number") {
          ownedProcesses?.adopt(spawned.pid, spawned.exited);
        }
        if (ended !== null && typeof spawned.pid === "number") {
          treeStop = escalateOwnedTree({ pid: spawned.pid, exited: spawned.exited });
        }
        const pid = typeof spawned.pid === "number" ? spawned.pid : 0;
        await collector.start(pid, clock.now());
        started = true;
        if (request.ownership !== undefined) {
          const birth = await identities.inspect(pid);
          if (birth.kind !== "present")
            stopFor({ kind: "uncertain", reason: "ownership-unavailable" });
          else {
            try {
              await request.ownership.started({
                identity: birth.identity,
                async stop(force, authorize) {
                  const current = await identities.inspect(pid);
                  if (
                    current.kind !== "present" ||
                    !sameProcessBirth(birth.identity, current.identity)
                  )
                    return "unavailable";
                  if (authorize !== undefined && !authorize()) return "unavailable";
                  stopFor({ kind: "cancelled" }, force);
                  return "requested";
                },
              });
            } catch {
              stopFor({ kind: "uncertain", reason: "owner-persistence-failed" });
            }
          }
        }

        let chain = Promise.resolve();
        const serialize = (work: () => Promise<CapturePressure>): Promise<CapturePressure> => {
          const next = chain.then(work, work);
          chain = next.then(
            () => undefined,
            () => undefined,
          );
          return next;
        };

        await Promise.all([
          readStream(spawned.stdout, "stdout", serialize, collector, stopFor),
          readStream(spawned.stderr, "stderr", serialize, collector, stopFor),
        ]);
        const exitCode = await spawned.exited;
        let cleanup = treeStop === null ? null : await treeStop;
        if (request.ownership !== undefined) {
          // Leader exit and closed pipes do not prove that redirected descendants stopped.
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
          const group = await settleOwnedGroupAfterLeader(pid);
          if (group.hadMembers) {
            ended ??= { kind: "uncertain", reason: "owned-descendants-remained" };
            cleanup = group.cleanup;
          }
        }
        return ok(
          await collector.finish(
            { exitCode, signal: signalText(spawned.signalCode) },
            clock.now(),
            ended ?? { kind: "exited" },
            cleanup?.stage === "unconfirmed"
              ? "unconfirmed"
              : forceRequested
                ? "kill"
                : (cleanup?.stage ?? "none"),
          ),
        );
      } catch (thrown) {
        if (started && ended !== null) {
          const cleanup = treeStop === null ? null : await treeStop;
          return ok(
            await collector.finish(
              { exitCode: null, signal: null },
              clock.now(),
              ended,
              forceRequested ? "kill" : (cleanup?.stage ?? "none"),
            ),
          );
        }
        return err({
          kind: "process-capture",
          code: "spawn-failed",
          detail: spawnFailureCode(thrown),
        });
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

async function cancelledWithoutProcess(
  clock: ClockPort,
  artifacts: ArtifactStorePort | null,
  request: ProcessCaptureRequest,
  listener: ProcessCaptureListener | undefined,
): Promise<Result<ProcessCaptureReport, ProcessCaptureError>> {
  const collector = createProcessCaptureCollector({
    captureId: captureIdFor(request),
    ...(request.invocationId === undefined ? {} : { invocationId: request.invocationId }),
    limits: resolveProcessCaptureLimits(request),
    artifacts,
    listener,
  });
  const now = clock.now();
  await collector.start(0, now);
  return ok(await collector.finish({ exitCode: null, signal: null }, now, { kind: "cancelled" }));
}

function captureIdFor(request: ProcessCaptureRequest) {
  const source = request.invocationId === undefined ? randomUUID() : String(request.invocationId);
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 32);
  return processCaptureId.from(`cap-${digest}`);
}

async function readStream(
  stream: ReadableStream<Uint8Array> | undefined,
  name: ProcessStreamName,
  serialize: (work: () => Promise<CapturePressure>) => Promise<CapturePressure>,
  collector: ReturnType<typeof createProcessCaptureCollector>,
  stopFor: (reason: ProcessCaptureStop) => void,
): Promise<void> {
  if (stream === undefined) {
    return;
  }
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || value === undefined) {
        return;
      }
      const pressure = await serialize(() => collector.append(name, value));
      if (pressure !== "continue") {
        stopFor({ kind: "capture-exceeded", reason: pressure });
        return;
      }
    }
  } catch {
    return;
  } finally {
    reader.releaseLock();
  }
}

function spawnArgv(request: ProcessCaptureRequest): string[] {
  if (request.mode === "bash") {
    return [request.executable, "--noprofile", "--norc", "-c", request.command];
  }
  return [request.executable, ...request.argv];
}

function spawnFailureCode(thrown: unknown): string {
  const code = (thrown as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z]{2,16}$/.test(code) ? code : "spawn-error";
}

function signalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
