/**
 * Non-bypassable product tool lifecycle used by the live model loop (#786).
 *
 * The provider can propose a name and JSON arguments only. This gateway binds
 * the immutable registry generation, validates and normalizes again at the
 * trusted boundary, applies policy and hooks, schedules the work, records
 * terminal semantic facts, and returns only the bounded/redacted projection.
 */

import {
  authorizeToolInvocation,
  type ClockPort,
  confirmationInputFingerprint,
  duration,
  type EffectCertainty,
  type FocusedConfirmationRequest,
  type PolicyAuthorizedInvocation,
  type SessionCorrelation,
  type TerminalOutcome,
  type ToolHookEnvelope,
  type ToolHookRegistry,
  type ToolInvocationOutcome,
  type ToolPolicyProfile,
  type ToolRegistry,
  type TurnId,
  type TurnLifecycleFact,
  validateAndNormalizeInvocations,
} from "../domain/index.ts";
import { createRuntimeRedactor } from "./redaction.ts";
import type { ToolRunnerPort, ToolRunnerRequest } from "./tool-call-loop.ts";
import { createToolHookRunner } from "./tool-hook-runner.ts";
import { envelopeToolResult } from "./tool-result-envelope.ts";
import { createToolWorkScheduler } from "./tool-work-scheduler.ts";
import type { TurnEventJournalPort } from "./turn-event-journal.ts";

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
  readonly clock: ClockPort;
  readonly registry: ToolRegistry;
  readonly runner: ToolRunnerPort;
  readonly journal: TurnEventJournalPort;
  readonly correlation: SessionCorrelation;
  readonly turnId: TurnId;
  readonly disclosedToolNames: ReadonlySet<string>;
  readonly hooks: ToolHookRegistry;
  readonly policy?: ToolPolicyProfile;
  readonly confirmation?: ProductToolConfirmationPort;
  readonly effectLedger: ProductToolEffectLedger;
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
      return { status, effect: "none", reason };
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
  signal: AbortSignal,
): Promise<boolean> {
  const result = await options.journal.persist([fact], signal);
  return result.kind === "persisted";
}

/** Create the runner injected into the existing bounded tool-call loop. */
export function createProductToolGateway(options: ProductToolGatewayOptions): ToolRunnerPort {
  const hookRunner = createToolHookRunner({ clock: options.clock, registry: options.hooks });
  const scheduler = createToolWorkScheduler({ clock: options.clock, runner: options.runner });
  const redactor = createRuntimeRedactor();

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
      const ledgerKey = `${options.turnId}:${confirmationInputFingerprint(
        ready.entry.manifest.capabilityId,
        ready.input,
        ready.entry.manifest.effect,
      )}`;
      if (ready.entry.manifest.effect !== "observation") {
        const prior = options.effectLedger.get(ledgerKey);
        if (prior !== undefined) {
          return prior;
        }
      }

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
        },
        request.signal,
      );
      if (!started) {
        return { status: "unavailable", reason: "invocation-journal-unavailable", effect: "none" };
      }

      const startedAt = options.clock.now();
      const scheduled = await scheduler.run({
        items: [{ authorized: authorized.value as PolicyAuthorizedInvocation }],
        joinPolicy: "all",
        signal: request.signal,
        maxQueued: 1,
      });
      const endedAt = options.clock.now();
      const outcome: ToolInvocationOutcome =
        scheduled.kind === "completed" && scheduled.records[0] !== undefined
          ? scheduled.records[0].outcome
          : { status: "unavailable", reason: "tool-schedule-rejected", effect: "none" };

      await hookRunner.runPost({
        envelope: hookEnvelope(request, options.registry, "after-capability-invocation", outcome),
        signal: request.signal,
      });

      const committed = await persist(
        options,
        {
          kind: "capability.invocation.completed",
          correlation: correlation(options),
          invocationId: request.invocationId,
          capabilityId: request.capabilityId,
          outcome: terminalOutcome(outcome),
        },
        request.signal,
      );

      const elapsed = Math.max(0, Number(endedAt) - Number(startedAt));
      const entry = ready.entry;
      const enveloped = envelopeToolResult({
        invocationId: request.invocationId,
        capabilityId: request.capabilityId,
        version: request.version,
        catalogGeneration: options.registry.generation,
        outputSchema: entry.manifest.outputSchema,
        maxOutputBytes: entry.manifest.limits.maxOutputBytes,
        outcome,
        artifacts: [],
        diagnostics: [],
        timing: {
          startedAt,
          endedAt,
          queueMs: null,
          executeMs: duration(elapsed),
          captureMs: null,
        },
        persistFailed: !committed,
        captureOverflow: false,
        projection: entry.manifest.resultProjection,
        redactor,
      });
      const projection = enveloped.projection as unknown as Readonly<Record<string, unknown>>;
      const projected = projectedOutcome(
        enveloped.result.status,
        enveloped.result.effect,
        projection,
        failureReason(outcome),
      );
      if (ready.entry.manifest.effect !== "observation" && effectOf(projected) !== "none") {
        options.effectLedger.set(ledgerKey, projected);
      }
      return projected;
    },
  };
}
