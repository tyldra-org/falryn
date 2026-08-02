/**
 * The stdout/stderr contract.
 *
 * stdout carries the selected result format and nothing else. Progress,
 * diagnostics, warnings, and human notices go to stderr — including when the
 * human format *is* the selected result format, because a consumer that pipes
 * `falryn ... | jq` and a consumer that reads the same command in a terminal
 * must see the same stdout.
 *
 * The rule is enforced structurally rather than by review: this module is the
 * only one that composes a result stream, and `src/integrations/host-terminal.ts`
 * is the only one that touches a host handle. `src/cli-boundaries.test.ts`
 * asserts both absences over the source tree.
 *
 * Nothing here decides what a result *says*. Formats and rendering belong to
 * the format owners; this module moves bytes and reports whether they left.
 */

import {
  createRecordingOutputStream,
  createStaticInputStream,
  type EnvironmentPort,
  type FlushReport,
  type InputStreamPort,
  isCompleteFlush,
  type OutputStreamPort,
  type StreamWrite,
  type TerminalCapabilities,
  type TerminalOutcome,
  terminalCapabilities,
} from "../domain/index.ts";
import {
  createHostEnvironment,
  createHostInputStream,
  createHostOutputStream,
  observeHandles,
} from "../integrations/index.ts";

export type CliStreams = {
  /** The selected result format. Never a diagnostic, on any path. */
  readonly result: OutputStreamPort;
  /** Progress, warnings, and human notices. Never the result. */
  readonly diagnostic: OutputStreamPort;
  readonly input: InputStreamPort;
  readonly capabilities: TerminalCapabilities;
  /** Confirms both handles emptied. Called before the process is allowed to end. */
  flush(): Promise<StreamsFlushReport>;
  /**
   * Releases both handles.
   *
   * Paired with `flush`, and always after it: flushing confirms the bytes left,
   * releasing gives the host back what the ports were holding. A caller that
   * builds streams and never disposes them accumulates a listener per handle
   * on objects that live as long as the process.
   */
  dispose(): void;
};

export type StreamsFlushReport = {
  readonly result: FlushReport;
  readonly diagnostic: FlushReport;
  /** Every accepted byte was confirmed to have left. */
  readonly complete: boolean;
  /**
   * The reader went away and nothing else went wrong.
   *
   * A normal end: writing stops, stderr is not used to complain about a reader
   * that left, and the run keeps the exit code its work earned.
   */
  readonly readerLeft: boolean;
};

export type CliStreamsParts = {
  readonly result: OutputStreamPort;
  readonly diagnostic: OutputStreamPort;
  readonly input: InputStreamPort;
  readonly capabilities: TerminalCapabilities;
};

/** Composes a `CliStreams` over ports a caller already holds. */
export function createCliStreams(parts: CliStreamsParts): CliStreams {
  return {
    result: parts.result,
    diagnostic: parts.diagnostic,
    input: parts.input,
    capabilities: parts.capabilities,

    async flush(): Promise<StreamsFlushReport> {
      // The result first: it is the one a consumer is waiting on, and a
      // diagnostic handle that hangs must not delay it.
      const result = await parts.result.flush();
      const diagnostic = await parts.diagnostic.flush();
      return {
        result,
        diagnostic,
        complete: isCompleteFlush(result) && isCompleteFlush(diagnostic),
        readerLeft:
          (result.status === "closed" || diagnostic.status === "closed") &&
          result.status !== "failed" &&
          diagnostic.status !== "failed",
      };
    },

    dispose(): void {
      // Both, unconditionally. A throw from one release must not strand the
      // other, and each port's own `dispose` is safe to call more than once.
      parts.result.dispose();
      parts.diagnostic.dispose();
    },
  };
}

export type HostCliStreamsOptions = {
  /** Supplied by tests so capability never derives from the developer's shell. */
  readonly environment?: EnvironmentPort;
  /** Bytes to read from stdin before the input is reported as over the bound. */
  readonly maxInputBytes?: number;
};

/** Composes a `CliStreams` over this process's real handles. */
export function createHostCliStreams(options: HostCliStreamsOptions = {}): CliStreams {
  const environment = options.environment ?? createHostEnvironment();
  return createCliStreams({
    result: createHostOutputStream({ handle: "stdout" }),
    diagnostic: createHostOutputStream({ handle: "stderr" }),
    input: createHostInputStream(
      options.maxInputBytes === undefined ? {} : { maxBytes: options.maxInputBytes },
    ),
    capabilities: terminalCapabilities(observeHandles(), environment),
  });
}

/** The capability of a run with nothing attached to any handle. */
export const DETACHED_CAPABILITIES: TerminalCapabilities = {
  stdout: { isTty: false, columns: null, rows: null, color: "none" },
  stderr: { isTty: false, columns: null, rows: null, color: "none" },
  stdin: { isTty: false },
};

export type RecordedCliStreams = CliStreams & {
  /** Everything stdout accepted, in order. */
  resultWrites(): readonly string[];
  /** Everything stderr accepted, in order. */
  diagnosticWrites(): readonly string[];
};

export type RecordingCliStreamsOptions = {
  readonly capabilities?: TerminalCapabilities;
  readonly stdin?: Uint8Array | string | null;
  /** Bytes stdout accepts before the reader is treated as gone. */
  readonly closeResultAfterBytes?: number;
  readonly failResultFlush?: boolean;
};

/**
 * A `CliStreams` that records instead of writing.
 *
 * The double exists so stdout purity is proven by reading back what was written
 * rather than asserted in a comment.
 */
export function createRecordingCliStreams(
  options: RecordingCliStreamsOptions = {},
): RecordedCliStreams {
  const result = createRecordingOutputStream({
    ...(options.closeResultAfterBytes === undefined
      ? {}
      : { closeAfterBytes: options.closeResultAfterBytes }),
    ...(options.failResultFlush === undefined ? {} : { failFlush: options.failResultFlush }),
  });
  const diagnostic = createRecordingOutputStream();
  const streams = createCliStreams({
    result,
    diagnostic,
    input: createStaticInputStream({ content: options.stdin ?? null }),
    capabilities: options.capabilities ?? DETACHED_CAPABILITIES,
  });

  return {
    ...streams,
    resultWrites: () => result.writes(),
    diagnosticWrites: () => diagnostic.writes(),
  };
}

const ENCODER = new TextEncoder();

/** Writes one newline-terminated record to the selected result format. */
export function writeResultLine(streams: CliStreams, line: string): StreamWrite {
  return streams.result.write(ENCODER.encode(`${line}\n`));
}

/** Writes one newline-terminated notice to the diagnostic handle. */
export function writeDiagnosticLine(streams: CliStreams, line: string): StreamWrite {
  return streams.diagnostic.write(ENCODER.encode(`${line}\n`));
}

/**
 * The outcome a run ends with once its output has been flushed.
 *
 * A flush that *failed* means the result may not have reached anyone, and a run
 * cannot claim it completed on the strength of bytes it was still holding — the
 * effect on the consumer is exactly `uncertain`. A reader that *left* is a
 * different fact and changes nothing: the consumer stopped listening on
 * purpose, and `falryn ... | head -1` must stay an ordinary success.
 */
export function outcomeAfterFlush(
  outcome: TerminalOutcome,
  flush: StreamsFlushReport,
): TerminalOutcome {
  if (flush.complete || flush.readerLeft) {
    return outcome;
  }
  return { kind: "uncertain", effect: "uncertain" };
}
