import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import type { OpenAiSdkFetch } from "../integrations/index.ts";
import type { ModelDiscoveryPort, ProviderProfile } from "../providers/index.ts";
import {
  type ModelRequest,
  modelRequestId,
  type NormalizedProviderEvent,
  OPENAI_RESPONSES_TRANSPORT_DEFAULT,
} from "../providers/index.ts";
import type { GlobalOptions } from "./options.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
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
    transportCompatibility: null,
    modelCapabilities: [],
    discovery: "static",
    timeouts: { connectMs: 1_000, requestMs: 10_000 },
  };
}

function officialProfile(
  adapterKind: "anthropic" | "google" | "commandcode",
  credentialLocator: string,
  model: string,
): ProviderProfile {
  return {
    profileId: adapterKind,
    providerId: providerId.from(adapterKind),
    adapterKind,
    displayName:
      adapterKind === "anthropic"
        ? "Anthropic"
        : adapterKind === "google"
          ? "Google"
          : "Command Code",
    endpoint: adapterKind === "commandcode" ? "https://api.commandcode.ai/provider/v1" : null,
    credential: {
      storeKind: "environment",
      locator: credentialLocator,
      consumer: `provider:${adapterKind}`,
      accountLabel: null,
    },
    organization: null,
    project: null,
    enabledModels: [modelId.from(model)],
    transportCompatibility: null,
    modelCapabilities: [],
    discovery: "static",
    timeouts: { connectMs: 1_000, requestMs: 10_000 },
  };
}

function sse(events: readonly object[]): Response {
  return new Response(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function responsesResult(id: string, output: readonly object[] = []): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 2_048,
    model: "gpt-5.6-sol",
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    prompt: null,
    reasoning: { effort: "medium", summary: "auto" },
    safety_identifier: null,
    service_tier: "default",
    store: false,
    temperature: null,
    text: { format: { type: "text" }, verbosity: "medium" },
    tool_choice: "auto",
    tools: [],
    top_logprobs: 0,
    top_p: null,
    truncation: "disabled",
    usage: null,
    user: null,
    metadata: {},
  };
}

