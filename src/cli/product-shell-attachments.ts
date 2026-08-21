/**
 * Default TUI product attachments (#752 / #711 / #712).
 *
 * Composes the product agent runtime, credentials, OpenAI-compatible adapter
 * (when a key resolves), and product tools (#711 workspace + #712 process) so
 * `launchShell` can pass a real submission port and transcript feed into
 * `runShell`.
 */

import {
  composeProductAgentRuntime,
  composeProductCredentials,
  composeProductGitTools,
  composeProductProcessTools,
  composeProductWorkspaceTools,
  DEFAULT_OPENAI_CREDENTIAL_REFERENCE,
  mergeProductToolBundles,
  resolveProviderApiKey,
} from "../application/index.ts";
import {
  type ClockPort,
  configurationGeneration,
  type EnvironmentPort,
  type EventStorePort,
  type FileSystemPort,
  type LocalDataPlatform,
  primaryWorkspaceRoot,
  sessionId as sessionIdCodec,
  streamId,
  traceId as traceIdCodec,
  type WorkspaceSet,
  workspaceId as workspaceIdCodec,
} from "../domain/index.ts";
import {
  createHostCommandRunner,
  createHostGitPort,
  createHostProcessCapturePort,
  hostPlatform,
} from "../integrations/index.ts";
import { createOpenAiCompatibleAdapter } from "../providers/openai-compatible-adapter.ts";
import type { ProviderAdapterPort } from "../providers/port.ts";
import { createProductSubmissionPort, type SubmissionPort } from "../tui/composer/index.ts";
import { type TranscriptFeed, transcriptFeedFromProducer } from "../tui/transcript-feed.ts";
import { CLI_EVENT_STREAM } from "./services.ts";

export type ProductShellAttachmentPorts = {
  readonly eventStore: EventStorePort;
  readonly clock: ClockPort;
  readonly environment: EnvironmentPort;
  readonly fileSystem: FileSystemPort;
  readonly workspaceSet: WorkspaceSet | null;
  readonly signal?: AbortSignal;
  readonly platform?: LocalDataPlatform;
  readonly commands?: ReturnType<typeof createHostCommandRunner>;
};

export type ProductShellAttachments = {
  readonly submission: SubmissionPort;
  readonly transcriptFeed: TranscriptFeed;
};

/**
 * Build submission + transcript attachments for the default TUI launch.
 * Returns null when product composition fails closed (shell may still open).
 */
export async function composeProductShellAttachments(
  ports: ProductShellAttachmentPorts,
): Promise<ProductShellAttachments | null> {
  const now = ports.clock.now();
  const workspaceId = workspaceIdCodec.from(
    ports.workspaceSet === null
      ? "workspace-unbound"
      : primaryWorkspaceRoot(ports.workspaceSet).rootId,
  );
  const sessionId = sessionIdCodec.from(`session-shell-${now}`);
  const traceId = traceIdCodec.from(`trace-shell-${now}`);
  const generation = configurationGeneration.from(0);
  const commands = ports.commands ?? createHostCommandRunner();

  let providerAdapter: ProviderAdapterPort | undefined;
  const credentials = composeProductCredentials({
    clock: ports.clock,
    commands,
    platform: ports.platform ?? hostPlatform(),
    environment: ports.environment,
  });
  const apiKey = await resolveProviderApiKey(
    credentials.resolver,
    DEFAULT_OPENAI_CREDENTIAL_REFERENCE,
    ports.signal,
  );
  if (apiKey !== null) {
    providerAdapter = createOpenAiCompatibleAdapter({
      profileId: "openai",
      baseUrl: "https://api.openai.com/v1",
      resolveApiKey: async () => apiKey,
    });
  }

  const workspaceTools =
    ports.workspaceSet === null
      ? null
      : composeProductWorkspaceTools({
          generation,
          fileSystem: ports.fileSystem,
          commands,
          workspaceRoot: primaryWorkspaceRoot(ports.workspaceSet).path,
        });
  const processTools =
    ports.workspaceSet === null
      ? null
      : composeProductProcessTools({
          generation,
          capture: createHostProcessCapturePort({ clock: ports.clock }),
          workspaceCwd: String(primaryWorkspaceRoot(ports.workspaceSet).path),
        });
  const gitTools =
    ports.workspaceSet === null
      ? null
      : composeProductGitTools({
          generation,
          git: createHostGitPort({
            capture: createHostProcessCapturePort({ clock: ports.clock }),
            clock: ports.clock,
          }),
          gitExecutable: "/usr/bin/git",
          startPath: String(primaryWorkspaceRoot(ports.workspaceSet).path),
        });
  const productTools =
    workspaceTools === null || processTools === null || gitTools === null
      ? null
      : mergeProductToolBundles(generation, [workspaceTools, processTools, gitTools]);

  const composed = composeProductAgentRuntime({
    eventStore: ports.eventStore,
    clock: ports.clock,
    streamId: streamId.from(CLI_EVENT_STREAM),
    correlation: {
      workspaceId,
      sessionId,
      traceId,
      configurationGeneration: generation,
    },
    ...(providerAdapter === undefined ? {} : { providerAdapter }),
    ...(productTools === null
      ? {}
      : { toolCatalog: productTools.catalog, toolRunner: productTools.runner }),
  });
  if (!composed.ok) {
    return null;
  }

  const producer = composed.value.attachments.turnProducer;
  return {
    submission: createProductSubmissionPort({
      producer,
      workspaceId,
      sessionId,
      traceId,
      configurationGeneration: generation,
      isAccepting: () => ports.signal === undefined || !ports.signal.aborted,
    }),
    transcriptFeed: transcriptFeedFromProducer(producer),
  };
}
