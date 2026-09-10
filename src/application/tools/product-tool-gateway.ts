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
): Promise<ReturnType<typeof authorizeToolInvocation>> {
  let result = authorizeToolInvocation({
    invocation,
    ...(options.policy === undefined ? {} : { profile: options.policy }),
  });
  if (result.ok || result.decision.decision !== "require-confirmation") {
    return result;
  }
  const resolved =
    options.confirmation === undefined
      ? ({ kind: "unavailable" } as const)
      : await options.confirmation.resolve(result.decision.confirmation, signal);
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

  return {
    async execute(request) {
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
          return prior;
        }
      }

      if (
        requiresEcosystemTrust(ready.entry.manifest.source) &&
        options.trust?.inspect(String(ready.entry.manifest.capabilityId))?.eligible !== true
      )
        return { status: "denied", reason: "ecosystem-trust-required", effect: "none" };
      const authorized = await authorize(ready, options, request.signal);
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

      const startedAt = options.clock.now();
      const manifest = ready.entry.manifest;
      const family = `${manifest.source}:${manifest.namespace}/${manifest.name}`;
      const task = options.taskResources ?? resources.openTask(String(options.registry.generation));
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
          bufferedBytes: manifest.limits.maxInputBytes + manifest.limits.maxOutputBytes,
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
            ...nativeRequest
          } = request;
          let nativeTerminated: boolean | undefined;
          const finished = Promise.withResolvers<void>();
          const value = await options.runner
            .execute({
              ...nativeRequest,
              taskResources: task,
              ...(options.delegation === undefined ? {} : { delegation: options.delegation }),
              ...(!["builtin:orchestration/delegate@1", "builtin:orchestration/peer@1"].includes(
                String(manifest.capabilityId),
              )
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
                      publishReceipt,
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
            .finally(() => finished.resolve());
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
      if (options.taskResources === undefined) task.close();
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

      await hookRunner.runPost({
        envelope: hookEnvelope(request, options.registry, "after-capability-invocation", outcome),
        signal: request.signal,
      });

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
        persistFailed: false,
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
        failureReason(outcome),
      );
      const committed = await persist(options, {
        kind: "capability.invocation.completed",
        correlation: correlation(options),
        invocationId: request.invocationId,
        capabilityId: request.capabilityId,
        outcome: terminalOutcome(validatedOutcome),
        observedStatus: validatedOutcome.status,
        ...(request.composition === undefined ? {} : { composition: request.composition }),
        admission: admitted.receipt,
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
      const projection = { ...enveloped.projection };
      const projected = projectedOutcome(
        enveloped.result.status,
        enveloped.result.effect,
        projection,
        failureReason(outcome),
      );
      if (ready.effect !== "observation" && effectOf(projected) !== "none") {
        options.effectLedger.set(ledgerKey, projected);
      }
      return {
        ...projected,
        admission: admitted.receipt,
        ...(request.composition === undefined ? {} : { composition: request.composition }),
      };
    },
  };
}
