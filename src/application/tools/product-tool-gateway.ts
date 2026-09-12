import type { ArtifactStorePort } from "../../domain/artifacts/index.ts";
import {
  createSandboxExpansionGrant,
  MAX_SANDBOX_RECEIPT_BYTES,
  SANDBOX_EXPANSION_TTL_MS,
  type SandboxInvocation,
  type SandboxInvocationPort,
  sandboxExpansionSchema,
} from "../../domain/security/sandbox.ts";
import { createSessionHistory, historyDigest } from "../sessions/session-history.ts";
/**
 * Non-bypassable product tool lifecycle used by the live model loop (#786).
 *
 * The provider can propose a name and JSON arguments only. This gateway binds
 * the immutable registry generation, validates and normalizes again at the
 * trusted boundary, applies policy and hooks, schedules the work, records
 * terminal semantic facts, and returns only the bounded/redacted projection.
 */

import { createHash } from "node:crypto";
import {
  type ClockPort,
  deadlineAt,
  duration,
  instant,
  type TurnId,
} from "../../domain/foundation/index.ts";
import type {
  EffectCertainty,
  ModelCapabilityBrief,
  TerminalOutcome,
} from "../../domain/orchestration/index.ts";
import type { SessionCorrelation, TurnLifecycleFact } from "../../domain/sessions/index.ts";
import {
  authorizeToolInvocation,
  confirmationInputFingerprint,
  type FocusedConfirmationRequest,
  type ToolHookEnvelope,
  type ToolHookRegistry,
  type ToolInvocationOutcome,
  type ToolPolicyProfile,
  type ToolRegistry,
  validateAndNormalizeInvocations,
  workUnitForAuthorized,
} from "../../domain/tools/index.ts";
import { createRuntimeProjectionRedactor } from "../diagnostics/redaction.ts";
import {
  type CapabilityTrustPort,
  requiresEcosystemTrust,
} from "../extensions/capability-trust.ts";
import {
  capacityScope,
  type ProductResources,
  type ProductTaskResources,
  processProductResources,
} from "../orchestration/product-resources.ts";
import type { ToolRunnerPort, ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import type { TurnEventJournalPort } from "../runtime/turn-event-journal.ts";
import { PROCESS_TASK_CONTROL_CAPABILITY } from "./process-task-tool.ts";
import { createToolHookRunner } from "./tool-hook-runner.ts";
import { envelopeToolResult } from "./tool-result-envelope.ts";

export type ProductToolConfirmationResult =
  | { readonly kind: "confirmed"; readonly confirmationId: string }
  | { readonly kind: "refused" }
  | { readonly kind: "unavailable" };

export type ProductToolConfirmationPort = {
  resolve(
    request: FocusedConfirmationRequest,
    signal: AbortSignal,
  ): Promise<ProductToolConfirmationResult>;
};

export type ProductToolEffectLedger = Map<string, ToolInvocationOutcome>;

export type ProductToolGatewayOptions = {
  readonly historyArtifacts?: ArtifactStorePort;
  readonly toolHost?: import("../../domain/tools/index.ts").HostPlatform;
  readonly sandbox?: SandboxInvocationPort;
  readonly trust?: CapabilityTrustPort;
  readonly delegation?: ToolRunnerRequest["delegation"];
  readonly clock: ClockPort;
  readonly resources?: ProductResources;
  readonly taskResources?: ProductTaskResources;
  readonly registry: ToolRegistry;
  readonly runner: ToolRunnerPort;
  readonly journal: TurnEventJournalPort;
  readonly correlation: SessionCorrelation;
  readonly turnId: TurnId;
  readonly attemptId?: string;
  readonly disclosedToolNames: ReadonlySet<string>;
  readonly hooks: ToolHookRegistry;
  readonly policy?: ToolPolicyProfile;
  readonly confirmation?: ProductToolConfirmationPort;
  readonly effectLedger: ProductToolEffectLedger;
  readonly opportunityPlan?: ModelCapabilityBrief;
};

function terminalOutcome(outcome: ToolInvocationOutcome): TerminalOutcome {
  switch (outcome.status) {
    case "completed":
      return { kind: "completed" };
    case "failed":
      return { kind: "failed", effect: outcome.effect };
    case "cancelled":
      return { kind: "cancelled", effect: outcome.effect };
    case "timed-out":
      return { kind: "timed-out", effect: outcome.effect };
    case "uncertain":
      return { kind: "uncertain", effect: "uncertain" };
    case "partial":
      return { kind: "failed", effect: outcome.effect };
    case "denied":
    case "unavailable":
    case "malformed":
      return { kind: "failed", effect: "none" };
  }
}

function effectOf(outcome: ToolInvocationOutcome): EffectCertainty {
  switch (outcome.status) {
    case "completed":
      return "completed";
    case "failed":
    case "cancelled":
    case "timed-out":
    case "partial":
      return outcome.effect;
    case "uncertain":
      return "uncertain";
    case "denied":
    case "unavailable":
    case "malformed":
      return "none";
  }
}

function hookEnvelope(
  request: ToolRunnerRequest,
  registry: ToolRegistry,
  point: ToolHookEnvelope["point"],
  outcome: ToolInvocationOutcome | null,
): ToolHookEnvelope {
  return {
    point,
    phase: point === "before-capability-invocation" ? "pre" : "post",
    invocationId: request.invocationId,
    capabilityId: request.capabilityId,
    catalogGeneration: registry.generation,
    registrationGeneration: registry.generation,
    deadline: null,
    recursionDepth: 0,
    reentryKey: `${request.invocationId}:${point}`,
    payload: request.input,
    observedOutcome: outcome,
  };
}

function failureReason(outcome: ToolInvocationOutcome): string {
  switch (outcome.status) {
    case "failed":
    case "denied":
    case "unavailable":
    case "malformed":
      return outcome.reason;
    case "uncertain":
      return outcome.recoveryHint;
    case "partial":
      return "partial-result";
    case "cancelled":
      return "cancelled";
    case "timed-out":
      return "timed-out";
    case "completed":
      return "completed";
  }
}

function degradationObservation(
  request: ToolRunnerRequest,
  outcome: ToolInvocationOutcome,
  plan: ModelCapabilityBrief | undefined,
) {
  if (outcome.status !== "unavailable" || plan === undefined) return undefined;
  const transitions = plan.degradation.transitions.filter(
    (transition) =>
      transition.fromCapabilityId === request.capabilityId &&
      transition.triggers.includes("runtime-unavailable"),
  );
  const terminal = plan.degradation.terminalOutcomes.find(
    (candidate) => candidate.capabilityId === request.capabilityId,
  );
  return {
    decision:
      transitions.length > 0 ? ("fallback-available" as const) : ("terminal-unavailable" as const),
    candidateIds: Object.freeze(transitions.map((transition) => transition.toCapabilityId)),
    terminalReason:
      terminal?.reason ?? (transitions.length > 0 ? "fallback-exhausted" : "no-declared-fallback"),
    recoveryHandles: terminal?.recoveryHandles ?? [],
  };
}

function projectedOutcome(
  status: ToolInvocationOutcome["status"],
  effect: EffectCertainty,
  projection: Readonly<Record<string, unknown>>,
  reason: string,
): ToolInvocationOutcome {
  switch (status) {
    case "completed":
      return { status, output: projection, effect: "completed" };
    case "partial":
      return { status, output: projection, effect };
    case "cancelled":
      return { status, effect };
    case "timed-out":
      return { status, effect };
    case "uncertain":
      return { status, effect: "uncertain", recoveryHint: reason };
    case "failed":
      return { status, effect, reason };
    case "denied":
      return { status, effect: "none", reason };
    case "unavailable":
      return { status, effect: "none", reason };
    case "malformed":
      return effect === "none"
        ? { status, effect, reason }
        : { status: "failed", effect, reason: "invalid-native-output" };
  }
}

async function authorize(
  invocation: Parameters<typeof authorizeToolInvocation>[0]["invocation"],
  options: ProductToolGatewayOptions,
  signal: AbortSignal,
  observe: (stage: "policy" | "confirmation", decision: string) => Promise<boolean>,
): Promise<ReturnType<typeof authorizeToolInvocation> | null> {
  let result = authorizeToolInvocation({
    invocation,
    ...(options.policy === undefined ? {} : { profile: options.policy }),
  });
  if (!(await observe("policy", result.ok ? "allowed" : result.decision.decision))) return null;
  if (result.ok || result.decision.decision !== "require-confirmation") {
    return result;
  }
  const resolved =
    options.confirmation === undefined
      ? ({ kind: "unavailable" } as const)
      : await options.confirmation.resolve(result.decision.confirmation, signal);
  if (!(await observe("confirmation", resolved.kind))) return null;
  result = authorizeToolInvocation({
    invocation,
    ...(options.policy === undefined ? {} : { profile: options.policy }),
    ...(resolved.kind === "confirmed"
      ? { confirmation: { confirmationId: resolved.confirmationId } }
      : {}),
    ...(resolved.kind === "refused" ? { refused: true } : {}),
  });
  return result;
}

function correlation(options: ProductToolGatewayOptions) {
  return { ...options.correlation, turnId: options.turnId };
}

async function persist(
  options: ProductToolGatewayOptions,
  fact: TurnLifecycleFact,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await options.journal.persist([fact], signal);
  return (
    result.kind === "persisted" && result.receipts.every((receipt) => receipt.kind !== "duplicate")
  );
}

/** Create the runner injected into the existing bounded tool-call loop. */
export function createProductToolGateway(options: ProductToolGatewayOptions): ToolRunnerPort {
  const hookRunner = createToolHookRunner({ clock: options.clock, registry: options.hooks });
  const resources = options.resources ?? processProductResources;
  const redactor = createRuntimeProjectionRedactor();
  const history = createSessionHistory({
    journal: options.journal,
    correlation: options.correlation,
    ...(options.historyArtifacts === undefined ? {} : { artifacts: options.historyArtifacts }),
  });

  return {
    async execute(request) {
      const task = options.taskResources ?? resources.openTask(String(options.registry.generation));
      try {
        const recorded = await history.record(
          options.turnId,
          {
            version: 1,
            type: "proposal",
            stage: "bound",
            inputDigest: historyDigest(JSON.stringify(request.input)),
            id: `${request.invocationId}:proposed`,
            generation: Number(options.registry.generation),
            attemptId: options.attemptId ?? String(options.turnId),
            proposalId: request.toolCallId,
            invocationId: String(request.invocationId),
            name: request.toolName,
            catalogGeneration: Number(options.registry.generation),
            policyGeneration: Number(options.correlation.configurationGeneration),
            disclosureDigest: historyDigest(JSON.stringify([...options.disclosedToolNames].sort())),
          },
          JSON.stringify(request.input),
          task,
        );
        if (!recorded.committed || recorded.evidence.availability === "unavailable")
          return { status: "unavailable", reason: "proposal-journal-unavailable", effect: "none" };
        const outcome = await execute(request, task);
        const settled = await history.record(
          options.turnId,
          {
            version: 1,
            type: "result",
            id: `${request.invocationId}:settlement`,
            generation: Number(options.registry.generation),
            proposalId: request.toolCallId,
            invocationId: String(request.invocationId),
            capabilityId: String(request.capabilityId),
            status: outcome.status,
            effect: outcome.effect,
            reason: redactor.redactText(failureReason(outcome), 256),
            relations:
              "output" in outcome && "history" in outcome.output
                ? [
                    {
                      type: "projection",
                      id: `${request.invocationId}:exact-result`,
                      generation: Number(options.registry.generation),
                    },
                  ]
                : [],
          },
          "{}",
          task,
        );
        if (!settled.committed)
          return {
            status: "failed",
            effect: outcome.effect,
            reason: "history-settlement-unavailable",
          };
        return outcome;
      } finally {
        if (options.taskResources === undefined) task.close();
      }
    },
  };
  async function execute(
    request: ToolRunnerRequest,
    historyTask: ProductTaskResources,
  ): Promise<ToolInvocationOutcome> {
    if (request.signal.aborted) {
      return { status: "cancelled", effect: "none" };
    }
    if (options.registry.generation !== options.correlation.configurationGeneration) {
      return { status: "unavailable", reason: "stale-tool-catalog", effect: "none" };
    }
    if (!options.disclosedToolNames.has(request.toolName)) {
      return { status: "unavailable", reason: "tool-not-disclosed", effect: "none" };
    }

    const validated = validateAndNormalizeInvocations({
      ...(options.toolHost === undefined ? {} : { host: options.toolHost }),
      registry: options.registry,
      proposals: [
        {
          toolCallId: request.toolCallId,
          name: request.toolName,
          arguments: request.input,
          version: request.version,
        },
      ],
      maxQueued: 1,
      nextInvocationId: () => request.invocationId,
    });
    if (!validated.ok || validated.value[0] === undefined) {
      return {
        status: "malformed",
        reason: validated.ok ? "missing-validated-invocation" : validated.error.code,
        effect: "none",
      };
    }
    const ready = validated.value[0];
    if (
      ready.entry.manifest.capabilityId !== request.capabilityId ||
      ready.entry.manifest.version !== request.version ||
      (request.composition !== undefined && ready.effect !== request.effect)
    ) {
      return { status: "unavailable", reason: "capability-binding-mismatch", effect: "none" };
    }
    const ledgerKey = `${options.turnId}:${confirmationInputFingerprint(
      ready.entry.manifest.capabilityId,
      ready.input,
      ready.effect,
    )}`;
    const childRefusal = options.taskResources?.checkAuthority(
      {
        kind: "tool",
        workspaceId: String(options.correlation.workspaceId),
        capabilityId: String(request.capabilityId),
        capabilityGeneration: String(options.registry.generation),
      },
      ready.effect,
    );
    if (childRefusal)
      return {
        status: "denied",
        reason: childRefusal.state,
        effect: "none",
        admission: childRefusal,
      };
    if (ready.effect !== "observation") {
      const prior = options.effectLedger.get(ledgerKey);
      if (prior !== undefined) {
        const reused = await history.record(
          options.turnId,
          {
            version: 1,
            type: "result",
            id: `${request.invocationId}:reused`,
            generation: Number(options.registry.generation),
            proposalId: request.toolCallId,
            invocationId: String(request.invocationId),
            capabilityId: String(request.capabilityId),
            status: "reused",
            effect: prior.effect,
            reason: "effect-ledger-reuse",
            relations: [],
          },
          JSON.stringify(prior),
          historyTask,
        );
        return reused.committed
          ? prior
          : { status: "failed", effect: prior.effect, reason: "reuse-history-unavailable" };
      }
    }

    if (
      requiresEcosystemTrust(ready.entry.manifest.source) &&
      options.trust?.inspect(String(ready.entry.manifest.capabilityId))?.eligible !== true
    )
      return { status: "denied", reason: "ecosystem-trust-required", effect: "none" };
    const observe = async (
      stage: "validation" | "policy" | "confirmation" | "pre-hook" | "post-hook" | "schedule",
      decision: string,
    ) => {
      const saved = await history.record(
        options.turnId,
        {
          version: 1,
          type: "gate",
          id: `${request.invocationId}:gate:${stage}`,
          generation: Number(options.registry.generation),
          invocationId: String(request.invocationId),
          proposalId: request.toolCallId,
          stage,
          decision,
          declaredEffect: ready.effect,
          cancelled: request.signal.aborted,
        },
        "{}",
        historyTask,
      );
      return saved.committed;
    };
    if (!(await observe("validation", "accepted")))
      return { status: "unavailable", reason: "validation-history-unavailable", effect: "none" };
    const authorized = await authorize(ready, options, request.signal, observe);
    if (authorized === null)
      return { status: "unavailable", reason: "policy-history-unavailable", effect: "none" };
    if (!authorized.ok) {
      return {
        status: "denied",
        reason:
          authorized.decision.decision === "require-confirmation"
            ? "focused-confirmation-required"
            : authorized.decision.reason.code,
        effect: "none",
      };
    }

    const pre = await hookRunner.runPre({
      envelope: hookEnvelope(request, options.registry, "before-capability-invocation", null),
      signal: request.signal,
    });
    if (!(await observe("pre-hook", pre.kind)))
      return { status: "unavailable", reason: "hook-history-unavailable", effect: "none" };
    if (pre.kind !== "allowed") {
      return {
        status: "denied",
        reason: `pre-hook-${pre.kind}`,
        effect: "none",
      };
    }

    const started = await persist(
      options,
      {
        kind: "capability.invocation.started",
        correlation: correlation(options),
        invocationId: request.invocationId,
        capabilityId: request.capabilityId,
        capabilityVersion: request.version,
        ...(request.composition === undefined ? {} : { composition: request.composition }),
        inputDigest: createHash("sha256")
          .update(confirmationInputFingerprint(request.capabilityId, ready.input, ready.effect))
          .digest("hex"),
      },
      request.signal,
    );
    if (!started) {
      return { status: "unavailable", reason: "invocation-journal-unavailable", effect: "none" };
    }

    if (!(await observe("schedule", "requested")))
      return { status: "unavailable", reason: "schedule-history-unavailable", effect: "none" };
    const startedAt = options.clock.now();
    const manifest = ready.entry.manifest;
    const family = `${manifest.source}:${manifest.namespace}/${manifest.name}`;
    const task = historyTask;
    const scopes = [];
    if (manifest.concurrency.maxGlobal !== null)
      scopes.push({
        scope: capacityScope("tool", "falryn", family, "concurrency", "occupancy"),
        amount: 1,
        limit: manifest.concurrency.maxGlobal,
      });
    if (manifest.concurrency.maxPerWorkspace !== null)
      scopes.push({
        scope: capacityScope(
          "tool",
          "falryn",
          family,
          "concurrency",
          "occupancy",
          String(options.correlation.workspaceId),
        ),
        amount: 1,
        limit: manifest.concurrency.maxPerWorkspace,
      });
    const workDeadline =
      manifest.limits.defaultTimeoutMs === null
        ? null
        : deadlineAt(instant(Number(startedAt) + manifest.limits.defaultTimeoutMs));
    const deferred: { run?: (signal: AbortSignal) => Promise<ToolInvocationOutcome> } = {};
    const admitted = await task.execute<ToolInvocationOutcome>({
      target: {
        kind: "tool",
        workspaceId: String(options.correlation.workspaceId),
        capabilityId: String(request.capabilityId),
        capabilityGeneration: String(options.registry.generation),
      },
      operation: String(request.invocationId),
      attempt: options.attemptId ?? String(options.turnId),
      generation: String(options.registry.generation),
      unit: {
        ...workUnitForAuthorized({ authorized: authorized.value }, workDeadline, null),
        ...(String(manifest.capabilityId) === PROCESS_TASK_CONTROL_CAPABILITY
          ? { priority: "interactive" as const }
          : {}),
      },
      inputBytes: new TextEncoder().encode(JSON.stringify(ready.input)).length,
      amounts: {
        ...manifest.resourceAmounts,
        bufferedBytes:
          manifest.limits.maxInputBytes +
          manifest.limits.maxOutputBytes +
          (options.sandbox === undefined ? 0 : MAX_SANDBOX_RECEIPT_BYTES),
        bufferedItems: 1,
      },
      scopes,
      signal: request.signal,
      async run(signal, publishReceipt) {
        if (
          request.composition !== undefined &&
          options.runner.hasBinding?.(manifest.capabilityId) !== true
        ) {
          return {
            value: {
              status: "unavailable",
              reason: "missing-native-binding",
              effect: "none",
            } as const,
            terminated: true,
            observedEffect: "none",
          };
        }
        if (
          requiresEcosystemTrust(manifest.source) &&
          options.trust?.inspect(String(manifest.capabilityId))?.eligible !== true
        ) {
          return {
            value: {
              status: "denied",
              reason: "ecosystem-trust-required",
              effect: "none",
            } as const,
            terminated: true,
            observedEffect: "none",
          };
        }
        const {
          captureExactOutput: _captureExactOutput,
          processTask: _processTask,
          delegation: _delegation,
          afterAdmission: _afterAdmission,
          invokeCapability: _invokeCapability,
          ...nativeRequest
        } = request;
        let nativeTerminated: boolean | undefined;
        const finished = Promise.withResolvers<void>();
        let sandboxInvocation: SandboxInvocation = {
          invocationId: String(request.invocationId),
          capabilityId: String(manifest.capabilityId),
          source: requiresEcosystemTrust(manifest.source) ? "extension" : "builtin",
          catalogGeneration: Number(options.registry.generation),
          policyGeneration: Number(options.correlation.configurationGeneration),
          inputFingerprint: createHash("sha256")
            .update(confirmationInputFingerprint(manifest.capabilityId, ready.input, ready.effect))
            .digest("hex"),
          effect: ready.effect,
          confirmationId: authorized.value.confirmation.required
            ? createHash("sha256")
                .update(authorized.value.confirmation.confirmationId)
                .digest("hex")
            : null,
          resourceTaskId: task.id,
          expiresAt: task.expiresAt,
        };
        if (ready.input.sandboxExpansion !== undefined) {
          const expansion = sandboxExpansionSchema.safeParse(ready.input.sandboxExpansion);
          if (
            !expansion.success ||
            !["run_process", "run_shell"].includes(manifest.name) ||
            options.sandbox === undefined
          ) {
            return {
              value: {
                status: "denied",
                effect: "none",
                reason: "sandbox-expansion-unavailable",
              } as const,
              terminated: true,
              observedEffect: "none" as const,
            };
          }
          const destinations = options.sandbox.resolveExpansion(expansion.data);
          if (destinations === null)
            return {
              value: {
                status: "denied",
                effect: "none",
                reason: "sandbox-expansion-invalid-root",
              } as const,
              terminated: true,
              observedEffect: "none" as const,
            };
          const confirmationInput = { ...ready.input, sandboxExpansion: destinations };
          sandboxInvocation = {
            ...sandboxInvocation,
            inputFingerprint: createHash("sha256")
              .update(
                confirmationInputFingerprint(
                  manifest.capabilityId,
                  confirmationInput,
                  ready.effect,
                ),
              )
              .digest("hex"),
          };
          const confirmationId = `sandbox:${request.invocationId}:${sandboxInvocation.inputFingerprint}`;
          const expiresAt = Math.min(
            sandboxInvocation.expiresAt,
            Number(workDeadline?.expiresAt ?? task.expiresAt),
            Number(options.clock.now()) + SANDBOX_EXPANSION_TTL_MS,
          );
          const decision = await options.confirmation?.resolve(
            {
              confirmationId,
              invocationId: request.invocationId,
              capabilityId: manifest.capabilityId,
              toolName: manifest.name,
              effectClass: ready.effect,
              title: "Allow these sandbox filesystem roots once?",
              normalizedInput: confirmationInput,
              inputFingerprint: sandboxInvocation.inputFingerprint,
            },
            signal,
          );
          if (
            signal.aborted ||
            Number(options.clock.now()) >= expiresAt ||
            decision?.kind !== "confirmed" ||
            decision.confirmationId !== confirmationId
          ) {
            return {
              value: {
                status: "denied",
                effect: "none",
                reason: "sandbox-expansion-confirmation-required",
              } as const,
              terminated: true,
              observedEffect: "none" as const,
            };
          }
          sandboxInvocation = { ...sandboxInvocation, confirmationId };
          sandboxInvocation = {
            ...sandboxInvocation,
            expansion: createSandboxExpansionGrant({
              invocation: sandboxInvocation,
              expansion: destinations,
              expiresAt,
            }),
          };
        }
        const executeNative = (): Promise<ToolInvocationOutcome> =>
          options.runner
            .execute({
              ...nativeRequest,
              taskResources: task,
              ...(options.delegation === undefined ? {} : { delegation: options.delegation }),
              ...(String(manifest.capabilityId) !== "builtin:orchestration/workflow@1"
                ? {}
                : {
                    invokeCapability: (
                      child: ToolRunnerRequest,
                      resources: ProductTaskResources,
                    ) => {
                      const binding = options.registry.resolveByCapabilityId(child.capabilityId);
                      if (
                        !binding ||
                        !options.delegation?.capabilities.includes(String(child.capabilityId)) ||
                        binding.manifest.name !== child.toolName ||
                        binding.manifest.version !== child.version
                      )
                        return Promise.resolve({
                          status: "unavailable" as const,
                          reason: "workflow-native-binding-unavailable",
                          effect: "none" as const,
                        });
                      // The native graph binds this registered action explicitly. Model-schema
                      // disclosure is not its selector; policy, trust, hooks, scopes and focused
                      // confirmation still run in the same gateway for every node.
                      return createProductToolGateway({
                        ...options,
                        taskResources: resources,
                        disclosedToolNames: new Set([child.toolName]),
                      }).execute(child);
                    },
                  }),
              ...(![
                "builtin:orchestration/delegate@1",
                "builtin:orchestration/peer@1",
                "builtin:orchestration/workflow@1",
              ].includes(String(manifest.capabilityId))
                ? {}
                : {
                    afterAdmission(run: (signal: AbortSignal) => Promise<ToolInvocationOutcome>) {
                      if (deferred.run !== undefined)
                        throw new Error("duplicate deferred orchestration action");
                      deferred.run = run;
                    },
                  }),
              ...(options.attemptId === undefined || options.correlation.workspaceId === null
                ? {}
                : {
                    processTask: {
                      owner: {
                        sessionId: String(options.correlation.sessionId),
                        workspaceId: String(options.correlation.workspaceId),
                        turnId: String(options.turnId),
                        invocationId: String(request.invocationId),
                        attemptId: options.attemptId,
                        configurationGeneration: Number(options.registry.generation),
                        resourceTaskId: task.id,
                      },
                      publishReceipt(outcome) {
                        const receipts = options.sandbox?.receipts() ?? [];
                        return publishReceipt({
                          ...outcome,
                          ...(receipts.length === 0 ? {} : { sandbox: receipts }),
                        });
                      },
                      finished: finished.promise,
                      deadline: Math.min(
                        task.expiresAt,
                        Number(workDeadline?.expiresAt ?? task.expiresAt),
                      ),
                      reportTermination(terminated) {
                        nativeTerminated = terminated;
                      },
                    },
                  }),
              capabilityId: manifest.capabilityId,
              version: manifest.version,
              effect: ready.effect,
              input: ready.input,
              signal,
            })
            .catch(
              (): ToolInvocationOutcome => ({
                status: "uncertain",
                effect: "uncertain",
                recoveryHint: "native-execution-interrupted",
              }),
            )
            .finally(() => finished.resolve());
        const sandboxed =
          options.sandbox === undefined
            ? { value: await executeNative(), receipts: [] }
            : await options.sandbox.run(sandboxInvocation, executeNative);
        const value: ToolInvocationOutcome = {
          ...sandboxed.value,
          ...(sandboxed.receipts.length === 0 ? {} : { sandbox: sandboxed.receipts }),
        };
        return {
          value,
          observedEffect: value.effect,
          terminated:
            nativeTerminated ??
            (value.status === "completed" ||
              value.status === "denied" ||
              value.status === "malformed" ||
              value.status === "unavailable"),
        };
      },
    });
    const deferredOutcome =
      admitted.kind === "completed" && deferred.run !== undefined
        ? await deferred.run(request.signal).catch(
            (): ToolInvocationOutcome => ({
              status: "uncertain",
              effect: "uncertain",
              recoveryHint: "delegation-control-interrupted",
            }),
          )
        : null;
    const endedAt = options.clock.now();
    const outcome: ToolInvocationOutcome =
      admitted.kind === "completed"
        ? { ...(deferredOutcome ?? admitted.value), admission: admitted.receipt }
        : admitted.kind === "replayed"
          ? {
              status: "unavailable",
              reason: "resource-result-replayed",
              effect: "none",
              admission: admitted.receipt,
            }
          : admitted.receipt.acquired
            ? {
                status: "uncertain",
                effect: "uncertain",
                recoveryHint: "resource-capacity-held-awaiting-termination",
                admission: admitted.receipt,
              }
            : {
                status: "unavailable",
                reason: admitted.receipt.state,
                effect: "none",
                admission: admitted.receipt,
              };

    let exactText: string | null = null;
    try {
      exactText = JSON.stringify(outcome);
    } catch {
      /* Malformed native output remains unavailable evidence. */
    }
    const captured = await history.record(
      options.turnId,
      {
        version: 1,
        type: "result",
        id: `${request.invocationId}:exact-result`,
        generation: Number(options.registry.generation),
        proposalId: request.toolCallId,
        invocationId: String(request.invocationId),
        capabilityId: String(request.capabilityId),
        status: outcome.status,
        effect: outcome.effect,
        reason: redactor.redactText(failureReason(outcome), 256),
        relations: [],
      },
      exactText,
      historyTask,
    );
    const post = await hookRunner.runPost({
      envelope: hookEnvelope(request, options.registry, "after-capability-invocation", outcome),
      signal: request.signal,
    });

    const postRecorded = await observe("post-hook", post.kind);
    const sandboxReceipts = outcome.sandbox?.map((receipt) => ({
      ...receipt,
      readRoots: receipt.readRoots.map((root) => redactor.redactText(root, 1_024)),
      writeRoots: receipt.writeRoots.map((root) => redactor.redactText(root, 1_024)),
      credentialHandles: receipt.credentialHandles.map((handle) =>
        redactor.redactText(handle, 256),
      ),
    }));
    const degradation = degradationObservation(request, outcome, options.opportunityPlan);
    const elapsed = Math.max(0, Number(endedAt) - Number(startedAt));
    const entry = ready.entry;
    const resultMetadata = "result" in outcome ? outcome.result : undefined;
    const envelopeInput: Parameters<typeof envelopeToolResult>[0] = {
      invocationId: request.invocationId,
      capabilityId: request.capabilityId,
      version: request.version,
      catalogGeneration: options.registry.generation,
      outputSchema: entry.manifest.outputSchema,
      maxOutputBytes: entry.manifest.limits.maxOutputBytes,
      outcome,
      artifacts: resultMetadata?.artifacts ?? [],
      diagnostics: [],
      timing: {
        startedAt,
        endedAt,
        queueMs: null,
        executeMs: duration(elapsed),
        captureMs: null,
      },
      persistFailed:
        !postRecorded || !captured.committed || captured.evidence.availability === "unavailable",
      captureOverflow: resultMetadata?.captureOverflow ?? false,
      ...(resultMetadata?.containedProcessExitCode === undefined
        ? {}
        : {
            containedOutcome: {
              kind: "process" as const,
              exitCode: resultMetadata.containedProcessExitCode,
            },
          }),
      projection: entry.manifest.resultProjection,
      redactor,
    };
    let enveloped = envelopeToolResult(envelopeInput);
    const validatedOutcome = projectedOutcome(
      enveloped.result.status,
      enveloped.result.effect,
      { ...enveloped.projection },
      outcome.status === "completed"
        ? (enveloped.result.error?.code ?? failureReason(outcome))
        : failureReason(outcome),
    );
    const committed = await persist(options, {
      kind: "capability.invocation.completed",
      correlation: correlation(options),
      invocationId: request.invocationId,
      capabilityId: request.capabilityId,
      outcome: terminalOutcome(validatedOutcome),
      observedStatus: validatedOutcome.status,
      historyId: `${request.invocationId}:exact-result`,
      ...(request.composition === undefined ? {} : { composition: request.composition }),
      admission: admitted.receipt,
      ...(sandboxReceipts === undefined ? {} : { sandbox: sandboxReceipts }),
      ...(degradation === undefined ? {} : { degradation }),
    });
    if (!committed) enveloped = envelopeToolResult({ ...envelopeInput, persistFailed: true });
    if (
      enveloped.result.status === "completed" &&
      !enveloped.result.captureTruncated &&
      enveloped.result.value !== null &&
      committed
    ) {
      request.captureExactOutput?.(enveloped.result.value);
    }
    const { text: _inlineText, ...evidence } =
      captured.evidence.availability === "inline"
        ? captured.evidence
        : { ...captured.evidence, text: undefined };
    const projection = {
      ...enveloped.projection,
      history: { ...evidence, id: `${request.invocationId}:exact-result` },
    };
    const projected = projectedOutcome(
      enveloped.result.status,
      enveloped.result.effect,
      projection,
      outcome.status === "completed"
        ? (enveloped.result.error?.code ?? failureReason(outcome))
        : failureReason(outcome),
    );
    if (ready.effect !== "observation" && effectOf(projected) !== "none") {
      options.effectLedger.set(ledgerKey, {
        ...projected,
        ...(sandboxReceipts === undefined ? {} : { sandbox: sandboxReceipts }),
      });
    }
    return {
      ...projected,
      ...(sandboxReceipts === undefined ? {} : { sandbox: sandboxReceipts }),
      admission: admitted.receipt,
      ...(request.composition === undefined ? {} : { composition: request.composition }),
    };
  }
}
