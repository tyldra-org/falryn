/**
 * Default live-product attachments for the TUI.
 *
 * Composes the durable session host, authenticated provider, product tools,
 * shared live-turn executor, transcript feed, and session-creation control so
 * `launchShell` can attach one application-owned runtime to `runShell`.
 */

import { randomUUID } from "node:crypto";
import type { ScratchResourcePort } from "../../application/artifacts/index.ts";
import {
  composeProductBriefControls,
  composeProductOutputControls,
  type LoomPort,
} from "../../application/compression/index.ts";
import {
  createProductContextSource,
  createUnavailableProductContextSource,
} from "../../application/context/index.ts";
import { createDebugAdapterSupervisor } from "../../application/debugging/index.ts";
import { createLanguageServerSupervisor } from "../../application/language/index.ts";
import { composeProductMemoryTurn, type MemoryRecords } from "../../application/memory/index.ts";
import {
  executePeerAction,
  peerActionSchema,
} from "../../application/orchestration/peer-actions.ts";
import type { ProcessTaskNotices } from "../../application/orchestration/process-task-notices.ts";
import type { ProcessTaskSupervisor } from "../../application/orchestration/process-task-supervisor.ts";
import { composeDelegatedAgentRuntime } from "../../application/runtime/delegated-agent-runtime.ts";
import {
  composeProductAgentRuntime,
  createProductLiveTurnExecutor,
} from "../../application/runtime/index.ts";
import {
  composeProductGitTools,
  composeProductLanguageTools,
  composeProductMemoryTools,
  composeProductProcessTools,
  composeProductScratchTools,
  composeProductWorkspaceTools,
  mergeProductToolBundles,
  type ProductToolConfirmationPort,
} from "../../application/tools/index.ts";
import { composePeerTool } from "../../application/tools/peer-tool.ts";
import { composeProductIndexLifecycle } from "../../application/workspace/index.ts";
import type { ArtifactStorePort } from "../../domain/artifacts/index.ts";
import {
  type ClockPort,
  type ConfigurationGeneration,
  type EnvironmentPort,
  sessionId as sessionIdCodec,
  streamId,
  traceId as traceIdCodec,
  workspaceId as workspaceIdCodec,
} from "../../domain/foundation/index.ts";
import type { ProcessCapturePort } from "../../domain/process/index.ts";
import {
  type EventStorePort,
  EXECUTION_PROFILES,
  type ExecutionProfileId,
  executionProfile,
} from "../../domain/sessions/index.ts";
import {
  type FileSystemPort,
  primaryWorkspaceRoot,
  type WorkspaceIndexPort,
  type WorkspaceIndexWritePort,
  type WorkspaceSet,
} from "../../domain/workspace/index.ts";
import {
  createHostCommandRunner,
  createHostGitPort,
  createHostManagedServicePort,
  createHostProcessCapturePort,
  type OwnedProcessRegistry,
} from "../../integrations/index.ts";
import { type ProviderModelIdentity, providerModelIdentityKey } from "../../providers/index.ts";
import {
  createProductSubmissionPort,
  type ProductSubmissionPort,
  type SubmissionPort,
} from "../../tui/composer/index.ts";
import type { ControlCatalog } from "../../tui/controls/index.ts";
import type { SessionCreationPort } from "../../tui/shell/session-creation.ts";
import type { TranscriptFeed } from "../../tui/transcript/transcript-feed.ts";
import type { ProductProviderConnectionHandoff } from "./product-provider-connections.ts";

export type ProductShellAttachmentPorts = {
  readonly peers?: import("./product-peer-mailboxes.ts").ProductPeerMailboxes;
  readonly resolveAgentProvider?: import("../../application/runtime/delegated-agent-runtime.ts").DelegatedRuntimeOptions["resolveProvider"];
  readonly agentRegistry?: import("../../application/orchestration/agent-registry.ts").AgentRegistry;
  readonly modelPreferences?: () => import("../../providers/configuration/policy-schema.ts").ModelPreferences;
  readonly modelConfigurationGeneration?: () => ConfigurationGeneration;
  readonly modelSettings?: import("../../application/providers/model-settings.ts").ModelSettingsService;
  /** Durable in production; tests may inject the in-memory event-store double. */
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
  readonly scratch?: ScratchResourcePort;
  /** Injectable process host for deterministic public-entrypoint integration tests. */
  readonly processCapture?: ProcessCapturePort;
  readonly tasks?: ProcessTaskSupervisor;
  readonly joins?: import("../../application/orchestration/agent-joins.ts").AgentJoins;
  readonly taskNotices?: ProcessTaskNotices;
  /** Application-owned focused confirmation host for consequential tool calls. */
  readonly toolConfirmation?: ProductToolConfirmationPort;
  readonly index?: WorkspaceIndexPort & WorkspaceIndexWritePort;
  readonly memoryRecords?: MemoryRecords;
  /** Selected, authenticated provider handoff from the application-owned profile service. */
  readonly provider?: ProductProviderConnectionHandoff;
};

