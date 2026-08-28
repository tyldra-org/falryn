/**
 * Headless `falryn run` coding command (#708).
 *
 * Declares a coding entry that hosts a session/turn through the product agent
 * runtime producer (same path as composer submission #707), projects through
 * the four CLI output contracts, and never prompts. Missing prompt text fails
 * closed. Without a ready selected provider connection (#798), the turn is
 * hosted then the command fails closed with a typed remediation rather than
 * hanging or selecting another destination silently.
 */

import { randomUUID } from "node:crypto";

import {
  adoptForeignError,
  CONTEXT_PLANNER_OWNER,
  composeProductAgentRuntime,
  composeProductBriefControls,
  composeProductCredentials,
  composeProductGitTools,
  composeProductIndexLifecycle,
  composeProductLanguageTools,
  composeProductMemoryTools,
  composeProductMemoryTurn,
  composeProductProcessTools,
  composeProductWorkspaceTools,
  createDebugAdapterSupervisor,
  createLanguageServerSupervisor,
  createProductContextSource,
  createProductLiveTurnExecutor,
  createUnavailableProductContextSource,
  DEFAULT_OPENAI_CREDENTIAL_REFERENCE,
  type LoomPort,
  mergeProductToolBundles,
  PRODUCT_BRIEF_OWNER,
  PRODUCT_INDEX_LIFECYCLE_OWNER,
  type ProductToolConfirmationPort,
  resolveProviderApiKey,
} from "../application/index.ts";
import {
  type ArtifactStorePort,
  type BriefVerbosityMode,
  type CredentialReference,
  type ExecutionProfileId,
  executionProfile,
  type FalrynError,
  type InputStreamPort,
  type Instant,
  type ProcessCapturePort,
  primaryWorkspaceRoot,
  type RuntimeEvent,
  sessionId as sessionIdCodec,
  streamId,
  type TerminalOutcome,
  traceId as traceIdCodec,
  turnId as turnIdCodec,
  workspaceId as workspaceIdCodec,
} from "../domain/index.ts";
import {
  createHostCommandRunner,
  createHostGitPort,
  createHostManagedServicePort,
  createHostProcessCapturePort,
  createOpenAiSdkAdapter,
  hostPlatform,
  type OpenAiSdkFetch,
  type OwnedProcessRegistry,
} from "../integrations/index.ts";
import {
  catalogFromAdapterModels,
  type ModelCatalog,
} from "../providers/index.ts";
import type { ProviderAdapterPort } from "../providers/port.ts";
import { startConfigurationReloadWatcher } from "./configuration-reload.ts";
import type { GlobalOptions } from "./options.ts";
import {
  openProductArtifactSession,
  type ProductArtifactSession,
} from "./product-artifact-session.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "./product-configuration.ts";
import { composeProductProviderConnections } from "./product-provider-connections.ts";
import {
  COMMAND_RESULT_SCHEMA_FAMILY,
  COMMAND_RESULT_SCHEMA_VERSION,
  type CommandEffect,
  type CommandResultOf,
  READ_ONLY_EFFECT,
} from "./result.ts";
import { attachResultEvents } from "./result-events.ts";
import type { ServiceProvider } from "./services.ts";
import type { CliStreams } from "./streams.ts";
import { describeWorkspaceResolveError } from "./workspace-resolution.ts";

export const CODING_RUN_COMMAND = "run" as const;
export const CODING_RUN_OWNER = "#708";

export { DEFAULT_OPENAI_CREDENTIAL_REFERENCE };
/** Parsed prompt fragments after `falryn run` (may be empty when stdin supplies text). */
export type CodingRunArguments = {
  readonly promptParts: readonly string[];
  /** Brief verbosity for live prompt composition (#717). */
  readonly brief?: BriefVerbosityMode;
  /** Explicit execution authority for this invocation (#789). */
  readonly mode?: ExecutionProfileId;
};

