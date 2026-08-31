import { describe, expect, test } from "bun:test";

import { modelId, providerId } from "../domain/identity.ts";
import {
  parseProviderModelIdentityKey,
  providerModelIdentityKey,
  sameProviderModelIdentity,
} from "./model-identity.ts";

const identity = {
  providerProfileId: "work/account:one",
  providerId: providerId.from("commandcode"),
  modelId: modelId.from("openai/gpt-5.6-sol:latest"),
};

describe("provider model identity", () => {
  test("round trips delimiter-rich provider and model IDs", () => {
    const key = providerModelIdentityKey(identity);
    expect(parseProviderModelIdentityKey(key)).toEqual({ ok: true, value: identity });
  });

  test("rejects malformed, incomplete, and unsupported keys", () => {
    for (const key of ["not-json", "[]", '[2,"profile","provider","model"]', '[1,"","p","m"]']) {
      expect(parseProviderModelIdentityKey(key)).toMatchObject({
        ok: false,
        code: "model-identity-key-invalid",
      });
    }
  });

  test("treats the provider profile as part of model identity", () => {
    expect(sameProviderModelIdentity(identity, identity)).toBe(true);
    expect(
      sameProviderModelIdentity(identity, {
        ...identity,
        providerProfileId: "personal",
      }),
    ).toBe(false);
  });
});
