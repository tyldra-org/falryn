import { describe, expect, test } from "bun:test";

import { formatNetworkOutput } from "./format.ts";

describe("Hush network dispatch", () => {
  test("minifies complete SSH JSON without dropping nested values", () => {
    expect(
      formatNetworkOutput(
        JSON.stringify(
          { host: "example.test", status: "ready", nested: { reducers: 82 } },
          null,
          2,
        ),
        ["ssh", "example.test", "falryn", "status", "--json"],
      ),
    ).toBe('{"host":"example.test","status":"ready","nested":{"reducers":82}}');
  });

  test("keeps ordinary SSH text exact when no safe reduction wins", () => {
    const source = "connected example.test\nremote command: ok\n";
    expect(formatNetworkOutput(source, ["ssh", "example.test", "echo", "connected"])).toBe(source);
  });
});
