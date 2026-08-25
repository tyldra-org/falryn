import { describe, expect, test } from "bun:test";

import { duration, instant, type ProcessCaptureReport, processCaptureId } from "../../../index.ts";
import { packageProjection } from "./projection.ts";

describe("Hush package projection", () => {
  test("dispatches package managers and runners through command-aware formats", () => {
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
        tokens: ["bun", "install"],
        source: [
          "bun install v1.4.0 (0aa2b1cd)",
          "Resolved, downloaded and extracted [2]",
          "+ zod@4.0.0",
          "2 packages installed [18.00ms]",
          "",
        ].join("\n"),
        marker:
          "bun install v1.4.0 (0aa2b1cd)\nresolved/downloaded/extracted 2\n+ zod@4.0.0\ninstalled 2 packages [18.00ms]",
      },
      {
        tokens: ["bun", "run", "verify"],
        source: "$ bun run verify.mjs\nchecking\nchecking\nchecking\nverified\n",
        marker: "bun run verify.mjs\nchecking ×3\nverified",
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
    expect(packageProjection(capture("bun-audit", source), 10_000, [], ["bun", "audit"]).text).toBe(
      source,
    );
    const silent = "$ user-authored output\nkeep this exact\n";
    expect(
      packageProjection(
        capture("bun-silent", silent),
        10_000,
        [],
        ["bun", "run", "custom", "--silent"],
      ).text,
    ).toBe(silent);
    const json = '{"@falryn/context":{"current":"0.2.0","latest":"0.3.0"}}\n';
    expect(
      packageProjection(capture("bun-json", json), 10_000, [], ["bun", "outdated", "--json"]).text,
    ).toBe(json);
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
