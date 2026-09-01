import { describe, expect, test } from "bun:test";

import { duration, instant } from "../../../clock.ts";
import { processCaptureId } from "../../../identity.ts";
import type { ProcessCaptureReport } from "../../../process-capture.ts";
import { compoundProjection } from "./reduce.ts";

describe("Hush compound reducer", () => {
  test("compacts search blocks across a pipeline while retaining transformed output", () => {
    const source = [
      "src/a.ts:10:first marker",
      "src/a.ts:20:second marker",
      "# exact sed output",
      "src/b.ts:7:third marker",
      "src/b.ts:8:fourth marker",
    ].join("\n");
    const projected = compoundProjection(
      report(source),
      64 * 1_024,
      [],
      [
        ["rg", "marker", "."],
        ["sed", "-n", "1,20p"],
      ],
    );
    expect(projected.text).toContain("src/a.ts:\n  10 first marker\n  20 second marker");
    expect(projected.text).toContain("# exact sed output");
    expect(projected.text).toContain("src/b.ts:\n  7 third marker\n  8 fourth marker");
    expect(projected.omissions).toEqual([]);
  });

  test("preserves arbitrary sed output exactly", () => {
    const source = "first transformed line\nsecond transformed line\n";
    const projected = compoundProjection(
      report(source),
      64 * 1_024,
      [],
      [
        ["cat", "fixture.txt"],
        ["sed", "-n", "1,2p"],
      ],
    );
    expect(projected.text).toBe(source);
    expect(projected.omissions).toEqual([]);
  });

  test("preserves failures and caller-pattern requests exactly", () => {
    const source = "src/a.ts:10:partial marker\n";
    expect(
      compoundProjection(
        report(source, "sed: invalid command\n", 1),
        64 * 1_024,
        [],
        [
          ["rg", "marker", "."],
          ["sed", "bad"],
        ],
      ).text,
    ).toBe(`${source}\nstderr:\nsed: invalid command\n`);
    expect(
      compoundProjection(report(source), 64 * 1_024, ["partial"], [["rg", "marker", "."]]).text,
    ).toBe(source);
  });
});

function report(stdout: string, stderr = "", exitCode = 0): ProcessCaptureReport {
  return {
    captureId: processCaptureId.from("compound-test"),
    pid: 42,
    startedAt: instant(1),
    endedAt: instant(2),
    durationMs: duration(1),
    stop: { kind: "exited" },
    killStage: "none",
    exit: { exitCode, signal: null },
    stdout: stream("stdout", stdout),
    stderr: stream("stderr", stderr),
    events: [],
  };
}

function stream(stream: "stdout" | "stderr", text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    stream,
    byteCount: bytes.byteLength,
    inlineBytes: bytes,
    inlineText: text,
    encoding: "utf-8" as const,
    truncated: false,
    omittedBytes: 0,
    maxLineExceeded: false,
    artifact: null,
  };
}
