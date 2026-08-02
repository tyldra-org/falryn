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
import { createHostInputStream, observeHandles } from "./host-terminal.ts";

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