export type ProductShellAttachments = {
  readonly submission: ProductSubmissionPort;
  readonly transcriptFeed: TranscriptFeed;
  readonly sessionCreation: SessionCreationPort;
  readonly controls: ControlCatalog;
};

/**
 * Build submission + transcript attachments for the default TUI launch.
 * Returns null when product composition fails closed (shell may still open).
 */
export async function composeProductShellAttachments(
  ports: ProductShellAttachmentPorts,
): Promise<ProductShellAttachments | null> {
  const workspaceId = workspaceIdCodec.from(
    ports.workspaceSet === null
      ? "workspace-unbound"
      : primaryWorkspaceRoot(ports.workspaceSet).rootId,
  );
  const generation = ports.configurationGeneration;
  const commands =
    ports.commands ??
    createHostCommandRunner(
      ports.ownedProcesses === undefined ? {} : { ownedProcesses: ports.ownedProcesses },
    );

  const providerAdapter = ports.provider?.kind === "ready" ? ports.provider.adapter : undefined;
  const providerProfile =
    ports.provider?.kind === "ready" ? ports.provider.session.connection.profile : null;
  const defaultModelId =
    ports.provider?.kind === "ready"
      ? ports.provider.session.catalog.models.find((model) => model.availability !== "unavailable")
          ?.modelId
      : undefined;
  let selectedModel: ProviderModelIdentity | null =
    ports.modelPreferences?.().roles.default ??
    (providerProfile === null || defaultModelId === undefined
      ? null
      : {
          providerProfileId: providerProfile.profileId,
          providerId: providerProfile.providerId,
          modelId: defaultModelId,
        });
  let selectedModelExplicit = false;

  const workspaceRoot =
    ports.workspaceSet === null ? null : primaryWorkspaceRoot(ports.workspaceSet).path;
  const index = workspaceRoot === null ? undefined : ports.index;
  const indexLifecycle =
    workspaceRoot === null || index === undefined
      ? null
      : composeProductIndexLifecycle({
          fileSystem: ports.fileSystem,
          workspaceRoot,
          index,
        });
  if (indexLifecycle !== null) {
    await indexLifecycle.rebuild(ports.signal);
  }

  const managedServices = createHostManagedServicePort(
    ports.ownedProcesses === undefined ? {} : { ownedProcesses: ports.ownedProcesses },
  );
  let selectedExecutionProfile: ExecutionProfileId = "agent";
  const brief = composeProductBriefControls({
    initialVerbosity: executionProfile(selectedExecutionProfile).defaultBriefVerbosity,
  });
  const output = composeProductOutputControls();

  async function buildSession() {
    const sessionId = sessionIdCodec.from(`session-shell-${randomUUID()}`);
    const traceId = traceIdCodec.from(`trace-shell-${randomUUID()}`);
    const workspaceTools =
      workspaceRoot === null
        ? null
        : composeProductWorkspaceTools({
            ...(ports.scratch === undefined ? {} : { scratch: ports.scratch }),
            generation,
            fileSystem: ports.fileSystem,
            commands,
            workspaceRoot,
            ...(ports.artifacts === undefined ? {} : { artifacts: ports.artifacts }),
            ...(ports.loom === undefined ? {} : { loom: ports.loom }),
            ...(index === undefined ? {} : { index }),
            workspaceId,
            sessionId,
            userReadOutputMode: output.getLoomMode,
          });
    const processTools =
      workspaceRoot === null
        ? null
        : composeProductProcessTools({
            generation,
            ...(ports.tasks === undefined ? {} : { tasks: ports.tasks }),
            capture:
              ports.processCapture ??
              createHostProcessCapturePort({
                clock: ports.clock,
                ...(ports.artifacts === undefined ? {} : { artifacts: ports.artifacts }),
                ...(ports.ownedProcesses === undefined
                  ? {}
                  : { ownedProcesses: ports.ownedProcesses }),
              }),
            workspaceCwd: String(workspaceRoot),
            ...(ports.artifacts === undefined ? {} : { artifacts: ports.artifacts }),
            ...(ports.loom === undefined ? {} : { loom: ports.loom }),
            workspaceId: String(workspaceId),
            sessionId: String(sessionId),
            ...(ports.scratch === undefined ? {} : { scratch: ports.scratch }),
            userOutputMode: output.getHushMode,
          });
    const scratchTools =
      ports.scratch === undefined
        ? null
        : composeProductScratchTools({ generation, scratch: ports.scratch, sessionId });
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
    const languageTools =
      workspaceRoot === null
        ? null
        : composeProductLanguageTools({
            generation,
            languageServers: createLanguageServerSupervisor(managedServices),
            debugAdapters: createDebugAdapterSupervisor(managedServices, {
              confirmationPolicy: "auto-allow",
              ...(ports.artifacts === undefined ? {} : { artifacts: ports.artifacts }),
            }),
            fileSystem: ports.fileSystem,
            workspaceRoot,
          });
    const memoryTools =
      workspaceRoot === null
        ? null
        : composeProductMemoryTools({
            generation,
            ...(ports.memoryRecords === undefined ? {} : { records: ports.memoryRecords }),
          });
    const peer =
      (await ports.peers?.open({ sessionId: String(sessionId), agentId: "main", generation: 1 })) ??
      null;
    const productTools =
      workspaceTools === null ||
      processTools === null ||
      gitTools === null ||
      languageTools === null ||
      memoryTools === null
        ? null
        : mergeProductToolBundles(
            generation,
            [
              workspaceTools,
              processTools,
              ...(scratchTools === null ? [] : [scratchTools]),
              gitTools,
              languageTools,
              memoryTools,
              composePeerTool(generation, peer),
            ],
            {
              afterMutation: async (request) => {
                if (
                  request.toolName === "scratch_write" ||
                  request.toolName === "scratch_discard" ||
                  request.toolName === "process_task"
                ) {
                  return {};
                }
                workspaceTools.invalidateContext();
                const languageDiagnostics = await languageTools.afterWorkspaceMutation(
                  request.signal,
                );
                if (indexLifecycle === null) {
                  return {
                    workspaceIndex: { status: "unavailable", code: "index-unavailable" },
                    languageDiagnostics,
                  };
                }
                const refreshed = await indexLifecycle.refresh(request.signal);
                return {
                  workspaceIndex: refreshed.ok
                    ? { status: "completed" }
                    : { status: "unavailable", code: refreshed.error.code },
                  languageDiagnostics,
                };
              },
            },
          );
    const { tasks, artifacts, modelConfigurationGeneration } = ports;
    const compose =
      tasks && artifacts
        ? (runtimePorts: Parameters<typeof composeProductAgentRuntime>[0]) =>
            composeDelegatedAgentRuntime(runtimePorts, {
              tasks,
              ...(ports.joins ? { joins: ports.joins } : {}),
              ...(ports.peers ? { peers: ports.peers } : {}),
              artifacts,
              ...(ports.agentRegistry ? { registry: ports.agentRegistry } : {}),
              ...(ports.resolveAgentProvider
                ? { resolveProvider: ports.resolveAgentProvider }
                : {}),
              providerCatalog:
                ports.provider?.kind === "ready" ? ports.provider.session.catalog : null,
              ...(ports.modelPreferences ? { preferences: ports.modelPreferences } : {}),
              ...(modelConfigurationGeneration
                ? { configurationGeneration: () => Number(modelConfigurationGeneration()) }
                : {}),
            })
        : composeProductAgentRuntime;
    const composed = compose({
      eventStore: ports.eventStore,
      clock: ports.clock,
      streamId: streamId.from(`live-turn:${String(sessionId)}`),
      correlation: {
        workspaceId,
        sessionId,
        traceId,
        configurationGeneration: generation,
      },
      ...(providerAdapter === undefined ? {} : { providerAdapter }),
      ...(ports.toolConfirmation === undefined ? {} : { toolConfirmation: ports.toolConfirmation }),
      ...(productTools === null
        ? {}
        : {
            toolRegistry: productTools.registry,
            capabilityRegistry: productTools.capabilityRegistry,
            toolCatalog: productTools.catalog,
            toolRunner: productTools.runner,
          }),
    });
    if (!composed.ok) {
      return null;
    }
    const contextSource =
      workspaceRoot === null || workspaceTools === null
        ? undefined
        : index === undefined
          ? createUnavailableProductContextSource(
              "index-unavailable",
              workspaceTools.contextCandidates,
            )
          : createProductContextSource({
              fileSystem: ports.fileSystem,
              index,
              workspaceRoot,
              workspaceId,
              additionalCandidates: workspaceTools.contextCandidates,
            });
    const memory =
      memoryTools === null
        ? undefined
        : composeProductMemoryTurn({
            admission: memoryTools.admission,
            recall: memoryTools.recall,
          });
    const executor = createProductLiveTurnExecutor({
      ...(workspaceTools?.resources == null ? {} : { resources: workspaceTools.resources }),
      ...(ports.modelConfigurationGeneration === undefined
        ? {}
        : { modelConfigurationGeneration: ports.modelConfigurationGeneration }),
      ...(ports.modelPreferences === undefined ? {} : { modelPreferences: ports.modelPreferences }),
      runtime: composed.value,
      clock: ports.clock,
      providerCatalog: ports.provider?.kind === "ready" ? ports.provider.session.catalog : null,
      ...(contextSource === undefined
        ? workspaceTools === null
          ? {}
          : { contextCandidates: workspaceTools.contextCandidates }
        : { contextSource }),
      ...(memory === undefined ? {} : { memory }),
      ...(ports.artifacts === undefined ? {} : { artifacts: ports.artifacts }),
      initialExecutionProfile: selectedExecutionProfile,
      ...(selectedModel === null || !selectedModelExplicit ? {} : { initialModel: selectedModel }),
    });
    return {
      sessionId,
      producer: composed.value.attachments.turnProducer,
      peer,
      executor,
      submission: createProductSubmissionPort({
        executor,
        sessionId,
        configurationGeneration: generation,
        brief,
        output,
        isAccepting: () => ports.signal === undefined || !ports.signal.aborted,
      }),
    };
  }

  const initial = await buildSession();
  if (initial === null) {
    return null;
  }
  let active = initial;
  const listeners = new Set<() => void>();
  let unsubscribeActive = active.producer.subscribe(() => {
    for (const listener of listeners) listener();
  });
  const transcriptFeed: TranscriptFeed = {
    events: () => [
      ...active.producer.events(),
      ...(ports.taskNotices
        ?.events()
        .filter((event) => event.correlation.sessionId === active.sessionId) ?? []),
    ],
    subscribe(listener) {
      listeners.add(listener);
      const unsubscribeTasks = ports.taskNotices?.subscribe(listener);
      return () => {
        listeners.delete(listener);
        unsubscribeTasks?.();
      };
    },
  };
  let activeSubmissions = 0;
  const peerListeners = new Set<
    (notice: import("../../domain/orchestration/peer-mailbox.ts").PeerNotice) => void
  >();
  const notifyPeer = (notice: import("../../domain/orchestration/peer-mailbox.ts").PeerNotice) => {
    for (const listener of peerListeners) listener(notice);
  };
  let unsubscribePeer: (() => void) | null = null;
  const submission = {
    subscribePeer(
      listener: (notice: import("../../domain/orchestration/peer-mailbox.ts").PeerNotice) => void,
    ) {
      peerListeners.add(listener);
      unsubscribePeer ??= ports.peers?.subscribe(String(active.sessionId), notifyPeer) ?? null;
      return () => {
        peerListeners.delete(listener);
        if (peerListeners.size === 0) {
          unsubscribePeer?.();
          unsubscribePeer = null;
        }
      };
    },
    peer: (input: unknown, signal: AbortSignal) => {
      const parsed = peerActionSchema.safeParse(input);
      const selected =
        parsed.success && parsed.data.as
          ? (ports.peers?.owned(parsed.data.as, String(active.sessionId)) ?? active.peer)
          : active.peer;
      return executePeerAction(selected, input, "user", signal);
    },
    ...(ports.modelSettings === undefined ? {} : { modelSettings: ports.modelSettings }),
    brief,
    output,
    executionProfile: {
      get: () => selectedExecutionProfile,
      async select(profileId: ExecutionProfileId) {
        const controls = active.executor.executionProfile;
        const selected = await controls.select(profileId);
        if (selected.ok) {
          const previousDefault = executionProfile(selectedExecutionProfile).defaultBriefVerbosity;
          if (brief.getVerbosity() === previousDefault) {
            brief.setVerbosity(executionProfile(selected.profileId).defaultBriefVerbosity);
          }
          selectedExecutionProfile = selected.profileId;
        }
        return selected;
      },
    },
    modelSelection: {
      get: () => active.executor.modelSelection.get(),
      async select(identity: ProviderModelIdentity) {
        const selected = await active.executor.modelSelection.select(identity);
        if (selected.ok) {
          selectedModelExplicit = true;
          selectedModel = {
            providerProfileId: selected.providerProfileId,
            providerId: selected.providerId,
            modelId: selected.modelId,
          };
        }
        return selected;
      },
    },
    async submit(
      snapshot: Parameters<SubmissionPort["submit"]>[0],
      context: Parameters<SubmissionPort["submit"]>[1],
    ) {
      const target = active.submission;
      activeSubmissions += 1;
      active.peer?.state("busy");
      try {
        return await target.submit(snapshot, context);
      } finally {
        activeSubmissions -= 1;
        if (activeSubmissions === 0) active.peer?.state("idle");
      }
    },
  };
  let sessionCreationInFlight: ReturnType<SessionCreationPort["create"]> | null = null;

  async function createAndActivateSession() {
    if (activeSubmissions > 0) {
      return { ok: false as const, reason: "the current session still has an active turn" };
    }
    const candidate = await buildSession();
    if (candidate === null) {
      return { ok: false as const, reason: "the product runtime could not compose" };
    }
    const failed = await candidate.executor.startSession();
    if (failed !== null) {
      await candidate.peer?.close();
      return { ok: false as const, reason: failed.message };
    }
    unsubscribeActive();
    unsubscribePeer?.();
    await active.peer?.close();
    active = candidate;
    unsubscribePeer =
      peerListeners.size > 0
        ? (ports.peers?.subscribe(String(active.sessionId), notifyPeer) ?? null)
        : null;
    unsubscribeActive = active.producer.subscribe(() => {
      for (const listener of listeners) listener();
    });
    for (const listener of listeners) listener();
    return { ok: true as const, sessionId: String(active.sessionId) };
  }

  return {
    submission,
    transcriptFeed,
    sessionCreation: {
      async create() {
        if (sessionCreationInFlight !== null) {
          return sessionCreationInFlight;
        }
        sessionCreationInFlight = createAndActivateSession();
        try {
          return await sessionCreationInFlight;
        } finally {
          sessionCreationInFlight = null;
        }
      },
    },
    controls: providerControls(ports.provider),
  };
}

