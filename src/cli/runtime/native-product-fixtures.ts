/** Source and compiled proof through the production headless owner; only the model is scripted. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  configurationGeneration,
  createStaticEnvironment,
  instant,
  streamId,
} from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import {
  catalogFromAdapterModels,
  createDeterministicProviderAdapter,
  type ModelRequest,
} from "../../providers/index.ts";
import type { GlobalOptions } from "../options.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { runCoding } from "./coding-run.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { composeProductShellAttachments } from "./product-shell-attachments.ts";
import { createServiceProvider } from "./services.ts";

const inputSchema = z.object({
  home: z.string(),
  name: z.string(),
  environment: z.record(z.string(), z.string()),
});
async function productHost(input: { home: string; environment: Record<string, string> }) {
  const workspace = join(input.home, "workspace");
  await mkdir(workspace, { recursive: true });
  const globals: GlobalOptions = {
    format: "json",
    color: "never",
    quiet: false,
    verbose: false,
    nonInteractive: true,
    workspace,
    addDirs: [],
    profile: null,
    timeoutMs: null,
    help: false,
    version: false,
  };
  const services = createServiceProvider(globals, {
    home: localPath(input.home),
    currentDirectory: localPath(workspace),
    environment: createStaticEnvironment(input.environment),
  });
  return { globals, services };
}

/**
 * Headless run of one prompt; the scripted model only answers with text. With
 * a session, the run continues it; the session's durable events are returned.
 */
export async function nativePromptJourney(input: {
  home: string;
  environment: Record<string, string>;
  prompt: string;
  session?: string;
}) {
  const { globals, services } = await productHost(input);
  const requests: string[] = [];
  const provider = createDeterministicProviderAdapter({
    onRequest: (request) => requests.push(JSON.stringify(request)),
    script: () => ({ kind: "text", text: "Reviewed." }),
  });
  const result = await runCoding(
    services,
    {
      promptParts: [input.prompt],
      ...(input.session === undefined ? {} : { session: input.session }),
    },
    {
      globals,
      input: createRecordingCliStreams({ stdin: null }).input,
      providerAdapter: provider,
    },
  );
  const sessionId = input.session ?? result.payload?.sessionId;
  const session = await openProductArtifactSession(services());
  if (!session) throw new Error("native-fixture-store-unavailable");
  try {
    const read =
      sessionId === undefined
        ? null
        : await session.eventStore.readFrom(
            { streamId: streamId.from("live-turn:" + sessionId), afterSequence: null },
            1_000,
          );
    if (read !== null && !read.ok) throw new Error("native-fixture-events-unavailable");
    return { result, requests, events: read === null ? [] : read.value };
  } finally {
    await session.close();
  }
}

/**
 * The terminal host's production attachments over the same installed packages:
 * durable native publication and ordinary submission; only the model is scripted.
 */
export async function nativePromptShellJourney(input: {
  home: string;
  environment: Record<string, string>;
}) {
  const { services } = await productHost(input);
  const graph = services();
  await graph.ensureWorkspaceSet();
  const durable = await openProductArtifactSession(graph);
  if (!durable) throw new Error("native-fixture-store-unavailable");
  const requests: ModelRequest[] = [];
  const adapter = createDeterministicProviderAdapter({
    onRequest: (request) => requests.push(request),
    script: () => ({ kind: "text", text: "Reviewed." }),
  });
  const controller = new AbortController();
  const attached = await composeProductShellAttachments({
    publishNativePackages: durable.publishNativePackages,
    rehydrateExtensions: durable.rehydrateExtensions,
    records: durable.records,
    eventStore: durable.eventStore,
    clock: graph.clock,
    fileSystem: graph.fileSystem,
    workspaceSet: graph.workspaceSet,
    configurationGeneration: graph.loader.current()?.generation ?? configurationGeneration.from(1),
    artifacts: durable.artifacts,
    signal: controller.signal,
    provider: {
      kind: "ready",
      adapter,
      session: {
        kind: "ready",
        release: async () => {},
        connection: {
          profile: {
            ...adapter.identity,
            endpoint: null,
            credential: null,
            organization: null,
            project: null,
            enabledModels: [...adapter.supportedModels],
            transportCompatibility: null,
            modelCapabilities: [],
            discovery: "static",
            timeouts: { connectMs: 1_000, requestMs: 10_000 },
          },
          account: null,
          updatedAt: graph.clock.now(),
        },
        auth: {
          profileId: adapter.identity.profileId,
          state: "ready",
          consumer: "provider:native-prompt",
          observedAt: instant(0),
          health: null,
          code: null,
          retryable: false,
        },
        catalog: catalogFromAdapterModels(adapter.supportedModels, {
          generation: 0,
          fetchedAt: instant(0),
          capabilities: adapter.modelCapabilities,
        }),
      },
    },
  });
  if (!attached) throw new Error("native-fixture-shell-unavailable");
  return {
    attached,
    requests,
    async close() {
      controller.abort();
      await attached.close();
      await durable.close();
    },
  };
}

export async function nativeProductJourney(
  input: z.infer<typeof inputSchema>,
  beforeFirstRequest?: () => Promise<void>,
  afterRun?: () => Promise<void>,
) {
  const { globals, services } = await productHost(input);
  const requests: string[] = [];
  const provider = createDeterministicProviderAdapter({
    onRequest: (request) => requests.push(JSON.stringify(request)),
    script: (_request, index) =>
      index === 0
        ? {
            kind: "tool",
            name: input.name,
            toolCallId: "native-fixture",
            argumentFragments: [JSON.stringify({ question: "answer" })],
          }
        : { kind: "text", text: "The fixture answered 42." },
  });
  const result = await runCoding(
    services,
    { promptParts: ["Read the native fixture answer using the fixture health tool."] },
    {
      globals,
      input: createRecordingCliStreams({ stdin: null }).input,
      providerAdapter: {
        ...provider,
        async *stream(request, options) {
          if (requests.length === 0) await beforeFirstRequest?.();
          yield* provider.stream(request, options);
        },
      },
    },
  );
  await afterRun?.();
  const session = await openProductArtifactSession(services());
  if (!session) throw new Error("native-fixture-store-unavailable");
  try {
    const published = await session.publishNativePackages(
      services().loader.current()?.generation ?? configurationGeneration.from(1),
      new AbortController().signal,
    );
    const events = result.payload?.sessionId
      ? await session.eventStore.readFrom(
          { streamId: streamId.from(`live-turn:${result.payload.sessionId}`), afterSequence: null },
          100,
        )
      : null;
    return {
      result,
      requests,
      catalog: published.catalog,
      events,
    };
  } finally {
    await session.close();
  }
}
if (import.meta.main)
  console.log(
    JSON.stringify(
      await nativeProductJourney(inputSchema.parse(JSON.parse(process.argv.at(-1) ?? "{}"))),
    ),
  );
