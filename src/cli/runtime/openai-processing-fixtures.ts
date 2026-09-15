/** Real connection, routing and attempt owners with only the SDK HTTP boundary scripted. */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStaticEnvironment,
  modelId,
  providerId,
  streamId,
} from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import type { OpenAiSdkFetch } from "../../integrations/index.ts";
import { knownModelCapability } from "../../providers/catalog/known-model-capability.ts";
import {
  OPENAI_CHAT_TRANSPORT_DEFAULT,
  OPENAI_RESPONSES_TRANSPORT_DEFAULT,
  type ProviderProfile,
} from "../../providers/index.ts";
import type { GlobalOptions } from "../options.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { runCoding } from "./coding-run.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { composeProductProviderConnections } from "./product-provider-connections.ts";
import { createServiceProvider } from "./services.ts";

export function processingResponse(dialect: "chat" | "responses", tier: unknown): Response {
  const usage = {
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
  const events =
    dialect === "responses"
      ? [
          {
            type: "response.output_text.delta",
            sequence_number: 1,
            item_id: "message",
            output_index: 0,
            content_index: 0,
            delta: "done",
            logprobs: [],
          },
          {
            type: "response.completed",
            sequence_number: 2,
            response: {
              id: "response",
              object: "response",
              status: "completed",
              output: [],
              service_tier: tier,
              usage,
            },
          },
        ]
      : [
          {
            id: "chat",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-5.6-sol",
            choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }],
          },
          {
            id: "chat",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-5.6-sol",
            service_tier: tier,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          },
        ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
      (dialect === "chat" ? "data: [DONE]\n\n" : ""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

export async function openAiProcessingJourney(
  options: {
    dialect: "chat" | "responses";
    mode: "standard" | "fast" | "provider-default";
    tier?: unknown;
    custom?: boolean;
    cost?: number;
    fetch?: OpenAiSdkFetch;
    signal?: AbortSignal;
    continueAt?: "standard";
  },
  register: (home: string) => void,
) {
  const home = await mkdtemp(join(tmpdir(), "falryn-openai-processing-"));
  register(home);
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  if (options.continueAt)
    await writeFile(join(workspace, "sample.txt"), "processing continuity evidence");
  const globals: GlobalOptions = {
    color: "never",
    format: "json",
    nonInteractive: true,
    profile: null,
    quiet: false,
    timeoutMs: null,
    verbose: false,
    workspace,
    addDirs: [],
    help: false,
    version: false,
  };
  const environment = createStaticEnvironment({
    FALRYN_CONFIG_DIR: join(home, "config"),
    FALRYN_STATE_DIR: join(home, "state"),
    FALRYN_TEST_OPENAI_KEY: "fixture-only",
  });
  const makeServices = () =>
    createServiceProvider(globals, {
      home: localPath(home),
      currentDirectory: localPath(workspace),
      environment,
    });
  const initial = makeServices();
  const capability = knownModelCapability(
    "openai",
    modelId.from("gpt-5.6-sol"),
    "https://api.openai.com/v1",
  );
  if (!capability) throw new Error("Missing fixture model");
  const profile: ProviderProfile = {
    profileId: "openai-processing",
    providerId: providerId.from("openai"),
    adapterKind: "openai",
    displayName: "OpenAI",
    endpoint: options.custom ? "https://gateway.example.test/v1" : "https://api.openai.com/v1",
    credential: {
      storeKind: "environment",
      locator: "FALRYN_TEST_OPENAI_KEY",
      consumer: "provider:openai",
      accountLabel: null,
    },
    organization: null,
    project: null,
    enabledModels: [modelId.from("gpt-5.6-sol")],
    modelCapabilities: options.custom ? [capability] : [],
    discovery: "static",
    transportCompatibility:
      options.dialect === "chat"
        ? OPENAI_CHAT_TRANSPORT_DEFAULT
        : OPENAI_RESPONSES_TRANSPORT_DEFAULT,
    timeouts: { connectMs: 1000, requestMs: 10000 },
  };
  const connections = composeProductProviderConnections(initial(), globals).service;
  for (const action of [
    { kind: "add", profile },
    { kind: "use", profileId: "openai-processing" },
  ] as const) {
    const result = await connections.execute(action);
    if (result.kind !== "completed") throw new Error(JSON.stringify(result));
  }
  const path = join(initial().configurationRoot, "falryn.jsonc");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.defaults ??= {};
  config.defaults.models ??= {};
  config.defaults.models.policy = {
    processing: { mode: options.mode },
    roles: {
      default: {
        providerProfileId: "openai-processing",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        reasoning: "balanced",
        budgets: {
          outputTokens: 100,
          attempts: options.continueAt ? 4 : 1,
          ...(options.cost === undefined ? {} : { cost: options.cost }),
        },
      },
    },
  };
  await writeFile(path, JSON.stringify(config));
  const services = makeServices();
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const runOptions = {
    globals,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    input: createRecordingCliStreams({ stdin: null }).input,
    openaiFetch: (async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)));
      return options.fetch
        ? options.fetch(input, init)
        : processingResponse(options.dialect, options.tier);
    }) satisfies OpenAiSdkFetch,
  };
  const result = await runCoding(
    services,
    { promptParts: [options.continueAt ? "Read sample.txt and reply briefly." : "Reply briefly."] },
    runOptions,
  );
  let followUp: Awaited<ReturnType<typeof runCoding>> | null = null;
  if (options.continueAt && result.outcome.kind === "completed" && result.payload?.sessionId) {
    config.defaults.models.policy.processing.mode = options.continueAt;
    await writeFile(path, JSON.stringify(config));
    followUp = await runCoding(
      services,
      {
        promptParts: ["Use the file you already read. Do not read it again."],
        session: result.payload.sessionId,
      },
      runOptions,
    );
  }
  const state = await openProductArtifactSession(services());
  if (!state) throw new Error("Missing durable store");
  try {
    const events = await state.eventStore.readFrom(
      { streamId: streamId.from(`live-turn:${result.payload?.sessionId}`), afterSequence: null },
      1000,
    );
    if (!events.ok) throw new Error("Event read failed");
    const receipts = events.value.flatMap((event) =>
      event.kind === "model.processing.recorded" ? [event.payload.receipt] : [],
    );
    return { result, followUp, bodies, urls, events, receipts };
  } finally {
    await state.close();
  }
}