async function providerEvents(
  adapter: {
    stream(
      request: ModelRequest,
      options: { signal: AbortSignal },
    ): AsyncIterable<NormalizedProviderEvent>;
  },
  request: ModelRequest,
): Promise<readonly NormalizedProviderEvent[]> {
  const events: NormalizedProviderEvent[] = [];
  for await (const event of adapter.stream(request, {
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
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
      catalog: { generation: 9, provenance: "remote-discovery" },
      discovery: { kind: "catalog", generation: 9, modelCount: 1 },
    });
    expect(discoveries).toBe(1);
    const tested = await service.execute({ kind: "test", profileId: "remote" });
    expect(tested).toMatchObject({
      kind: "completed",
      catalog: { generation: 9, provenance: "remote-discovery" },
    });
    expect(discoveries).toBe(2);
    expect(JSON.stringify(tested)).not.toContain("secret-not-projected");
  });

  test("resolves provider-native aliases on Linux through the shared environment store", async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-provider-alias-"));
    homes.push(home);
    const services = createServiceProvider(GLOBALS, {
      home: localPath(home),
      platform: "linux",
      currentDirectory: localPath(home),
      environment: createStaticEnvironment({
        FALRYN_STATE_DIR: home,
        COMMAND_CODE_API_KEY: "secret-not-projected",
      }),
    });
    const modelDiscovery: ModelDiscoveryPort = {
      async discover(profile) {
        return {
          kind: "catalog",
          catalog: {
            generation: 1,
            provenance: "remote-discovery",
            fetchedAt: instant(0),
            expiresAt: null,
            models: profile.enabledModels.map((model) => ({
              schemaVersion: 1,
              modelId: model,
              displayName: "MiniMax M3",
              inputModalities: ["text"],
              outputModalities: ["text"],
              tools: "supported",
              structuredOutput: "unknown",
              streaming: "supported",
              reasoning: "supported",
              reasoningControls: [],
              contextTokens: 1_000_000,
              outputTokens: null,
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
    const profile = {
      ...officialProfile("commandcode", "FALRYN_COMMANDCODE_API_KEY", "MiniMaxAI/MiniMax-M3"),
      discovery: "remote" as const,
    };

    const added = await service.execute({ kind: "add", profile });
    expect(added).toMatchObject({
      kind: "completed",
      auth: { state: "ready" },
      discovery: { kind: "catalog", modelCount: 1 },
    });
    expect(JSON.stringify(added)).not.toContain("secret-not-projected");
  });

  test("loads referenced user catalogs from the active configuration home", async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-provider-catalog-"));
    homes.push(home);
    const services = createServiceProvider(GLOBALS, {
      home: localPath(home),
      platform: "darwin",
      currentDirectory: localPath(home),
      environment: createStaticEnvironment({
        FALRYN_STATE_DIR: home,
        FALRYN_TEST_LOCAL_KEY: "secret-not-projected",
      }),
    });
    const graph = services();
    const catalogDirectory = join(graph.configurationRoot, "catalogs");
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(
      join(catalogDirectory, "local-models.jsonc"),
      JSON.stringify({
        schemaVersion: 1,
        catalogId: "local-models",
        displayName: "Local models",
        provider: {
          providerId: "local",
          adapterKind: "openai",
          endpoint: "http://127.0.0.1:11434/v1",
        },
        models: [
          {
            schemaVersion: 1,
            modelId: "coder",
            displayName: "Local coder",
            inputModalities: ["text"],
            outputModalities: ["text"],
            tools: "supported",
            structuredOutput: "unknown",
            streaming: "supported",
            reasoning: "unknown",
            reasoningControls: [],
            contextTokens: 32_000,
            outputTokens: 4_000,
            completeness: "partial",
          },
        ],
      }),
    );
    const service = composeProductProviderConnections(graph, GLOBALS).service;
    const profile: ProviderProfile = {
      ...localProfile(),
      credential: {
        storeKind: "environment",
        locator: "FALRYN_TEST_LOCAL_KEY",
        consumer: "provider:local",
        accountLabel: null,
      },
      catalogs: ["local-models"],
    };

    expect(await service.execute({ kind: "add", profile })).toMatchObject({
      kind: "completed",
      catalog: {
        models: [
          {
            modelId: "coder",
            displayName: "Local coder",
            tools: "supported",
            provenance: ["user-catalog"],
          },
        ],
      },
      discovery: { kind: "catalog", modelCount: 1 },
    });
    const tested = await service.execute({ kind: "test", profileId: "local" });
    expect(tested).toMatchObject({
      kind: "completed",
      catalog: {
        models: [
          {
            modelId: "coder",
            displayName: "Local coder",
            tools: "supported",
            provenance: ["user-catalog"],
          },
        ],
      },
    });
    expect(JSON.stringify(tested)).not.toContain("secret-not-projected");
  });

  test("resolves selected profiles to their installed provider adapters", async () => {
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
      {
        adapterKind: "commandcode" as const,
        credentialLocator: "FALRYN_TEST_COMMAND_CODE_KEY",
        model: "gpt-5.6-sol",
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

  test("composes an OpenAI Responses destination without treating it as a provider", async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-provider-openai-responses-"));
    homes.push(home);
    const services = createServiceProvider(GLOBALS, {
      home: localPath(home),
      platform: "darwin",
      currentDirectory: localPath(home),
      environment: createStaticEnvironment({
        FALRYN_STATE_DIR: home,
        FALRYN_TEST_OPENAI_KEY: "secret-not-projected",
      }),
    });
    const product = composeProductProviderConnections(services(), GLOBALS, {
      providerFetch: async () => {
        throw new Error("adapter composition must not contact the provider");
      },
    });
    const profile: ProviderProfile = {
      ...localProfile(),
      profileId: "openai-responses",
      providerId: providerId.from("openai"),
      displayName: "OpenAI Responses",
      endpoint: "https://api.openai.com/v1",
      credential: {
        storeKind: "environment",
        locator: "FALRYN_TEST_OPENAI_KEY",
        consumer: "provider:openai",
        accountLabel: null,
      },
      enabledModels: [modelId.from("gpt-5.6-sol")],
      transportCompatibility: OPENAI_RESPONSES_TRANSPORT_DEFAULT,
    };

    expect(await product.service.execute({ kind: "add", profile })).toMatchObject({
      kind: "completed",
    });
    expect(
      await product.service.execute({ kind: "use", profileId: "openai-responses" }),
    ).toMatchObject({ kind: "completed", selectedProfileId: "openai-responses" });

    const selected = await product.resolveSelected();
    expect(selected.kind).toBe("ready");
    if (selected.kind === "ready") {
      expect(selected.adapter.identity).toMatchObject({
        adapterKind: "openai",
        providerId: "openai",
        profileId: "openai-responses",
      });
      expect(
        selected.adapter.transportCompatibilityFor(modelId.from("gpt-5.6-sol"))?.declaration
          .dialect,
      ).toBe("openai-responses");
    }
    expect(JSON.stringify(selected)).not.toContain("secret-not-projected");
  });

  test("replays exact Responses tool state through product routing after restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-provider-responses-restart-"));
    homes.push(home);
    const services = createServiceProvider(GLOBALS, {
      home: localPath(home),
      platform: "darwin",
      currentDirectory: localPath(home),
      environment: createStaticEnvironment({
        FALRYN_STATE_DIR: join(home, "state"),
        FALRYN_ARTIFACT_DIR: join(home, "artifacts"),
        FALRYN_TEMP_DIR: join(home, "tmp"),
        FALRYN_TEST_OPENAI_KEY: "secret-not-projected",
      }),
    });
    const graph = services();
    const profile: ProviderProfile = {
      ...localProfile(),
      profileId: "openai-responses-restart",
      providerId: providerId.from("openai"),
      endpoint: "https://api.openai.com/v1",
      credential: {
        storeKind: "environment",
        locator: "FALRYN_TEST_OPENAI_KEY",
        consumer: "provider:openai",
        accountLabel: null,
      },
      enabledModels: [modelId.from("gpt-5.6-sol")],
      transportCompatibility: OPENAI_RESPONSES_TRANSPORT_DEFAULT,
    };
    const configured = composeProductProviderConnections(graph, GLOBALS).service;
    expect(await configured.execute({ kind: "add", profile })).toMatchObject({ kind: "completed" });
    expect(await configured.execute({ kind: "use", profileId: profile.profileId })).toMatchObject({
      kind: "completed",
    });

    const bodies: Record<string, unknown>[] = [];
    let providerCall = 0;
    const fetch: OpenAiSdkFetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      providerCall += 1;
      if (providerCall === 1) {
        const reasoning = {
          id: "reasoning-restart",
          type: "reasoning",
          encrypted_content: "opaque-provider-state",
          summary: [],
          status: "completed",
        };
        const functionCall = {
          id: "function-restart",
          type: "function_call",
          call_id: "call-restart",
          name: "read_file",
          arguments: "{}",
          status: "completed",
        };
        return sse([
          {
            type: "response.output_item.done",
            sequence_number: 1,
            output_index: 0,
            item: reasoning,
          },
          {
            type: "response.output_item.added",
            sequence_number: 2,
            output_index: 1,
            item: { ...functionCall, arguments: "", status: "in_progress" },
          },
          {
            type: "response.output_item.done",
            sequence_number: 3,
            output_index: 1,
            item: functionCall,
          },
          {
            type: "response.completed",
            sequence_number: 4,
            response: responsesResult("response-before-restart", [reasoning, functionCall]),
          },
        ]);
      }
      return sse([
        {
          type: "response.output_text.delta",
          sequence_number: 1,
          item_id: "message-after-restart",
          output_index: 0,
          content_index: 0,
          delta: "done",
          logprobs: [],
        },
        {
          type: "response.completed",
          sequence_number: 2,
          response: responsesResult("response-after-restart"),
        },
      ]);
    };

    const firstState = await openProductArtifactSession(graph);
    expect(firstState).not.toBeNull();
    if (firstState === null) {
      throw new Error("expected durable product state");
    }
    const first = await composeProductProviderConnections(graph, GLOBALS, {
      providerFetch: fetch,
      providerContinuations: firstState.providerContinuations,
    }).resolveSelected();
    expect(first.kind).toBe("ready");
    if (first.kind !== "ready") {
      throw new Error(`expected first provider route, got ${first.code}`);
    }
    const baseRequest: ModelRequest = {
      requestId: modelRequestId.from("responses-before-restart"),
      providerId: providerId.from("openai"),
      modelId: modelId.from("gpt-5.6-sol"),
      messages: [{ role: "user", parts: [{ kind: "text", text: "read" }] }],
      tools: [
        {
          name: "read_file",
          description: "Read a file.",
          parameters: { type: "object", additionalProperties: false },
        },
      ],
      output: { kind: "text" },
      budgets: {},
      metadata: { role: "default" },
    };
    const beforeRestart = await providerEvents(first.adapter, baseRequest);
    expect(beforeRestart.at(-1)).toMatchObject({ kind: "finished", finishReason: "tool_calls" });
    expect(beforeRestart).toContainEqual(
      expect.objectContaining({
        kind: "provider-metadata",
        entries: { continuationStateSaved: "true", continuationStateSavedCount: "1" },
      }),
    );
    await firstState.close();

    const restartedState = await openProductArtifactSession(graph);
    expect(restartedState).not.toBeNull();
    if (restartedState === null) {
      throw new Error("expected reopened product state");
    }
    const restarted = await composeProductProviderConnections(graph, GLOBALS, {
      providerFetch: fetch,
      providerContinuations: restartedState.providerContinuations,
    }).resolveSelected();
    expect(restarted.kind).toBe("ready");
    if (restarted.kind !== "ready") {
      throw new Error(`expected restarted provider route, got ${restarted.code}`);
    }
    const afterRestart = await providerEvents(restarted.adapter, {
      ...baseRequest,
      requestId: modelRequestId.from("responses-after-restart"),
      messages: [
        ...baseRequest.messages,
        {
          role: "assistant",
          parts: [],
          toolCalls: [{ toolCallId: "call-restart", name: "read_file", arguments: {} }],
        },
        {
          role: "tool",
          toolCallId: "call-restart",
          parts: [{ kind: "text", text: "contents" }],
        },
      ],
    });
    expect(afterRestart).toContainEqual(
      expect.objectContaining({
        kind: "provider-metadata",
        entries: { continuationStateLoaded: "true", continuationStateLoadedCount: "1" },
      }),
    );
    expect(afterRestart.at(-1)).toMatchObject({ kind: "finished", finishReason: "completed" });
    expect(bodies[1]?.input).toEqual([
      { role: "user", content: "read" },
      {
        id: "reasoning-restart",
        type: "reasoning",
        encrypted_content: "opaque-provider-state",
        summary: [],
        status: "completed",
      },
      { type: "function_call", call_id: "call-restart", name: "read_file", arguments: "{}" },
      { type: "function_call_output", call_id: "call-restart", output: "contents" },
    ]);
    expect(JSON.stringify(afterRestart)).not.toContain("opaque-provider-state");
    await restartedState.close();
  });
});
