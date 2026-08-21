/**
 * The supervised command adapter.
 *
 * A leaf over `Bun.spawn`, and the only place in Falryn that starts a process.
 * Everything the port promises is enforced here: the argument vector is passed
 * as a list so no shell ever sees it, the environment is exactly what the caller
 * supplied, output is read with a hard byte bound, and a deadline or an abort
 * kills the child rather than leaving it running.
 *
 * `stdout` is returned to the caller and may hold a secret. It is not logged
 * here, not folded into an error, and not retained after the call returns.
 * `stderr` is drained to completion so the child can never block on a full
 * pipe, and every chunk is discarded as it arrives: a platform tool's error
 * text routinely quotes what it was asked for, and the port's contract is that
 * no such text crosses this boundary.
 *
 * A child that exceeds its output bound is killed at the moment the bound is
 * reached. Merely stopping the read would leave the child blocked on a full
 * pipe until its deadline expired, and the caller would then be told the
 * command was slow when in fact it was too loud.
 *
 * Deadline and abort escalate against the owned process group, not only the
 * leader PID, so a grandchild does not outlive a confirmed stop.
 */

import {
  type CommandOutcome,
  type CommandRequest,
  type CommandRunnerPort,
  type DurationMs,
  isAbsoluteCommandPath,
  MAX_COMMAND_ARGUMENTS,
  MAX_COMMAND_ENVIRONMENT_BYTES,
  MAX_COMMAND_ENVIRONMENT_ENTRIES,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_COMMAND_SCRIPT_BYTES,
} from "../domain/index.ts";
import type { OwnedProcessRegistry } from "./host-owned-process-registry.ts";
import { escalateOwnedTree, ownedTreeSpawnOptions } from "./host-process-tree.ts";

export type HostCommandRunnerOptions = {
  readonly ownedProcesses?: OwnedProcessRegistry;
};

