import { expect, test } from "bun:test";
import { modelId, ok, providerId } from "../../domain/foundation/index.ts";
import type {
  ProviderContinuationStatePort,
  ProviderContinuationStateRecord,
} from "../../providers/protocol/continuation-state.ts";
import { scopeProviderContinuations } from "./continuation-scope.ts";

test("a new binding cannot reuse account-private continuation state under the same logical profile", () => {
  const records = new Map<string, ProviderContinuationStateRecord>();
  const store: ProviderContinuationStatePort = {
    load: (key) => ok(records.get(key.profileId) ?? null),
    save: (values) => {
      for (const value of values) records.set(value.profileId, value);
      return ok({ inserted: values.length, replaced: 0 });
    },
  };
  const key = {
    profileId: "work",
    providerId: providerId.from("openai"),
    destinationId: "same-endpoint",
    transportCompatibilityId: "responses",
    modelId: modelId.from("model"),
    toolCallId: "call",
  };
  const a = scopeProviderContinuations(store, "session:binding-a");
  const b = scopeProviderContinuations(store, "session:binding-b");
  a.save([{ ...key, schemaVersion: 1, stateJson: "opaque-account-a", capturedAt: 1 }]);
  expect(a.load(key)).toMatchObject({
    ok: true,
    value: { profileId: "work", stateJson: "opaque-account-a" },
  });
  expect(b.load(key)).toEqual({ ok: true, value: null });
  b.save([{ ...key, schemaVersion: 1, stateJson: "opaque-account-b", capturedAt: 2 }]);
  expect(a.load(key)).toMatchObject({ value: { stateJson: "opaque-account-a" } });
});
