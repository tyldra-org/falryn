import { afterEach, describe, expect, test } from "bun:test";

import { modelId, providerId } from "../domain/index.ts";
import { PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION } from "../providers/index.ts";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "./fixtures.ts";
import {
  createProviderContinuationStateRepository,
  MAX_DURABLE_PROVIDER_CONTINUATIONS,
} from "./provider-continuation-repository.ts";

afterEach(removeTemporaryRoots);

function record(toolCallId: string, capturedAt = 100) {
  return {
    schemaVersion: PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION,
    profileId: "openai",
    providerId: providerId.from("openai"),
    destinationId: "sha-256:destination",
    transportCompatibilityId: "openai-responses:v1",
    modelId: modelId.from("gpt-test"),
    toolCallId,
    stateJson: JSON.stringify({
      schemaVersion: PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION,
      responseId: "resp-1",
      reasoning: [],
    }),
    capturedAt,
  } as const;
}

describe("provider continuation state repository", () => {
  test("atomically stores parallel calls and reloads them after restart", async () => {
    const root = await temporaryRoot("falryn-provider-continuation-");
    const first = await openProductStoreOrThrow(root);
    const repository = createProviderContinuationStateRepository(first);

    expect(repository.save([record("call-1"), record("call-2")])).toEqual({
      ok: true,
      value: { inserted: 2, replaced: 0 },
    });
    await first.close();

    const reopened = await openProductStoreOrThrow(root);
    const restored = createProviderContinuationStateRepository(reopened);
    expect(restored.load(record("call-1"))).toEqual({ ok: true, value: record("call-1") });
    expect(restored.load(record("call-2"))).toEqual({ ok: true, value: record("call-2") });
    expect(restored.load(record("missing"))).toEqual({ ok: true, value: null });
    await reopened.close();
  });

  test("replaces the same exact-route call without crossing model or plan identity", async () => {
    const root = await temporaryRoot("falryn-provider-continuation-replace-");
    const store = await openProductStoreOrThrow(root);
    const repository = createProviderContinuationStateRepository(store);
    const replacement = { ...record("call-1", 200), stateJson: '{"replacement":true}' };

    expect(repository.save([record("call-1")]).ok).toBe(true);
    expect(repository.save([replacement])).toEqual({
      ok: true,
      value: { inserted: 0, replaced: 1 },
    });
    expect(repository.load(record("call-1"))).toEqual({ ok: true, value: replacement });
    expect(
      repository.load({ ...record("call-1"), modelId: modelId.from("different-model") }),
    ).toEqual({ ok: true, value: null });
    expect(
      repository.load({ ...record("call-1"), transportCompatibilityId: "different-plan" }),
    ).toEqual({ ok: true, value: null });
    await store.close();
  });

  test("keeps only the newest bounded recovery state for each profile and destination", async () => {
    const root = await temporaryRoot("falryn-provider-continuation-bound-");
    const store = await openProductStoreOrThrow(root);
    const repository = createProviderContinuationStateRepository(store);
    const records = Array.from({ length: MAX_DURABLE_PROVIDER_CONTINUATIONS + 1 }, (_, index) =>
      record(`call-${String(index).padStart(3, "0")}`, index),
    );

    expect(repository.save(records).ok).toBe(true);
    const oldest = records[0];
    const newest = records.at(-1);
    if (oldest === undefined || newest === undefined) {
      throw new Error("The bounded continuation fixture must not be empty.");
    }
    expect(repository.load(oldest)).toEqual({ ok: true, value: null });
    expect(repository.load(newest)).toEqual({ ok: true, value: newest });
    await store.close();
  });
});
