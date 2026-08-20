/**
 * Product bootstrap composition for the live coding agent host (#705).
 *
 * Composes the verified session runtime, turn coordinator, and durable turn
 * journal into one fail-closed product graph. Leaves typed attachment points
 * for live providers, registered tools, attempt runners, and later TUI /
 * headless producers (#706) and composer submission (#707).
 *
 * Does not register builtin tools (#700), Hush/Loom product policy (#701), or
 * live vendor HTTP/OAuth adapters (#709).
 */

import {
  type ClockPort,
  type ConfigurationGeneration,
  createToolCatalog,
  type EventStorePort,
  type SessionCorrelation,
  type SessionId,
  type StreamId,
  type ToolCatalog,
  type TraceId,
  type TurnId,
  type TurnLifecycleFact,
  type WorkspaceId,
} from "../domain/index.ts";
import type { ProviderAdapterPort } from "../providers/port.ts";
import type { SessionRuntime } from "./session-runtime.ts";
import { createSessionRuntime } from "./session-runtime.ts";
import type { ToolRunnerPort } from "./tool-call-loop.ts";
import type { AttemptRunnerPort } from "./turn-attempt-policy.ts";
import type { StartTurnInput, TurnCoordinator, TurnCoordinatorError } from "./turn-coordinator.ts";
import { createTurnCoordinator } from "./turn-coordinator.ts";
import type { PersistTurnEventsOutcome, TurnEventJournal } from "./turn-event-journal.ts";
import { createTurnEventJournal } from "./turn-event-journal.ts";

export type ProductAgentRuntimePorts = {
  readonly eventStore: EventStorePort;
  readonly clock: ClockPort;
  readonly streamId: StreamId;
  readonly correlation: SessionCorrelation;
  /**
   * Optional catalog for the tool-call loop seam. Omitted builds an empty
   * catalog for the correlation's configuration generation (#700 registers
   * product tools later).
   */
  readonly toolCatalog?: ToolCatalog;
  /** Optional runner; absent means tools cannot execute (fail closed). */
  readonly toolRunner?: ToolRunnerPort;
  /** Optional live or deterministic adapter; absent means no model stream. */
  readonly providerAdapter?: ProviderAdapterPort | null;
  /** Optional attempt runner; absent means turn attempts cannot run. */
  readonly attemptRunner?: AttemptRunnerPort;
};

export type ProductAgentRuntimeError =
  | { readonly code: "missing-event-store" }
  | { readonly code: "missing-clock" }
  | { readonly code: "missing-stream-id" }
  | { readonly code: "missing-correlation" }
  | { readonly code: "missing-correlation-field"; readonly field: string }
  | { readonly code: "provider-adapter-required" }
  | { readonly code: "attempt-runner-required" }
  | { readonly code: "tool-runner-required" };

export type ProductAgentRuntimeComposeResult =
  | { readonly ok: true; readonly value: ProductAgentRuntime }
  | { readonly ok: false; readonly error: ProductAgentRuntimeError };

export type ProductAgentAttachmentPoints = {
  /**
   * Slot for OpenTUI / headless session-turn-transcript producers (#706).
   * Null until a sibling attaches a producer.
   */
  readonly turnProducer: null;
  /**
   * Slot for composer submission wiring (#707). Null until the composer
   * replaces UNAVAILABLE_SUBMISSION.
   */
  readonly submission: null;
};

export type ProductAgentPortResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: ProductAgentRuntimeError };

export type ProductAgentRuntime = {
  readonly sessionRuntime: SessionRuntime;
  readonly turnCoordinator: TurnCoordinator;
  readonly journal: TurnEventJournal;
  readonly toolCatalog: ToolCatalog;
  readonly toolRunner: ToolRunnerPort | null;
  readonly providerAdapter: ProviderAdapterPort | null;
  readonly attemptRunner: AttemptRunnerPort | null;
  readonly attachments: ProductAgentAttachmentPoints;
  readonly streamId: StreamId;
  readonly correlation: SessionCorrelation;
  requireToolRunner(): ProductAgentPortResult<ToolRunnerPort>;
  requireProviderAdapter(): ProductAgentPortResult<ProviderAdapterPort>;
  requireAttemptRunner(): ProductAgentPortResult<AttemptRunnerPort>;
  /**
   * Start a turn on the coordinator and persist `turn.started`. Proves the
   * product graph can host a turn without depending on builtin tools or live
   * vendors.
   */
  hostTurn(input: StartTurnInput): Promise<HostTurnOutcome>;
};

