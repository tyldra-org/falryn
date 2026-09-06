import { describe, expect, test } from "bun:test";

import { formatCurlResponse } from "./response.ts";

describe("Hush curl response formatting", () => {
  test("keeps every status, header value, and JSON body value", () => {
    const formatted = formatCurlResponse(
      [
        "HTTP/2 200",
        "content-type: application/json",
        'etag: "falryn-736"',
        "x-request-id: req-784",
        "",
        "{",
        '  "status": "ready",',
        '  "nested": { "reducers": 82 }',
        "}",
        "",
      ].join("\r\n"),
    );
    expect(formatted).toBe(
      'HTTP/2 200\ncontent-type:application/json\netag:"falryn-736"\nx-request-id:req-784\n{"status":"ready","nested":{"reducers":82}}',
    );
  });

  test("keeps every response in a redirect or proxy chain", () => {
    const formatted = formatCurlResponse(
      [
        "HTTP/1.1 200 Connection established",
        "proxy-agent: falryn-proxy",
        "",
        "HTTP/2 302 Found",
        "location: https://cdn.example.test/final",
        "x-request-id: req-736",
        "",
        "HTTP/2 200 OK",
        "content-type: text/plain",
        "",
        "ready",
      ].join("\r\n"),
    );
    expect(formatted).toContain("HTTP/1.1 200 Connection established");
    expect(formatted).toContain("proxy-agent:falryn-proxy");
    expect(formatted).toContain("HTTP/2 302 Found");
    expect(formatted).toContain("location:https://cdn.example.test/final");
    expect(formatted).toContain("HTTP/2 200 OK");
    expect(formatted).toContain("ready");
  });

  test("declines malformed or folded headers instead of guessing", () => {
    expect(formatCurlResponse("ready\n")).toBeNull();
    expect(formatCurlResponse("HTTP/20 200\n\nready\n")).toBeNull();
    expect(formatCurlResponse("HTTP/2 200\n folded\n\nready\n")).toBeNull();
  });
});
