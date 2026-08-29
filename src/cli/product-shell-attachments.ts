/**
 * Default live-product attachments for the TUI.
 *
 * Composes the durable session host, authenticated provider, product tools,
 * shared live-turn executor, transcript feed, and session-creation control so
 * `launchShell` can attach one application-owned runtime to `runShell`.
 */

import { randomUUID } from "node:crypto";

import {
  composeProductAgentRuntime,
  composeProductBriefControls,
  composeProductGitTools,
  composeProductIndexLifecycle,
  composeProductLanguageTools,
  composeProductMemoryTools,
  composeProductMemoryTurn,
  composeProductProcessTools,
  composeProductScratchTools,
  composeProductWorkspaceTools,
  createDebugAdapterSupervisor,
  createLanguageServerSupervisor,
  createProductContextSource,
  createProductLiveTurnExecutor,
  createUnavailableProductContextSource,
  type LoomPort,
  type MemoryRecords,
  mergeProductToolBundles,
  type ProductToolConfirmationPort,
  type ScratchResourcePort,
} from "../application/index.ts";
import {
  type ArtifactStorePort,
  type ClockPort,
  type ConfigurationGeneration,
  type EnvironmentPort,
  type EventStorePort,
  EXECUTION_PROFILES,
  type ExecutionProfileId,
  executionProfile,
  type FileSystemPort,
  type ProcessCapturePort,
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
import {
  createProductSubmissionPort,
  type ProductSubmissionPort,
  type SubmissionPort,
} from "../tui/composer/index.ts";
import type { ControlCatalog } from "../tui/controls/index.ts";
import type { SessionCreationPort } from "../tui/session-creation.ts";
import type { TranscriptFeed } from "../tui/transcript-feed.ts";
import type { ProductProviderConnectionHandoff } from "./product-provider-connections.ts";

export type ProductShellAttachmentPorts = {
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

  function buildSession() {
    const sessionId = sessionIdCodec.from(`session-shell-${randomUUID()}`);
    const traceId = traceIdCodec.from(`trace-shell-${randomUUID()}`);
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
            ],
            {
              afterMutation: async (request) => {
                if (
                  request.toolName === "scratch_write" ||
                  request.toolName === "scratch_discard"
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
    const composed = composeProductAgentRuntime({
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
    });
    return {
      sessionId,
      producer: composed.value.attachments.turnProducer,
      executor,
      submission: createProductSubmissionPort({
        executor,
        sessionId,
        configurationGeneration: generation,
        brief,
        isAccepting: () => ports.signal === undefined || !ports.signal.aborted,
      }),
    };
  }

  const initial = buildSession();
  if (initial === null) {
    return null;
  }
  let active = initial;
  const listeners = new Set<() => void>();
  let unsubscribeActive = active.producer.subscribe(() => {
    for (const listener of listeners) listener();
  });
  const transcriptFeed: TranscriptFeed = {
    events: () => active.producer.events(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  let activeSubmissions = 0;
  const submission = {
    brief,
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
    async submit(snapshot: Parameters<SubmissionPort["submit"]>[0]) {
      const target = active.submission;
      activeSubmissions += 1;
      try {
        return await target.submit(snapshot);
      } finally {
        activeSubmissions -= 1;
      }
    },
  };
  let sessionCreationInFlight: ReturnType<SessionCreationPort["create"]> | null = null;

  async function createAndActivateSession() {
    if (activeSubmissions > 0) {
      return { ok: false as const, reason: "the current session still has an active turn" };
    }
    const candidate = buildSession();
    if (candidate === null) {
      return { ok: false as const, reason: "the product runtime could not compose" };
    }
    const failed = await candidate.executor.startSession();
    if (failed !== null) {
      return { ok: false as const, reason: failed.message };
    }
    unsubscribeActive();
    active = candidate;
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
      ready?.catalog.models.map((model) => ({
        id: String(model.modelId),
        title: String(model.modelId),
        detail: [
          profile?.displayName ?? "provider",
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
