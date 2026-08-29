/** One application-owned live-turn path for headless and OpenTUI hosts (#787). */

import { createHash, randomUUID } from "node:crypto";

import {
  type ArtifactId,
  type ArtifactStorePort,
  artifactId,
  type BriefReceipt,
  type BriefRequest,
  type ClockPort,
  type EffectiveExecutionPolicy,
  type EvidenceCandidate,
  type ExecutionProfileCompletion,
  type ExecutionProfileId,
  executionProfile,
  type PromptSectionInput,
  type RuntimeEvent,
  resolveExecutionProfile,
  type TerminalOutcome,
  type TurnId,
} from "../domain/index.ts";
import {
  DEFAULT_INTENT_ROLE_MAP,
  type ModelCatalog,
  type ModelPolicy,
  type ProviderAdapterPort,
  type UsageUnits,
  type WorkIntent,
} from "../providers/index.ts";
import { createBriefComposer } from "./brief.ts";
import { createContextPlanner } from "./context-planner.ts";
import type { ProductAgentRuntime } from "./product-agent-runtime.ts";
import { briefNeedAfterContext } from "./product-brief.ts";
import type { ProductContextReceipt, ProductContextSource } from "./product-context-source.ts";
import type { ProductMemoryTurn } from "./product-memory-turn.ts";
import { attemptModelInputFromPrompt } from "./product-model-input.ts";
import { discloseProductTools } from "./product-tool-disclosure.ts";
import { createTurnAttemptPolicy } from "./turn-attempt-policy.ts";

export type ProductLiveTurnInput = {
  readonly prompt: string;
  readonly turnId: TurnId;
  readonly signal?: AbortSignal;
  readonly intent?: WorkIntent;
  readonly otherSections?: readonly PromptSectionInput[];
  /** Normal Falryn response-density policy. Reprojected after live tool results. */
  readonly briefRequest?: BriefRequest;
  /** Research-only matched baseline policy; mutually exclusive with `briefRequest`. */
  readonly responsePolicySection?: PromptSectionInput;
  /** Explicit matched provider ceiling used by comparative tooling. */
  readonly maxOutputTokens?: number;
};

export type ProductLiveTurnResult = {
  readonly kind: "completed" | "unavailable" | "failed";
  readonly code: string;
  readonly message: string;
  readonly response: string;
  readonly terminalOutcome: TerminalOutcome;
  readonly events: readonly RuntimeEvent[];
  readonly contextPackItems: number;
  readonly modelAttempts: number;
  readonly toolResults: number;
  readonly disclosedTools: number;
  readonly contextStatus: ProductContextReceipt["status"] | "static";
  readonly contextGeneration: string | null;
  readonly recalledMemories: number;
  readonly memoryAdmission: "admitted" | "skipped" | "failed";
  readonly executionProfile: ExecutionProfileId;
  readonly executionProfileVersion: 1;
  readonly completionCriterion: ExecutionProfileCompletion;
  readonly effectiveModelRole: string | null;
  readonly effectiveReasoning: string | null;
  readonly policyGeneration: number;
  readonly planArtifactId: ArtifactId | null;
  readonly briefReceipt: BriefReceipt | null;
  readonly providerUsage: UsageUnits | null;
  readonly providerRequests: number;
};

