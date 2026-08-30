import { describe, expect, test } from "bun:test";

import {
  createStaticEnvironment,
  createStubCommandRunner,
  DEFAULT_CREDENTIAL_TIMEOUT_MS,
  MAX_CREDENTIAL_SECRET_BYTES,
} from "../domain/index.ts";
import {
  createSessionEnvironmentCredentialLookup,
  LAUNCHCTL_EXECUTABLE,
} from "./session-environment-credentials.ts";

describe("session environment credential lookup", () => {
  test("queries exactly one declared macOS launchd variable", async () => {
    const commands = createStubCommandRunner(async () => ({
      kind: "exited",
      exitCode: 0,
      stdout: "secret-from-launchd\n",
    }));
    const lookup = createSessionEnvironmentCredentialLookup({
      commands,
      environment: createStaticEnvironment({}),
      platform: "darwin",
    });
    expect(lookup).not.toBeNull();
    const outcome = await lookup?.read("CMD_API_KEY");
    expect(outcome).toEqual({ kind: "found", value: "secret-from-launchd" });
    expect(commands.requests()[0]).toMatchObject({
      executable: LAUNCHCTL_EXECUTABLE,
      argv: ["getenv", "CMD_API_KEY"],
      environment: {},
      timeoutMs: DEFAULT_CREDENTIAL_TIMEOUT_MS,
      maxOutputBytes: MAX_CREDENTIAL_SECRET_BYTES,
    });
  });

  test("queries only the named Windows user and machine values", async () => {
    const commands = createStubCommandRunner(async () => ({
      kind: "exited",
      exitCode: 0,
      stdout: "secret-from-windows",
    }));
    const lookup = createSessionEnvironmentCredentialLookup({
      commands,
      environment: createStaticEnvironment({ SystemRoot: "D:\\Windows" }),
      platform: "win32",
    });
    const outcome = await lookup?.read("OPENAI_API_KEY");
    expect(outcome).toEqual({ kind: "found", value: "secret-from-windows" });
    const request = commands.requests()[0];
    expect(request?.executable).toBe(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(request?.environment).toEqual({ FALRYN_CREDENTIAL_VARIABLE: "OPENAI_API_KEY" });
    expect(request !== undefined && "argv" in request ? request.argv : []).toContain("-NoProfile");
    expect(JSON.stringify(request)).not.toContain("secret-from-windows");
  });

  test("does not dump a Linux session environment", () => {
    const commands = createStubCommandRunner(async () => {
      throw new Error("must not run");
    });
    expect(
      createSessionEnvironmentCredentialLookup({
        commands,
        environment: createStaticEnvironment({}),
        platform: "linux",
      }),
    ).toBeNull();
    expect(commands.requests()).toEqual([]);
  });

  test("maps empty, timeout, cancellation, oversized output, and spawn failure", async () => {
    const outcomes: readonly {
      readonly outcome:
        | { readonly kind: "exited"; readonly exitCode: number; readonly stdout: string }
        | { readonly kind: "timed-out"; readonly timeoutMs: typeof DEFAULT_CREDENTIAL_TIMEOUT_MS }
        | { readonly kind: "cancelled" }
        | { readonly kind: "output-exceeded"; readonly maxOutputBytes: number }
        | { readonly kind: "spawn-failed"; readonly code: string };
      readonly expected: "missing" | "timed-out" | "cancelled" | "malformed" | "unavailable";
    }[] = [
      { outcome: { kind: "exited", exitCode: 0, stdout: "" } as const, expected: "missing" },
      {
        outcome: { kind: "timed-out", timeoutMs: DEFAULT_CREDENTIAL_TIMEOUT_MS } as const,
        expected: "timed-out",
      },
      { outcome: { kind: "cancelled" } as const, expected: "cancelled" },
      {
        outcome: { kind: "output-exceeded", maxOutputBytes: MAX_CREDENTIAL_SECRET_BYTES } as const,
        expected: "malformed",
      },
      {
        outcome: { kind: "spawn-failed", code: "ENOENT" } as const,
        expected: "unavailable",
      },
    ];
    for (const fixture of outcomes) {
      const lookup = createSessionEnvironmentCredentialLookup({
        commands: createStubCommandRunner(async () => fixture.outcome),
        environment: createStaticEnvironment({}),
        platform: "darwin",
      });
      expect((await lookup?.read("CMD_API_KEY"))?.kind).toBe(fixture.expected);
    }
  });
});