export type CodingRunPayload = {
  readonly prompt: string;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly workspaceId: string;
  /** How far the product graph progressed before the result was formed. */
  readonly stage:
    | "prompt-missing"
    | "workspace-refused"
    | "compose-failed"
    | "provider-required"
    | "attempt-completed"
    | "attempt-failed";
  readonly eventCount: number;
  /** Evidence items admitted by the live context planner (#715), when composed. */
  readonly contextPackItems?: number;
  /** Whether the live prompt composition included a planner-built evidence path. */
  readonly contextPlannerOwner?: string;
  /** Product index lifecycle freshness (#716). */
  readonly indexFreshness?: string;
  readonly indexOwner?: string;
  /** Selected Brief verbosity on the live turn (#717). */
  readonly briefVerbosity?: string;
  readonly briefOwner?: string;
  readonly contextStatus?: string;
  readonly contextGeneration?: string | null;
  readonly recalledMemories?: number;
  readonly memoryAdmission?: string;
  /** Final assistant text from the terminal model attempt. */
  readonly response?: string;
  readonly modelAttempts?: number;
  readonly toolResults?: number;
  readonly disclosedTools?: number;
  readonly executionProfile?: ExecutionProfileId;
  readonly executionProfileVersion?: number;
  readonly completionCriterion?: string;
  readonly effectiveModelRole?: string | null;
  readonly effectiveReasoning?: string | null;
  readonly policyGeneration?: number;
  readonly planArtifactId?: string | null;
};

export type CodingRunResult = CommandResultOf<typeof CODING_RUN_COMMAND, CodingRunPayload>;

export type CodingRunOptions = {
  readonly input: InputStreamPort;
  readonly signal?: AbortSignal;
  /**
   * Stable identities for tests. Production derives session/turn/trace from
   * collision-resistant invocation identities.
   */
  readonly identities?: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly traceId: string;
    readonly workspaceId?: string;
  };
  /**
   * Optional live or deterministic adapter for tests. Production resolves the
   * selected provider profile through the provider connection service (#798).
   */
  readonly providerAdapter?: ProviderAdapterPort | null;
  /** Catalog paired with an injected adapter; otherwise derived from its static models. */
  readonly providerCatalog?: ModelCatalog;
  /** Override the default OpenAI environment credential reference. */
  readonly credentialReference?: CredentialReference;
  /** OpenAI SDK base URL when composing from credentials. */
  readonly openaiBaseUrl?: string;
  /** Injectable OpenAI SDK transport for deterministic provider integration tests. */
  readonly openaiFetch?: OpenAiSdkFetch;
  /**
   * Invocation globals for configuration load (#728). Production supplies
   * profile and CLI overrides; tests may omit for an empty load request.
   */
  readonly globals?: GlobalOptions;
  /** Diagnostic handle for live configuration reload notices. */
  readonly reloadDiagnostics?: CliStreams;
  /** Adopts owned subprocess trees for shutdown (#730). */
  readonly ownedProcesses?: OwnedProcessRegistry;
  /** Durable exact-output storage and optional shared Loom lifecycle (#814). */
  readonly artifacts?: ArtifactStorePort;
  readonly loom?: LoomPort;
  /** Injectable process host for deterministic public-entrypoint integration tests. */
  readonly processCapture?: ProcessCapturePort;
  /** Focused confirmation host; absent remains fail-closed for consequential tools. */
  readonly toolConfirmation?: ProductToolConfirmationPort;
};

/**
 * Resolve the task text from argv fragments and/or stdin.
 * Never waits on an interactive handle: not-connected stdin is empty input.
 */
export async function resolveCodingPrompt(
  promptParts: readonly string[],
  input: InputStreamPort,
): Promise<
  | { readonly ok: true; readonly prompt: string; readonly source: "argv" | "stdin" }
  | { readonly ok: false; readonly reason: string }