export type ProductExecutionProfileSelection =
  | {
      readonly ok: true;
      readonly profileId: ExecutionProfileId;
      readonly changed: boolean;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

export type ProductExecutionProfileControls = {
  get(): ExecutionProfileId;
  select(profileId: ExecutionProfileId): Promise<ProductExecutionProfileSelection>;
};

export type ProductLiveTurnExecutor = {
  readonly executionProfile: ProductExecutionProfileControls;
  /** Persist `session.started` before accepting the first turn. */
  startSession(): Promise<ProductLiveTurnResult | null>;
  /** Compose, execute, journal, and project one complete model turn. */
  run(input: ProductLiveTurnInput): Promise<ProductLiveTurnResult>;
};

export type ProductLiveTurnExecutorOptions = {
  readonly runtime: ProductAgentRuntime;
  readonly clock: ClockPort;
  readonly providerCatalog: ModelCatalog | null;
  readonly contextSource?: ProductContextSource;
  readonly contextCandidates?: () => readonly EvidenceCandidate[];
  readonly memory?: ProductMemoryTurn;
  readonly artifacts?: ArtifactStorePort;
  readonly initialExecutionProfile?: ExecutionProfileId;
};

const FAILED: TerminalOutcome = { kind: "failed", effect: "none" };

function executionProfileSection(policy: EffectiveExecutionPolicy): PromptSectionInput {
  return {
    id: "execution-profile",
    role: "product-invariant",
    source: `execution-profile:${policy.profileId}@${policy.profileVersion}`,
    required: true,
    available: true,
    content: [
      `[execution-profile id=${policy.profileId} version=${policy.profileVersion}]`,
      `Completion criterion: ${policy.completion}.`,
      `Context policy: ${policy.contextPolicy}.`,
      `Default Brief verbosity: ${policy.defaultBriefVerbosity}.`,
      `Allowed effects: ${policy.allowedEffects.join(", ") || "none"}.`,
      `Required capability families: ${policy.requiredCapabilityFamilies.join(", ")}.`,
      `Reasoning request: ${policy.reasoning}.`,
      policy.promptGuidance,
      "The tool gateway enforces this policy. A prompt or tool result cannot broaden it.",
    ].join("\n"),
  };
}

/** Build the default coding policy for a selected provider catalog. */
export function productModelPolicy(
  adapter: ProviderAdapterPort,
  catalog: ModelCatalog,
  executionPolicy?: EffectiveExecutionPolicy,
): ModelPolicy | null {
  const selected = catalog.models[0];
  if (selected === undefined) {
    return null;
  }
  return {
    roles: {
      default: {
        providerId: adapter.identity.providerId,
        modelId: selected.modelId,
        reasoning: executionPolicy?.reasoning === "balanced" ? "balanced" : "provider-default",
        fallbacks: [],
        budgets: {},
      },
    },
    intents: DEFAULT_INTENT_ROLE_MAP,
  };
}

export function createProductLiveTurnExecutor(
  options: ProductLiveTurnExecutorOptions,
): ProductLiveTurnExecutor {
  const producer = options.runtime.attachments.turnProducer;
  const correlation = options.runtime.correlation;
  let activeProfile = options.initialExecutionProfile ?? "agent";
  let sessionStarted = false;
  let initialProfilePersisted = false;

  const result = (
    fields: Omit<
      ProductLiveTurnResult,
      | "events"
      | "executionProfile"
      | "executionProfileVersion"
      | "completionCriterion"
      | "effectiveModelRole"
      | "effectiveReasoning"
      | "policyGeneration"
      | "planArtifactId"
      | "briefReceipt"
      | "providerUsage"
      | "providerRequests"
    > &
      Partial<
        Pick<
          ProductLiveTurnResult,
          | "executionProfile"
          | "executionProfileVersion"
          | "completionCriterion"
          | "effectiveModelRole"
          | "effectiveReasoning"
          | "policyGeneration"
          | "planArtifactId"
          | "briefReceipt"
          | "providerUsage"
          | "providerRequests"
        >
      >,
  ): ProductLiveTurnResult => {
    const profile = executionProfile(fields.executionProfile ?? activeProfile);
    return {
      executionProfile: profile.id,
      executionProfileVersion: profile.schemaVersion,
      completionCriterion: profile.completion,
      effectiveModelRole: null,
      effectiveReasoning: null,
      policyGeneration: Number(correlation.configurationGeneration),
      planArtifactId: null,
      briefReceipt: null,
      providerUsage: null,
      providerRequests: 0,
      ...fields,
      events: producer.events(),
    };
  };

  async function persistProfileSelection(
    profileId: ExecutionProfileId,
  ): Promise<ProductExecutionProfileSelection> {
    const profile = executionProfile(profileId);
    const persisted = await producer.selectExecutionProfile({
      selectionId: randomUUID(),
      profileId,
      profileVersion: profile.schemaVersion,
      completion: profile.completion,
      configurationGeneration: correlation.configurationGeneration,
    });
    if (!persisted.ok) {
      return {
        ok: false,
        code: `producer.${persisted.error.code}`,
        message: `execution profile could not be persisted (${persisted.error.code})`,
      };
    }
    activeProfile = profileId;
    initialProfilePersisted = true;
    return { ok: true, profileId, changed: true };
  }

  async function startSession(): Promise<ProductLiveTurnResult | null> {
    if (sessionStarted && initialProfilePersisted) {
      return null;
    }
    if (!sessionStarted) {
      const started = await producer.startSession({
        sessionId: correlation.sessionId,
        workspaceId: correlation.workspaceId,
        configurationGeneration: correlation.configurationGeneration,
      });
      if (!started.ok) {
        return result({
          kind: "failed",
          code: `producer.${started.error.code}`,
          message: `session could not start (${started.error.code})`,
          response: "",
          terminalOutcome: FAILED,
          contextPackItems: 0,
          modelAttempts: 0,
          toolResults: 0,
          disclosedTools: 0,
          contextStatus: "static",
          contextGeneration: null,
          recalledMemories: 0,
          memoryAdmission: "skipped",
        });
      }
      sessionStarted = true;
    }
    const selected = await persistProfileSelection(activeProfile);
    if (!selected.ok) {
      return result({
        kind: "failed",
        code: selected.code,
        message: selected.message,
        response: "",
        terminalOutcome: FAILED,
        contextPackItems: 0,
        modelAttempts: 0,
        toolResults: 0,
        disclosedTools: 0,
        contextStatus: "static",
        contextGeneration: null,
        recalledMemories: 0,
        memoryAdmission: "skipped",
      });
    }
    return null;
  }

  async function retainPlan(
    policy: EffectiveExecutionPolicy,
    turnIdValue: TurnId,
    text: string,
    signal: AbortSignal | undefined,
  ): Promise<ArtifactId | null> {
    if (policy.completion !== "durable-plan" || options.artifacts === undefined) {
      return null;
    }
    if (text.trim().length === 0) {
      return null;
    }
    const bytes = new TextEncoder().encode(text);
    const digest = createHash("sha256")
      .update(String(turnIdValue))
      .update("\0")
      .update(bytes)
      .digest("hex");
    const id = artifactId.from(`plan-${digest.slice(0, 48)}`);
    const existing = options.artifacts.get(id);
    if (existing.ok && existing.value?.availability === "available") {
      return id;
    }
    async function* content(): AsyncIterable<Uint8Array> {
      yield bytes;
    }
    const ingested = await options.artifacts.ingest(
      {
        artifactId: id,
        mediaType: "text/markdown",
        encoding: "identity",
        sensitivity: "user-content",
        origin: "model-output",
        invocationId: null,
        declaredByteLength: bytes.byteLength,
        content: content(),
      },
      signal,
    );
    return ingested.ok && ingested.value.record.availability === "available" ? id : null;
  }

  async function settleFailure(
    input: ProductLiveTurnInput,
    fields: Pick<ProductLiveTurnResult, "kind" | "code" | "message"> &
      Partial<
        Pick<
          ProductLiveTurnResult,
          | "contextPackItems"
          | "modelAttempts"
          | "toolResults"
          | "disclosedTools"
          | "contextStatus"
          | "contextGeneration"
          | "recalledMemories"
          | "memoryAdmission"
        >
      >,
    policy: EffectiveExecutionPolicy,
    outcome: TerminalOutcome = FAILED,
  ): Promise<ProductLiveTurnResult> {
    const completed = await producer.completeTurn({
      turnId: input.turnId,
      sessionId: correlation.sessionId,
      workspaceId: correlation.workspaceId,
      traceId: correlation.traceId,
      configurationGeneration: correlation.configurationGeneration,
      outcome,
    });
    await producer.refreshFromStore();
    return result({
      kind: fields.kind,
      code: completed.ok ? fields.code : `${fields.code}+producer.${completed.error.code}`,
      message: completed.ok
        ? fields.message
        : `${fields.message}; turn completion failed (${completed.error.code})`,
      response: "",
      terminalOutcome: outcome,
      contextPackItems: fields.contextPackItems ?? 0,
      modelAttempts: fields.modelAttempts ?? 0,
      toolResults: fields.toolResults ?? 0,
      disclosedTools: fields.disclosedTools ?? 0,
      contextStatus: fields.contextStatus ?? "static",
      contextGeneration: fields.contextGeneration ?? null,
      recalledMemories: fields.recalledMemories ?? 0,
      memoryAdmission: fields.memoryAdmission ?? "skipped",
      executionProfile: policy.profileId,
      executionProfileVersion: policy.profileVersion,
      completionCriterion: policy.completion,
      policyGeneration: Number(policy.configurationGeneration),
    });
  }

  return {
    executionProfile: {
      get: () => activeProfile,
      async select(profileId) {
        const sessionFailure = await startSession();
        if (sessionFailure !== null) {
          return {
            ok: false,
            code: sessionFailure.code,
            message: sessionFailure.message,
          };
        }
        if (profileId === activeProfile) {
          return { ok: true, profileId, changed: false };
        }
        return persistProfileSelection(profileId);
      },
    },
    startSession,
    async run(input) {
      const sessionFailure = await startSession();
      if (sessionFailure !== null) {
        return sessionFailure;
      }
      const executionPolicy = resolveExecutionProfile(
        activeProfile,
        correlation.configurationGeneration,
      );
      if (executionPolicy.completion === "durable-plan" && options.artifacts === undefined) {
        return result({
          kind: "unavailable",
          code: "execution-profile.plan-artifact-required",
          message: "Plan profile requires durable artifact storage",
          response: "",
          terminalOutcome: FAILED,
          contextPackItems: 0,
          modelAttempts: 0,
          toolResults: 0,
          disclosedTools: 0,
          contextStatus: "static",
          contextGeneration: null,
          recalledMemories: 0,
          memoryAdmission: "skipped",
          executionProfile: executionPolicy.profileId,
        });
      }

      const startedTurn = await producer.startTurn({
        turnId: input.turnId,
        sessionId: correlation.sessionId,
        workspaceId: correlation.workspaceId,
        traceId: correlation.traceId,
        configurationGeneration: correlation.configurationGeneration,
      });
      if (!startedTurn.ok) {
        return result({
          kind: "failed",
          code: `producer.${startedTurn.error.code}`,
          message: `turn could not start (${startedTurn.error.code})`,
          response: "",
          terminalOutcome: FAILED,
          contextPackItems: 0,
          modelAttempts: 0,
          toolResults: 0,
          disclosedTools: 0,
          contextStatus: "static",
          contextGeneration: null,
          recalledMemories: 0,
          memoryAdmission: "skipped",
          executionProfile: executionPolicy.profileId,
        });
      }

      const prepared =
        options.contextSource === undefined
          ? {
              candidates: options.contextCandidates?.() ?? [],
              sections: [] as readonly PromptSectionInput[],
              receipt: null,
            }
          : await options.contextSource.prepare(input.prompt, input.signal);
      if (prepared.receipt?.status === "cancelled") {
        return settleFailure(
          input,
          {
            kind: "failed",
            code: "context.cancelled",
            message: "context preparation was cancelled",
            contextStatus: "cancelled",
            contextGeneration: prepared.receipt.generation,
          },
          executionPolicy,
          { kind: "cancelled", effect: "none" },
        );
      }

      const recalled = options.memory?.recallBeforeTurn({
        workspaceId: correlation.workspaceId,
        task: input.prompt,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const memorySection: PromptSectionInput | null =
        recalled?.ok === true
          ? recalled.value.memorySection
          : options.memory === undefined
            ? null
            : {
                id: "memory",
                role: "memory",
                source: "memory:#720",
                content: `Memory unavailable (${recalled?.error.code ?? "unavailable"}).`,
                required: false,
                available: false,
              };
      const recalledMemories = recalled?.ok === true ? recalled.value.recalledCount : 0;

      if (input.briefRequest !== undefined && input.responsePolicySection !== undefined) {
        return settleFailure(
          input,
          {
            kind: "failed",
            code: "brief.conflicting-policy",
            message: "Brief and comparison response policies cannot both be active",
            contextStatus: prepared.receipt?.status ?? "static",
            contextGeneration: prepared.receipt?.generation ?? null,
            recalledMemories,
          },
          executionPolicy,
        );
      }
      const briefRequest =
        input.briefRequest === undefined
          ? null
          : {
              ...input.briefRequest,
              need: briefNeedAfterContext(input.briefRequest.need, {
                status: prepared.receipt?.status ?? "static",
                candidateCount: prepared.candidates.length,
              }),
            };
      const briefed =
        briefRequest === null
          ? null
          : createBriefComposer().projectForTurn(input.turnId, briefRequest);
      if (briefed !== null && !briefed.ok) {
        return settleFailure(
          input,
          {
            kind: "failed",
            code: `brief.${briefed.error.code}`,
            message: `Brief could not prepare the response policy (${briefed.error.code})`,
            contextStatus: prepared.receipt?.status ?? "static",
            contextGeneration: prepared.receipt?.generation ?? null,
            recalledMemories,
          },
          executionPolicy,
        );
      }

      const registry = options.runtime.toolRegistry;
      if (registry === null) {
        return settleFailure(
          input,
          {
            kind: "unavailable",
            code: "runtime.tool-registry-required",
            message: "the executable tool registry is unavailable",
          },
          executionPolicy,
        );
      }
      const disclosure = discloseProductTools(registry, { executionPolicy });
      const planned = createContextPlanner().composeTurn({
        turnId: input.turnId,
        sessionId: correlation.sessionId,
        workspaceId: correlation.workspaceId,
        configurationGeneration: correlation.configurationGeneration,
        task: input.prompt,
        candidates: prepared.candidates,
        tools: disclosure.promptTools,
        otherSections: [
          executionProfileSection(executionPolicy),
          ...(input.otherSections ?? []),
          ...prepared.sections,
          ...(memorySection === null ? [] : [memorySection]),
          ...(briefed?.ok ? [briefed.value.section] : []),
          ...(input.responsePolicySection === undefined ? [] : [input.responsePolicySection]),
        ],
      });
      if (!planned.ok) {
        return settleFailure(
          input,
          {
            kind: "failed",
            code: "context.planner-failed",
            message: `context planner could not compose (${
              "code" in planned.error ? planned.error.code : "failed"
            })`,
            disclosedTools: disclosure.receipt.disclosed.length,
            contextStatus: prepared.receipt?.status ?? "static",
            contextGeneration: prepared.receipt?.generation ?? null,
            recalledMemories,
          },
          executionPolicy,
        );
      }

      const provider = options.runtime.requireProviderAdapter();
      if (!provider.ok) {
        return settleFailure(
          input,
          {
            kind: "unavailable",
            code: "provider.adapter-required",
            message: "the selected provider connection is unavailable",
            contextPackItems: planned.value.plan.pack.items.length,
            disclosedTools: disclosure.receipt.disclosed.length,
            contextStatus: prepared.receipt?.status ?? "static",
            contextGeneration: prepared.receipt?.generation ?? null,
            recalledMemories,
          },
          executionPolicy,
        );
      }
      const attemptRunner = options.runtime.requireAttemptRunner();
      const policy =
        options.providerCatalog === null
          ? null
          : productModelPolicy(provider.value, options.providerCatalog, executionPolicy);
      if (!attemptRunner.ok || options.providerCatalog === null || policy === null) {
        return settleFailure(
          input,
          {
            kind: "unavailable",
            code: "runtime.attempt-runner-required",
            message:
              options.providerCatalog === null
                ? "the selected provider has no usable model catalog"
                : policy === null
                  ? "the selected provider catalog contains no model"
                  : "the product attempt runner is unavailable",
            contextPackItems: planned.value.plan.pack.items.length,
            disclosedTools: disclosure.receipt.disclosed.length,
            contextStatus: prepared.receipt?.status ?? "static",
            contextGeneration: prepared.receipt?.generation ?? null,
            recalledMemories,
          },
          executionPolicy,
        );
      }

      const attemptPolicy = createTurnAttemptPolicy({
        clock: options.clock,
        coordinator: options.runtime.turnCoordinator,
        runner: attemptRunner.value,
        policy,
        catalogs: [
          {
            providerId: provider.value.identity.providerId,
            profileId: provider.value.identity.profileId,
            adapterKind: provider.value.identity.adapterKind,
            destinationId: provider.value.identity.destinationId,
            requestInputModalities: provider.value.requestInputModalities,
            catalog: options.providerCatalog,
          },
        ],
        journal: options.runtime.journal,
        persistTurnLifecycle: false,
      });
      const attempted = await attemptPolicy.run({
        turnId: input.turnId,
        configurationGeneration: correlation.configurationGeneration,
        signal: input.signal ?? new AbortController().signal,
        intent: input.intent ?? executionPolicy.workIntent,
        modelInput: attemptModelInputFromPrompt(planned.value.prompt, disclosure, executionPolicy, {
          ...(briefed?.ok && briefRequest !== null
            ? { brief: { request: briefRequest, projection: briefed.value.projection } }
            : {}),
          ...(input.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: input.maxOutputTokens }),
        }),
      });
      const attemptOutcome =
        attempted.turn?.status === "terminal" && attempted.turn.outcome !== null
          ? attempted.turn.outcome
          : FAILED;
      const lastAttempt = attempted.attempts.at(-1) ?? null;
      const response = lastAttempt?.output?.text ?? "";
      const toolResults = attempted.attempts.reduce(
        (total, attempt) => total + (attempt.output?.toolResults ?? 0),
        0,
      );
      const providerRequests = attempted.attempts.reduce(
        (total, attempt) => total + (attempt.output?.providerRequests ?? 0),
        0,
      );
      const providerUsage = aggregateAttemptUsage(
        attempted.attempts.map((attempt) => attempt.output),
      );
      const briefReceipt =
        lastAttempt?.output?.briefReceipt ??
        (briefed?.ok ? briefed.value.projection.receipt : null);
      const planArtifactId =
        attempted.kind === "completed"
          ? await retainPlan(executionPolicy, input.turnId, response, input.signal)
          : null;
      const planArtifactFailed =
        attempted.kind === "completed" &&
        executionPolicy.completion === "durable-plan" &&
        planArtifactId === null;
      const terminalOutcome = planArtifactFailed ? FAILED : attemptOutcome;
      const completed = await producer.completeTurn({
        turnId: input.turnId,
        sessionId: correlation.sessionId,
        workspaceId: correlation.workspaceId,
        traceId: correlation.traceId,
        configurationGeneration: correlation.configurationGeneration,
        outcome: terminalOutcome,
      });
      const refreshed = await producer.refreshFromStore();
      const succeeded =
        attempted.kind === "completed" &&
        completed.ok &&
        refreshed.ok &&
        (executionPolicy.completion !== "durable-plan" || planArtifactId !== null);
      const memoryAdmission =
        !succeeded || options.memory === undefined
          ? null
          : options.memory.admitAfterTurn({
              turnId: input.turnId,
              workspaceId: correlation.workspaceId,
              task: input.prompt,
              outcome: terminalOutcome,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
      return result({
        kind: succeeded ? "completed" : "failed",
        code: succeeded
          ? "completed"
          : planArtifactFailed
            ? "execution-profile.plan-artifact-failed"
            : `runtime.attempt-${attempted.kind}`,
        message: succeeded
          ? "turn completed"
          : planArtifactFailed
            ? "model attempt completed but the reviewable plan artifact could not be retained"
            : !completed.ok
              ? `turn settled as ${attempted.kind}; completion failed (${completed.error.code})`
              : !refreshed.ok
                ? `turn settled as ${attempted.kind}; durable replay failed (${refreshed.error.code})`
                : `turn settled as ${attempted.kind}`,
        response,
        terminalOutcome,
        contextPackItems: planned.value.plan.pack.items.length,
        modelAttempts: attempted.attempts.length,
        toolResults,
        disclosedTools: disclosure.receipt.disclosed.length,
        contextStatus: prepared.receipt?.status ?? "static",
        contextGeneration: prepared.receipt?.generation ?? null,
        recalledMemories,
        memoryAdmission:
          memoryAdmission === null
            ? "skipped"
            : memoryAdmission.ok && memoryAdmission.value.admitted
              ? "admitted"
              : memoryAdmission.ok
                ? "skipped"
                : "failed",
        executionProfile: executionPolicy.profileId,
        executionProfileVersion: executionPolicy.profileVersion,
        completionCriterion: executionPolicy.completion,
        effectiveModelRole: lastAttempt?.receipt.role ?? null,
        effectiveReasoning: lastAttempt?.receipt.reasoning ?? null,
        policyGeneration: Number(executionPolicy.configurationGeneration),
        planArtifactId,
        briefReceipt,
        providerUsage,
        providerRequests,
      });
    },
  };
}

function aggregateAttemptUsage(
  outputs: readonly (
    | {
        readonly usage?: UsageUnits | null;
      }
    | null
    | undefined
  )[],
): UsageUnits | null {
  if (
    outputs.length === 0 ||
    outputs.some(
      (output) =>
        output?.usage === undefined ||
        output.usage === null ||
        output.usage.provenance !== "provider-reported" ||
        output.usage.inputTokens === undefined ||
        output.usage.outputTokens === undefined,
    )
  ) {
    return null;
  }
  const usage = outputs.map((output) => output?.usage as UsageUnits);
  return {
    provenance: "provider-reported",
    inputTokens: usage.reduce((total, entry) => total + (entry.inputTokens ?? 0), 0),
    outputTokens: usage.reduce((total, entry) => total + (entry.outputTokens ?? 0), 0),
    ...(usage.every((entry) => entry.totalTokens !== undefined)
      ? { totalTokens: usage.reduce((total, entry) => total + (entry.totalTokens ?? 0), 0) }
      : {}),
    ...(usage.every((entry) => entry.cachedInputTokens !== undefined)
      ? {
          cachedInputTokens: usage.reduce(
            (total, entry) => total + (entry.cachedInputTokens ?? 0),
            0,
          ),
        }
      : {}),
    ...(usage.every((entry) => entry.cacheWriteInputTokens !== undefined)
      ? {
          cacheWriteInputTokens: usage.reduce(
            (total, entry) => total + (entry.cacheWriteInputTokens ?? 0),
            0,
          ),
        }
      : {}),
    ...(usage.every((entry) => entry.reasoningTokens !== undefined)
      ? {
          reasoningTokens: usage.reduce((total, entry) => total + (entry.reasoningTokens ?? 0), 0),
        }
      : {}),
  };
}
