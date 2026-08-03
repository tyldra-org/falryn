/**
 * The process boundary, as the runtime sees it.
 *
 * Three facts live here and nowhere else: how bytes leave, how bytes arrive,
 * and what the attached terminal can actually display. Each is a port for the
 * same reason `SignalPort` and `EnvironmentPort` are — a test that writes to the
 * real `process.stdout` leaks into every test that runs after it, and a test
 * that reads the real `process.stdin` hangs.
 *
 * Two rules the types enforce rather than document:
 *
 * - **A write is never assumed to have landed.** `write` reports what the
 *   stream accepted; only `flush` reports what left the process. A boundary
 *   that collapsed the two would let a run claim it emitted a result it still
 *   held in a buffer when it exited.
 * - **Capability is a fact about this process, not a preference.** Colour and
 *   size are derived from the environment and the handle being asked about. An
 *   option that overrides the fact belongs to the command surface; it overrides
 *   this computation rather than replacing it.
 *
 * This module assigns no exit code and decides what goes on which handle for
 * nobody. Those are the CLI's, and `src/cli/` owns them.
 */

import type { EnvironmentPort } from "./environment.ts";
import { err, ok, type Result } from "./result.ts";

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Largest single write, in bytes.
 *
 * Bounded so one record cannot commit the process to an unbounded copy. A
 * producer with more than this to say emits more than one write; a producer
 * that hands over more than this at once has a defect the boundary reports
 * rather than absorbs.
 */
export const MAX_STREAM_WRITE_BYTES = 1024 * 1024;

export const STREAM_WRITE_STATUSES = ["accepted", "closed", "too-large"] as const;

export type StreamWriteStatus = (typeof STREAM_WRITE_STATUSES)[number];

export type StreamWrite = {
  /**
   * `closed` means the reader on the other end went away. It is a normal end,
   * not a failure: the caller stops writing and says nothing about it.
   */
  readonly status: StreamWriteStatus;
  /** Bytes this call handed to the stream. Zero unless `accepted`. */
  readonly accepted: number;
  /** Accepted bytes no flush has yet confirmed left the process. */
  readonly pending: number;
};

export const FLUSH_STATUSES = ["flushed", "closed", "failed"] as const;

export type FlushStatus = (typeof FLUSH_STATUSES)[number];

export type FlushReport = {
  readonly status: FlushStatus;
  /** Bytes this flush confirmed left the process. */
  readonly flushed: number;
  /** Bytes still unconfirmed when the flush ended. Zero only when `flushed`. */
  readonly pending: number;
  /**
   * The boundary's own code, such as `EPIPE`.
   *
   * Structural only, and never the bytes that were being written — a flush
   * report is meant to be loggable.
   */
  readonly detail: string | null;
};

export type OutputStreamPort = {
  /** Hands bytes to the stream. Reports acceptance, never delivery. */
  write(bytes: Uint8Array): StreamWrite;
  /**
   * Confirms accepted bytes left the process.
   *
   * Called before the process is allowed to end. A flush that could not
   * complete is reported here rather than assumed, because the alternative is a
   * clean exit over output nobody received.
   */
  flush(): Promise<FlushReport>;
  /** Whether the reader is known to be gone. Once true it stays true. */
  isClosed(): boolean;
  /**
   * Releases whatever the stream holds on the host.
   *
   * Declared for the same reason `SignalPort` returns an `Unsubscribe`: an
   * adapter over a process-lifetime handle has to attach a listener to observe
   * a departed reader, and a listener nobody removes accumulates on a stream
   * that outlives every port built over it. Calling it more than once is safe,
   * and a stream that holds nothing implements it as a no-op rather than
   * omitting it — an optional release is one a caller forgets.
   */
  dispose(): void;
};

/** Whether a flush confirmed everything the stream had accepted. */
export function isCompleteFlush(report: FlushReport): boolean {
  return report.status === "flushed" && report.pending === 0;
}

export type RecordingOutputStreamOptions = {
  /**
   * Bytes this stream accepts before the reader is treated as gone.
   *
   * Models `head -1`: the writes up to the bound land, and everything after it
   * reports `closed`.
   */
  readonly closeAfterBytes?: number;
  /** Makes every flush report `failed`, so a caller's reporting path is real. */
  readonly failFlush?: boolean;
};

export type RecordingOutputStream = OutputStreamPort & {
  /** Every accepted write, decoded, in the order it was made. */
  writes(): readonly string[];
  /** Every accepted write concatenated. */
  text(): string;
  /** Writes that a flush has confirmed, in order. */
  flushed(): readonly string[];
  flushCount(): number;
};

