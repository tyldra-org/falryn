import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIGURATION_FILE_NAME } from "../config/index.ts";
import {
  createStaticEnvironment,
  instant,
  localPath,
  modelId,
  providerId,
} from "../domain/index.ts";
import type { ModelDiscoveryPort, ProviderProfile } from "../providers/index.ts";
import type { GlobalOptions } from "./options.ts";
import { composeProductProviderConnections } from "./product-provider-connections.ts";
import { createServiceProvider } from "./services.ts";

const GLOBALS: GlobalOptions = {
  color: "auto",
  format: "human",
  nonInteractive: true,
  profile: null,
  quiet: false,
  timeoutMs: null,
  verbose: false,
  workspace: null,
  addDirs: [],
  help: false,
  version: false,
};

function localProfile(): ProviderProfile {
  return {
    profileId: "local",
    providerId: providerId.from("local"),
    adapterKind: "openai",
    displayName: "Local",
    endpoint: "http://127.0.0.1:11434/v1",
    credential: null,
    organization: null,
    project: null,
    enabledModels: [modelId.from("coder")],
    modelCapabilities: [],
    discovery: "static",
    timeouts: { connectMs: 1_000, requestMs: 10_000 },
  };
}

function officialProfile(
  adapterKind: "anthropic" | "google",
  credentialLocator: string,
  model: string,
): ProviderProfile {
  return {
    profileId: adapterKind,
    providerId: providerId.from(adapterKind),
    adapterKind,
    displayName: adapterKind === "anthropic" ? "Anthropic" : "Google",
    endpoint: null,
    credential: {
      storeKind: "environment",
      locator: credentialLocator,
      consumer: `provider:${adapterKind}`,
      accountLabel: null,
    },
    organization: null,
    project: null,
    enabledModels: [modelId.from(model)],
    modelCapabilities: [],
    discovery: "static",
    timeouts: { connectMs: 1_000, requestMs: 10_000 },
  };
}

describe("product provider connection persistence", () => {
  const homes: string[] = [];

  afterEach(async () => {
    for (const home of homes.splice(0)) {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("reconstructs the selected profile from typed configuration after restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-provider-"));
    homes.push(home);
    const services = createServiceProvider(GLOBALS, {
      home: localPath(home),
      platform: "darwin",
      currentDirectory: localPath(home),
      environment: createStaticEnvironment({ FALRYN_STATE_DIR: home }),
    });
    const graph = services();
    const first = composeProductProviderConnections(graph, GLOBALS).service;

    expect(await first.execute({ kind: "add", profile: localProfile() })).toMatchObject({
      kind: "completed",
      selectedProfileId: "openai",
    });
    expect(await first.execute({ kind: "use", profileId: "local" })).toMatchObject({
      kind: "completed",
      selectedProfileId: "local",
    });

    const restarted = composeProductProviderConnections(graph, GLOBALS).service;
    const listed = await restarted.execute({ kind: "list" });
    expect(listed).toMatchObject({
      kind: "completed",
      selectedProfileId: "local",
      connections: [
        { profileId: "openai", selected: false },
        { profileId: "local", selected: true },
      ],
    });

    const document = await readFile(join(graph.configurationRoot, CONFIGURATION_FILE_NAME), "utf8");
    expect(document).toContain('"connections"');
    expect(document).toContain('"selectedProfileId": "local"');
    expect(document).not.toContain("sk-live-secret-material");
  });

  test("passes remote profiles through the composed model discovery port", async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-provider-discovery-"));
    homes.push(home);
    const services = createServiceProvider(GLOBALS, {
      home: localPath(home),
      platform: "darwin",
      currentDirectory: localPath(home),
      environment: createStaticEnvironment({
        FALRYN_STATE_DIR: home,
        FALRYN_TEST_REMOTE_KEY: "secret-not-projected",
      }),
    });
    let discoveries = 0;
    const modelDiscovery: ModelDiscoveryPort = {
      async discover(profile) {
        discoveries += 1;
        return {
          kind: "catalog",
          catalog: {
            generation: 9,
            provenance: "remote-discovery",
            fetchedAt: instant(0),
            expiresAt: null,
            models: profile.enabledModels.map((model) => ({
              schemaVersion: 1,
              modelId: model,
              displayName: "Remote model",
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
              provenance: ["provider-manifest"],
            })),
          },
        };
      },
    };
    const service = composeProductProviderConnections(services(), GLOBALS, {
      modelDiscovery,
    }).service;
    const remote: ProviderProfile = {
      ...localProfile(),
      profileId: "remote",
      providerId: providerId.from("remote"),
      displayName: "Remote",
      endpoint: "https://api.example.test/v1",
      credential: {
        storeKind: "environment",
        locator: "FALRYN_TEST_REMOTE_KEY",
        consumer: "provider:remote",
        accountLabel: null,
      },
      discovery: "remote",
    };

    expect(await service.execute({ kind: "add", profile: remote })).toMatchObject({
      kind: "completed",
    });
    const tested = await service.execute({ kind: "test", profileId: "remote" });
    expect(tested).toMatchObject({
      kind: "completed",
      catalog: { generation: 9, provenance: "remote-discovery" },
    });
    expect(discoveries).toBe(1);
    expect(JSON.stringify(tested)).not.toContain("secret-not-projected");
  });

  test("resolves selected Anthropic and Google profiles to their official SDK adapters", async () => {
    for (const fixture of [
      {
        adapterKind: "anthropic" as const,
        credentialLocator: "FALRYN_TEST_ANTHROPIC_KEY",
        model: "claude-test",
      },
      {
        adapterKind: "google" as const,
        credentialLocator: "FALRYN_TEST_GOOGLE_KEY",
        model: "gemini-test",
      },
    ]) {
      const home = await mkdtemp(join(tmpdir(), `falryn-provider-${fixture.adapterKind}-`));
      homes.push(home);
      const services = createServiceProvider(GLOBALS, {
        home: localPath(home),
        platform: "darwin",
        currentDirectory: localPath(home),
        environment: createStaticEnvironment({
          FALRYN_STATE_DIR: home,
          [fixture.credentialLocator]: "secret-not-projected",
        }),
      });
      const product = composeProductProviderConnections(services(), GLOBALS);
      expect(
        await product.service.execute({
          kind: "add",
          profile: officialProfile(fixture.adapterKind, fixture.credentialLocator, fixture.model),
        }),
      ).toMatchObject({ kind: "completed" });
      expect(
        await product.service.execute({ kind: "use", profileId: fixture.adapterKind }),
      ).toMatchObject({ kind: "completed", selectedProfileId: fixture.adapterKind });

      const selected = await product.resolveSelected();
      expect(selected.kind).toBe("ready");
      if (selected.kind === "ready") {
        expect(selected.adapter.identity).toMatchObject({
          profileId: fixture.adapterKind,
          providerId: fixture.adapterKind,
        });
        expect(selected.adapter.supportedModels.map(String)).toEqual([fixture.model]);
      }
      expect(JSON.stringify(selected)).not.toContain("secret-not-projected");
    }
  });
});
