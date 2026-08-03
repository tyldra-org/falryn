import { describe, expect, test } from "bun:test";

import { createStaticEnvironment } from "./environment.ts";
import {
  colorLevelFor,
  createRecordingOutputStream,
  createStaticInputStream,
  DEFAULT_STDIN_MAX_BYTES,
  DETACHED_HANDLE,
  decodeStdin,
  isCompleteFlush,
  isReadableBound,
  MAX_STDIN_BYTES,
  MAX_STREAM_WRITE_BYTES,
  MAX_TERMINAL_COLUMNS,
  symbolSupportFor,
  terminalCapabilities,
  terminalSize,
} from "./terminal.ts";

const TTY: Parameters<typeof colorLevelFor>[0] = { isTty: true, columns: 120, rows: 40 };

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("an output stream", () => {
  test("reports acceptance, and only a flush reports delivery", async () => {
    const stream = createRecordingOutputStream();

    const write = stream.write(bytes("one\n"));
    expect(write).toEqual({ status: "accepted", accepted: 4, pending: 4 });
    // Written is not landed. Until a flush says so, the bytes are the process's.
    expect(stream.flushed()).toEqual([]);

    const report = await stream.flush();
    expect(report).toEqual({ status: "flushed", flushed: 4, pending: 0, detail: null });
    expect(isCompleteFlush(report)).toBe(true);
    expect(stream.flushed()).toEqual(["one\n"]);
  });

  test("keeps writes in the order they were made", () => {
    const stream = createRecordingOutputStream();
    for (const line of ["a", "b", "c"]) {
      stream.write(bytes(line));
    }
    expect(stream.writes()).toEqual(["a", "b", "c"]);
    expect(stream.text()).toBe("abc");
  });

  test("refuses a write past the declared bound rather than splitting it", () => {
    const stream = createRecordingOutputStream();
    const oversized = new Uint8Array(MAX_STREAM_WRITE_BYTES + 1);

    expect(stream.write(oversized)).toEqual({ status: "too-large", accepted: 0, pending: 0 });
    // Nothing partial landed: a caller that saw half its record emitted would
    // have no way to tell which half.
    expect(stream.writes()).toEqual([]);
  });

  test("stops accepting once the reader has gone", async () => {
    // `head -1` in miniature: the first record lands, the second does not.
    const stream = createRecordingOutputStream({ closeAfterBytes: 4 });

    expect(stream.write(bytes("one\n")).status).toBe("accepted");
    expect(stream.write(bytes("two\n")).status).toBe("closed");
    expect(stream.isClosed()).toBe(true);
    expect(stream.writes()).toEqual(["one\n"]);

    const report = await stream.flush();
    expect(report.status).toBe("closed");
    expect(isCompleteFlush(report)).toBe(false);
  });

  test("reports a flush that could not complete rather than assuming it did", async () => {
    const stream = createRecordingOutputStream({ failFlush: true });
    stream.write(bytes("result\n"));

    const report = await stream.flush();
    expect(report.status).toBe("failed");
    expect(report.pending).toBe(7);
    expect(isCompleteFlush(report)).toBe(false);
  });
});

