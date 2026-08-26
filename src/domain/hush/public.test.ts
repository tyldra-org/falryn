/** Hush public reduction, recovery, and fallback contracts behavior. */

import { describe, expect, test } from "bun:test";
import { artifactId } from "../artifact.ts";
import { duration } from "../clock.ts";
import {
  createHushPort,
  HUSH_REDUCER_VERSION,
  MAX_HUSH_REDUCED_BYTES,
  reduceHush,
} from "../index.ts";
import { argv, report } from "./fixtures.ts";

describe("Hush public reduction, recovery, and fallback contracts", () => {
  test("rejects a reduced-byte limit above the hush cap", () => {
    expect(
      reduceHush({
        command: argv("/usr/bin/git", ["status"]),
        capture: report(""),
        maxReducedBytes: MAX_HUSH_REDUCED_BYTES + 1,
      }),
    ).toEqual({
      ok: false,
      error: { kind: "hush", code: "invalid-request", reason: "invalid-reduced-limit" },
    });
  });

  test("rejects an empty important pattern without exposing the command", () => {
    expect(
      reduceHush({
        command: argv("/usr/bin/git", ["status"]),
        capture: report("ok"),
        importantPatterns: [""],
      }),
    ).toEqual({
      ok: false,
      error: { kind: "hush", code: "invalid-request", reason: "invalid-pattern" },
    });
  });

  test("preserves terminal facts and omits the child environment", () => {
    const captured = report("On branch main\n", { durationMs: 44, exitCode: 1 });
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["status"]),
      capture: captured,
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.command).toEqual({
      mode: "argv",
      executable: "/usr/bin/git",
      argv: ["status"],
      command: null,
      cwd: "/workspace",
    });
    expect(reduced.value.exit).toEqual({ exitCode: 1, signal: null });
    expect(reduced.value.durationMs).toBe(duration(44));
    expect(reduced.value.stop).toEqual({ kind: "exited" });
    expect(reduced.value.reducerVersion).toBe(HUSH_REDUCER_VERSION);
    expect(reduced.value.family).toBe("git");
    expect(JSON.stringify(reduced.value)).not.toContain("do-not-copy");
  });

  test("falls back to generic when the selected family is not expected", () => {
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["status"]),
      capture: report("M src/hush.ts\n".repeat(40)),
      expectedFamilies: ["search"],
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.family).toBe("git");
    expect(reduced.value.strategy).toBe("generic");
    expect(reduced.value.fallbackReason).toBe("expected-family-miss");
    expect(reduced.value.fidelity).toBe("deterministic-reduction");
  });

  test("passthrough of small utf-8 output is exact", () => {
    const reduced = reduceHush({
      command: argv("/bin/echo", ["hi"]),
      capture: report("hi\n"),
      strategy: "passthrough",
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.fidelity).toBe("exact");
    expect(reduced.value.reducedText).toBe("hi\n");
    expect(reduced.value.strategy).toBe("passthrough");
    expect(reduced.value.reducerId).toBe("safe.passthrough");
  });

  test("unknown commands use the generic reducer and keep stderr", () => {
    const reduced = reduceHush({
      command: argv("/usr/bin/mystery"),
      capture: report("aaaa\naaaa\naaaa\naaaa\n", { stderr: "warn\n" }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.family).toBe("generic");
    expect(reduced.value.fallbackReason).toBe("unknown-family");
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.reducedText).toContain("aaaa ×4");
    expect(reduced.value.reducedText).toContain("stderr:\nwarn");
  });

  test("keeps every unique semantic line beyond the former default budget", () => {
    const lines = Array.from(
      { length: 600 },
      (_, index) => `case-${index.toString().padStart(3, "0")}: unique diagnostic context`,
    );
    const reduced = reduceHush({
      command: argv("/usr/bin/bun", ["test"]),
      capture: report(`${lines.join("\n")}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toContain(lines[0] ?? "missing-first-line");
    expect(reduced.value.reducedText).toContain(lines.at(-1) ?? "missing-last-line");
    expect(reduced.value.truncated).toBe(false);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("counts repeated progress lines instead of silently dropping them", () => {
    const output = `${"Compiling falryn\n".repeat(80)}Finished release build\n`;
    const reduced = reduceHush({
      command: argv("/usr/bin/tail", ["-n", "100", "build.log"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("files.tail");
    expect(reduced.value.reducedText).toContain("Compiling falryn ×80");
    expect(reduced.value.reducedText).toContain("Finished release build");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("binary stdout is omitted with an expansion route", () => {
    const reduced = reduceHush({
      command: argv("/usr/bin/cat", ["blob"]),
      capture: report("\u0000\u0001", { encoding: "binary", artifact: true }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).not.toContain("\u0000");
    expect(reduced.value.omissions).toContainEqual({
      kind: "binary-stream",
      stream: "stdout",
      count: 2,
      detail: "cap-1.stdout",
    });
    expect(reduced.value.expansion.stdoutArtifact).toEqual(artifactId.from("cap-1.stdout"));
  });

  test("timed-out capture facts survive reduction", () => {
    const reduced = reduceHush({
      command: argv("/bin/sleep", ["5"]),
      capture: report("", {
        stop: { kind: "timed-out", timeoutMs: duration(200) },
        exitCode: null,
        durationMs: 200,
      }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.stop).toEqual({ kind: "timed-out", timeoutMs: duration(200) });
    expect(reduced.value.exit.exitCode).toBeNull();
  });

  test("createHushPort exposes the same reduce function", () => {
    const port = createHushPort();
    const reduced = port.reduce({
      command: argv("/usr/bin/true"),
      capture: report(""),
    });
    expect(reduced.ok).toBe(true);
  });
});
