import { describe, expect, test } from "bun:test";

import { duration, instant, type ProcessCaptureReport, processCaptureId } from "../../../index.ts";
import { packageProjection } from "./projection.ts";

describe("Hush package projection", () => {
  test("dispatches npm, pnpm, yarn, npx, and pnpx through command-aware formats", () => {
    const cases = [
      {
        tokens: ["npm", "install"],
        source: "added 2 packages, and audited 3 packages in 1s\nfound 0 vulnerabilities\n",
        marker: "packages +2; audited 3; 1s\nvulnerabilities 0",
      },
      {
        tokens: ["pnpm", "install"],
        source: "Packages: +1\ndependencies:\n+ zod 4.0.0\nDone in 1s using pnpm v11\n",
        marker: "+1 packages\nprod zod 4.0.0",
      },
      {
        tokens: ["yarn", "run", "verify"],
        source: "yarn run v1.22.22\n$ node verify.mjs\nverified\nDone in 0.2s.\n",
        marker: "node verify.mjs\nverified",
      },
      {
        tokens: ["npx", "package-audit"],
        source: "checking\nchecking\nchecking\nverified\n",
        marker: "checking ×3\nverified",
      },
      {
        tokens: ["pnpx", "package-audit"],
        source: "checking\nchecking\nchecking\nverified\n",
        marker: "checking ×3\nverified",
      },
    ] as const;
    for (const [index, fixture] of cases.entries()) {
      expect(
        packageProjection(capture(`package-${index}`, fixture.source), 10_000, [], fixture.tokens)
          .text,
      ).toBe(fixture.marker);
    }
  });

  test("uses exact fallback for failures, machine output, patterns, and unfamiliar output", () => {
    const source = "npm WARN registry unavailable\nraw details\n";
    expect(
      packageProjection(capture("failure", source, 1), 10_000, [], ["npm", "install"]).text,
    ).toBe(source);
    expect(
      packageProjection(capture("json", source), 10_000, [], ["npm", "list", "--json"]).text,
    ).toBe(source);
    expect(
      packageProjection(capture("pattern", source), 10_000, ["WARN"], ["npm", "install"]).text,
    ).toBe(source);
    expect(packageProjection(capture("unknown", source), 10_000, [], ["npm", "doctor"]).text).toBe(
      source,
    );
  });
});

function capture(id: string, stdout: string, exitCode = 0): ProcessCaptureReport {
  return {
    captureId: processCaptureId.from(id),
    pid: 1,
    startedAt: instant(1),
    endedAt: instant(2),
    durationMs: duration(1),
    stop: { kind: "exited" },
    killStage: "none",
    exit: { exitCode, signal: null },
    stdout: stream("stdout", stdout),
    stderr: stream("stderr", ""),
    events: [],
  };
}

function stream(name: "stdout" | "stderr", text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    stream: name,
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
