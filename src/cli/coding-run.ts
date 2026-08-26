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

import {
  adoptForeignError,
  attemptModelInputFromPrompt,
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
  createContextPlanner,
  createDebugAdapterSupervisor,
  createEphemeralProductIndexPort,
  createLanguageServerSupervisor,
  createTurnAttemptPolicy,
  DEFAULT_OPENAI_CREDENTIAL_REFERENCE,
  discloseProductTools,
  type LoomPort,
  mergeProductToolBundles,
  PRODUCT_BRIEF_OWNER,
  PRODUCT_INDEX_LIFECYCLE_OWNER,
  resolveProviderApiKey,
} from "../application/index.ts";
import {
  type ArtifactStorePort,
  type BriefVerbosityMode,
  type CredentialReference,
  type FalrynError,
  type InputStreamPort,
  type Instant,
  primaryWorkspaceRoot,
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
  hostPlatform,
  type OwnedProcessRegistry,
} from "../integrations/index.ts";
import {
  DEFAULT_INTENT_ROLE_MAP,
  type ModelCatalog,
  type ModelPolicy,
} from "../providers/index.ts";
import type { OpenAiCompatibleFetch } from "../providers/openai-compatible-adapter.ts";
import { createOpenAiCompatibleAdapter } from "../providers/openai-compatible-adapter.ts";
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
import { CLI_EVENT_STREAM, type ServiceProvider } from "./services.ts";
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
  /** Final assistant text from the terminal model attempt. */
  readonly response?: string;
  readonly modelAttempts?: number;
  readonly toolResults?: number;
  readonly disclosedTools?: number;
};

export type CodingRunResult = CommandResultOf<typeof CODING_RUN_COMMAND, CodingRunPayload>;

export type CodingRunOptions = {
  readonly input: InputStreamPort;
  readonly signal?: AbortSignal;
  /**
   * Stable identities for tests. Production derives session/turn/trace from
   * the clock so each invocation is distinct without depending on crypto.
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
  /** OpenAI-compatible base URL when composing from credentials. */
  readonly openaiBaseUrl?: string;
  /** Injectable transport for deterministic OpenAI-compatible integration tests. */
  readonly openaiFetch?: OpenAiCompatibleFetch;
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
  return {
    generation,
    provenance: "static-config",
    fetchedAt,
    expiresAt: null,
    models: adapter.supportedModels.map((modelId) => ({
      modelId,
      modalities: ["text"],
      tools: true,
      streaming: true,
      reasoning: false,
      contextTokens: null,
      outputTokens: null,
    })),
  };
}