> {
  const fromArgs = promptParts.join(" ").trim();
  if (fromArgs.length > 0) {
    return { ok: true, prompt: fromArgs, source: "argv" };
  }

  const read = await input.read();
  if (!read.ok) {
    return {
      ok: false,
      reason:
        read.error.code === "too-large"
          ? `stdin exceeds the declared byte limit (${read.error.maxBytes})`
          : read.error.code === "invalid-encoding"
            ? "stdin is not valid UTF-8"
            : `stdin could not be read (${read.error.code})`,
    };
  }

  if (read.value.kind === "not-connected") {
    return {
      ok: false,
      reason: "a prompt is required as arguments or on stdin; this run never prompts",
    };
  }

  if (read.value.kind === "empty") {
    return {
      ok: false,
      reason: "a prompt is required as arguments or on stdin; empty input is refused",
    };
  }

  const fromStdin = read.value.text.trim();
  if (fromStdin.length === 0) {
    return {
      ok: false,
      reason: "a prompt is required as arguments or on stdin; empty input is refused",
    };
  }

  return { ok: true, prompt: fromStdin, source: "stdin" };
}

function catalogForAdapter(
  adapter: ProviderAdapterPort,
  generation: number,
  fetchedAt: Instant,
): ModelCatalog {
  return catalogFromAdapterModels(adapter.supportedModels, {
    generation,
    fetchedAt,
    capabilities: adapter.modelCapabilities,
  });
}

/**
 * Host one headless coding turn through the product producer and fail closed
 * when a live provider adapter is not attached.
 */
