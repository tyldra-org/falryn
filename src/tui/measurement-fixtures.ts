/**
 * Test-only support for measurements that need the shipped executable.
 *
 * The test renderer is the right owner for in-process measurements, but it does
 * not run OpenTUI's frame loop and it cannot include process startup. This
 * fixture opens the same pseudo-terminal shape as the compiled walk and exposes
 * only the observations the gated measurement needs. It is named as a fixture so
 * the TUI boundary control keeps it out of the product-file set and the build
 * graph.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, createReadStream, writeSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The artifact a user runs, beside `src/` in the repository root. */
export const MEASURED_EXECUTABLE = join(
  dirname(dirname(dirname(import.meta.path))),
  "dist",
  "falryn",
);

/** OpenTUI's synchronized-update sequence starts one rendered frame. */
export const FRAME_START = "\u001b[?2026h";

const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 30;
const POLL_MS = 5;
const FRAME_TIMEOUT_MS = 15_000;
const QUIET_MS = 250;
const EXIT_TIMEOUT_MS = 8_000;

export type MeasurementPty = {
  readonly master: number;
  readonly slave: number;
  transcript(): string;
  releaseSlave(): void;
  close(): void;
};

export type CompiledMeasurement = {
  readonly process: Bun.Subprocess;
  readonly pty: MeasurementPty;
  readonly startedAt: number;
  write(bytes: string | readonly number[]): void;
  waitForFrame(): Promise<{ readonly elapsedMs: number; readonly frameCount: number }>;
  waitForQuiet(): Promise<void>;
  frameCount(): number;
  stop(): Promise<number | "timed-out">;
};

/** Whether the exact compiled artifact exists before a gated run starts. */
export async function measuredExecutableExists(): Promise<boolean> {
  return await stat(MEASURED_EXECUTABLE)
    .then(() => true)
    .catch(() => false);
}

/**
 * Allocates a pseudo-terminal with dimensions set before the child starts.
 * `openpty` is used rather than an ioctl because its window size arguments are
 * ordinary fixed-arity FFI parameters on arm64.
 */
export function openMeasurementPty(
  columns: number = DEFAULT_COLUMNS,
  rows: number = DEFAULT_ROWS,
): MeasurementPty | null {
  const master = new Int32Array(1);
  const slave = new Int32Array(1);
  const size = new Uint16Array([rows, columns, 0, 0]);

  try {
    const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libutil.so.1", {
      openpty: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    if (libc.symbols.openpty(ptr(master), ptr(slave), null, null, ptr(size)) !== 0) {
      return null;
    }
  } catch {
    return null;
  }

  const masterFd = master[0] ?? -1;
  const slaveFd = slave[0] ?? -1;
  let transcript = "";
  let closed = false;
  const reader = createReadStream("", { fd: masterFd, autoClose: false });
  reader.on("data", (chunk) => {
    transcript += chunk.toString();
  });
  reader.on("error", () => {
    // The child closing the slave is the ordinary end of a pseudo-terminal.
  });
  let slaveClosed = false;
  const releaseSlave = (): void => {
    if (slaveClosed) {
      return;
    }
    slaveClosed = true;
    try {
      closeSync(slaveFd);
    } catch {
      // The slave may already have been released by the host runtime.
    }
  };

  return {
    master: masterFd,
    slave: slaveFd,
    transcript: () => transcript,
    releaseSlave,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      reader.destroy();
      try {
        closeSync(masterFd);
      } catch {
        // The master may already have been closed by the host after the child exits.
      }
      releaseSlave();
    },
  };
}

/** Starts `dist/falryn` attached to a real pseudo-terminal. */
export async function startCompiledMeasurement(): Promise<CompiledMeasurement | null> {
  if (!(await measuredExecutableExists())) {
    return null;
  }

  const pty = openMeasurementPty();
  if (pty === null) {
    return null;
  }

  const startedAt = performance.now();
  const child = Bun.spawn([MEASURED_EXECUTABLE], {
    stdin: pty.slave,
    stdout: pty.slave,
    stderr: pty.slave,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TERM: "xterm-256color",
    },
  });
  pty.releaseSlave();

  const waitForFrame = async (): Promise<{
    readonly elapsedMs: number;
    readonly frameCount: number;
  }> => {
    const deadline = performance.now() + FRAME_TIMEOUT_MS;
    while (performance.now() < deadline) {
      if (pty.transcript().includes(FRAME_START)) {
        return {
          elapsedMs: performance.now() - startedAt,
          frameCount: frameCountOf(pty.transcript()),
        };
      }
      await Bun.sleep(POLL_MS);
    }
    throw new Error("the compiled shell did not draw a synchronized frame");
  };

  const waitForQuiet = async (): Promise<void> => {
    const deadline = performance.now() + FRAME_TIMEOUT_MS;
    let lastLength = pty.transcript().length;
    let quietSince = performance.now();
    while (performance.now() < deadline) {
      await Bun.sleep(POLL_MS);
      const length = pty.transcript().length;
      if (length !== lastLength) {
        lastLength = length;
        quietSince = performance.now();
      } else if (performance.now() - quietSince >= QUIET_MS) {
        return;
      }
    }
    throw new Error("the compiled shell did not become quiet");
  };

  const stop = async (): Promise<number | "timed-out"> => {
    if (child.exitCode === null) {
      child.kill("SIGINT");
    }
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(EXIT_TIMEOUT_MS).then(() => "timed-out" as const),
    ]);
    if (exitCode === "timed-out") {
      child.kill("SIGKILL");
    }
    await Bun.sleep(50);
    pty.close();
    return exitCode;
  };

  return {
    process: child,
    pty,
    startedAt,
    write(bytes) {
      writeSync(
        pty.master,
        Buffer.from(typeof bytes === "string" ? bytes : Uint8Array.from(bytes)),
      );
    },
    waitForFrame,
    waitForQuiet,
    frameCount: () => frameCountOf(pty.transcript()),
    stop,
  };
}

function frameCountOf(transcript: string): number {
  return Math.max(0, transcript.split(FRAME_START).length - 1);
}
