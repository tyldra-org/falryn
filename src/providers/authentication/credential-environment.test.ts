import { describe, expect, test } from "bun:test";

import {
  providerCredentialEnvironment,
  providerCredentialEnvironmentAliases,
  providerEnvironmentCredentialReference,
} from "./credential-environment.ts";

describe("official provider environment credentials", () => {
  test("keeps provider-native and Falryn-specific aliases in explicit precedence order", () => {
    expect(providerCredentialEnvironment("openai")?.variables).toEqual([
      "FALRYN_OPENAI_API_KEY",
      "OPENAI_API_KEY",
    ]);
    expect(providerCredentialEnvironment("anthropic")?.variables).toEqual([
      "FALRYN_ANTHROPIC_API_KEY",
      "ANTHROPIC_API_KEY",
    ]);
    expect(providerCredentialEnvironment("google")?.variables).toEqual([
      "FALRYN_GOOGLE_API_KEY",
      "FALRYN_GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
    ]);
    expect(providerCredentialEnvironment("commandcode")?.variables).toEqual([
      "FALRYN_COMMANDCODE_API_KEY",
      "FALRYN_COMMAND_CODE_API_KEY",
      "FALRYN_CMD_API_KEY",
      "COMMAND_CODE_API_KEY",
      "CMD_API_KEY",
      "COMMANDCODE_API_KEY",
    ]);
  });

  test("creates a reference without reading or retaining credential bytes", () => {
    expect(providerEnvironmentCredentialReference("commandcode", "command-work")).toEqual({
      storeKind: "environment",
      locator: "FALRYN_COMMANDCODE_API_KEY",
      consumer: "provider:command-work",
      accountLabel: null,
    });
    expect(providerEnvironmentCredentialReference("custom", "custom-work")).toBeNull();
  });

  test("exposes aliases only under their canonical persisted locators", () => {
    expect(providerCredentialEnvironmentAliases()).toEqual({
      FALRYN_OPENAI_API_KEY: ["OPENAI_API_KEY"],
      FALRYN_ANTHROPIC_API_KEY: ["ANTHROPIC_API_KEY"],
      FALRYN_GOOGLE_API_KEY: ["FALRYN_GEMINI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"],
      FALRYN_COMMANDCODE_API_KEY: [
        "FALRYN_COMMAND_CODE_API_KEY",
        "FALRYN_CMD_API_KEY",
        "COMMAND_CODE_API_KEY",
        "CMD_API_KEY",
        "COMMANDCODE_API_KEY",
      ],
    });
  });
});
