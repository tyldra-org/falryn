import { describe, expect, test } from "bun:test";

import {
  createInMemoryFileSystem,
  instant,
  localPath,
  modelId,
  providerId,
} from "../domain/index.ts";
import {
  MODEL_CAPABILITY_SCHEMA_VERSION,
  type ModelCatalog,
  type ModelDiscoveryPort,
  type ProviderProfile,
} from "../providers/index.ts";
import { createCachedModelDiscovery } from "./product-model-catalog-cache.ts";

function profile(): ProviderProfile {
  return {
    profileId: "openai",
    providerId: providerId.from("openai"),
    adapterKind: "openai",
    displayName: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    credential: null,
    organization: null,
    project: null,
    enabledModels: [modelId.from("demo")],
    catalogs: [],
    transportCompatibility: null,
    modelCapabilities: [],
    discovery: "remote",
    timeouts: { connectMs: 1_000, requestMs: 10_000 },
  };
}

function catalog(generation: number, fetchedAt: number, expiresAt: number): ModelCatalog {
  return {
    generation,
    provenance: "remote-discovery" as const,
    fetchedAt: instant(fetchedAt),
    expiresAt: instant(expiresAt),
    models: [
      {
        schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
        modelId: modelId.from("demo"),
        displayName: "Demo",
        inputModalities: ["text"] as const,
        outputModalities: ["text"] as const,
        tools: "unknown" as const,
        structuredOutput: "unknown" as const,
        streaming: "supported" as const,
        reasoning: "unknown" as const,
        reasoningControls: [],
        contextTokens: null,
        outputTokens: null,
        completeness: "partial" as const,
        availability: "available" as const,
        provenance: ["remote-identity"] as const,
      },
    ],
  };
}

describe("provider model catalog cache", () => {
  test("reuses an unexpired normalized generation without another provider call", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: { "/cache": { kind: "directory" } } });
    let calls = 0;
    const inner: ModelDiscoveryPort = {
      async discover() {
        calls += 1;
        return { kind: "catalog", catalog: catalog(calls, 10, 100) };
      },
    };
    const discovery = createCachedModelDiscovery(inner, {
      fileSystem,
      async cacheRoot() {
        return localPath("/cache");
      },
    });

    const first = await discovery.discover(profile(), {
      signal: new AbortController().signal,
      now: instant(10),
    });
    const second = await discovery.discover(profile(), {
      signal: new AbortController().signal,
      now: instant(20),
    });

    expect(first).toMatchObject({ kind: "catalog", catalog: { generation: 1 } });
    expect(second).toMatchObject({ kind: "catalog", catalog: { generation: 1 } });
    expect(calls).toBe(1);
    expect(
      fileSystem
        .paths()
        .some((path) => String(path).startsWith("/cache/provider-catalog-downloads/")),
    ).toBe(true);
  });

  test("refreshes an expired cached generation", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: { "/cache": { kind: "directory" } } });
    let calls = 0;
    const inner: ModelDiscoveryPort = {
      async discover() {
        calls += 1;
        return { kind: "catalog", catalog: catalog(calls, calls * 100, calls * 100 + 10) };
      },
    };
    const discovery = createCachedModelDiscovery(inner, {
      fileSystem,
      async cacheRoot() {
        return localPath("/cache");
      },
    });
    await discovery.discover(profile(), {
      signal: new AbortController().signal,
      now: instant(100),
    });
    const refreshed = await discovery.discover(profile(), {
      signal: new AbortController().signal,
      now: instant(200),
    });

    expect(refreshed).toMatchObject({ kind: "catalog", catalog: { generation: 2 } });
    expect(calls).toBe(2);
  });
});
