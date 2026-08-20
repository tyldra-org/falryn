/**
 * The host terminal adapter.
 *
 * The one module in the tree allowed to name `process.stdout`,
 * `process.stderr`, or `process.stdin`. Every other module reaches them through
 * `OutputStreamPort`, `InputStreamPort`, and `TerminalCapabilities`, which is
 * what makes "stdout carried only the result" a property a test can prove
 * rather than a convention a reviewer has to enforce by reading.
 *
 * Three host behaviors are handled here and nowhere else:
 *
 * - **A reader that leaves.** Writing to a closed pipe surfaces as an `EPIPE`
 *   error event. Left unhandled it terminates the process with a stack trace
 *   over a completely normal end — `falryn ... | head -1` is the reproduction.
 *   The adapter records it, stops writing, and reports `closed`.
 * - **Backpressure.** A stream that refuses more bytes has buffered them, and
 *   `drain` is the only signal that they left. The wait races `drain` against
 *   `error` and `close`, because a pipe whose reader is gone never drains and a
 *   wait on `drain` alone hangs forever.
 * - **An interactive input handle.** A TTY stdin is reported as not connected
 *   rather than read, so a piped run can never block on a read nobody is going
 *   to satisfy.
 */

import {
  DEFAULT_STDIN_MAX_BYTES,
  decodeStdin,
  err,
  type FlushReport,
  type HandleFacts,
  type InputStreamPort,
  isReadableBound,
  MAX_STREAM_WRITE_BYTES,
  type ObservedHandles,
  type OutputStreamPort,
  ok,
  type Result,
  STDIN_ENCODING,
  type StdinContent,
  type StdinError,
  type StreamWrite,
  terminalSize,
} from "../domain/index.ts";

/**
 * The subset of a host output handle this adapter uses.
 *
 * Declared structurally so the adapter can be tested against a stream that is
 * not the process's own. It is deliberately not exported: a caller holding one
 * of these is holding a handle, which is the thing this module exists to
 * prevent.
 */
/**
 * What an emitter actually hands a listener.
 *
 * `unknown`, because that is the truth: the host emits whatever it emits, and
 * a listener that declared `NodeJS.ErrnoException` would be asserting a shape
 * nothing checked. The one place that needs a field narrows for it.
 */
type HostListener = (...args: unknown[]) => void;

type HostWritable = {
  write(chunk: Uint8Array): boolean;
  on(event: "error", listener: HostListener): unknown;
  once(event: "drain" | "error" | "close", listener: HostListener): unknown;
  off(event: "drain" | "error" | "close", listener: HostListener): unknown;
};

/**
 * The `code` an errno-carrying value reports, or `unknown` when it carries none.
 *
 * A guard rather than an assertion: a stream can emit something that is not an
 * `Error`, and `(thrown as NodeJS.ErrnoException).code` would quietly produce
 * `undefined` for it and call that a missing code.
 */
function errnoCode(value: unknown): string {
  if (typeof value !== "object" || value === null || !("code" in value)) {
    return "unknown";
  }
  const { code } = value;
  return typeof code === "string" ? code : "unknown";
}

export type HostOutputStreamOptions = {
  /** Which handle to write to. Defaults to the process's standard output. */
  readonly handle?: "stdout" | "stderr";
};

/**
 * An `OutputStreamPort` over one of the process's standard output handles.
 *
 * `write` reports acceptance and `flush` reports delivery, which is the whole
 * point of the split: a stream can accept a megabyte and still be holding it
 * when the process is asked to end.
 */
export function createHostOutputStream(options: HostOutputStreamOptions = {}): OutputStreamPort {
  // Assignable without an assertion: `HostWritable` describes exactly the four
  // members this adapter uses, with the host's own listener arity.
  const stream: HostWritable = options.handle === "stderr" ? process.stderr : process.stdout;

  return outputStreamOver(stream);
}

