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
  composeProductGitTools,
  composeProductIndexLifecycle,
  composeProductLanguageTools,
  composeProductMemoryTools,
  composeProductProcessTools,
  composeProductWorkspaceTools,
  createDebugAdapterSupervisor,
  createEphemeralProductIndexPort,
  createLanguageServerSupervisor,
  type LoomPort,
  mergeProductToolBundles,
} from "../application/index.ts";
import {
  type ArtifactStorePort,
  type ClockPort,
  type ConfigurationGeneration,
  type EnvironmentPort,
  type EventStorePort,
  type FileSystemPort,
  primaryWorkspaceRoot,
  sessionId as sessionIdCodec,
  streamId,
  traceId as traceIdCodec,
  type WorkspaceIndexPort,
  type WorkspaceIndexWritePort,
  type WorkspaceSet,
  workspaceId as workspaceIdCodec,
} from "../domain/index.ts";
import {
  createHostCommandRunner,
  createHostGitPort,
  createHostManagedServicePort,
  createHostProcessCapturePort,
  type OwnedProcessRegistry,
} from "../integrations/index.ts";
import { createProductSubmissionPort, type SubmissionPort } from "../tui/composer/index.ts";
import type { ControlCatalog } from "../tui/controls/index.ts";
import { type TranscriptFeed, transcriptFeedFromProducer } from "../tui/transcript-feed.ts";
import type { ProductProviderConnectionHandoff } from "./product-provider-connections.ts";
import { CLI_EVENT_STREAM } from "./services.ts";

export type ProductShellAttachmentPorts = {
  readonly eventStore: EventStorePort;
  readonly clock: ClockPort;
  /** Compatibility input retained for callers; provider auth is now composed before this seam. */
  readonly environment?: EnvironmentPort;
  readonly fileSystem: FileSystemPort;
  readonly workspaceSet: WorkspaceSet | null;
  /** From the loader after a durable load (#728); not hardcoded generation zero. */
  readonly configurationGeneration: ConfigurationGeneration;
  readonly signal?: AbortSignal;
  readonly commands?: ReturnType<typeof createHostCommandRunner>;
  readonly ownedProcesses?: OwnedProcessRegistry;
  /** Durable exact-output storage and optional shared Loom lifecycle (#814). */
  readonly artifacts?: ArtifactStorePort;
  readonly loom?: LoomPort;
  readonly index?: WorkspaceIndexPort & WorkspaceIndexWritePort;
  /** Selected, authenticated provider handoff from the application-owned profile service. */
  readonly provider?: ProductProviderConnectionHandoff;
};

export type ProductShellAttachments = {
  readonly submission: SubmissionPort;
  readonly transcriptFeed: TranscriptFeed;
  readonly controls: ControlCatalog;
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
  const generation = ports.configurationGeneration;
  const commands =
    ports.commands ??
    createHostCommandRunner(
      ports.ownedProcesses === undefined ? {} : { ownedProcesses: ports.ownedProcesses },
    );

  const providerAdapter = ports.provider?.kind === "ready" ? ports.provider.adapter : undefined;

  const workspaceRoot =
    ports.workspaceSet === null ? null : primaryWorkspaceRoot(ports.workspaceSet).path;
  const index =
    workspaceRoot === null || ports.artifacts === undefined
      ? undefined
      : (ports.index ?? createEphemeralProductIndexPort());
  if (workspaceRoot !== null && index !== undefined) {
    await composeProductIndexLifecycle({
      fileSystem: ports.fileSystem,
      workspaceRoot,
      index,
    }).rebuild(ports.signal);
  }

  const workspaceTools =
    workspaceRoot === null
      ? null
      : composeProductWorkspaceTools({
          generation,
          fileSystem: ports.fileSystem,
          commands,
          workspaceRoot,
          ...(ports.artifacts === undefined ? {} : { artifacts: ports.artifacts }),
          ...(ports.loom === undefined ? {} : { loom: ports.loom }),
          ...(index === undefined ? {} : { index }),
          workspaceId,
          sessionId,
        });
  const processTools =
    workspaceRoot === null
      ? null
      : composeProductProcessTools({
          generation,
          capture: createHostProcessCapturePort({
            clock: ports.clock,
            ...(ports.ownedProcesses === undefined ? {} : { ownedProcesses: ports.ownedProcesses }),
          }),
          workspaceCwd: String(workspaceRoot),
        });
  const gitTools =
    workspaceRoot === null
      ? null
      : composeProductGitTools({
          generation,
          git: createHostGitPort({
            capture: createHostProcessCapturePort({
              clock: ports.clock,
              ...(ports.ownedProcesses === undefined
                ? {}
                : { ownedProcesses: ports.ownedProcesses }),
            }),
            clock: ports.clock,
          }),
          gitExecutable: "/usr/bin/git",
          startPath: String(workspaceRoot),
        });
  const managedServices = createHostManagedServicePort(
    ports.ownedProcesses === undefined ? {} : { ownedProcesses: ports.ownedProcesses },
  );
  const languageTools =
    workspaceRoot === null
      ? null
      : composeProductLanguageTools({
          generation,
          languageServers: createLanguageServerSupervisor(managedServices),
          debugAdapters: createDebugAdapterSupervisor(managedServices),
        });
  const memoryTools = workspaceRoot === null ? null : composeProductMemoryTools({ generation });
  const productTools =
    workspaceTools === null ||
    processTools === null ||
    gitTools === null ||
    languageTools === null ||
    memoryTools === null
      ? null
      : mergeProductToolBundles(generation, [
          workspaceTools,
          processTools,
          gitTools,
          languageTools,
          memoryTools,
        ]);

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
      ...(workspaceTools === null ? {} : { contextCandidates: workspaceTools.contextCandidates }),
    }),
    transcriptFeed: transcriptFeedFromProducer(producer),
    controls: providerControls(ports.provider),
  };
}

function providerControls(provider: ProductProviderConnectionHandoff | undefined): ControlCatalog {
  const ready = provider?.kind === "ready" ? provider.session : null;
  const profile = ready?.connection.profile ?? null;
  return {
    sessions: [],
    models:
      ready?.catalog.models.map((model) => ({
        id: String(model.modelId),
        title: String(model.modelId),
        detail: [
          profile?.displayName ?? "provider",
          model.modalities.join("+"),
          model.tools ? "tools" : "no tools",
          model.reasoning ? "reasoning" : "standard",
        ].join(" · "),
      })) ?? [],
    context: [
      { label: "tokens", value: { kind: "unavailable", reason: "no context pack yet" } },
      { label: "bytes", value: { kind: "unavailable", reason: "no context pack yet" } },
      { label: "items", value: { kind: "unavailable", reason: "no context pack yet" } },
    ],
    resources: [
      {
        label: "provider",
        value:
          profile === null
            ? {
                kind: "unavailable",
                reason:
                  provider?.kind === "unavailable"
                    ? `${provider.code}; run falryn provider list or falryn provider test <id>`
                    : "not connected; run falryn provider list",
              }
            : { kind: "known", text: profile.displayName },
      },
      { label: "memory", value: { kind: "unavailable", reason: "no resource probe yet" } },
      { label: "tokens", value: { kind: "unavailable", reason: "no usage yet" } },
    ],
  };
}