function policyForCatalog(adapter: ProviderAdapterPort, catalog: ModelCatalog): ModelPolicy | null {
  const selected = catalog.models[0];
  if (selected === undefined) {
    return null;
  }
  return {
    roles: {
      default: {
        providerId: adapter.identity.providerId,
        modelId: selected.modelId,
        reasoning: "provider-default",
        fallbacks: [],
        budgets: {},
      },
    },
    intents: DEFAULT_INTENT_ROLE_MAP,
  };
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
    const now = graph.clock.now();
    const ids = options.identities ?? {
      sessionId: `session-run-${now}`,
      turnId: `turn-run-${now}`,
      traceId: `trace-run-${now}`,
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
    if (options.artifacts === undefined) {
      productArtifactSession = await openProductArtifactSession(graph, options.signal);
    }

    const indexStore = createEphemeralProductIndexPort();
    const indexLifecycle = composeProductIndexLifecycle({
      fileSystem: graph.fileSystem,
      workspaceRoot: primaryWorkspaceRoot(workspace.value.set).path,
      index: indexStore,
    });
    await indexLifecycle.rebuild(options.signal);
    const indexFreshness = indexLifecycle.status().freshness;
    const indexOwner = PRODUCT_INDEX_LIFECYCLE_OWNER;
    const ownedProcessOptions =
      options.ownedProcesses === undefined ? {} : { ownedProcesses: options.ownedProcesses };
    const captureOptions = {
      clock: graph.clock,
      ...ownedProcessOptions,
    };

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
        providerAdapter = createOpenAiCompatibleAdapter({
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
    const workspaceTools = composeProductWorkspaceTools({
      generation,
      fileSystem: graph.fileSystem,
      commands: createHostCommandRunner(ownedProcessOptions),
      workspaceRoot: primaryWorkspaceRoot(workspace.value.set).path,
      ...(productArtifacts === undefined ? {} : { artifacts: productArtifacts }),
      ...(productLoom === undefined ? {} : { loom: productLoom }),
      index: indexStore,
      workspaceId,
      sessionId,
    });
    const processTools = composeProductProcessTools({
      generation,
      capture: createHostProcessCapturePort(captureOptions),
      workspaceCwd: String(primaryWorkspaceRoot(workspace.value.set).path),
    });
    const gitTools = composeProductGitTools({
      generation,
      git: createHostGitPort({
        capture: createHostProcessCapturePort(captureOptions),
        clock: graph.clock,
      }),
      gitExecutable: "/usr/bin/git",
      startPath: String(primaryWorkspaceRoot(workspace.value.set).path),
    });
    const managedServices = createHostManagedServicePort(ownedProcessOptions);
    const languageTools = composeProductLanguageTools({
      generation,
      languageServers: createLanguageServerSupervisor(managedServices),
      debugAdapters: createDebugAdapterSupervisor(managedServices),
    });
    const memoryTools = composeProductMemoryTools({ generation });
    const productTools = mergeProductToolBundles(generation, [
      workspaceTools,
      processTools,
      gitTools,
      languageTools,
      memoryTools,
    ]);
    const toolDisclosure = discloseProductTools(productTools.registry);

    const composed = composeProductAgentRuntime({
      eventStore: graph.eventStore,
      clock: graph.clock,
      streamId: streamId.from(CLI_EVENT_STREAM),
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

    const producer = composed.value.attachments.turnProducer;
    const startedSession = await producer.startSession({
      sessionId,
      workspaceId,
      configurationGeneration: generation,
    });
    if (!startedSession.ok) {
      return codingResult(
        {
          prompt: resolved.prompt,
          sessionId: ids.sessionId,
          turnId: null,
          workspaceId: String(workspaceId),
          stage: "compose-failed",
          eventCount: producer.events().length,
        },
        [
          adoptForeignError(
            {
              code: `producer.${startedSession.error.code}`,
              category: "internal",
              message: `session could not start (${startedSession.error.code})`,
            },
            { operation: "start coding session" },
          ),
        ],
      );
    }

    const startedTurn = await producer.startTurn({
      turnId,
      sessionId,
      workspaceId,
      traceId,
      configurationGeneration: generation,
    });
    if (!startedTurn.ok) {
      return codingResult(
        {
          prompt: resolved.prompt,
          sessionId: ids.sessionId,
          turnId: null,
          workspaceId: String(workspaceId),
          stage: "compose-failed",
          eventCount: producer.events().length,
        },
        [
          adoptForeignError(
            {
              code: `producer.${startedTurn.error.code}`,
              category: "internal",
              message: `turn could not start (${startedTurn.error.code})`,
            },
            { operation: "start coding turn" },
          ),
        ],
      );
    }

    const planned = createContextPlanner().composeTurn({
      turnId,
      sessionId,
      workspaceId,
      configurationGeneration: generation,
      task: resolved.prompt,
      candidates: workspaceTools.contextCandidates(),
      tools: toolDisclosure.promptTools,
      otherSections: (() => {
        const briefControls = composeProductBriefControls({
          initialVerbosity: arguments_.brief ?? "balanced",
        });
        const briefed = briefControls.projectForTurn({
          turnId,
          sessionId,
          configurationGeneration: generation,
        });
        const memoryTurn = composeProductMemoryTurn({
          admission: memoryTools.admission,
          recall: memoryTools.recall,
        }).endTurn({
          turnId,
          sessionId,
          workspaceId,
          task: resolved.prompt,
        });
        const sections = [];
        if (briefed.ok) {
          sections.push(briefed.value.section);
        }
        if (memoryTurn.ok && memoryTurn.value.memorySection !== null) {
          sections.push(memoryTurn.value.memorySection);
        }
        return sections;
      })(),
    });
    if (!planned.ok) {
      return codingResult(
        {
          prompt: resolved.prompt,
          sessionId: ids.sessionId,
          turnId: ids.turnId,
          workspaceId: String(workspaceId),
          stage: "compose-failed",
          eventCount: producer.events().length,
          contextPlannerOwner: CONTEXT_PLANNER_OWNER,
          indexFreshness,
          indexOwner,
          briefVerbosity: arguments_.brief ?? "balanced",
          briefOwner: PRODUCT_BRIEF_OWNER,
        },
        [
          adoptForeignError(
            {
              code: "context.planner-failed",
              category: "internal",
              message: `live context planner could not compose (${"code" in planned.error ? planned.error.code : "failed"})`,
            },
            { operation: "compose live turn context" },
          ),
        ],
      );
    }
    const contextPackItems = planned.value.plan.pack.items.length;
    const contextPlannerOwner = CONTEXT_PLANNER_OWNER;
    const briefVerbosity = arguments_.brief ?? "balanced";
    const briefOwner = PRODUCT_BRIEF_OWNER;

    const provider = composed.value.requireProviderAdapter();
    if (!provider.ok) {
      const outcome: TerminalOutcome = { kind: "failed", effect: "none" };
      const completed = await producer.completeTurn({
        turnId,
        sessionId,
        workspaceId,
        traceId,
        configurationGeneration: generation,
        outcome,
      });
      if (!completed.ok) {
        return codingResult(
          {
            prompt: resolved.prompt,
            sessionId: ids.sessionId,
            turnId: ids.turnId,
            workspaceId: String(workspaceId),
            stage: "provider-required",
            eventCount: producer.events().length,
            contextPackItems,
            contextPlannerOwner,
            indexFreshness,
            indexOwner,
            briefVerbosity,
            briefOwner,
          },
          [
            adoptForeignError(
              {
                code: "provider.adapter-required",
                category: "provider",
                message: `The selected provider connection is unavailable (${providerUnavailableCode ?? "provider-not-ready"}). Run 'falryn provider list' and 'falryn provider test <id>' to inspect it. Turn completion also failed (${completed.error.code}).`,
              },
              { operation: "require provider for coding run" },
            ),
          ],
          outcome,
        );
      }

      return codingResult(
        {
          prompt: resolved.prompt,
          sessionId: ids.sessionId,
          turnId: ids.turnId,
          workspaceId: String(workspaceId),
          stage: "provider-required",
          eventCount: producer.events().length,
          contextPackItems,
          contextPlannerOwner,
          indexFreshness,
          indexOwner,
          briefVerbosity,
          briefOwner,
        },
        [
          adoptForeignError(
            {
              code: "provider.adapter-required",
              category: "provider",
              message: `The selected provider connection is unavailable (${providerUnavailableCode ?? "provider-not-ready"}). Run 'falryn provider list' and 'falryn provider test <id>' to inspect it.`,
            },
            { operation: "require provider for coding run" },
          ),
        ],
        outcome,
      );
    }

    const attemptRunner = composed.value.requireAttemptRunner();
    const modelPolicy =
      providerCatalog === null ? null : policyForCatalog(provider.value, providerCatalog);
    if (!attemptRunner.ok || providerCatalog === null || modelPolicy === null) {
      const outcome: TerminalOutcome = { kind: "failed", effect: "none" };
      await producer.completeTurn({
        turnId,
        sessionId,
        workspaceId,
        traceId,
        configurationGeneration: generation,
        outcome,
      });
      return codingResult(
        {
          prompt: resolved.prompt,
          sessionId: ids.sessionId,
          turnId: ids.turnId,
          workspaceId: String(workspaceId),
          stage: "attempt-failed",
          eventCount: producer.events().length,
          contextPackItems,
          contextPlannerOwner,
          indexFreshness,
          indexOwner,
          briefVerbosity,
          briefOwner,
          modelAttempts: 0,
          toolResults: 0,
          disclosedTools: toolDisclosure.receipt.disclosed.length,
        },
        [
          adoptForeignError(
            {
              code: "runtime.attempt-runner-required",
              category: "internal",
              message:
                providerCatalog === null
                  ? "The selected provider has no usable model catalog."
                  : modelPolicy === null
                    ? "The selected provider catalog contains no model."
                    : "The product attempt runner is unavailable.",
            },
            { operation: "compose coding attempt" },
          ),
        ],
        outcome,
      );
    }

    const attemptPolicy = createTurnAttemptPolicy({
      clock: graph.clock,
      coordinator: composed.value.turnCoordinator,
      runner: attemptRunner.value,
      policy: modelPolicy,
      catalogs: [
        {
          providerId: provider.value.identity.providerId,
          catalog: providerCatalog,
        },
      ],
      journal: composed.value.journal,
    });
    const attempted = await attemptPolicy.run({
      turnId,
      configurationGeneration: generation,
      signal: options.signal ?? new AbortController().signal,
      intent: "coding",
      modelInput: attemptModelInputFromPrompt(planned.value.prompt, toolDisclosure),
    });
    const terminalTurn = attempted.turn;
    const terminalOutcome: TerminalOutcome =
      terminalTurn?.status === "terminal" && terminalTurn.outcome !== null
        ? terminalTurn.outcome
        : { kind: "failed", effect: "none" };
    const completed = await producer.completeTurn({
      turnId,
      sessionId,
      workspaceId,
      traceId,
      configurationGeneration: generation,
      outcome: terminalOutcome,
    });
    await producer.refreshFromStore();
    const lastAttempt = attempted.attempts.at(-1) ?? null;
    const response = lastAttempt?.output?.text ?? "";
    const toolResults = attempted.attempts.reduce(
      (total, attempt) => total + (attempt.output?.toolResults ?? 0),
      0,
    );
    const succeeded = attempted.kind === "completed" && completed.ok;
    const errors = succeeded
      ? []
      : [
          adoptForeignError(
            {
              code: `runtime.attempt-${attempted.kind}`,
              category: attempted.kind === "routing-refused" ? "provider" : "internal",
              message: completed.ok
                ? `The coding attempt settled as ${attempted.kind}.`
                : `The coding attempt settled as ${attempted.kind}; session completion failed (${completed.error.code}).`,
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
        stage: succeeded ? "attempt-completed" : "attempt-failed",
        eventCount: producer.events().length,
        contextPackItems,
        contextPlannerOwner,
        indexFreshness,
        indexOwner,
        briefVerbosity,
        briefOwner,
        response,
        modelAttempts: attempted.attempts.length,
        toolResults,
        disclosedTools: toolDisclosure.receipt.disclosed.length,
      },
      errors,
      terminalOutcome,
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
): CodingRunResult {
  return {
    schemaFamily: COMMAND_RESULT_SCHEMA_FAMILY,
    schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
    command: CODING_RUN_COMMAND,
    outcome:
      outcome ?? (errors.length === 0 ? { kind: "completed" } : { kind: "failed", effect: "none" }),
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
  };
}
