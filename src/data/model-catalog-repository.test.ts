import { afterEach, describe, expect, test } from "bun:test";

import { instant, modelId, providerId } from "../domain/index.ts";
import { MODEL_CAPABILITY_SCHEMA_VERSION, type ModelCatalog } from "../providers/index.ts";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "./fixtures.ts";
import { createModelCatalogGenerationRepository } from "./model-catalog-repository.ts";

afterEach(removeTemporaryRoots);

function catalog(generation = 7): ModelCatalog {
  return {
    generation,
    provenance: "static-config",
    fetchedAt: instant(100),
    expiresAt: null,
    models: [
      {
        schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
        modelId: modelId.from("demo"),
        displayName: "Demo",
        inputModalities: ["text"],
        outputModalities: ["text"],
        tools: "supported",
        structuredOutput: "supported",
        streaming: "supported",
        reasoning: "unknown",
        reasoningControls: [],
        contextTokens: 32_000,
        outputTokens: 4_000,
        completeness: "partial",
        availability: "available",
        provenance: ["user-catalog"],
      },
    ],
  };
}

describe("model catalog generation repository", () => {
  test("publishes one immutable generation and reads it after restart", async () => {
    const root = await temporaryRoot("falryn-model-catalog-");
    const first = await openProductStoreOrThrow(root);
    const repository = createModelCatalogGenerationRepository(first);
    const record = {
      profileId: "work",
      providerId: providerId.from("provider"),
      adapterKind: "openai" as const,
      endpoint: "https://provider.example/v1",
      destinationId: "sha-256:provider-example",
      catalog: catalog(),
      publishedAt: instant(200),
    };

    expect(repository.publish(record)).toEqual({ ok: true, value: "inserted" });
    expect(repository.publish(record)).toEqual({ ok: true, value: "existing" });
    await first.close();

    const reopened = await openProductStoreOrThrow(root);
    expect(
      createModelCatalogGenerationRepository(reopened).latest("work", "sha-256:provider-example"),
    ).toEqual({
      ok: true,
      value: record,
    });
    await reopened.close();
  });

  test("rejects a different catalog under an existing generation", async () => {
    const root = await temporaryRoot("falryn-model-catalog-conflict-");
    const store = await openProductStoreOrThrow(root);
    const repository = createModelCatalogGenerationRepository(store);
    const base = {
      profileId: "work",
      providerId: providerId.from("provider"),
      adapterKind: "openai" as const,
      endpoint: "https://provider.example/v1",
      destinationId: "sha-256:provider-example",
      catalog: catalog(),
      publishedAt: instant(200),
    };
    expect(repository.publish(base).ok).toBe(true);
    expect(
      repository.publish({
        ...base,
        catalog: { ...catalog(), fetchedAt: instant(101) },
      }),
    ).toEqual({ ok: false, error: { code: "conflict" } });
    expect(repository.publish({ ...base, endpoint: "https://other.example/v1" })).toEqual({
      ok: false,
      error: { code: "conflict" },
    });
    expect(
      repository.publish({
        ...base,
        endpoint: "https://other.example/v1",
        destinationId: "sha-256:other-example",
      }),
    ).toEqual({ ok: true, value: "inserted" });
    await store.close();
  });
});
