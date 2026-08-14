/**
 * Host adapter for ordered process-output capture.
 *
 * Spawns through Bun with an explicit argv or Bash interpreter, drains stdout
 * and stderr together so neither pipe can stall the child, and feeds copied
 * bytes into the domain collector. Credential-safe CommandRunnerPort is
 * unchanged: this adapter is the observation path that may retain stderr and
 * spill exact overflow to artifacts.
 */

import type { ArtifactStorePort } from "../domain/artifact.ts";
import type { ClockPort } from "../domain/clock.ts";
import { createSystemClock } from "../domain/clock.ts";
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
  processCaptureId,
  resolveProcessCaptureLimits,
  validateProcessCaptureRequest,
} from "../domain/index.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { escalateOwnedTree, ownedTreeSpawnOptions } from "./host-process-tree.ts";

export type HostProcessCaptureOptions = {
  readonly artifacts?: ArtifactStorePort;
  readonly clock?: ClockPort;
};

export function createHostProcessCapturePort(
  options: HostProcessCaptureOptions = {},
): ProcessCapturePort {
  const clock = options.clock ?? createSystemClock();
  const artifacts = options.artifacts ?? null;
  let nextId = 1;

  return {
    async run(
      request: ProcessCaptureRequest,
      listener?: ProcessCaptureListener,
    ): Promise<Result<ProcessCaptureReport, ProcessCaptureError>> {
      const invalid = validateProcessCaptureRequest(request);
      if (invalid !== null) {
        return invalidProcessCaptureRequest(invalid);
      }
      if (request.signal?.aborted === true) {
        return cancelledWithoutProcess(clock, artifacts, request, listener);
      }

      const captureId = processCaptureId.from(`cap-${nextId}`);
      nextId += 1;
      const collector = createProcessCaptureCollector({
        captureId,
        limits: resolveProcessCaptureLimits(request),
        artifacts,
        listener,
      });
      const controller = new AbortController();
      let ended: ProcessCaptureStop | null = null;
      let started = false;
      let child: Bun.Subprocess | null = null;
      let treeStop: Promise<{ readonly stage: ProcessKillStage }> | null = null;

      const stopFor = (reason: ProcessCaptureStop): void => {
        if (ended === null) {
          ended = reason;
          controller.abort();
          if (child !== null && typeof child.pid === "number") {
            treeStop = escalateOwnedTree({ pid: child.pid, exited: child.exited });
          }
        }
      };

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
        if (ended !== null && typeof spawned.pid === "number") {
          treeStop = escalateOwnedTree({ pid: spawned.pid, exited: spawned.exited });
        }
        const pid = typeof spawned.pid === "number" ? spawned.pid : 0;
        await collector.start(pid, clock.now());
        started = true;

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
        const cleanup = treeStop === null ? null : await treeStop;
        return ok(
          await collector.finish(
            { exitCode, signal: signalText(spawned.signalCode) },
            clock.now(),
            ended ?? { kind: "exited" },
            cleanup?.stage ?? "none",
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
              cleanup?.stage ?? "none",
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
    captureId: processCaptureId.from("cap-cancelled"),
    limits: resolveProcessCaptureLimits(request),
    artifacts,
    listener,
  });
  const now = clock.now();
  await collector.start(0, now);
  return ok(await collector.finish({ exitCode: null, signal: null }, now, { kind: "cancelled" }));
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
