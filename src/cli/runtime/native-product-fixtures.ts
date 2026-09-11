/** Source and compiled proof through the production headless owner; only the model is scripted. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  configurationGeneration,
  createStaticEnvironment,
  streamId,
} from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { createDeterministicProviderAdapter } from "../../providers/index.ts";
import type { GlobalOptions } from "../options.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { runCoding } from "./coding-run.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { createServiceProvider } from "./services.ts";

const inputSchema = z.object({
  home: z.string(),
  name: z.string(),
  environment: z.record(z.string(), z.string()),
});
export async function nativeProductJourney(
  input: z.infer<typeof inputSchema>,
  beforeFirstRequest?: () => Promise<void>,
) {
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
