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
  type ModelCapabilityDeclaration,
  type ProviderProfile,
} from "../providers/index.ts";
import { createUserCatalogModelDiscovery } from "./model-catalogs.ts";

const ROOT = localPath("/home/user/.falryn");

function declaration(displayName: string): ModelCapabilityDeclaration {
  return {
    schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
    modelId: modelId.from("custom-code-model"),
    displayName,
    inputModalities: ["text"],
    outputModalities: ["text"],
    tools: "supported",
    structuredOutput: "supported",
    streaming: "supported",
    reasoning: "unknown",
    reasoningControls: [],
    contextTokens: 200_000,
    outputTokens: 32_000,
    completeness: "partial",
  };
}

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    profileId: "local",
    providerId: providerId.from("local"),
    adapterKind: "openai",
    displayName: "Local",
    endpoint: "http://127.0.0.1:11434/v1",
    credential: null,
    organization: null,
    project: null,
    enabledModels: [modelId.from("custom-code-model")],
    catalogs: ["local-models"],
    modelCapabilities: [],
    discovery: "static",
    timeouts: { connectMs: 1_000, requestMs: 10_000 },
    ...overrides,
  };
}

function catalog(model = declaration("Catalog model")): string {
  return JSON.stringify({
    schemaVersion: 1,
    catalogId: "local-models",
    displayName: "Local models",
    provider: {
      providerId: "local",
      adapterKind: "openai",
      endpoint: "http://127.0.0.1:11434/v1",
    },
    models: [model],
  });
}

function discovery(text = catalog()) {
  const fileSystem = createInMemoryFileSystem({
    nodes: {
      "/home": { kind: "directory" },
      "/home/user": { kind: "directory" },
      "/home/user/.falryn": { kind: "directory" },
      "/home/user/.falryn/catalogs": { kind: "directory" },
      "/home/user/.falryn/catalogs/local-models.jsonc": { kind: "file", text },
    },
  });
  return createUserCatalogModelDiscovery({
    fileSystem,
    async configurationRoot() {
      return ROOT;
    },
  });
}

describe("user model catalog discovery", () => {
  test("loads a referenced catalog and preserves its provenance", async () => {
    const outcome = await discovery().discover(profile(), {
      signal: new AbortController().signal,
      now: instant(42),
    });

    expect(outcome.kind).toBe("catalog");
    if (outcome.kind === "catalog") {
      expect(outcome.catalog.generation).toBe(42);
      expect(outcome.catalog.models[0]).toMatchObject({
        displayName: "Catalog model",
        provenance: ["user-catalog"],
      });
    }
  });

  test("keeps an explicit profile declaration above a user catalog", async () => {
    const outcome = await discovery().discover(
      profile({ modelCapabilities: [declaration("Profile model")] }),
      { signal: new AbortController().signal, now: instant(42) },
    );

    expect(outcome.kind).toBe("catalog");
    if (outcome.kind === "catalog") {
      expect(outcome.catalog.models[0]).toMatchObject({
        displayName: "Profile model",
        provenance: ["profile-declaration"],
      });
    }
  });

  test("fails closed when a catalog is bound to another destination", async () => {
    const wrong = catalog().replace("127.0.0.1:11434", "127.0.0.1:9999");
    const outcome = await discovery(wrong).discover(profile(), {
      signal: new AbortController().signal,
      now: instant(42),
    });

    expect(outcome).toMatchObject({
      kind: "failed",
      failure: { kind: "malformed", code: "user-catalog-destination-mismatch" },
    });
  });
});
