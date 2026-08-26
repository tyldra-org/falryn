/**
 * Product bootstrap composition for the live coding agent host (#705).
 *
 * Composes the verified session runtime, turn coordinator, durable turn
 * journal, and live session/turn/transcript producer into one fail-closed
 * product graph. When a provider, registry, and tool runner are supplied, it
 * also composes the production provider/tool continuation controller (#786).
 * Leaves OpenTUI submission as a typed attachment point owned by #787.
 */

import {
  type ClockPort,
  type ConfigurationGeneration,
  createToolCatalog,
  createToolHookRegistry,
  type EventStorePort,
  type SessionCorrelation,
  type SessionId,
  type StreamId,
  type ToolCatalog,
  type ToolHookRegistry,
  type ToolPolicyProfile,
  type ToolRegistry,
  type TraceId,
  type TurnId,
  type TurnLifecycleFact,
  type WorkspaceId,
} from "../domain/index.ts";
import type { ProviderAdapterPort } from "../providers/port.ts";
import { createProductAttemptRunner } from "./product-attempt-runner.ts";
import type { ProductToolConfirmationPort } from "./product-tool-gateway.ts";
import type { SessionRuntime } from "./session-runtime.ts";
import { createSessionRuntime } from "./session-runtime.ts";
import type { SessionTurnTranscriptProducer } from "./session-turn-transcript-producer.ts";
import { createSessionTurnTranscriptProducer } from "./session-turn-transcript-producer.ts";
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
  /** Registry authority used for disclosure and the production lifecycle. */
  readonly toolRegistry?: ToolRegistry;
  /** Optional runner; absent means tools cannot execute (fail closed). */
  readonly toolRunner?: ToolRunnerPort;
  /** Optional live or deterministic adapter; absent means no model stream. */
  readonly providerAdapter?: ProviderAdapterPort | null;
  /** Explicit test/host override; normal product composition builds this. */
  readonly attemptRunner?: AttemptRunnerPort;
  readonly toolHooks?: ToolHookRegistry;
  readonly toolPolicy?: ToolPolicyProfile;
  readonly toolConfirmation?: ProductToolConfirmationPort;
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
   * Live session/turn/transcript producer (#706). Always composed with the
   * product runtime so OpenTUI and headless can fold the same event stream.
   */
  readonly turnProducer: SessionTurnTranscriptProducer;
  /**
   * Composer {@link SubmissionPort} is owned by the TUI layer (#707). Callers
   * build it with `createProductSubmissionPort({ producer })` and pass it into
   * `runShell` / `ShellApp`. Remains null here so application does not depend
   * on OpenTUI types.
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
  readonly toolRegistry: ToolRegistry | null;
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
 * Compose the product agent runtime. Required ports fail closed. Provider,
 * registry, and tool runner ports form one all-or-nothing live attempt graph;
 * otherwise the attempt seam remains unavailable and callers must not claim a
 * completed model turn.
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

  const toolRegistry = ports.toolRegistry ?? null;
  const toolCatalog =
    ports.toolCatalog ??
    toolRegistry?.catalog ??
    createToolCatalog(ports.correlation.configurationGeneration, []);
  const toolRunner = ports.toolRunner ?? null;
  const providerAdapter = ports.providerAdapter ?? null;

  const sessionRuntime = createSessionRuntime();
  const turnCoordinator = createTurnCoordinator();
  const journal = createTurnEventJournal({
    eventStore: ports.eventStore,
    clock: ports.clock,
    streamId: ports.streamId,
    correlation: ports.correlation,
  });
  const hookRegistry = (() => {
    if (ports.toolHooks !== undefined) {
      return ports.toolHooks;
    }
    const empty = createToolHookRegistry(ports.correlation.configurationGeneration, []);
    if (!empty.ok) {
      throw new Error(`empty tool hook registry failed: ${empty.error.code}`);
    }
    return empty.value;
  })();
  const attemptRunner =
    ports.attemptRunner ??
    (providerAdapter !== null && toolRunner !== null && toolRegistry !== null
      ? createProductAttemptRunner({
          clock: ports.clock,
          coordinator: turnCoordinator,
          provider: providerAdapter,
          registry: toolRegistry,
          toolRunner,
          hooks: hookRegistry,
          journal,
          correlation: ports.correlation,
          ...(ports.toolPolicy === undefined ? {} : { policy: ports.toolPolicy }),
          ...(ports.toolConfirmation === undefined ? {} : { confirmation: ports.toolConfirmation }),
        })
      : null);
  const turnProducer = createSessionTurnTranscriptProducer({
    eventStore: ports.eventStore,
    journal,
    sessionRuntime,
    turnCoordinator,
    streamId: ports.streamId,
    correlation: ports.correlation,
  });

  const runtime: ProductAgentRuntime = {
    sessionRuntime,
    turnCoordinator,
    journal,
    toolCatalog,
    toolRegistry,
    toolRunner,
    providerAdapter,
    attemptRunner,
    attachments: { turnProducer, submission: null },
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