function outputStreamOver(stream: HostWritable): OutputStreamPort {
  let closedCode: string | null = null;
  let pending = 0;
  /** Set when the stream refused a write and has not drained since. */
  let congested = false;

  // Attached for the lifetime of this port. Without it an `EPIPE` reaches the
  // default handler, which ends the process on an error that this boundary
  // treats as an ordinary end.
  //
  // Released by `dispose`, because the handle outlives the port: `process.stdout`
  // is one object for the whole process, so a listener nobody removes
  // accumulates once per port ever built over it.
  const onError: HostListener = (...args) => {
    closedCode = errnoCode(args[0]);
  };
  stream.on("error", onError);
  let released = false;

  const settle = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const done = (): void => {
        stream.off("drain", done);
        stream.off("error", done);
        stream.off("close", done);
        resolve();
      };
      stream.once("drain", done);
      // A pipe whose reader is gone never drains. Racing the failure signals is
      // what keeps a flush from waiting forever on a stream that is finished.
      stream.once("error", done);
      stream.once("close", done);
    });

  return {
    write(bytes: Uint8Array): StreamWrite {
      if (bytes.byteLength > MAX_STREAM_WRITE_BYTES) {
        return { status: "too-large", accepted: 0, pending };
      }
      if (closedCode !== null) {
        return { status: "closed", accepted: 0, pending };
      }

      let accepted: boolean;
      try {
        accepted = stream.write(bytes);
      } catch (error) {
        // A synchronous throw is the same fact as the error event, and both
        // mean the same thing: there is no reader left.
        closedCode = errnoCode(error);
        return { status: "closed", accepted: 0, pending };
      }

      pending += bytes.byteLength;
      congested = !accepted;
      return { status: "accepted", accepted: bytes.byteLength, pending };
    },

    async flush(): Promise<FlushReport> {
      if (congested && closedCode === null) {
        await settle();
        congested = false;
      }

      if (closedCode !== null) {
        // The reader left. Whatever was still buffered did not arrive, and
        // saying so is the honest report; the caller decides that a departed
        // reader is a normal end.
        const unflushed = pending;
        pending = 0;
        return { status: "closed", flushed: 0, pending: unflushed, detail: closedCode };
      }

      const flushed = pending;
      pending = 0;
      return { status: "flushed", flushed, pending: 0, detail: null };
    },

    isClosed(): boolean {
      return closedCode !== null;
    },

    dispose(): void {
      if (released) {
        return;
      }
      released = true;
      stream.off("error", onError);
    },
  };
}

export type HostInputStreamOptions = {
  /** Bytes to read before the input is reported as over the bound. */
  readonly maxBytes?: number;
};

/**
 * An `InputStreamPort` over the process's standard input.
 *
 * A TTY handle resolves immediately as `not-connected` rather than being read.
 * That is the concrete defence against a headless run waiting on interaction
 * that is never coming, and it is why the check is here rather than in a
 * caller that might forget it.
 */
export function createHostInputStream(options: HostInputStreamOptions = {}): InputStreamPort {
  const maxBytes = options.maxBytes ?? DEFAULT_STDIN_MAX_BYTES;
  if (!isReadableBound(maxBytes)) {
    throw new RangeError(`stdin bound out of range: ${maxBytes}`);
  }

  return {
    encoding: STDIN_ENCODING,
    maxBytes,
    async read(): Promise<Result<StdinContent, StdinError>> {
      if (process.stdin.isTTY === true) {
        return ok({ kind: "not-connected" });
      }

      try {
        // Read one byte past the bound so an over-long input is reported as
        // over-long. Stopping at the bound would make an exactly-bounded read
        // and a truncated one indistinguishable.
        const bytes = await readBounded(process.stdin, maxBytes + 1);
        return decodeStdin(bytes, maxBytes);
      } catch (error) {
        const code = errnoCode(error);
        return err({ code: "unreadable", detail: code === "unknown" ? null : code });
      }
    },
  };
}

async function readBounded(
  source: AsyncIterable<Uint8Array | string>,
  limit: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let total = 0;

  for await (const chunk of source) {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    chunks.push(bytes);
    total += bytes.byteLength;
    if (total >= limit) {
      break;
    }
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/** What this process can observe about its own three standard handles. */
export function observeHandles(): ObservedHandles {
  return {
    stdout: handleFacts(process.stdout),
    stderr: handleFacts(process.stderr),
    stdin: { isTty: process.stdin.isTTY === true },
  };
}

function handleFacts(handle: NodeJS.WriteStream): HandleFacts {
  const isTty = handle.isTTY === true;
  return {
    isTty,
    // Only a terminal has a size. A pipe that reported one would be describing
    // the terminal its reader happens to sit in, not the destination of these
    // bytes.
    columns: isTty ? terminalSize(handle.columns) : null,
    rows: isTty ? terminalSize(handle.rows) : null,
  };
}

/** Plain-print fallback for transcript copy when OSC 52 is unavailable (#623). */
export function plainPrintLabeledCopy(text: string): boolean {
  try {
    process.stderr.write(`[falryn copy]\n${text}\n`);
    return true;
  } catch {
    return false;
  }
}