function providerControls(provider: ProductProviderConnectionHandoff | undefined): ControlCatalog {
  const ready = provider?.kind === "ready" ? provider.session : null;
  const profile = ready?.connection.profile ?? null;
  return {
    sessions: [],
    profiles: EXECUTION_PROFILES.map((execution) => ({
      id: execution.id,
      title: execution.label,
      detail: `${execution.description} Completion: ${execution.completion}.`,
    })),
    models:
      ready?.catalog.models.flatMap((model) =>
        profile === null
          ? []
          : [
              {
                id: providerModelIdentityKey({
                  providerProfileId: profile.profileId,
                  providerId: profile.providerId,
                  modelId: model.modelId,
                }),
                title: `${String(model.modelId)} · ${profile.displayName}`,
                detail: [
                  `provider:${String(profile.providerId)}`,
                  `profile:${profile.profileId}`,
                  `in:${model.inputModalities.join("+") || "unknown"}`,
                  `out:${model.outputModalities.join("+") || "unknown"}`,
                  `tools:${model.tools}`,
                  `structured:${model.structuredOutput}`,
                  `stream:${model.streaming}`,
                  `reasoning:${model.reasoning}`,
                  `ctx:${model.contextTokens ?? "unknown"}`,
                  `max-out:${model.outputTokens ?? "unknown"}`,
                  model.availability,
                  `via:${model.provenance.join("+")}`,
                ].join(" · "),
              },
            ],
      ) ?? [],
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
      {
        label: "authentication",
        value:
          ready === null
            ? {
                kind: "unavailable",
                reason: provider?.kind === "unavailable" ? provider.code : "not connected",
              }
            : {
                kind: "known",
                text: `${ready.auth.state} · ${ready.connection.account?.authMethod ?? "api-key"}`,
              },
      },
      { label: "memory", value: { kind: "unavailable", reason: "no resource probe yet" } },
      { label: "tokens", value: { kind: "unavailable", reason: "no usage yet" } },
    ],
  };
}
