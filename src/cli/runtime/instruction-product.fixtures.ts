/** Real files, configuration writer, persistence and headless hosting; only inference is scripted. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeConfigurationValue } from "../../config/index.ts";
import type { ConfigurationValue } from "../../domain/configuration/index.ts";
import { createStaticEnvironment, streamId } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import {
  createDeterministicProviderAdapter,
  type DeterministicProviderScript,
  type ModelRequest,
} from "../../providers/index.ts";
import { runConfigReset } from "../commands/config.ts";
import type { GlobalOptions } from "../options.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { runCoding } from "./coding-run.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { createServiceProvider } from "./services.ts";

export async function instructionProduct(home: string, addDirs: readonly string[] = []) {
  const workspace = join(home, "workspace");
  for (const path of [workspace, join(home, "config"), join(home, "state")])
    await mkdir(path, { recursive: true, mode: 0o700 });
  const globals: GlobalOptions = {
    format: "json",
    color: "never",
    quiet: false,
    verbose: false,
    nonInteractive: true,
    workspace,
    addDirs: [...addDirs],
    profile: null,
    timeoutMs: null,
    help: false,
    version: false,
  };
  const services = createServiceProvider(globals, {
    home: localPath(home),
    currentDirectory: localPath(workspace),
    environment: createStaticEnvironment({
      FALRYN_CONFIG_DIR: join(home, "config"),
      FALRYN_STATE_DIR: join(home, "state"),
    }),
  });
  async function setting(key: string, value: unknown, scope: "user" | "project" = "user") {
    const graph = services();
    const result = await writeConfigurationValue(graph.registry, graph.fileSystem, {
      configurationRoot: graph.configurationRoot,
      legacyConfigurationRoot: graph.legacyConfigurationRoot,
      workspaceRoot: graph.workspaceRoot,
      profile: null,
      keyPath: key,
      value: value as ConfigurationValue,
      scope,
    });
    if (result.kind !== "written") throw new Error(JSON.stringify(result));
  }
  async function reset(key: string, scope: "user" | "project" = "user") {
    const result = await runConfigReset(
      services,
      { keyPath: key, rawValue: "", scope, expectedRevision: null },
      globals,
    );
    if (result.outcome.kind !== "completed") throw new Error(JSON.stringify(result));
  }
  async function run(
    beforeResponse?: () => Promise<void>,
    script?: (request: ModelRequest, index: number) => DeterministicProviderScript,
  ) {
    await services().ensureWorkspaceSet();
    await services().workspaceTrust.resolve(async () => "proceed");
    const requests: ModelRequest[] = [];
    const provider = createDeterministicProviderAdapter({
      script: script ?? { kind: "text", text: "instructions observed" },
      onRequest: (request) => requests.push(request),
    });
    const result = await runCoding(
      services,
      { promptParts: ["Follow the applicable instructions."] },
      {
        globals,
        input: createRecordingCliStreams({ stdin: null }).input,
        providerAdapter: {
          ...provider,
          async *stream(request, options) {
            await beforeResponse?.();
            yield* provider.stream(request, options);
          },
        },
      },
    );
    const session = await openProductArtifactSession(services());
    if (!session) throw new Error("instruction-fixture-store-unavailable");
    try {
      const events = result.payload?.sessionId
        ? await session.eventStore.readFrom(
            {
              streamId: streamId.from(`live-turn:${result.payload.sessionId}`),
              afterSequence: null,
            },
            100,
          )
        : null;
      return { result, requests, events };
    } finally {
      await session.close();
    }
  }
  return { workspace, globals, services, setting, reset, run };
}