export function createHostCommandRunner(options: HostCommandRunnerOptions = {}): CommandRunnerPort {
  const ownedProcesses = options.ownedProcesses;
  return {
    async run(request: CommandRequest): Promise<CommandOutcome> {
      const invalid = invalidRequest(request);
      if (invalid !== null) {
        return invalid;
      }
      if (request.signal?.aborted === true) {
        return { kind: "cancelled" };
      }

      const maxOutputBytes = Math.min(request.maxOutputBytes, MAX_COMMAND_OUTPUT_BYTES);
      const controller = new AbortController();
      let ended: StopReason | null = null;
      let child: ReturnType<typeof Bun.spawn> | null = null;
      let treeStop: Promise<unknown> | null = null;

      const stopFor = (reason: StopReason): void => {
        if (ended === null) {
          ended = reason;
          controller.abort();
          if (child !== null && typeof child.pid === "number") {
            treeStop = escalateOwnedTree({ pid: child.pid, exited: child.exited });
          }
        }
      };

      const timer = setTimeout(() => {
        stopFor("timed-out");
      }, request.timeoutMs);
      const onAbort = (): void => {
        stopFor("cancelled");
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        // Direct mode passes a list, so no shell parses any argument. Bash mode
        // passes one deliberate command string to the named interpreter. `env`
        // is exactly what was supplied — Bun replaces rather than merges when
        // it is given.
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

        const [stdoutBytes] = await Promise.all([
          // One byte past the bound, so exceeding it is detectable rather than
          // indistinguishable from filling it exactly.
          readBounded(spawned.stdout, maxOutputBytes + 1, () => {
            stopFor("output-exceeded");
          }),
          // Drained and dropped. An undrained pipe fills and stalls the child.
          drain(spawned.stderr),
        ]);
        const exitCode = await spawned.exited;
        if (treeStop !== null) {
          await treeStop;
        }

        const stopped = stoppedOutcome(ended, request.timeoutMs, maxOutputBytes);
        if (stopped !== null) {
          return stopped;
        }
        if (stdoutBytes.length > maxOutputBytes) {
          // The child finished on its own but wrote past the bound.
          return { kind: "output-exceeded", maxOutputBytes };
        }

        return { kind: "exited", exitCode, stdout: new TextDecoder().decode(stdoutBytes) };
      } catch (thrown) {
        const stopped = stoppedOutcome(ended, request.timeoutMs, maxOutputBytes);
        if (stopped !== null) {
          return stopped;
        }
        // The thrown value's message is discarded rather than reported: a spawn
        // failure's text carries an absolute path and sometimes the argv.
        return { kind: "spawn-failed", code: spawnFailureCode(thrown) };
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

type StopReason = "timed-out" | "cancelled" | "output-exceeded";

function invalidRequest(request: CommandRequest): CommandOutcome | null {
  if (!isAbsoluteCommandPath(request.executable)) {
    return { kind: "spawn-failed", code: "invalid-executable" };
  }
  if (request.cwd !== undefined && !isAbsoluteCommandPath(request.cwd)) {
    return { kind: "spawn-failed", code: "invalid-working-directory" };
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0) {
    return { kind: "spawn-failed", code: "invalid-timeout" };
  }
  if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 0) {
    return { kind: "spawn-failed", code: "invalid-output-limit" };
  }

  const environmentError = validateEnvironment(request.environment);
  if (environmentError !== null) {
    return { kind: "spawn-failed", code: environmentError };
  }

  if (request.mode === "bash") {
    if (request.command.includes("\0")) {
      return { kind: "spawn-failed", code: "invalid-command" };
    }
    const commandBytes = new TextEncoder().encode(request.command).byteLength;
    return commandBytes > MAX_COMMAND_SCRIPT_BYTES
      ? { kind: "spawn-failed", code: "command-too-large" }
      : null;
  }
  if (request.argv.length > MAX_COMMAND_ARGUMENTS) {
    return { kind: "spawn-failed", code: "too-many-arguments" };
  }
  if (request.argv.some((argument) => argument.includes("\0"))) {
    return { kind: "spawn-failed", code: "invalid-argument" };
  }
  return null;
}

function validateEnvironment(
  environment: Readonly<Record<string, string>>,
): "invalid-environment" | "environment-too-large" | null {
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    return "invalid-environment";
  }

  const entries = Object.entries(environment);
  if (entries.length > MAX_COMMAND_ENVIRONMENT_ENTRIES) {
    return "environment-too-large";
  }

  const encoder = new TextEncoder();
  let bytes = 0;
  for (const [name, value] of entries) {
    if (name.includes("\0") || typeof value !== "string" || value.includes("\0")) {
      return "invalid-environment";
    }
    bytes += encoder.encode(`${name}=${value}`).byteLength;
    if (bytes > MAX_COMMAND_ENVIRONMENT_BYTES) {
      return "environment-too-large";
    }
  }
  return null;
}

function spawnArgv(request: CommandRequest): string[] {
  if (request.mode === "bash") {
    return [request.executable, "--noprofile", "--norc", "-c", request.command];
  }
  return [request.executable, ...request.argv];
}

/** The outcome a stop reason produces, or `null` when nothing stopped the run. */
function stoppedOutcome(
  ended: StopReason | null,
  timeoutMs: DurationMs,
  maxOutputBytes: number,
): CommandOutcome | null {
  switch (ended) {
    case null:
      return null;
    case "timed-out":
      return { kind: "timed-out", timeoutMs };
    case "cancelled":
      return { kind: "cancelled" };
    case "output-exceeded":
      return { kind: "output-exceeded", maxOutputBytes };
  }
}

/** Node's `errno` names are stable enough to route on; its messages are not. */
function spawnFailureCode(thrown: unknown): string {
  const code = (thrown as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z]{2,16}$/.test(code) ? code : "spawn-error";
}

/**
 * Reads a stream to completion and keeps none of it.
 *
 * Unbounded on purpose, and safe because nothing accumulates: a bound here
 * would stop reading while the child kept writing, and the child would then
 * block on a full pipe until something killed it.
 */
async function drain(stream: ReadableStream<Uint8Array> | undefined): Promise<void> {
  if (stream === undefined) {
    return;
  }
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) {
        return;
      }
    }
  } catch {
    // The stream closed under us because the child was killed. Nothing was
    // being kept, so there is nothing to report.
    return;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Reads a stream up to a bound, then calls `onExceeded` and stops.
 *
 * Stopping is not enough on its own — a child that keeps writing would block on
 * a full pipe — so the callback is what lets the caller kill it immediately
 * instead of waiting for a deadline that describes the wrong problem.
 */
async function readBounded(
  stream: ReadableStream<Uint8Array> | undefined,
  maximumBytes: number,
  onExceeded: () => void,
): Promise<Uint8Array> {
  if (stream === undefined) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    while (total < maximumBytes) {
      const { done, value } = await reader.read();
      if (done || value === undefined) {
        break;
      }
      chunks.push(value);
      total += value.length;
    }
    if (total >= maximumBytes) {
      onExceeded();
    }
  } catch {
    // Killed mid-read. Whatever arrived before that is returned; the stop
    // reason the caller already recorded decides the outcome.
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(Math.min(total, maximumBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= joined.length) {
      break;
    }
    const take = Math.min(chunk.length, joined.length - offset);
    joined.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return joined;
}
