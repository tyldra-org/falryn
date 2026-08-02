/**
 * What the host adapter can be asserted about in-process.
 *
 * Writing to the real `process.stdout` from a test leaks into every test after
 * it, and reading the real `process.stdin` hangs, so the adapter's actual
 * behavior — EPIPE, flush, closed and absent stdin — is measured on spawned
 * processes in `src/cli/process-boundary.test.ts`. What is left here is what can
 * be observed without touching a handle: the bounds it refuses, and the shape
 * of the facts it reports.
 */

import { describe, expect, test } from "bun:test";

import {
  createStaticEnvironment,
  DEFAULT_STDIN_MAX_BYTES,
  MAX_STDIN_BYTES,
  terminalCapabilities,
} from "../domain/index.ts";
import { createHostInputStream, createHostOutputStream, observeHandles } from "./host-terminal.ts";

describe("the input stream", () => {
  test("declares the encoding and bound it reads to", () => {
    const input = createHostInputStream();
    expect(input.encoding).toBe("utf-8");
    expect(input.maxBytes).toBe(DEFAULT_STDIN_MAX_BYTES);
    expect(createHostInputStream({ maxBytes: 64 }).maxBytes).toBe(64);
  });

  test("refuses a bound it is not willing to read to", () => {
    // A caller asking for an unbounded read has a defect, and accepting it
    // would make the declared maximum a suggestion.
    expect(() => createHostInputStream({ maxBytes: 0 })).toThrow(RangeError);
    expect(() => createHostInputStream({ maxBytes: -1 })).toThrow(RangeError);
    expect(() => createHostInputStream({ maxBytes: MAX_STDIN_BYTES + 1 })).toThrow(RangeError);
  });
});

describe("the output stream", () => {
  test("releases its host listener, and releasing twice removes nothing extra", () => {
    // The handle outlives the port: `process.stdout` is one object for the
    // whole process, so a listener nobody removes accumulates once per port
    // ever built. Twelve undisposed ports already trip Node's leak warning.
    // This mirrors `process-signals.test.ts`, because both adapters attach to
    // something that is not theirs to keep.
    const before = process.stdout.listenerCount("error");

    const streams = Array.from({ length: 8 }, () => createHostOutputStream({ handle: "stdout" }));
    expect(process.stdout.listenerCount("error")).toBe(before + 8);

    for (const stream of streams) {
      stream.dispose();
      stream.dispose();
    }
    expect(process.stdout.listenerCount("error")).toBe(before);
  });

  test("releases each handle independently", () => {
    const beforeOut = process.stdout.listenerCount("error");
    const beforeErr = process.stderr.listenerCount("error");

    const out = createHostOutputStream({ handle: "stdout" });
    const errors = createHostOutputStream({ handle: "stderr" });
    out.dispose();

    // Disposing one must not detach the other, the same guarantee
    // `SignalPort` gives two independent subscribers.
    expect(process.stdout.listenerCount("error")).toBe(beforeOut);
    expect(process.stderr.listenerCount("error")).toBe(beforeErr + 1);

    errors.dispose();
    expect(process.stderr.listenerCount("error")).toBe(beforeErr);
  });
});

describe("observed handles", () => {
  test("report a size only for a handle that is a terminal", () => {
    const handles = observeHandles();

    for (const handle of [handles.stdout, handles.stderr]) {
      if (handle.isTty) {
        expect(handle.columns === null || handle.columns > 0).toBe(true);
      } else {
        // Absent, not defaulted. A pipe reporting a width would be describing
        // the terminal its reader happens to sit in.
        expect(handle.columns).toBeNull();
        expect(handle.rows).toBeNull();
      }
    }
  });

  test("compose into capability without consulting the developer's own shell", () => {
    // The environment is supplied, so a maintainer running this under
    // `NO_COLOR` does not change what it asserts.
    const capabilities = terminalCapabilities(
      observeHandles(),
      createStaticEnvironment({ NO_COLOR: "1", TERM: "xterm-256color" }),
    );

    expect(capabilities.stdout.color).toBe("none");
    expect(capabilities.stderr.color).toBe("none");
  });
});
