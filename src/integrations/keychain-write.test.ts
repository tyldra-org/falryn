/**
 * Keychain credential write tests (#709).
 */

import { describe, expect, test } from "bun:test";

import type { CommandRequest, CommandRunnerPort } from "../domain/index.ts";
import { SECURITY_EXECUTABLE } from "./keychain-credentials.ts";
import { writeKeychainCredential } from "./keychain-write.ts";

function reference() {
  return {
    storeKind: "operating-system-keychain" as const,
    locator: "falryn.provider.openai",
    consumer: "provider:openai",
    accountLabel: "default",
  };
}

function runner(
  handler: (
    request: CommandRequest,
  ) => Promise<{ kind: "exited"; exitCode: number; stdout: string }>,
): CommandRunnerPort {
  return {
    run: async (request) => handler(request),
  };
}

describe("writeKeychainCredential", () => {
  test("writes through security add-generic-password without logging the secret", async () => {
    let captured: CommandRequest | undefined;
    const result = await writeKeychainCredential({
      platform: "darwin",
      reference: reference(),
      secret: "sk-never-log-me",
      commands: runner(async (request) => {
        captured = request;
        return { kind: "exited", exitCode: 0, stdout: "" };
      }),
    });
    expect(result).toEqual({ kind: "written" });
    expect(captured).toBeDefined();
    if (captured === undefined) {
      return;
    }
    expect(captured.executable).toBe(SECURITY_EXECUTABLE);
    expect("argv" in captured ? captured.argv : []).toEqual([
      "add-generic-password",
      "-U",
      "-a",
      "default",
      "-s",
      "falryn.provider.openai",
      "-w",
      "sk-never-log-me",
    ]);
    expect(captured.environment).toEqual({});
  });

  test("refuses unsupported platforms", async () => {
    const result = await writeKeychainCredential({
      platform: "linux",
      reference: reference(),
      secret: "sk-test",
      commands: runner(async () => {
        throw new Error("must not run");
      }),
    });
    expect(result).toEqual({ kind: "unsupported", code: "platform-linux" });
  });

  test("refuses an empty secret", async () => {
    const result = await writeKeychainCredential({
      platform: "darwin",
      reference: reference(),
      secret: "",
      commands: runner(async () => {
        throw new Error("must not run");
      }),
    });
    expect(result).toEqual({ kind: "failed", code: "empty-secret" });
  });
});
