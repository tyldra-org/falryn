import { describe, expect, test } from "bun:test";
import {
  parseBreakpointsResponse,
  parseStackTraceResponse,
  parseThreadsResponse,
  validateSetBreakpointsRequest,
} from "./debug-adapter-session.ts";

describe("debug-adapter session contracts", () => {
  test("validates breakpoint requests and parses DAP bodies", () => {
    expect(
      validateSetBreakpointsRequest({
        sourcePath: "src/a.ts",
        breakpoints: [{ line: 10, column: 2 }],
      }),
    ).toBeNull();
    expect(
      validateSetBreakpointsRequest({
        sourcePath: "",
        breakpoints: [{ line: 1 }],
      }),
    ).toMatchObject({ reason: "invalid-source" });

    expect(
      parseBreakpointsResponse("src/a.ts", 3, {
        breakpoints: [{ id: 1, verified: true, line: 10, column: 2 }],
      }),
    ).toEqual({
      ok: true,
      value: {
        sourcePath: "src/a.ts",
        revision: 3,
        breakpoints: [{ id: 1, verified: true, line: 10, column: 2, message: null }],
      },
    });

    expect(parseThreadsResponse({ threads: [{ id: 1, name: "main" }] })).toEqual({
      ok: true,
      value: [{ id: 1, name: "main" }],
    });

    expect(
      parseStackTraceResponse({
        stackFrames: [
          {
            id: 7,
            name: "foo",
            line: 12,
            column: 1,
            source: { path: "/tmp/a.ts" },
          },
        ],
      }),
    ).toEqual({
      ok: true,
      value: [
        {
          id: 7,
          name: "foo",
          line: 12,
          column: 1,
          sourcePath: "/tmp/a.ts",
        },
      ],
    });
  });
});