export async function runCoding(
  services: ServiceProvider,
  arguments_: CodingRunArguments,
  options: CodingRunOptions,
): Promise<CodingRunResult> {
  const resolved = await resolveCodingPrompt(arguments_.promptParts, options.input);
  if (!resolved.ok) {
    return codingResult(
      {
        prompt: "",
        sessionId: "",
        turnId: null,
        workspaceId: "",
        stage: "prompt-missing",
        eventCount: 0,
      },
      [
        adoptForeignError(
          {
            code: "cli.prompt-required",
            category: "configuration",
            message: resolved.reason,
          },
          { operation: "resolve coding prompt" },
        ),
      ],
    );
  }

  const graph = services();
  const workspace = await graph.ensureWorkspaceSet(options.signal);
  if (!workspace.ok) {
    return codingResult(
      {
        prompt: resolved.prompt,
        sessionId: "",
        turnId: null,
        workspaceId: "",
        stage: "workspace-refused",
        eventCount: 0,
      },
      [
        adoptForeignError(
          {
            code: "cli.workspace-refused",
            category: "workspace",
            message: describeWorkspaceResolveError(workspace.error),
          },
          { operation: "resolve workspace for coding run" },
        ),
      ],
    );
  }

  const configReload =
    options.globals === undefined
      ? null
      : startConfigurationReloadWatcher(graph, options.globals, {
          ...(options.reloadDiagnostics === undefined
            ? {}
            : { streams: options.reloadDiagnostics }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
  let productArtifactSession: ProductArtifactSession | null = null;

  try {
    const ids = options.identities ?? {
      sessionId: `session-run-${randomUUID()}`,
      turnId: `turn-run-${randomUUID()}`,
      traceId: `trace-run-${randomUUID()}`,
    };
    const workspaceId = workspaceIdCodec.from(
      ids.workspaceId ?? primaryWorkspaceRoot(workspace.value.set).rootId,
    );
    const sessionId = sessionIdCodec.from(ids.sessionId);
    const turnId = turnIdCodec.from(ids.turnId);
    const traceId = traceIdCodec.from(ids.traceId);
    const configRequest =
      options.globals === undefined
        ? { profile: null, overrides: {} }
        : productConfigurationLoadRequest(options.globals);
    const configuration = await loadProductConfiguration(graph, configRequest, options.signal);
    const generation = configuration.generation;
    productArtifactSession = await openProductArtifactSession(graph, options.signal);
    if (productArtifactSession === null) {
      return codingResult(
        {
          prompt: resolved.prompt,
          sessionId: ids.sessionId,
          turnId: null,
          workspaceId: String(workspaceId),
          stage: "compose-failed",
          eventCount: 0,
        },
        [
          adoptForeignError(
            {
              code: "runtime.durable-event-store-required",
              category: "persistence",
              message: "the durable product event store could not be opened",
            },
            { operation: "open durable coding session" },
          ),
        ],
      );
    }

    const workspaceRoot = primaryWorkspaceRoot(workspace.value.set).path;
    const indexStore = await productArtifactSession.openWorkspaceIndex(
      workspaceRoot,
      options.signal,
    );
    const indexLifecycle =
      indexStore === null
        ? null
        : composeProductIndexLifecycle({
            fileSystem: graph.fileSystem,
            workspaceRoot,
            index: indexStore,
          });
    await indexLifecycle?.rebuild(options.signal);
    const indexFreshness = indexLifecycle?.status().freshness ?? "absent";
    const indexOwner = PRODUCT_INDEX_LIFECYCLE_OWNER;
    const ownedProcessOptions =
      options.ownedProcesses === undefined ? {} : { ownedProcesses: options.ownedProcesses };
    let providerAdapter = options.providerAdapter;
    let providerCatalog = options.providerCatalog ?? null;
    let providerUnavailableCode = providerAdapter === null ? "provider-not-attached" : null;
    if (
      providerAdapter === undefined &&
      (options.credentialReference !== undefined || options.openaiBaseUrl !== undefined)
    ) {
      // Compatibility seam for deterministic tests that predate connection profiles.
      const credentials = composeProductCredentials({
        clock: graph.clock,
        commands: createHostCommandRunner(ownedProcessOptions),
        platform: hostPlatform(),
        environment: graph.environment,
      });
      const reference = options.credentialReference ?? DEFAULT_OPENAI_CREDENTIAL_REFERENCE;
      const apiKey = await resolveProviderApiKey(credentials.resolver, reference, options.signal);
      if (apiKey !== null) {
        const baseUrl = options.openaiBaseUrl ?? "https://api.openai.com/v1";
        providerAdapter = createOpenAiSdkAdapter({
          profileId: "openai",
          baseUrl,
          resolveApiKey: async () => apiKey,
          ...(options.openaiFetch === undefined ? {} : { fetch: options.openaiFetch }),
        });
      }
    }
    if (providerAdapter === undefined) {
      const handoff = await composeProductProviderConnections(
        graph,
        options.globals ?? {
          format: "human",
          color: "auto",
          quiet: false,
          verbose: false,
          nonInteractive: true,
          workspace: null,
          addDirs: [],
          profile: null,
          timeoutMs: null,
          help: false,
          version: false,
        },
        {
          configuration: configuration.values,
          ...ownedProcessOptions,
          ...(options.openaiFetch === undefined ? {} : { providerFetch: options.openaiFetch }),
        },
      ).resolveSelected(options.signal);
      providerAdapter = handoff.kind === "ready" ? handoff.adapter : null;
      providerCatalog = handoff.kind === "ready" ? handoff.session.catalog : null;
      providerUnavailableCode = handoff.kind === "unavailable" ? handoff.code : null;
    }
    if (providerAdapter !== null && providerAdapter !== undefined && providerCatalog === null) {
      providerCatalog = catalogForAdapter(providerAdapter, Number(generation), graph.clock.now());
    }

    const productArtifacts = options.artifacts ?? productArtifactSession?.artifacts;
    const productLoom = options.loom ?? productArtifactSession?.loom;
    const captureOptions = {
      clock: graph.clock,
      ...ownedProcessOptions,
      ...(productArtifacts === undefined ? {} : { artifacts: productArtifacts }),
    };
    const workspaceTools = composeProductWorkspaceTools({
      generation,
      fileSystem: graph.fileSystem,
      commands: createHostCommandRunner(ownedProcessOptions),
      workspaceRoot,
      ...(productArtifacts === undefined ? {} : { artifacts: productArtifacts }),
      ...(productLoom === undefined ? {} : { loom: productLoom }),
      ...(indexStore === null ? {} : { index: indexStore }),
      workspaceId,
      sessionId,
    });
    const processTools = composeProductProcessTools({
      generation,
      capture: options.processCapture ?? createHostProcessCapturePort(captureOptions),
      workspaceCwd: String(workspaceRoot),
      ...(productArtifacts === undefined ? {} : { artifacts: productArtifacts }),
      ...(productLoom === undefined ? {} : { loom: productLoom }),
      workspaceId: String(workspaceId),
      sessionId: String(sessionId),
    });
    const gitTools = composeProductGitTools({
      generation,
      git: createHostGitPort({
        capture: createHostProcessCapturePort(captureOptions),
        clock: graph.clock,
      }),
      gitExecutable: "/usr/bin/git",
      startPath: String(workspaceRoot),
    });
    const managedServices = createHostManagedServicePort(ownedProcessOptions);
    const languageTools = composeProductLanguageTools({
      generation,
      languageServers: createLanguageServerSupervisor(managedServices),
      debugAdapters: createDebugAdapterSupervisor(managedServices, {
        confirmationPolicy: "auto-allow",
        ...(productArtifacts === undefined ? {} : { artifacts: productArtifacts }),
      }),
      fileSystem: graph.fileSystem,
      workspaceRoot,
    });
    const memoryTools = composeProductMemoryTools({
      generation,
      records: productArtifactSession.memoryRecords,
    });
    const productTools = mergeProductToolBundles(
      generation,
      [workspaceTools, processTools, gitTools, languageTools, memoryTools],
      {
        afterMutation: async (signalRequest) => {
          workspaceTools.invalidateContext();
          const languageDiagnostics = await languageTools.afterWorkspaceMutation(
            signalRequest.signal,
          );
          if (indexLifecycle === null) {
            return {
              workspaceIndex: { status: "unavailable", code: "index-unavailable" },
              languageDiagnostics,
            };
          }
          const refreshed = await indexLifecycle.refresh(signalRequest.signal);
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
      eventStore: productArtifactSession.eventStore,
      clock: graph.clock,
      streamId: streamId.from(`live-turn:${String(sessionId)}`),
      correlation: {
        workspaceId,
        sessionId,
        traceId,
        configurationGeneration: generation,
      },
      ...(providerAdapter !== undefined && providerAdapter !== null ? { providerAdapter } : {}),
      toolRegistry: productTools.registry,
      toolCatalog: productTools.catalog,
      toolRunner: productTools.runner,
      ...(options.toolConfirmation === undefined
        ? {}
        : { toolConfirmation: options.toolConfirmation }),
    });
    if (!composed.ok) {
      return codingResult(
        {
          prompt: resolved.prompt,
          sessionId: ids.sessionId,
          turnId: null,
          workspaceId: String(workspaceId),
          stage: "compose-failed",
          eventCount: 0,
        },
        [
          adoptForeignError(
            {
              code: `runtime.${composed.error.code}`,
              category: "internal",
              message: `product agent runtime could not compose (${composed.error.code})`,
            },
            { operation: "compose product agent runtime" },
          ),
        ],
      );
    }

    const contextPlannerOwner = CONTEXT_PLANNER_OWNER;
    const selectedExecutionProfile = arguments_.mode ?? "agent";
    const briefVerbosity =
      arguments_.brief ?? executionProfile(selectedExecutionProfile).defaultBriefVerbosity;
    const briefOwner = PRODUCT_BRIEF_OWNER;
    const briefControls = composeProductBriefControls({ initialVerbosity: briefVerbosity });
    const briefed = briefControls.projectForTurn({
      turnId,
      sessionId,
      configurationGeneration: generation,
    });
    const memoryTurn = composeProductMemoryTurn({
      admission: memoryTools.admission,
      recall: memoryTools.recall,
    });
    const otherSections = [];
    if (briefed.ok) {
      otherSections.push(briefed.value.section);
    }
    const contextSource =
      indexStore === null
        ? createUnavailableProductContextSource(
            "index-unavailable",
            workspaceTools.contextCandidates,
          )
        : createProductContextSource({
            fileSystem: graph.fileSystem,
            index: indexStore,
            workspaceRoot,
            workspaceId,
            additionalCandidates: workspaceTools.contextCandidates,
          });
    const executor = createProductLiveTurnExecutor({
      runtime: composed.value,
      clock: graph.clock,
      providerCatalog,
      contextSource,
      memory: memoryTurn,
      artifacts: options.artifacts ?? productArtifactSession.artifacts,
      initialExecutionProfile: selectedExecutionProfile,
    });
    const attempted = await executor.run({
      prompt: resolved.prompt,
      turnId,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      otherSections,
    });
    const succeeded = attempted.kind === "completed";
    const errors = succeeded
      ? []
      : [
          adoptForeignError(
            {
              code: attempted.code,
              category: attempted.code.startsWith("provider.") ? "provider" : "internal",
              message:
                attempted.code === "provider.adapter-required"
                  ? `The selected provider connection is unavailable (${providerUnavailableCode ?? "provider-not-ready"}). Run 'falryn provider list' and 'falryn provider test <id>' to inspect it.`
                  : attempted.message,
            },
            { operation: "run coding attempt" },
          ),
        ];

    return codingResult(
      {
        prompt: resolved.prompt,
        sessionId: ids.sessionId,
        turnId: ids.turnId,
        workspaceId: String(workspaceId),
        stage:
          attempted.code === "provider.adapter-required"
            ? "provider-required"
            : succeeded
              ? "attempt-completed"
              : "attempt-failed",
        eventCount: attempted.events.length,
        contextPackItems: attempted.contextPackItems,
        contextPlannerOwner,
        indexFreshness,
        indexOwner,
        briefVerbosity,
        briefOwner,
        contextStatus: attempted.contextStatus,
        contextGeneration: attempted.contextGeneration,
        recalledMemories: attempted.recalledMemories,
        memoryAdmission: attempted.memoryAdmission,
        response: attempted.response,
        modelAttempts: attempted.modelAttempts,
        toolResults: attempted.toolResults,
        disclosedTools: attempted.disclosedTools,
        executionProfile: attempted.executionProfile,
        executionProfileVersion: attempted.executionProfileVersion,
        completionCriterion: attempted.completionCriterion,
        effectiveModelRole: attempted.effectiveModelRole,
        effectiveReasoning: attempted.effectiveReasoning,
        policyGeneration: attempted.policyGeneration,
        planArtifactId: attempted.planArtifactId,
      },
      errors,
      attempted.terminalOutcome,
      READ_ONLY_EFFECT,
      attempted.events,
    );
  } finally {
    await productArtifactSession?.close();
    configReload?.dispose();
  }
}

function codingResult(
  payload: CodingRunPayload,
  errors: readonly FalrynError[],
  outcome?: TerminalOutcome,
  effect: CommandEffect = READ_ONLY_EFFECT,
  events: readonly RuntimeEvent[] = [],
): CodingRunResult {
  return attachResultEvents(
    {
      schemaFamily: COMMAND_RESULT_SCHEMA_FAMILY,
      schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
      command: CODING_RUN_COMMAND,
      outcome:
        outcome ??
        (errors.length === 0 ? { kind: "completed" } : { kind: "failed", effect: "none" }),
      effect,
      payload,
      errors,
      warnings: [],
      omissions: [],
      truncation: [],
      artifacts: [],
      correlation: {
        workspaceId: payload.workspaceId === "" ? null : workspaceIdCodec.from(payload.workspaceId),
        sessionId: payload.sessionId === "" ? null : sessionIdCodec.from(payload.sessionId),
        turnId: payload.turnId === null ? null : turnIdCodec.from(payload.turnId),
        traceId: null,
        scopeId: null,
        invocationId: null,
        capabilityId: null,
        eventId: null,
      },
    },
    events,
  );
}