export type HostTurnOutcome =
  | {
      readonly kind: "hosted";
      readonly turnId: TurnId;
      readonly persist: PersistTurnEventsOutcome;
    }
  | {
      readonly kind: "coordinator-rejected";
      readonly error: TurnCoordinatorError;
    }
  | {
      readonly kind: "persist-failed";
      readonly turnId: TurnId;
      readonly persist: PersistTurnEventsOutcome;
    };

function missingCorrelationField(correlation: SessionCorrelation): ProductAgentRuntimeError | null {
  const fields: readonly (keyof SessionCorrelation)[] = [
    "workspaceId",
    "sessionId",
    "traceId",
    "configurationGeneration",
  ];
  for (const field of fields) {
    if (correlation[field] === undefined || correlation[field] === null) {
      return { code: "missing-correlation-field", field };
    }
  }
  return null;
}

/**
 * Compose the product agent runtime. Required ports fail closed; optional
 * seams stay null until siblings attach them.
 */
export function composeProductAgentRuntime(
  ports: ProductAgentRuntimePorts,
): ProductAgentRuntimeComposeResult {
  if (ports.eventStore === undefined || ports.eventStore === null) {
    return { ok: false, error: { code: "missing-event-store" } };
  }
  if (ports.clock === undefined || ports.clock === null) {
    return { ok: false, error: { code: "missing-clock" } };
  }
  if (ports.streamId === undefined || ports.streamId === null) {
    return { ok: false, error: { code: "missing-stream-id" } };
  }
  if (ports.correlation === undefined || ports.correlation === null) {
    return { ok: false, error: { code: "missing-correlation" } };
  }
  const correlationError = missingCorrelationField(ports.correlation);
  if (correlationError !== null) {
    return { ok: false, error: correlationError };
  }

  const toolCatalog =
    ports.toolCatalog ?? createToolCatalog(ports.correlation.configurationGeneration, []);
  const toolRunner = ports.toolRunner ?? null;
  const providerAdapter = ports.providerAdapter ?? null;
  const attemptRunner = ports.attemptRunner ?? null;

  const sessionRuntime = createSessionRuntime();
  const turnCoordinator = createTurnCoordinator();
  const journal = createTurnEventJournal({
    eventStore: ports.eventStore,
    clock: ports.clock,
    streamId: ports.streamId,
    correlation: ports.correlation,
  });

  const runtime: ProductAgentRuntime = {
    sessionRuntime,
    turnCoordinator,
    journal,
    toolCatalog,
    toolRunner,
    providerAdapter,
    attemptRunner,
    attachments: { turnProducer: null, submission: null },
    streamId: ports.streamId,
    correlation: ports.correlation,
    requireToolRunner() {
      if (toolRunner === null) {
        return { ok: false, error: { code: "tool-runner-required" } };
      }
      return { ok: true, value: toolRunner };
    },
    requireProviderAdapter() {
      if (providerAdapter === null) {
        return { ok: false, error: { code: "provider-adapter-required" } };
      }
      return { ok: true, value: providerAdapter };
    },
    requireAttemptRunner() {
      if (attemptRunner === null) {
        return { ok: false, error: { code: "attempt-runner-required" } };
      }
      return { ok: true, value: attemptRunner };
    },
    async hostTurn(input) {
      const started = turnCoordinator.start(input);
      if (!started.ok) {
        return { kind: "coordinator-rejected", error: started.error };
      }

      const fact: TurnLifecycleFact = {
        kind: "turn.started",
        correlation: {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          traceId: input.traceId,
          configurationGeneration: input.configurationGeneration,
          turnId: input.turnId,
        },
      };
      const persist = await journal.persist([fact]);
      if (persist.kind !== "persisted") {
        return { kind: "persist-failed", turnId: input.turnId, persist };
      }
      return { kind: "hosted", turnId: input.turnId, persist };
    },
  };

  return { ok: true, value: runtime };
}

/** Identity helpers retained for callers assembling correlation. */
export type ProductAgentSessionIds = {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly traceId: TraceId;
  readonly configurationGeneration: ConfigurationGeneration;
};
