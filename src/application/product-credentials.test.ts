/**
 * Product credential bootstrap tests (#710).
 */

import { describe, expect, test } from "bun:test";

import {
  type CommandRequest,
  type CommandRunnerPort,
  type CredentialReference,
  createManualClock,
  createStaticEnvironment,
} from "../domain/index.ts";
import { composeProductCredentials, resolveProviderApiKey } from "./product-credentials.ts";

const REFERENCE: CredentialReference = {
  storeKind: "environment",
  locator: "FALRYN_TEST_PROVIDER_KEY",
  consumer: "provider:openai",
  accountLabel: null,
};

function runner(
  handler: (
    request: CommandRequest,
  ) => Promise<{ kind: "exited"; exitCode: number; stdout: string }>,
): CommandRunnerPort {
  return { run: async (request) => handler(request) };
}

describe("composeProductCredentials", () => {
  test("resolves an environment credential through the product resolver", async () => {
    const clock = createManualClock();
    const bundle = composeProductCredentials({
      clock,
      commands: runner(async () => {
        throw new Error("keychain must not run for environment refs");
      }),
      platform: "darwin",
      environment: createStaticEnvironment({
        FALRYN_TEST_PROVIDER_KEY: "sk-from-env",
      }),
    });
    const key = await resolveProviderApiKey(bundle.resolver, REFERENCE);
    expect(key).toBe("sk-from-env");
  });

  test("fails closed when the credential is missing", async () => {
    const clock = createManualClock();
    const bundle = composeProductCredentials({
      clock,
      commands: runner(async () => ({ kind: "exited", exitCode: 44, stdout: "" })),
      platform: "darwin",
      environment: createStaticEnvironment({}),
    });
    const key = await resolveProviderApiKey(bundle.resolver, REFERENCE);
    expect(key).toBeNull();
  });

  test("resolves an official provider-native alias through the canonical reference", async () => {
    const clock = createManualClock();
    const bundle = composeProductCredentials({
      clock,
      commands: runner(async () => {
        throw new Error("keychain must not run for environment refs");
      }),
      platform: "linux",
      environment: createStaticEnvironment({ OPENAI_API_KEY: "sk-provider-native" }),
    });
    const key = await resolveProviderApiKey(bundle.resolver, {
      storeKind: "environment",
      locator: "FALRYN_OPENAI_API_KEY",
      consumer: "provider:openai",
      accountLabel: null,
    });
    expect(key).toBe("sk-provider-native");
  });

  test("placeApiKey writes through the keychain channel without returning the secret", async () => {
    const clock = createManualClock();
    let wroteSecret: Uint8Array | undefined;
    const bundle = composeProductCredentials({
      clock,
      commands: runner(async (request) => {
        wroteSecret = "stdinBytes" in request ? request.stdinBytes : undefined;
        expect("argv" in request && request.argv).not.toContain("sk-place-me");
        return { kind: "exited", exitCode: 0, stdout: "" };
      }),
      platform: "darwin",
      environment: createStaticEnvironment({}),
    });
    const secret = "sk-place-me";
    const placed = await bundle.placeApiKey({
      reference: {
        storeKind: "operating-system-keychain",
        locator: "falryn.provider.openai",
        consumer: "provider:openai",
        accountLabel: "default",
      },
      secret,
    });
    expect(placed).toEqual({ kind: "written" });
    expect(wroteSecret).toEqual(new TextEncoder().encode(`${secret}\n`));
    expect(JSON.stringify(placed)).not.toContain(secret);
  });
});
