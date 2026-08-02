import { describe, expect, test } from "bun:test";

import {
  createRecordingOutputStream,
  createStaticEnvironment,
  createStaticInputStream,
  type TerminalOutcome,
  terminalCapabilities,
} from "../domain/index.ts";
import { EXIT_CODES, resolveExitCode } from "./exit.ts";
import {
  createCliStreams,
  createRecordingCliStreams,
  DETACHED_CAPABILITIES,
  outcomeAfterFlush,
  writeDiagnosticLine,
  writeResultLine,
} from "./streams.ts";

const COMPLETED: TerminalOutcome = { kind: "completed" };

describe("the two handles", () => {
  test("keep the result and the diagnostics apart", async () => {
    const streams = createRecordingCliStreams();

    writeResultLine(streams, `{"ok":true}`);
    writeDiagnosticLine(streams, "reading workspace…");
    writeDiagnosticLine(streams, "warning: nothing to do");

    // stdout carries the selected result format and nothing else. Read back
    // rather than asserted in a comment: that is what the double is for.
    expect(streams.resultWrites()).toEqual([`{"ok":true}\n`]);
    expect(streams.diagnosticWrites()).toEqual([
      "reading workspace…\n",
      "warning: nothing to do\n",
    ]);
    expect((await streams.flush()).complete).toBe(true);
  });

  test("keep human notices off stdout even when human is the result format", () => {
    const streams = createRecordingCliStreams();

    // The rule does not relax when a person is reading. `falryn ... | jq` and
    // the same command in a terminal have to produce the same stdout.
    writeDiagnosticLine(streams, "Working on it…");
    writeResultLine(streams, "Done: 3 files changed");

    expect(streams.resultWrites()).toEqual(["Done: 3 files changed\n"]);
    expect(streams.diagnosticWrites()).toEqual(["Working on it…\n"]);
  });
});

describe("a flush", () => {
  test("reports both handles and whether everything left", async () => {
    const streams = createRecordingCliStreams();
    writeResultLine(streams, "one");
    writeDiagnosticLine(streams, "note");

    const report = await streams.flush();
    expect(report.result.status).toBe("flushed");
    expect(report.diagnostic.status).toBe("flushed");
    expect(report.complete).toBe(true);
    expect(report.readerLeft).toBe(false);
  });

  test("reports a reader that left separately from a flush that failed", async () => {
    const departed = createRecordingCliStreams({ closeResultAfterBytes: 0 });
    // The reader's departure is discovered by writing to it, not by asking.
    expect(writeResultLine(departed, "one").status).toBe("closed");
    const closed = await departed.flush();
    expect(closed.readerLeft).toBe(true);
    expect(closed.complete).toBe(false);

    const failed = await createRecordingCliStreams({ failResultFlush: true }).flush();
    expect(failed.readerLeft).toBe(false);
    expect(failed.complete).toBe(false);
  });

  test("does not let a failed diagnostic flush read as a departed reader", async () => {
    const streams = createCliStreams({
      result: createRecordingOutputStream({ closeAfterBytes: 0 }),
      diagnostic: createRecordingOutputStream({ failFlush: true }),
      input: createStaticInputStream({ content: null }),
      capabilities: DETACHED_CAPABILITIES,
    });
    writeResultLine(streams, "one");

    const report = await streams.flush();
    expect(report.readerLeft).toBe(false);
    expect(report.complete).toBe(false);
  });
});

describe("the outcome a run ends with", () => {
  test("is unchanged when everything it wrote left the process", async () => {
    const streams = createRecordingCliStreams();
    writeResultLine(streams, "one");

    expect(outcomeAfterFlush(COMPLETED, await streams.flush())).toEqual(COMPLETED);
  });

  test("is unchanged when the reader simply left", async () => {
    // `falryn ... | head -1` is an ordinary success. The consumer stopped
    // listening on purpose and there is nothing to report about it.
    const streams = createRecordingCliStreams({ closeResultAfterBytes: 4 });
    writeResultLine(streams, "one");
    writeResultLine(streams, "two");

    const outcome = outcomeAfterFlush(COMPLETED, await streams.flush());
    expect(outcome).toEqual(COMPLETED);
    expect(resolveExitCode({ outcome })).toBe(EXIT_CODES.COMPLETED);
  });

  test("becomes uncertain when the result could not be flushed", async () => {
    // A run cannot claim it completed on the strength of bytes it was still
    // holding when it exited; the effect on the consumer is exactly uncertain.
    const streams = createRecordingCliStreams({ failResultFlush: true });
    writeResultLine(streams, "one");

    const outcome = outcomeAfterFlush(COMPLETED, await streams.flush());
    expect(outcome).toEqual({ kind: "uncertain", effect: "uncertain" });
    expect(resolveExitCode({ outcome })).toBe(EXIT_CODES.UNCERTAIN_EFFECT);
  });
});

describe("composed capability", () => {
  test("reaches the streams that were asked to carry the result", () => {
    const streams = createCliStreams({
      result: createRecordingOutputStream(),
      diagnostic: createRecordingOutputStream(),
      input: createStaticInputStream({ content: "piped" }),
      capabilities: terminalCapabilities(
        {
          stdout: { isTty: false, columns: null, rows: null },
          stderr: { isTty: true, columns: 100, rows: 30 },
          stdin: { isTty: false },
        },
        createStaticEnvironment({ TERM: "xterm-256color" }),
      ),
    });

    expect(streams.capabilities.stdout.color).toBe("none");
    expect(streams.capabilities.stderr.color).toBe("ansi256");
  });

  test("defaults the double to a run with nothing attached", async () => {
    const streams = createRecordingCliStreams();
    expect(streams.capabilities).toEqual(DETACHED_CAPABILITIES);
    // Nothing is attached, so a read is an immediate typed fact and not a wait.
    const read = await streams.input.read();
    expect(read.ok && read.value).toEqual({ kind: "not-connected" });
  });
});
