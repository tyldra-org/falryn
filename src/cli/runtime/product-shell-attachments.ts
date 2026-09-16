import { checkpointControl } from "../../application/compression/checkpoint-request.ts";
import type { NativePublication } from "../../application/extensions/native-registration.ts";
import { productAgentHost } from "../../application/runtime/product-agent-runtime.ts";
import {
  activationRefused,
  createSessionTransitionGuard,
  type PreparedSessionSelection,
  prepareSessionSelection,
  type SessionActivationFact,
  type SessionActivationPort,
} from "../../application/sessions/session-activation.ts";
import type { ConfigurationValues } from "../../domain/configuration/index.ts";
import type { SessionId } from "../../domain/foundation/index.ts";
import { agentRegistryFrom } from "./agent-configuration.ts";
import { createEnvironmentProcessContext } from "./environment-process-context.ts";
import { languageServiceConfiguration } from "./language-service-configuration.ts";
import { modelPreferencesFrom } from "./model-configuration.ts";
import { composeProductMcp } from "./product-mcp.ts";
import { productToolHost } from "./product-tool-host.ts";
import type {
  WorkingProfileSession,
  WorkingProfileSessionFactory,
} from "./product-working-profiles.ts";
import { createProductSandbox } from "./sandbox-configuration.ts";
import { sessionManagedServices } from "./session-managed-services.ts";
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
import type { CatalogRehydration } from "../../application/extensions/catalog-rehydration.ts";
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
import { projectCatalogHistory } from "../../domain/extensions/catalog-history.ts";
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
  readonly authorizeMcp?: (signal: AbortSignal) => Promise<boolean>;
  readonly workingProfileSession?: WorkingProfileSessionFactory;
  readonly records?: Pick<
    import("./product-artifact-session.ts").ProductArtifactSession["records"],
    "sessions" | "turns"
  >;
  readonly exportSession?: (
    session: SessionId,
    resources: import("../../application/orchestration/product-resources.ts").ProductResources,
  ) => import("../../application/sessions/session-export.ts").SessionExportControl;
  readonly configurationValues?: () => ConfigurationValues;
  readonly sandboxConfiguration?: () =>
    | import("../../domain/configuration/index.ts").ConfigurationGenerationRecord
    | null;
  readonly publishNativePackages?: (
    generation: ConfigurationGeneration,
    signal: AbortSignal,
    session?: string,
  ) => Promise<NativePublication>;
  readonly rehydrateExtensions?: (
    signal: AbortSignal,
    session?: string,
  ) => Promise<CatalogRehydration>;
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
  readonly workflows?: import("../../domain/orchestration/workflow-state.ts").WorkflowStore;
  readonly workflowQuestions?: import("../../application/orchestration/workflow-questions.ts").WorkflowQuestions;
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
  readonly activation: SessionActivationPort;
  close(): Promise<void>;
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
  const stop = new AbortController();
  const hostSignal = AbortSignal.any([stop.signal, ports.signal ?? new AbortController().signal]);
  const pending = new Set<Promise<void>>();
  const transition = createSessionTransitionGuard();
  function enter(kind: "prompt" | "activation") {
    const release = transition.enter(kind);
    if (!release || hostSignal.aborted) {
      release?.();
      return null;
    }
    let resolve!: () => void;
    const settled = new Promise<void>((done) => {
      resolve = done;
    });
    pending.add(settled);
    return () => {
      release();
      pending.delete(settled);
      resolve();
    };
  }
  const workspaceId = workspaceIdCodec.from(
    ports.workspaceSet === null
      ? "workspace-unbound"
      : primaryWorkspaceRoot(ports.workspaceSet).rootId,
  );
  const generation = ports.configurationGeneration;
  const sandbox = createProductSandbox({
    ...(ports.sandboxConfiguration === undefined
      ? {}
      : { configuration: ports.sandboxConfiguration }),
    now: () => Number(ports.clock.now()),
    values: ports.configurationValues ?? (() => ({})),
    generation: () => Number(ports.modelConfigurationGeneration?.() ?? generation),
    workspaceRoot:
      ports.workspaceSet === null ? null : String(primaryWorkspaceRoot(ports.workspaceSet).path),
  });
  const hostCommands =
    ports.commands ??
    createHostCommandRunner({
      sandbox,
      ...(ports.ownedProcesses === undefined ? {} : { ownedProcesses: ports.ownedProcesses }),
    });

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

  const managedServices = createHostManagedServicePort({
    sandbox,
    ...(ports.ownedProcesses === undefined ? {} : { ownedProcesses: ports.ownedProcesses }),
  });
  let selectedExecutionProfile: ExecutionProfileId = "agent";
  const brief = composeProductBriefControls({
    initialVerbosity: executionProfile(selectedExecutionProfile).defaultBriefVerbosity,
  });
  const output = composeProductOutputControls();

  async function buildSession(selection?: PreparedSessionSelection, signal = hostSignal) {
    const environmentContext = createEnvironmentProcessContext();
    const commands = environmentContext.commands(hostCommands);
    const generation = ports.modelConfigurationGeneration?.() ?? ports.configurationGeneration;
    const sessionId =
      selection?.record.sessionId ?? sessionIdCodec.from(`session-shell-${randomUUID()}`);
    const native = await ports.publishNativePackages?.(
      generation,
      signal,
      selection ? String(sessionId) : undefined,
    );
    const extensions =
      native === undefined
        ? await ports.rehydrateExtensions?.(signal, selection ? String(sessionId) : undefined)
        : { status: "ready" as const, catalog: native.catalog };
    if (extensions?.status === "failed") return null;
    const extensionCatalog =
      extensions === undefined
        ? undefined
        : projectCatalogHistory(extensions.catalog, ports.workspaceSet);
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
            capture: environmentContext.capture(
              ports.processCapture ??
                createHostProcessCapturePort({
                  sandbox,
                  clock: ports.clock,
                  ...(ports.artifacts === undefined ? {} : { artifacts: ports.artifacts }),
                  ...(ports.ownedProcesses === undefined
                    ? {}
                    : { ownedProcesses: ports.ownedProcesses }),
                }),
            ),
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
              capture: environmentContext.gitCapture(
                createHostProcessCapturePort({
                  sandbox,
                  clock: ports.clock,
                  ...(ports.ownedProcesses === undefined
                    ? {}
                    : { ownedProcesses: ports.ownedProcesses }),
                }),
              ),
              clock: ports.clock,
            }),
            gitExecutable: "/usr/bin/git",
            resolveExecutable: environmentContext.gitExecutable,
            startPath: String(workspaceRoot),
          });
    const sessionServices = sessionManagedServices(environmentContext.services(managedServices));
    const mcpServices = sessionManagedServices(managedServices);
    let profileSession: WorkingProfileSession | undefined;
    const mcp = composeProductMcp({
      identity: String(sessionId),
      generation,
      context: environmentContext,
      services: mcpServices.port,
      environment: ports.environment ?? { get: () => null },
      configuration: () => {
        const record = profileSession?.configuration() ?? ports.sandboxConfiguration?.();
        return {
          values: record?.values ?? ports.configurationValues?.() ?? {},
          generation: Number(
            record?.generation ?? ports.modelConfigurationGeneration?.() ?? generation,
          ),
          ...(record === undefined ? {} : { record }),
        };
      },
      authorize: ports.authorizeMcp ?? (async () => false),
    });
    const languageTools =
      workspaceRoot === null
        ? null
        : composeProductLanguageTools({
            configuration: () =>
              languageServiceConfiguration(
                ports.configurationValues?.() ?? {},
                Number(ports.modelConfigurationGeneration?.() ?? generation),
                ports.sandboxConfiguration?.(),
              ),
            generation,
            languageServers: createLanguageServerSupervisor(sessionServices.port),
            debugAdapters: createDebugAdapterSupervisor(sessionServices.port, {
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
            workspaceId: String(workspaceId),
            ...(ports.memoryRecords === undefined ? {} : { records: ports.memoryRecords }),
          });
    let prepared = false;
    const peer =
      (await ports.peers?.open({ sessionId: String(sessionId), agentId: "main", generation: 1 })) ??
      null;
    try {
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
                mcp.tools,
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
      const compose = (
        runtimePorts: Parameters<typeof composeProductAgentRuntime>[0],
        profile?: {
          record: import("../../domain/configuration/index.ts").ConfigurationGenerationRecord;
          connections: import("./product-provider-connections.ts").ProductProviderConnections;
          provider: Extract<
            import("./product-provider-connections.ts").ProductProviderConnectionHandoff,
            { kind: "ready" }
          >;
        },
      ) =>
        tasks && artifacts
          ? composeDelegatedAgentRuntime(runtimePorts, {
              tasks,
              artifacts,
              ...(ports.workflows ? { workflows: ports.workflows } : {}),
              ...(ports.workflowQuestions ? { workflowQuestions: ports.workflowQuestions } : {}),
              ...(ports.joins ? { joins: ports.joins } : {}),
              ...(ports.peers ? { peers: ports.peers } : {}),
              ...(profile
                ? {
                    registry: agentRegistryFrom(profile.record.values),
                    preferences: () => modelPreferencesFrom(profile.record.values),
                    configurationGeneration: () => Number(profile.record.generation),
                    resolveProvider: async (id: string, signal: AbortSignal) => {
                      const resolved = await profile.connections.resolveProfile(id, signal);
                      return resolved.kind === "ready"
                        ? { adapter: resolved.adapter, catalog: resolved.session.catalog }
                        : { reason: resolved.code };
                    },
                  }
                : {
                    ...(ports.agentRegistry ? { registry: ports.agentRegistry } : {}),
                    ...(ports.resolveAgentProvider
                      ? { resolveProvider: ports.resolveAgentProvider }
                      : {}),
                    ...(ports.modelPreferences ? { preferences: ports.modelPreferences } : {}),
                    ...(modelConfigurationGeneration
                      ? { configurationGeneration: () => Number(modelConfigurationGeneration()) }
                      : {}),
                  }),
              providerCatalog:
                profile?.provider.session.catalog ??
                (ports.provider?.kind === "ready" ? ports.provider.session.catalog : null),
            })
          : composeProductAgentRuntime(runtimePorts);
      const initialTools =
        productTools === null
          ? null
          : mergeProductToolBundles(generation, [
              productTools,
              ...(native === undefined ? [] : [native.tools]),
            ]);
      const composed = compose({
        eventStore: ports.eventStore,
        ...(ports.artifacts === undefined ? {} : { historyArtifacts: ports.artifacts }),
        clock: ports.clock,
        streamId: selection?.record.streamId ?? streamId.from(`live-turn:${String(sessionId)}`),
        correlation: {
          workspaceId,
          sessionId,
          traceId,
          configurationGeneration: generation,
        },
        ...(providerAdapter === undefined ? {} : { providerAdapter }),
        ...(ports.toolConfirmation === undefined
          ? {}
          : { toolConfirmation: ports.toolConfirmation }),
        ...(initialTools === null
          ? {}
          : {
              ...productToolHost(),
              toolRegistry: initialTools.registry,
              capabilityRegistry: initialTools.capabilityRegistry,
              toolCatalog: initialTools.catalog,
              toolRunner: initialTools.runner,
              sandbox,
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
      let publishedRuntime = composed.value;
      if (selection) {
        const runtime = composed.value.sessionRuntime;
        const opened = runtime.create({
          sessionId,
          workspaceId,
          configurationGeneration: generation,
        });
        if (
          !opened.ok ||
          !runtime.apply({ sessionId, command: "mark-ready", configurationGeneration: generation })
            .ok
        ) {
          return null;
        }
        const refreshed = await composed.value.attachments.turnProducer.refreshFromStore();
        if (!refreshed.ok) {
          return null;
        }
      }
      profileSession = await ports.workingProfileSession?.(
        composed.value,
        (record, connections, provider) => {
          const correlation = {
            ...composed.value.correlation,
            configurationGeneration: record.generation,
          };
          const tools =
            initialTools === null
              ? null
              : mergeProductToolBundles(record.generation, [initialTools]);
          const next = compose(
            {
              eventStore: ports.eventStore,
              clock: ports.clock,
              streamId: composed.value.streamId,
              correlation,
              host: { ...productAgentHost(composed.value), correlation },
              resources: composed.value.resources,
              providerAdapter: provider.adapter,
              ...(ports.artifacts ? { historyArtifacts: ports.artifacts } : {}),
              ...(ports.toolConfirmation ? { toolConfirmation: ports.toolConfirmation } : {}),
              ...(tools
                ? {
                    ...productToolHost(),
                    toolRegistry: tools.registry,
                    capabilityRegistry: tools.capabilityRegistry,
                    toolCatalog: tools.catalog,
                    toolRunner: tools.runner,
                    sandbox,
                  }
                : {}),
            },
            { record, connections, provider },
          );
          if (!next.ok) throw new Error(next.error.code);
          return next.value;
        },
        environmentContext,
        selection !== undefined,
      );
      const executor = createProductLiveTurnExecutor({
        ...(profileSession ? { admissionBinding: profileSession.capture } : {}),
        ...(selection ? { resumed: true, historyParents: selection.parents } : {}),
        checkpointEvents: ports.eventStore,
        checkpointDurable: ports.artifacts !== undefined,
        ...(extensionCatalog === undefined ? {} : { extensionCatalog }),
        ...(workspaceTools?.resources == null ? {} : { resources: workspaceTools.resources }),
        ...(ports.modelConfigurationGeneration === undefined
          ? {}
          : { modelConfigurationGeneration: ports.modelConfigurationGeneration }),
        ...(ports.modelPreferences === undefined
          ? {}
          : { modelPreferences: ports.modelPreferences }),
        runtime: composed.value,
        ...(ports.publishNativePackages === undefined || productTools === null
          ? {}
          : {
              async refreshRuntime(signal: AbortSignal, captured = publishedRuntime) {
                const generation = captured.correlation.configurationGeneration;
                const publication = await ports.publishNativePackages?.(
                  generation,
                  signal,
                  String(sessionId),
                );
                if (!publication) throw new Error("native-publication-unavailable");
                const tools = mergeProductToolBundles(generation, [
                  productTools,
                  publication.tools,
                ]);
                const next = captured.recomposeTools(tools);
                if (!next.ok) throw new Error(next.error.code);
                publishedRuntime = next.value;
                return publishedRuntime;
              },
            }),
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
        ...(selectedModel === null || !selectedModelExplicit
          ? {}
          : { initialModel: selectedModel }),
      });
      prepared = true;
      return {
        profileSession,
        async close() {
          const stopped = await mcp.close();
          await mcpServices.close();
          await profileSession?.close();
          await sessionServices.close();
          await peer?.close();
          if (stopped.some((result) => result.kind !== "completed"))
            throw new Error("mcp-shutdown-uncertain");
        },
        extensionCatalog,
        sessionId,
        streamId: composed.value.streamId,
        inherited:
          selection?.history.records
            .filter((r) => r.event.correlation.sessionId !== sessionId)
            .map((r) => r.event) ?? [],
        resources: composed.value.resources,
        producer: composed.value.attachments.turnProducer,
        peer,
        executor,
        submission: createProductSubmissionPort({
          executor,
          sessionId,
          configurationGeneration: generation,
          brief,
          output,
          isAccepting: () => !hostSignal.aborted,
        }),
      };
    } finally {
      if (!prepared) {
        await mcp.close();
        await mcpServices.close();
        await sessionServices.close();
        await peer?.close();
      }
    }
  }

  const initial = await buildSession();
  if (initial === null) {
    return null;
  }
  let active = initial;
  const taskSubscriptions = new Set<() => void>();
  const listeners = new Set<() => void>();
  let unsubscribeActive = active.producer.subscribe(() => {
    for (const listener of listeners) listener();
  });
  const transcriptFeed: TranscriptFeed = {
    events: () => [
      ...active.inherited,
      ...active.producer.events(),
      ...(ports.taskNotices
        ?.events()
        .filter((event) => event.correlation.sessionId === active.sessionId) ?? []),
    ],
    subscribe(listener) {
      listeners.add(listener);
      const unsubscribeTasks = ports.taskNotices?.subscribe(listener);
      if (unsubscribeTasks) taskSubscriptions.add(unsubscribeTasks);
      return () => {
        listeners.delete(listener);
        unsubscribeTasks?.();
        if (unsubscribeTasks) taskSubscriptions.delete(unsubscribeTasks);
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
  const exportSession = ports.exportSession;
  const submission = {
    environment: {
      execute: (action: "inspect" | "reload", signal?: AbortSignal) => {
        const control = active.profileSession?.environment;
        if (!control) return Promise.reject(new Error("environment-controls-unavailable"));
        return control.execute(action, AbortSignal.any([hostSignal, ...(signal ? [signal] : [])]));
      },
    },
    binding: () => `${active.sessionId}:${activationGeneration}`,
    workingProfile: (
      argument: string | null,
      signal: AbortSignal,
      actor: "user" | "model" = "user",
    ) =>
      active.profileSession?.control(argument, AbortSignal.any([hostSignal, signal]), actor) ??
      Promise.resolve({ kind: "refused", code: "profile-controls-unavailable" }),
    get workingProfiles() {
      return active.profileSession;
    },
    compact: checkpointControl(
      async (request, signal) => {
        const release = enter("prompt");
        if (!release) return { kind: "refused", reason: "session-busy", effect: "none" };
        try {
          return (
            (await active.executor.compact?.(request, AbortSignal.any([hostSignal, signal]))) ?? {
              kind: "refused",
              reason: "compaction-unavailable",
              effect: "none",
            }
          );
        } finally {
          release();
        }
      },
      () => String(active.sessionId),
    ),
    ...(exportSession === undefined
      ? {}
      : {
          exportSession: (argument: string | null, signal: AbortSignal) =>
            exportSession(active.sessionId, active.resources)(argument, signal),
        }),
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
    get modelSettings() {
      return active.profileSession?.modelSettings ?? ports.modelSettings;
    },
    brief,
    output,
    executionProfile: {
      get: () => selectedExecutionProfile,
      async select(profileId: ExecutionProfileId) {
        const release = enter("prompt");
        if (!release)
          return {
            ok: false as const,
            code: "session.busy",
            message: "A session transition or turn is in progress.",
          };
        try {
          const controls = active.executor.executionProfile;
          const selected = await controls.select(profileId);
          if (selected.ok) {
            const previousDefault =
              executionProfile(selectedExecutionProfile).defaultBriefVerbosity;
            if (brief.getVerbosity() === previousDefault) {
              brief.setVerbosity(executionProfile(selected.profileId).defaultBriefVerbosity);
            }
            selectedExecutionProfile = selected.profileId;
          }
          return selected;
        } finally {
          release();
        }
      },
    },
    modelSelection: {
      get: () => active.executor.modelSelection.get(),
      async select(identity: ProviderModelIdentity) {
        const release = enter("prompt");
        if (!release)
          return {
            ok: false as const,
            code: "session.busy",
            message: "A session transition or turn is in progress.",
          };
        try {
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
        } finally {
          release();
        }
      },
    },
    async submit(
      snapshot: Parameters<SubmissionPort["submit"]>[0],
      context: Parameters<SubmissionPort["submit"]>[1],
    ) {
      const release = enter("prompt");
      if (!release)
        return {
          kind: "unavailable" as const,
          snapshot,
          reason: "a session transition or turn is in progress",
          owner: "#953",
          route: "session.resume",
        };
      if (snapshot.binding !== undefined && snapshot.binding !== submission.binding()) {
        release();
        return {
          kind: "unavailable" as const,
          snapshot,
          reason: "the selected session changed while this input was being prepared",
          owner: "#953",
          route: "session.resume",
        };
      }
      const target = active;
      activeSubmissions += 1;
      active.peer?.state("busy");
      try {
        return await target.submission.submit(snapshot, {
          payloads: context?.payloads ?? { get: () => null },
          signal: AbortSignal.any([hostSignal, context?.signal ?? new AbortController().signal]),
        });
      } finally {
        activeSubmissions -= 1;
        if (activeSubmissions === 0) target.peer?.state("idle");
        release();
      }
    },
  };
  let sessionCreationInFlight: ReturnType<SessionCreationPort["create"]> | null = null;

  let activationGeneration = 1;
  const activationListeners = new Set<(fact: SessionActivationFact) => void>();
  const activation: SessionActivationPort = {
    subscribe(listener) {
      activationListeners.add(listener);
      return () => {
        activationListeners.delete(listener);
      };
    },
    async activate(request, requestedSignal) {
      const release = enter("activation");
      if (!release) return activationRefused("busy");
      const signal = AbortSignal.any([hostSignal, requestedSignal ?? new AbortController().signal]);
      let candidate: Awaited<ReturnType<typeof buildSession>> = null;
      let committed = false;
      let selection: PreparedSessionSelection | undefined;
      const refused = (code: string) => {
        const result = activationRefused(code);
        const retained =
          selection && request.kind !== "resume" && request.kind !== "new"
            ? selection.record.sessionId
            : request.kind === "new" && candidate
              ? candidate.sessionId
              : null;
        const stored = retained === null ? null : ports.records?.sessions.get(retained);
        return stored?.ok && stored.value
          ? {
              ...result,
              reason: `${result.reason} Prepared session ${retained} remains inactive and available for inspection.`,
            }
          : result;
      };
      try {
        if (signal.aborted) return refused("cancelled");
        if ((ports.tasks?.report().active ?? 0) > 0) return refused("busy");
        const admittedGeneration = ports.modelConfigurationGeneration?.() ?? generation;
        if (request.kind !== "new") {
          if (!ports.records) return refused("records-unavailable");
          if (!providerAdapter) return refused("provider-unavailable");
          const prepared = await prepareSessionSelection(
            {
              ...ports.records,
              events: ports.eventStore,
              ...(ports.artifacts ? { artifacts: ports.artifacts } : {}),
              workspaceId,
              generation: Number(admittedGeneration),
              resources: active.resources,
            },
            request,
            signal,
          );
          if (!prepared.ok) return prepared;
          selection = prepared.value;
          if (request.kind === "resume" && request.sessionId === String(active.sessionId))
            return {
              ok: true,
              sessionId: String(active.sessionId),
              streamId: String(active.streamId),
              generation: activationGeneration,
              explanation: selection.explanation,
              changed: false,
            };
        }
        candidate = await buildSession(selection, signal);
        if (!candidate) return refused("prepare-failed");
        if (
          signal.aborted ||
          (ports.modelConfigurationGeneration?.() ?? generation) !== admittedGeneration ||
          (selection && !selection.current())
        )
          return refused("stale-selection");
        if (!selection) {
          const failure = await candidate.executor.startSession();
          if (failure) return refused(failure.code);
        }
        if (signal.aborted) return refused("cancelled");
        const previous = active;
        unsubscribeActive();
        unsubscribePeer?.();
        active = candidate;
        activationGeneration += 1;
        committed = true;
        await active.profileSession?.startEnvironment(signal);
        const fact: SessionActivationFact = Object.freeze({
          kind: "session.activated",
          reason: request.kind,
          sessionId: String(active.sessionId),
          streamId: String(active.streamId),
          workspaceId: String(workspaceId),
          generation: activationGeneration,
          configurationGeneration: Number(admittedGeneration),
          checkpointId: selection?.history.checkpointId ?? null,
          historyDigest: selection?.history.projectionDigest ?? null,
        });
        for (const observer of activationListeners) {
          try {
            observer(fact);
          } catch {
            /* A committed binding remains committed. */
          }
        }
        unsubscribePeer =
          peerListeners.size > 0
            ? (ports.peers?.subscribe(String(active.sessionId), notifyPeer) ?? null)
            : null;
        unsubscribeActive = active.producer.subscribe(() => {
          for (const listener of listeners) listener();
        });
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            /* Observers cannot undo the committed binding. */
          }
        }
        await previous.close().catch(() => {});
        return {
          ok: true,
          sessionId: String(active.sessionId),
          streamId: String(active.streamId),
          generation: activationGeneration,
          explanation: `${selection?.explanation ?? `Started session ${active.sessionId} with current configuration ${admittedGeneration}.`} Model: ${active.executor.modelSelection.get()?.modelId ?? "unavailable"}; mode: ${active.executor.executionProfile.get()}. Current instruction/catalog inputs: ${active.extensionCatalog?.inputs ?? "unavailable"}; recorded: ${selection?.record.extensionCatalog?.inputs ?? "unavailable"}. Inspect workspace trust for current loader admission.`,
          changed: true,
        };
      } catch {
        return refused("prepare-failed");
      } finally {
        try {
          if (!committed) await candidate?.close().catch(() => {});
        } finally {
          release();
        }
      }
    },
  };
  async function close() {
    transition.close();
    stop.abort();
    await Promise.allSettled([...pending]);
    unsubscribeActive();
    unsubscribePeer?.();
    for (const unsubscribe of taskSubscriptions) unsubscribe();
    taskSubscriptions.clear();
    listeners.clear();
    peerListeners.clear();
    activationListeners.clear();
    await active.close();
  }

  return {
    close,
    activation,
    submission,
    transcriptFeed,
    sessionCreation: {
      async create() {
        if (sessionCreationInFlight !== null) {
          return sessionCreationInFlight;
        }
        sessionCreationInFlight = activation.activate({ kind: "new" });
        try {
          return await sessionCreationInFlight;
        } finally {
          sessionCreationInFlight = null;
        }
      },
    },
    controls: {
      ...providerControls(ports.provider),
      get models() {
        return providerControls(active.profileSession?.provider ?? ports.provider).models;
      },
      get activeSessionId() {
        return String(active.sessionId);
      },
      get sessions() {
        return [
          {
            id: String(active.sessionId),
            title: String(active.sessionId),
            detail: "Active session",
          },
        ];
      },
      get resources() {
        const resources = providerControls(
          active.profileSession?.provider ?? ports.provider,
        ).resources;
        const catalog = active.extensionCatalog;
        if (catalog === undefined) return resources;
        return [
          ...resources,
          {
            label: "Extensions catalog",
            value: {
              kind: "known" as const,
              text: `${catalog.catalog}; generation ${catalog.generation}; ${catalog.total} descriptors; ${catalog.omitted} omitted; historical, no native execution`,
            },
          },
          ...catalog.entries.map((entry) => ({
            label: `${entry.contribution.nativeKind} ${entry.contribution.localId}`,
            value: {
              kind: "known" as const,
              text: `${entry.wasEnabled ? "enabled" : "disabled"}; ${entry.reason}; owner ${entry.contribution.owner.digest}`,
            },
          })),
        ];
      },
    },
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