/**
 * An in-memory `OutputStreamPort` for tests.
 *
 * It records exactly what was written and in what order, which is what makes a
 * claim like "stdout carried only the result" provable rather than asserted in
 * a comment.
 */
export function createRecordingOutputStream(
  options: RecordingOutputStreamOptions = {},
): RecordingOutputStream {
  const decoder = new TextDecoder();
  const accepted: string[] = [];
  let confirmed = 0;
  let flushes = 0;
  let acceptedBytes = 0;
  let pending = 0;
  let closed = false;

  return {
    write(bytes: Uint8Array): StreamWrite {
      if (bytes.byteLength > MAX_STREAM_WRITE_BYTES) {
        return { status: "too-large", accepted: 0, pending };
      }
      if (closed) {
        return { status: "closed", accepted: 0, pending };
      }
      const bound = options.closeAfterBytes;
      if (bound !== undefined && acceptedBytes + bytes.byteLength > bound) {
        closed = true;
        return { status: "closed", accepted: 0, pending };
      }
      accepted.push(decoder.decode(bytes));
      acceptedBytes += bytes.byteLength;
      pending += bytes.byteLength;
      return { status: "accepted", accepted: bytes.byteLength, pending };
    },

    async flush(): Promise<FlushReport> {
      flushes += 1;
      if (options.failFlush === true) {
        return { status: "failed", flushed: 0, pending, detail: "flush-refused" };
      }
      if (closed) {
        return { status: "closed", flushed: 0, pending, detail: "EPIPE" };
      }
      const flushedBytes = pending;
      pending = 0;
      confirmed = accepted.length;
      return { status: "flushed", flushed: flushedBytes, pending: 0, detail: null };
    },

    isClosed(): boolean {
      return closed;
    },

    // The double holds nothing on the host, so releasing it is a no-op. It is
    // implemented rather than omitted so a caller written against the double
    // and a caller written against the adapter are the same caller.
    dispose(): void {},

    writes(): readonly string[] {
      return [...accepted];
    },

    text(): string {
      return accepted.join("");
    },

    flushed(): readonly string[] {
      return accepted.slice(0, confirmed);
    },

    flushCount(): number {
      return flushes;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

/** The only encoding this boundary reads. Declared, not inferred per run. */
export const STDIN_ENCODING = "utf-8";

/** Bytes a caller reads from stdin when it names no smaller bound. */
export const DEFAULT_STDIN_MAX_BYTES = 1024 * 1024;

/** Largest bound a caller may name. A larger request is a defect, not a policy. */
export const MAX_STDIN_BYTES = 16 * 1024 * 1024;

export type StdinContent =
  /**
   * Nothing is attached to read.
   *
   * A TTY is reported this way on purpose: piped operation must never wait on
   * an interactive read, so "no stdin" is an immediate typed fact rather than a
   * hang.
   */
  | { readonly kind: "not-connected" }
  /** Connected, and closed without a byte. Distinguishable from the above. */
  | { readonly kind: "empty" }
  | { readonly kind: "text"; readonly text: string; readonly bytes: number };

export type StdinError =
  /** More bytes than the declared bound. Reported, never silently truncated. */
  | { readonly code: "too-large"; readonly maxBytes: number }
  /** Bytes that are not the declared encoding. */
  | { readonly code: "invalid-encoding" }
  /** The handle itself failed. Carries the boundary's code, never the bytes. */
  | { readonly code: "unreadable"; readonly detail: string | null };

export type InputStreamPort = {
  readonly encoding: typeof STDIN_ENCODING;
  /** The bound this port reads to. Declared once, not per call. */
  readonly maxBytes: number;
  read(): Promise<Result<StdinContent, StdinError>>;
};

/** Whether a bound is one this boundary is willing to read to. */
export function isReadableBound(maxBytes: number): boolean {
  return Number.isInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_STDIN_BYTES;
}

export type StaticInputStreamOptions = {
  /** `null` models a handle nothing is attached to. */
  readonly content: Uint8Array | string | null;
  readonly maxBytes?: number;
  /** Models a handle that failed rather than one that was empty. */
  readonly unreadable?: string;
};

/** An in-memory `InputStreamPort` for tests. Never touches a real handle. */
export function createStaticInputStream(options: StaticInputStreamOptions): InputStreamPort {
  const maxBytes = options.maxBytes ?? DEFAULT_STDIN_MAX_BYTES;
  const bytes =
    typeof options.content === "string"
      ? new TextEncoder().encode(options.content)
      : options.content;

  return {
    encoding: STDIN_ENCODING,
    maxBytes,
    async read(): Promise<Result<StdinContent, StdinError>> {
      if (options.unreadable !== undefined) {
        return err({ code: "unreadable", detail: options.unreadable });
      }
      if (bytes === null) {
        return ok({ kind: "not-connected" });
      }
      return decodeStdin(bytes, maxBytes);
    },
  };
}

/**
 * Turns read bytes into the declared encoding, or says why it could not.
 *
 * Shared by the host adapter and the double so both answer identically: the
 * bound is checked before decoding, because a truncated decode of over-long
 * input would report the wrong failure.
 */
export function decodeStdin(bytes: Uint8Array, maxBytes: number): Result<StdinContent, StdinError> {
  if (bytes.byteLength > maxBytes) {
    return err({ code: "too-large", maxBytes });
  }
  if (bytes.byteLength === 0) {
    return ok({ kind: "empty" });
  }
  try {
    const text = new TextDecoder(STDIN_ENCODING, { fatal: true }).decode(bytes);
    return ok({ kind: "text", text, bytes: bytes.byteLength });
  } catch {
    return err({ code: "invalid-encoding" });
  }
}

/* -------------------------------------------------------------------------- */
/* Capability                                                                  */
/* -------------------------------------------------------------------------- */

export const COLOR_LEVELS = ["none", "basic", "ansi256", "truecolor"] as const;

export type ColorLevel = (typeof COLOR_LEVELS)[number];

/** Narrowest and widest column counts this boundary believes a handle about. */
export const MIN_TERMINAL_COLUMNS = 1;
export const MAX_TERMINAL_COLUMNS = 10_000;

/**
 * What a process can observe about one handle.
 *
 * `columns` and `rows` are `null` when the handle does not report them. Absent
 * is absent: a non-TTY substituted with `80` is a narrow terminal that does not
 * exist, and every layout decision taken from it is wrong.
 */
export type HandleFacts = {
  readonly isTty: boolean;
  readonly columns: number | null;
  readonly rows: number | null;
};

/** A handle attached to something that is not a terminal. */
export const DETACHED_HANDLE: HandleFacts = { isTty: false, columns: null, rows: null };

export const SYMBOL_SUPPORTS = ["unicode", "ascii"] as const;

/**
 * The character repertoire a handle can be relied on to draw.
 *
 * Independent of colour, and deliberately so: losing decoration and losing a
 * character repertoire are different losses, so `--color never` on a UTF-8
 * terminal keeps its symbols and a non-UTF-8 locale on a colour terminal keeps
 * its colour.
 */
export type SymbolSupport = (typeof SYMBOL_SUPPORTS)[number];

export type StreamCapability = HandleFacts & {
  readonly color: ColorLevel;
  readonly symbols: SymbolSupport;
};

/**
 * The capability of each handle this process holds.
 *
 * Kept per handle rather than as one process-wide answer, because the common CI
 * shape has stdout piped and stderr on a terminal. A renderer that keyed colour
 * off the wrong handle would put escape sequences into a captured result.
 */
export type TerminalCapabilities = {
  readonly stdout: StreamCapability;
  readonly stderr: StreamCapability;
  /** Input has no colour and no size that matters here — only whether it waits. */
  readonly stdin: { readonly isTty: boolean };
};

export type ObservedHandles = {
  readonly stdout: HandleFacts;
  readonly stderr: HandleFacts;
  readonly stdin: { readonly isTty: boolean };
};

/** A column or row count, or `null` when the handle reported an unusable one. */
export function terminalSize(value: number | undefined | null): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  return value < MIN_TERMINAL_COLUMNS || value > MAX_TERMINAL_COLUMNS ? null : value;
}

/**
 * The colour this handle supports.
 *
 * Precedence, highest first:
 *
 * 1. `NO_COLOR` — an explicit refusal, and it outranks a request. A caller that
 *    wants colour in an environment that refused it is asking the wrong layer;
 *    the command surface's `--color` overrides the fact this returns.
 * 2. `TERM=dumb` — the terminal said it cannot render them.
 * 3. `FORCE_COLOR` — a request, honoured even off a TTY, which is what makes a
 *    piped-to-a-pager or captured-for-a-log run able to keep colour.
 * 4. Whether this handle is a terminal at all, and what it advertises.
 *
 * `NO_COLOR` follows the published convention and this repository's
 * `EnvironmentPort`, which both read an exported-but-empty variable as unset.
 */
export function colorLevelFor(handle: HandleFacts, environment: EnvironmentPort): ColorLevel {
  if (environment.get("NO_COLOR") !== null) {
    return "none";
  }
  const term = environment.get("TERM");
  if (term === "dumb") {
    return "none";
  }

  const forced = environment.get("FORCE_COLOR");
  if (forced !== null) {
    return forcedColorLevel(forced);
  }

  if (!handle.isTty) {
    return "none";
  }

  const colorTerm = environment.get("COLORTERM");
  if (colorTerm === "truecolor" || colorTerm === "24bit") {
    return "truecolor";
  }
  if (term?.includes("256color") === true) {
    return "ansi256";
  }
  return term === null ? "none" : "basic";
}

/**
 * The level a `FORCE_COLOR` value names.
 *
 * `0` is a refusal, `1`–`3` name depths, and anything else is a request without
 * a depth, which resolves to the depth every terminal that has colour has.
 */
function forcedColorLevel(value: string): ColorLevel {
  switch (value) {
    case "0":
    case "false":
      return "none";
    case "2":
      return "ansi256";
    case "3":
      return "truecolor";
    default:
      return "basic";
  }
}

/**
 * The character repertoire this process can rely on.
 *
 * Precedence, highest first:
 *
 * 1. `TERM=dumb` — the terminal said it renders nothing beyond plain text.
 * 2. `LC_ALL`, `LC_CTYPE`, then `LANG` — the first that names a charset. A
 *    charset that is not UTF-8 cannot carry the characters, so the fallback is
 *    ASCII. A value that names no charset at all — `C`, `en_US`, an empty
 *    environment — is not a statement about the repertoire and does not lower
 *    it.
 * 3. Otherwise Unicode.
 *
 * Unlike {@link colorLevelFor} this takes no handle: nothing about which handle
 * is being asked changes the answer, and a parameter that exists only for
 * symmetry is one a reader has to check for meaning it does not have. The
 * derivation still lives here, in one module, for the same reason colour's
 * does.
 */
export function symbolSupportFor(environment: EnvironmentPort): SymbolSupport {
  if (environment.get("TERM") === "dumb") {
    return "ascii";
  }
  for (const variable of ["LC_ALL", "LC_CTYPE", "LANG"] as const) {
    const value = environment.get(variable);
    if (value === null) {
      continue;
    }
    const charset = charsetIn(value);
    // Only the first variable that names a charset speaks. A `LC_ALL` without
    // one does not hand the question down to `LANG`, because the POSIX
    // precedence is over the whole setting rather than over each field of it.
    return charset === null ? "unicode" : isUtf8(charset) ? "unicode" : "ascii";
  }
  return "unicode";
}

/** The charset a locale value names, or `null` when it names none. */
function charsetIn(locale: string): string | null {
  const separator = locale.indexOf(".");
  if (separator < 0) {
    return null;
  }
  // `en_US.UTF-8@euro` — the modifier is not part of the charset.
  const charset = locale.slice(separator + 1).split("@")[0] ?? "";
  return charset === "" ? null : charset;
}

/** Whether a charset name is a spelling of UTF-8. */
function isUtf8(charset: string): boolean {
  return charset.toLowerCase().replaceAll(/[^a-z0-9]/g, "") === "utf8";
}

/** The capability of every handle, derived from what the process observed. */
export function terminalCapabilities(
  handles: ObservedHandles,
  environment: EnvironmentPort,
): TerminalCapabilities {
  const symbols = symbolSupportFor(environment);
  return {
    stdout: { ...handles.stdout, color: colorLevelFor(handles.stdout, environment), symbols },
    stderr: { ...handles.stderr, color: colorLevelFor(handles.stderr, environment), symbols },
    stdin: { isTty: handles.stdin.isTty },
  };
}

/* -------------------------------------------------------------------------- */
/* Renderer failure                                                            */
/* -------------------------------------------------------------------------- */

export const RENDERER_FAILURE_CODES = [
  /** A renderer is already open. Two owners of one terminal is a defect. */
  "already-open",
  /** Creation failed. The terminal was never taken, or was given back already. */
  "initialization-failed",
  /** It went away underneath the caller: a crash, or a host stream that closed. */
  "lost",
] as const;

export type RendererFailureCode = (typeof RENDERER_FAILURE_CODES)[number];

/**
 * What went wrong with a terminal renderer.
 *
 * Declared here rather than beside the renderer for the same reason
 * `SqliteStoreError` is declared away from the driver: the vocabulary is a
 * boundary fact, the translation to a `FalrynError` belongs to the application
 * layer, and neither may depend on the adapter that produces it. Nothing in this
 * module knows what a renderer *is*.
 *
 * `detail` is bounded and structural, never the thrown value — a renderer
 * failure message is written by a library with no idea what is sensitive.
 */
export type RendererFailure = {
  readonly code: RendererFailureCode;
  readonly detail: string | null;
};

/** Handles for a run with nothing attached. The shape a test starts from. */
export const DETACHED_HANDLES: ObservedHandles = {
  stdout: DETACHED_HANDLE,
  stderr: DETACHED_HANDLE,
  stdin: { isTty: false },
};
