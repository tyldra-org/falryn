import { describe, expect, test } from "bun:test";

import { parseProviderConnectionState } from "../providers/connection-schema.ts";
import { DEFAULT_PROVIDER_CONNECTION_STATE } from "./provider-configuration.ts";

describe("default provider configuration", () => {
  test("enables the current OpenAI family with Sol as the default route", () => {
    const parsed = parseProviderConnectionState(DEFAULT_PROVIDER_CONNECTION_STATE);
    expect(parsed.ok).toBe(true);

    const profile = DEFAULT_PROVIDER_CONNECTION_STATE.connections[0]?.profile;
    expect(profile?.enabledModels.map(String)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.6",
    ]);
    expect(profile?.modelCapabilities.map((capability) => String(capability.modelId))).toEqual(
      profile?.enabledModels.map(String),
    );
  });
});
