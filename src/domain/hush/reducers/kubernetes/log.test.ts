import { describe, expect, test } from "bun:test";

import { formatKubernetesLogOutput } from "./log.ts";

describe("Hush Kubernetes log formatting", () => {
  test("factors repeated ISO dates while preserving every timestamp and message", () => {
    const formatted = formatKubernetesLogOutput(
      [
        "2026-08-25T12:00:00.001Z service started",
        "2026-08-25T12:00:01.125Z request=req-736 status=ok",
        "2026-08-25T12:00:02.250Z request=req-784 status=ok",
      ].join("\n"),
    );
    expect(formatted).toBe(
      [
        "2026-08-25Z",
        "12:00:00.001 service started",
        "12:00:01.125 request=req-736 status=ok",
        "12:00:02.250 request=req-784 status=ok",
      ].join("\n"),
    );
  });

  test("factors source prefixes without changing interleaved pod order", () => {
    const formatted = formatKubernetesLogOutput(
      [
        "[pod/api/container/falryn] 2026-08-25T12:00:00Z started",
        "[pod/api/container/falryn] 2026-08-25T12:00:01Z request=req-736",
        "[pod/worker/container/falryn] 2026-08-25T12:00:02Z ready",
        "[pod/api/container/falryn] 2026-08-25T12:00:03Z request=req-784",
      ].join("\n"),
    );
    expect(formatted).toBe(
      [
        "[pod/api/container/falryn] 2026-08-25Z",
        "12:00:00 started",
        "12:00:01 request=req-736",
        "[pod/worker/container/falryn] 2026-08-25Z",
        "12:00:02 ready",
        "[pod/api/container/falryn] 2026-08-25Z",
        "12:00:03 request=req-784",
      ].join("\n"),
    );
  });

  test("keeps every log record without deduplication or an item cap", () => {
    const source = Array.from({ length: 80 }, (_, index) => {
      const minute = Math.floor(index / 60);
      const second = index % 60;
      return `2026-08-25T12:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z event=${index}`;
    }).join("\n");
    const formatted = formatKubernetesLogOutput(source);
    expect(formatted).toContain("event=0");
    expect(formatted).toContain("event=79");
    expect(formatted).not.toContain("omitted");
  });

  test("declines arbitrary application-owned output", () => {
    expect(formatKubernetesLogOutput("ready\nready\nrequest=req-736 status=ok")).toBeNull();
  });
});