describe("stdin", () => {
  test("distinguishes closed-with-nothing from not-connected-at-all", async () => {
    const empty = await createStaticInputStream({ content: "" }).read();
    const absent = await createStaticInputStream({ content: null }).read();

    expect(empty.ok && empty.value).toEqual({ kind: "empty" });
    expect(absent.ok && absent.value).toEqual({ kind: "not-connected" });
  });

  test("reads text to the declared bound", async () => {
    const input = createStaticInputStream({ content: "hello" });

    expect(input.encoding).toBe("utf-8");
    expect(input.maxBytes).toBe(DEFAULT_STDIN_MAX_BYTES);
    const read = await input.read();
    expect(read.ok && read.value).toEqual({ kind: "text", text: "hello", bytes: 5 });
  });

  test("reports an over-bound read as invalid input rather than truncating it", async () => {
    const read = await createStaticInputStream({ content: "abcdef", maxBytes: 3 }).read();

    expect(read.ok).toBe(false);
    // Truncation would hand a caller a valid-looking prefix of input it never
    // agreed to process.
    expect(!read.ok && read.error).toEqual({ code: "too-large", maxBytes: 3 });
  });

  test("accepts input that is exactly the bound", async () => {
    const read = await createStaticInputStream({ content: "abc", maxBytes: 3 }).read();
    expect(read.ok && read.value).toEqual({ kind: "text", text: "abc", bytes: 3 });
  });

  test("rejects bytes that are not the declared encoding", async () => {
    // A lone continuation byte: valid as bytes, not valid as UTF-8.
    const read = await createStaticInputStream({ content: new Uint8Array([0x41, 0x80]) }).read();

    expect(!read.ok && read.error).toEqual({ code: "invalid-encoding" });
  });

  test("checks the bound before the encoding", async () => {
    // Over-long invalid bytes are over-long. Decoding first would report the
    // wrong failure and send the caller to fix the wrong thing.
    const read = decodeStdin(new Uint8Array([0x80, 0x80, 0x80]), 2);
    expect(!read.ok && read.error).toEqual({ code: "too-large", maxBytes: 2 });
  });

  test("reports an unreadable handle separately from an empty one", async () => {
    const read = await createStaticInputStream({ content: "", unreadable: "EIO" }).read();
    expect(!read.ok && read.error).toEqual({ code: "unreadable", detail: "EIO" });
  });

  test("names the bounds it is willing to read to", () => {
    expect(isReadableBound(0)).toBe(false);
    expect(isReadableBound(-1)).toBe(false);
    expect(isReadableBound(1.5)).toBe(false);
    expect(isReadableBound(DEFAULT_STDIN_MAX_BYTES)).toBe(true);
    expect(isReadableBound(MAX_STDIN_BYTES)).toBe(true);
    expect(isReadableBound(MAX_STDIN_BYTES + 1)).toBe(false);
  });
});

describe("terminal size", () => {
  test("is absent rather than defaulted when the handle reports none", () => {
    expect(terminalSize(undefined)).toBeNull();
    expect(terminalSize(null)).toBeNull();
    expect(terminalSize(0)).toBeNull();
    expect(terminalSize(MAX_TERMINAL_COLUMNS + 1)).toBeNull();
    expect(terminalSize(80)).toBe(80);
  });

  test("never turns a non-TTY into a narrow terminal", () => {
    const capabilities = terminalCapabilities(
      { stdout: DETACHED_HANDLE, stderr: DETACHED_HANDLE, stdin: { isTty: false } },
      createStaticEnvironment(),
    );

    // Absent, not 80. Every layout decision taken from a substituted width is a
    // decision about a terminal that does not exist.
    expect(capabilities.stdout.columns).toBeNull();
    expect(capabilities.stdout.rows).toBeNull();
    expect(capabilities.stdout.isTty).toBe(false);
  });
});

