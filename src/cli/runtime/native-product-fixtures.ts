/** Source and compiled proof through the production headless owner; only the model is scripted. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ProductToolConfirmationPort } from "../../application/tools/product-tool-gateway.ts";
import {
  configurationGeneration,
  createStaticEnvironment,
  instant,
  streamId,
} from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import type { HookEgressOptions } from "../../integrations/extensions/host-hook-http.ts";
import { reduceTranscript } from "../../presentation/transcript/reducer.ts";
import {
  catalogFromAdapterModels,
  createDeterministicProviderAdapter,
  type DeterministicProviderScript,
  type ModelRequest,
} from "../../providers/index.ts";
import type { GlobalOptions } from "../options.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { runCoding } from "./coding-run.ts";
import { composeInstructionSources } from "./instruction-sources.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "./product-configuration.ts";
import { composeProductShellAttachments } from "./product-shell-attachments.ts";
import { createServiceProvider } from "./services.ts";

const inputSchema = z.object({
  home: z.string(),
  name: z.string(),
  environment: z.record(z.string(), z.string()),
});
async function productHost(input: {
  home: string;
  environment: Record<string, string>;
  hookEgress?: HookEgressOptions;
}) {
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
    ...(input.hookEgress === undefined ? {} : { hookEgress: input.hookEgress }),
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
  /** Wire the terminal's instruction-source owner, as dispatch does. */
  instructions?: boolean;
  /** The scripted model; a single text answer by default. */
  script?: (request: ModelRequest, index: number) => DeterministicProviderScript;
}) {
  const { globals, services } = await productHost(input);
  const graph = services();
  await graph.ensureWorkspaceSet();
  // Dispatch loads configuration before composing the terminal; instruction sources bind to it.
  if (input.instructions)
    await loadProductConfiguration(graph, productConfigurationLoadRequest(globals));
  const durable = await openProductArtifactSession(graph);
  if (!durable) throw new Error("native-fixture-store-unavailable");
  const requests: ModelRequest[] = [];
  const adapter = createDeterministicProviderAdapter({
    onRequest: (request) => requests.push(request),
    script: input.script ?? (() => ({ kind: "text", text: "Reviewed." })),
  });
  const controller = new AbortController();
  const attached = await composeProductShellAttachments({
    ...(input.instructions
      ? {
          instructionSources: (configuration: Parameters<typeof composeInstructionSources>[1]) =>
            composeInstructionSources(graph, configuration),
          sandboxConfiguration: () => graph.loader.current(),
        }
      : {}),
    publishNativePackages: durable.publishNativePackages,
    openReflection: durable.openReflection,
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
  options: {
    readonly beforeFirstRequest?: () => Promise<void>;
    readonly afterRun?: () => Promise<void>;
    /** Test egress for package HTTP hooks; the compiled journey never passes one. */
    readonly hookEgress?: HookEgressOptions;
    /** The user's answer to focused tool confirmations, such as a hook's MCP call. */
    readonly toolConfirmation?: ProductToolConfirmationPort;
    /**
     * How the scripted model answers a package evaluator hook: every request that asks for
     * a structured verdict, numbered among those requests. Main-turn requests are unaffected.
     */
    readonly evaluate?: (request: ModelRequest, index: number) => DeterministicProviderScript;
  } = {},
) {
  const { beforeFirstRequest, afterRun, hookEgress, toolConfirmation, evaluate } = options;
  const { globals, services } = await productHost({
    ...input,
    ...(hookEgress === undefined ? {} : { hookEgress }),
  });
  const requests: string[] = [];
  let turns = 0;
  let evaluations = 0;
  const provider = createDeterministicProviderAdapter({
    onRequest: (request) => requests.push(JSON.stringify(request)),
    script: (request) => {
      if (request.output.kind === "json-schema" && evaluate)
        return evaluate(request, evaluations++);
      return turns++ === 0
        ? {
            kind: "tool",
            name: input.name,
            toolCallId: "native-fixture",
            argumentFragments: [JSON.stringify({ question: "answer" })],
          }
        : { kind: "text", text: "The fixture answered 42." };
    },
  });
  const result = await runCoding(
    services,
    { promptParts: ["Read the native fixture answer using the fixture health tool."] },
    {
      globals,
      input: createRecordingCliStreams({ stdin: null }).input,
      ...(toolConfirmation === undefined ? {} : { toolConfirmation }),
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

/**
 * The transcript notices a journey's stored history projects for completed async hook
 * observers. Projection is passive: it reads the journal and runs nothing.
 */
export function observerNotices(journey: Awaited<ReturnType<typeof nativeProductJourney>>) {
  if (!journey.events?.ok) return [];
  return reduceTranscript(journey.events.value).blocks.flatMap((block) =>
    block.kind === "notice" && / observed /u.test(block.summary.text) ? [block.summary.text] : [],
  );
}

if (import.meta.main)
  console.log(
    JSON.stringify(
      await nativeProductJourney(inputSchema.parse(JSON.parse(process.argv.at(-1) ?? "{}"))),
    ),
  );
