import { describe, expect, test } from "bun:test";

import { formatContainerLogOutput } from "./log.ts";

describe("Hush container log formatting", () => {
  test("factors repeated ISO date and zone while preserving every timestamp and message", () => {
    const formatted = formatContainerLogOutput(
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

  test("groups compose services without changing interleaved order", () => {
    const formatted = formatContainerLogOutput(
      [
        "api     | 2026-08-25T12:00:00Z listening port=3000",
        "api     | 2026-08-25T12:00:01Z request=req-736",
        "db      | 2026-08-25T12:00:02Z ready",
        "api     | 2026-08-25T12:00:03Z request=req-784",
      ].join("\n"),
    );
    expect(formatted).toBe(
      [
        "[api] 2026-08-25Z",
        "12:00:00 listening port=3000",
        "12:00:01 request=req-736",
        "[db] 2026-08-25Z",
        "12:00:02 ready",
        "[api] 2026-08-25Z",
        "12:00:03 request=req-784",
      ].join("\n"),
    );
  });

  test("keeps every log record without an item cap", () => {
    const source = Array.from({ length: 80 }, (_, index) => {
      const minute = Math.floor(index / 60);
      const second = index % 60;
      return `2026-08-25T12:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z event=${index}`;
    }).join("\n");
    const formatted = formatContainerLogOutput(source);
    expect(formatted).toContain("event=0");
    expect(formatted).toContain("event=79");
    expect(formatted).not.toContain("omitted");
  });

  test("declines arbitrary application-owned output", () => {
    expect(formatContainerLogOutput("application output\nsecond exact line")).toBeNull();
  });
});