describe("colour", () => {
  test("is absent on a handle that is not a terminal", () => {
    expect(colorLevelFor(DETACHED_HANDLE, createStaticEnvironment({ TERM: "xterm" }))).toBe("none");
  });

  test("derives depth from what a terminal advertises", () => {
    expect(colorLevelFor(TTY, createStaticEnvironment({ TERM: "xterm" }))).toBe("basic");
    expect(colorLevelFor(TTY, createStaticEnvironment({ TERM: "xterm-256color" }))).toBe("ansi256");
    expect(
      colorLevelFor(
        TTY,
        createStaticEnvironment({ TERM: "xterm-256color", COLORTERM: "truecolor" }),
      ),
    ).toBe("truecolor");
    expect(colorLevelFor(TTY, createStaticEnvironment({ TERM: "xterm", COLORTERM: "24bit" }))).toBe(
      "truecolor",
    );
    // A terminal that advertises nothing at all is not assumed to have colour.
    expect(colorLevelFor(TTY, createStaticEnvironment())).toBe("none");
  });

  test("is refused by NO_COLOR whatever else is set", () => {
    for (const environment of [
      createStaticEnvironment({ NO_COLOR: "1", TERM: "xterm-256color" }),
      createStaticEnvironment({ NO_COLOR: "anything", COLORTERM: "truecolor" }),
      // The refusal outranks the request. A caller that wants colour anyway
      // overrides the fact at the command surface, not here.
      createStaticEnvironment({ NO_COLOR: "1", FORCE_COLOR: "3" }),
    ]) {
      expect(colorLevelFor(TTY, environment)).toBe("none");
    }
  });

  test("treats an exported-but-empty NO_COLOR as unset", () => {
    // `EnvironmentPort` reads an empty value as unset, and the published
    // NO_COLOR convention says the same: a variable exported without a value is
    // what a shell produces for `export NO_COLOR=`, not a refusal.
    expect(colorLevelFor(TTY, createStaticEnvironment({ NO_COLOR: "", TERM: "xterm" }))).toBe(
      "basic",
    );
  });

  test("is refused by TERM=dumb even on a terminal", () => {
    expect(colorLevelFor(TTY, createStaticEnvironment({ TERM: "dumb" }))).toBe("none");
    expect(
      colorLevelFor(TTY, createStaticEnvironment({ TERM: "dumb", COLORTERM: "truecolor" })),
    ).toBe("none");
  });

  test("is granted by FORCE_COLOR even when the handle is not a terminal", () => {
    // The conflicting case the issue names: a piped stdout with colour asked
    // for. A request against a pipe is legitimate — the pipe may be a pager.
    expect(colorLevelFor(DETACHED_HANDLE, createStaticEnvironment({ FORCE_COLOR: "1" }))).toBe(
      "basic",
    );
    expect(colorLevelFor(DETACHED_HANDLE, createStaticEnvironment({ FORCE_COLOR: "2" }))).toBe(
      "ansi256",
    );
    expect(colorLevelFor(DETACHED_HANDLE, createStaticEnvironment({ FORCE_COLOR: "3" }))).toBe(
      "truecolor",
    );
    expect(colorLevelFor(TTY, createStaticEnvironment({ FORCE_COLOR: "0" }))).toBe("none");
    expect(colorLevelFor(TTY, createStaticEnvironment({ FORCE_COLOR: "false" }))).toBe("none");
    // A request with no depth resolves to the depth every colour terminal has.
    expect(colorLevelFor(DETACHED_HANDLE, createStaticEnvironment({ FORCE_COLOR: "yes" }))).toBe(
      "basic",
    );
  });

  test("is derived per handle, not once for the process", () => {
    // The common CI shape: a captured stdout and a terminal stderr. A renderer
    // keying colour off the wrong handle would put escapes into the capture.
    const capabilities = terminalCapabilities(
      {
        stdout: DETACHED_HANDLE,
        stderr: { isTty: true, columns: 100, rows: 30 },
        stdin: { isTty: false },
      },
      createStaticEnvironment({ TERM: "xterm-256color" }),
    );

    expect(capabilities.stdout.color).toBe("none");
    expect(capabilities.stderr.color).toBe("ansi256");
    expect(capabilities.stderr.columns).toBe(100);
  });

  test("is derived per handle in the reverse shape too", () => {
    const capabilities = terminalCapabilities(
      {
        stdout: { isTty: true, columns: 100, rows: 30 },
        stderr: DETACHED_HANDLE,
        stdin: { isTty: true },
      },
      createStaticEnvironment({ TERM: "xterm-256color" }),
    );

    expect(capabilities.stdout.color).toBe("ansi256");
    expect(capabilities.stderr.color).toBe("none");
    expect(capabilities.stdin.isTty).toBe(true);
  });
});

