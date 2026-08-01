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
 * `stderr` is drained so the child cannot block on a full pipe, and then
 * discarded: a platform tool's error text routinely quotes what it was asked
 * for, and the port's contract is that no such text crosses this boundary.
 */

import {
  type CommandOutcome,
  type CommandRequest,
  type CommandRunnerPort,
  MAX_COMMAND_ARGUMENTS,
  MAX_COMMAND_OUTPUT_BYTES,
} from "../domain/index.ts";

export function createHostCommandRunner(): CommandRunnerPort {
  return {
    async run(request: CommandRequest): Promise<CommandOutcome> {
      if (request.argv.length > MAX_COMMAND_ARGUMENTS) {
        return { kind: "spawn-failed", code: "too-many-arguments" };
      }
      if (request.signal?.aborted === true) {
        return { kind: "cancelled" };
      }

      const maxOutputBytes = Math.min(request.maxOutputBytes, MAX_COMMAND_OUTPUT_BYTES);
      const controller = new AbortController();
      let ended: "timed-out" | "cancelled" | null = null;

      const stopFor = (reason: "timed-out" | "cancelled"): void => {
        if (ended === null) {
          ended = reason;
          controller.abort();
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
        // `argv` is a list, so no shell parses any of it. `env` is exactly what
        // was supplied — Bun replaces rather than merges when it is given.
        const child = Bun.spawn([request.executable, ...request.argv], {
          env: request.environment,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          signal: controller.signal,
        });

        const [stdoutBytes] = await Promise.all([
          readBounded(child.stdout, maxOutputBytes + 1),
          // Drained and dropped. An undrained pipe fills and stalls the child.
          drain(child.stderr, maxOutputBytes),
        ]);
        const exitCode = await child.exited;

        if (ended !== null) {
          return ended === "timed-out"
            ? { kind: "timed-out", timeoutMs: request.timeoutMs }
            : { kind: "cancelled" };
        }

        const truncated = stdoutBytes.length > maxOutputBytes;
        return {
          kind: "exited",
          exitCode,
          stdout: new TextDecoder().decode(
            truncated ? stdoutBytes.subarray(0, maxOutputBytes) : stdoutBytes,
          ),
          outputTruncated: truncated,
        };
      } catch (thrown) {
        if (ended === "timed-out") {
          return { kind: "timed-out", timeoutMs: request.timeoutMs };
        }
        if (ended === "cancelled") {
          return { kind: "cancelled" };
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

/** Node's `errno` names are stable enough to route on; its messages are not. */
function spawnFailureCode(thrown: unknown): string {
  const code = (thrown as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z]{2,16}$/.test(code) ? code : "spawn-error";
}

/** Reads a stream to its bound and keeps nothing. */
async function drain(
  stream: ReadableStream<Uint8Array> | undefined,
  maximumBytes: number,
): Promise<void> {
  await readBounded(stream, maximumBytes);
}

/**
 * Reads a stream up to a bound and stops.
 *
 * Stopping matters more than the bound: a child that keeps writing after the
 * limit is reached would otherwise be read forever, and the deadline is not a
 * substitute for refusing to accumulate.
 */
async function readBounded(
  stream: ReadableStream<Uint8Array> | undefined,
  maximumBytes: number,
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