describe("symbol support", () => {
  test("is Unicode when nothing in the environment says otherwise", () => {
    expect(symbolSupportFor(createStaticEnvironment())).toBe("unicode");
    expect(symbolSupportFor(createStaticEnvironment({ TERM: "xterm-256color" }))).toBe("unicode");
  });

  test("is ASCII on a terminal that said it renders nothing else", () => {
    expect(symbolSupportFor(createStaticEnvironment({ TERM: "dumb" }))).toBe("ascii");
    // Outranks a UTF-8 locale: the terminal is the thing that has to draw it.
    expect(symbolSupportFor(createStaticEnvironment({ TERM: "dumb", LANG: "en_US.UTF-8" }))).toBe(
      "ascii",
    );
  });

  test("is Unicode for a UTF-8 locale, however it is spelled", () => {
    for (const value of ["en_US.UTF-8", "en_US.utf8", "C.UTF-8", "de_DE.UTF-8@euro"]) {
      expect(symbolSupportFor(createStaticEnvironment({ LANG: value }))).toBe("unicode");
    }
  });

  test("is ASCII for a locale that names a charset that is not UTF-8", () => {
    expect(symbolSupportFor(createStaticEnvironment({ LANG: "en_US.ISO-8859-1" }))).toBe("ascii");
    expect(symbolSupportFor(createStaticEnvironment({ LC_CTYPE: "ja_JP.eucJP" }))).toBe("ascii");
  });

  test("reads LC_ALL, then LC_CTYPE, then LANG", () => {
    expect(
      symbolSupportFor(
        createStaticEnvironment({ LC_ALL: "en_US.ISO-8859-1", LANG: "en_US.UTF-8" }),
      ),
    ).toBe("ascii");
    expect(
      symbolSupportFor(
        createStaticEnvironment({ LC_CTYPE: "en_US.ISO-8859-1", LANG: "en_US.UTF-8" }),
      ),
    ).toBe("ascii");
    expect(
      symbolSupportFor(
        createStaticEnvironment({ LC_ALL: "en_US.UTF-8", LC_CTYPE: "en_US.ISO-8859-1" }),
      ),
    ).toBe("unicode");
  });

  test("takes a locale that names no charset as saying nothing about the repertoire", () => {
    // `C` and `en_US` name a locale, not an encoding. Lowering the repertoire
    // on them would drop symbols for an environment that never refused them.
    expect(symbolSupportFor(createStaticEnvironment({ LANG: "C" }))).toBe("unicode");
    expect(symbolSupportFor(createStaticEnvironment({ LC_ALL: "en_US" }))).toBe("unicode");
  });

  test("is a process fact carried on every handle", () => {
    const capabilities = terminalCapabilities(
      {
        stdout: { isTty: true, columns: 100, rows: 30 },
        stderr: DETACHED_HANDLE,
        stdin: { isTty: false },
      },
      createStaticEnvironment({ LANG: "en_US.ISO-8859-1" }),
    );

    expect(capabilities.stdout.symbols).toBe("ascii");
    expect(capabilities.stderr.symbols).toBe("ascii");
  });

  test("is independent of colour in both directions", () => {
    // Losing decoration and losing a character repertoire are different losses.
    const noColour = terminalCapabilities(
      {
        stdout: { isTty: true, columns: 100, rows: 30 },
        stderr: DETACHED_HANDLE,
        stdin: { isTty: false },
      },
      createStaticEnvironment({ NO_COLOR: "1", TERM: "xterm-256color", LANG: "en_US.UTF-8" }),
    );
    expect(noColour.stdout.color).toBe("none");
    expect(noColour.stdout.symbols).toBe("unicode");

    const noSymbols = terminalCapabilities(
      {
        stdout: { isTty: true, columns: 100, rows: 30 },
        stderr: DETACHED_HANDLE,
        stdin: { isTty: false },
      },
      createStaticEnvironment({ TERM: "xterm-256color", LANG: "en_US.ISO-8859-1" }),
    );
    expect(noSymbols.stdout.color).toBe("ansi256");
    expect(noSymbols.stdout.symbols).toBe("ascii");
  });
});
